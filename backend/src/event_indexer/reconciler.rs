//! On-chain state reconciliation
//!
//! Periodically fetches PoolState + CommitmentTree PDAs via `getMultipleAccounts`,
//! compares on-chain counts with local SQLite, and triggers backfill on mismatch.

use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::time::{self, Duration};

use super::storage::EventStore;
use super::tree_cache::TreeCache;

/// Parsed on-chain state from PoolState + CommitmentTree PDAs
#[derive(Debug, Clone, serde::Serialize)]
pub struct OnChainState {
    pub deposit_count: u64,
    pub total_minted: u64,
    pub total_burned: u64,
    pub total_shielded: u64,
    pub pending_redemptions: u64,
    pub tree_next_index: u64,
    /// Current on-chain Merkle root (hex)
    pub tree_root: String,
}

/// Result of comparing on-chain vs local state
#[derive(Debug, Clone, serde::Serialize)]
pub struct ReconciliationResult {
    pub on_chain: OnChainState,
    pub local_leaf_count: i64,
    pub local_deposit_count: i64,
    pub local_nullifier_count: i64,
    pub leaves_match: bool,
    pub deposits_match: bool,
    pub recovery_triggered: bool,
    pub checked_at: i64,
}

/// Background reconciler that compares on-chain state with local SQLite
pub struct Reconciler {
    rpc_url: String,
    pool_state_pubkey: String,
    commitment_tree_pubkey: String,
    store: Arc<EventStore>,
    tree_cache: Arc<TreeCache>,
    interval_secs: u64,
    status: Arc<RwLock<Option<ReconciliationResult>>>,
    http_client: reqwest::Client,
}

// PoolState byte offsets (repr(C), disc=0x01)
const POOL_DISC: u8 = 0x01;
const POOL_DEPOSIT_COUNT_OFFSET: usize = 132; // 4 header + 32*4 pubkeys
const POOL_TOTAL_MINTED_OFFSET: usize = 140;
const POOL_TOTAL_BURNED_OFFSET: usize = 148;
const POOL_PENDING_REDEMPTIONS_OFFSET: usize = 156;
const POOL_TOTAL_SHIELDED_OFFSET: usize = 188;

// CommitmentTree byte offsets (repr(C), disc=0x05)
const TREE_DISC: u8 = 0x05;
const TREE_ROOT_OFFSET: usize = 8; // 1+1+6 padding
const TREE_NEXT_INDEX_OFFSET: usize = 40; // 1+1+6 padding + 32 root

/// Recovery cooldown to prevent loops during active backfill
const RECOVERY_COOLDOWN_SECS: i64 = 300; // 5 minutes

impl Reconciler {
    pub fn new(
        rpc_url: String,
        pool_state_pubkey: String,
        commitment_tree_pubkey: String,
        store: Arc<EventStore>,
        tree_cache: Arc<TreeCache>,
        interval_secs: u64,
        status: Arc<RwLock<Option<ReconciliationResult>>>,
    ) -> Self {
        Self {
            rpc_url,
            pool_state_pubkey,
            commitment_tree_pubkey,
            store,
            tree_cache,
            interval_secs,
            status,
            http_client: reqwest::Client::new(),
        }
    }

    /// Main loop: reconcile on-chain vs local state every `interval_secs`
    pub async fn run(&self) {
        let mut interval = time::interval(Duration::from_secs(self.interval_secs));
        let mut last_recovery_at: i64 = 0;

        tracing::info!(
            interval_secs = self.interval_secs,
            pool = %self.pool_state_pubkey,
            tree = %self.commitment_tree_pubkey,
            "[reconciler] started"
        );

        loop {
            interval.tick().await;

            match self.reconcile_once(&mut last_recovery_at).await {
                Ok(result) => {
                    if result.leaves_match && result.deposits_match {
                        tracing::info!(
                            on_chain_leaves = result.on_chain.tree_next_index,
                            local_leaves = result.local_leaf_count,
                            on_chain_deposits = result.on_chain.deposit_count,
                            local_deposits = result.local_deposit_count,
                            "[reconciler] OK"
                        );
                    }
                    *self.status.write().await = Some(result);
                }
                Err(e) => {
                    tracing::warn!(error = %e, "[reconciler] check failed");
                }
            }
        }
    }

    async fn reconcile_once(&self, last_recovery_at: &mut i64) -> Result<ReconciliationResult, String> {
        // 1. Fetch both PDAs in a single RPC call
        let on_chain = self.fetch_on_chain_state().await?;

        // 2. Query local counts
        let local_leaf_count = self.store.get_next_leaf_index()?; // max+1 or 0
        let local_deposit_count = self.store.get_deposit_count()?;
        let local_nullifier_count = self.store.get_nullifier_count()?;

        // 3. Compare
        let leaves_match = on_chain.tree_next_index == local_leaf_count as u64;
        let deposits_match = on_chain.deposit_count == local_deposit_count as u64;

        let now = chrono::Utc::now().timestamp();
        let mut recovery_triggered = false;

        // 4. On mismatch, trigger recovery (with cooldown)
        if !leaves_match {
            let since_last = now - *last_recovery_at;
            if since_last >= RECOVERY_COOLDOWN_SECS {
                // If local is completely empty but on-chain has leaves, try seeding from localnet-state.json
                if local_leaf_count == 0 && on_chain.tree_next_index > 0 {
                    if let Some(count) = self.try_seed_from_state_file().await {
                        tracing::info!(
                            seeded = count,
                            "[reconciler] seeded {} leaves from localnet-state.json",
                            count
                        );
                        recovery_triggered = true;
                        *last_recovery_at = now;
                        if let Err(e) = self.tree_cache.force_rebuild().await {
                            tracing::warn!(error = %e, "[reconciler] tree cache rebuild after seed failed");
                        }
                    }
                }

                // If still mismatched (seed didn't help or wasn't applicable), clear checkpoint
                let new_local = self.store.get_next_leaf_index().unwrap_or(0);
                if new_local as u64 != on_chain.tree_next_index {
                    tracing::warn!(
                        on_chain = on_chain.tree_next_index,
                        local = new_local,
                        "[reconciler] leaf count mismatch — clearing checkpoint to trigger backfill"
                    );
                    if let Err(e) = self.store.set_last_signature("") {
                        tracing::error!(error = %e, "[reconciler] failed to clear checkpoint");
                    } else {
                        recovery_triggered = true;
                        *last_recovery_at = now;
                        if let Err(e) = self.tree_cache.force_rebuild().await {
                            tracing::warn!(error = %e, "[reconciler] tree cache rebuild failed (will retry)");
                        }
                    }
                }
            } else {
                tracing::info!(
                    cooldown_remaining = RECOVERY_COOLDOWN_SECS - since_last,
                    "[reconciler] mismatch detected but in cooldown"
                );
            }
        }

        Ok(ReconciliationResult {
            on_chain,
            local_leaf_count,
            local_deposit_count,
            local_nullifier_count,
            leaves_match,
            deposits_match,
            recovery_triggered,
            checked_at: now,
        })
    }

    /// Try to seed leaves from localnet-state.json (localnet recovery)
    ///
    /// When the validator is reset with --reset, account state is cloned but tx history
    /// is wiped. The indexer can't backfill via getSignaturesForAddress because there are
    /// no transactions. But localnet-state.json (written by the init script) contains
    /// all commitment hashes. We seed the local DB from that file.
    async fn try_seed_from_state_file(&self) -> Option<usize> {
        // Only attempt on localnet
        let network = std::env::var("UTXOPIA_NETWORK").unwrap_or_default();
        if network != "localnet" {
            return None;
        }

        // Try to find localnet-state.json relative to the binary or working directory
        let paths = [
            "../scripts/e2e/localnet-state.json".to_string(),
            "scripts/e2e/localnet-state.json".to_string(),
        ];

        let mut state_path = None;
        for p in &paths {
            if std::path::Path::new(p).exists() {
                state_path = Some(p.clone());
                break;
            }
        }

        let path = state_path?;
        tracing::info!(path = %path, "[reconciler] found localnet-state.json, seeding leaves");

        let content = std::fs::read_to_string(&path).ok()?;
        let json: serde_json::Value = serde_json::from_str(&content).ok()?;

        let commitments = json["commitments"].as_array()?;
        if commitments.is_empty() {
            return None;
        }

        let mut count = 0;
        for (i, c) in commitments.iter().enumerate() {
            let hex_str = c.as_str()?;
            // Pad odd-length hex (e.g. "194b7..." → "0194b7...")
            let padded = if hex_str.len() % 2 != 0 {
                format!("0{}", hex_str)
            } else {
                hex_str.to_string()
            };
            let commitment_bytes = match hex::decode(&padded) {
                Ok(b) => b,
                Err(_) => continue,
            };
            if commitment_bytes.len() != 32 {
                continue;
            }
            let mut arr = [0u8; 32];
            arr.copy_from_slice(&commitment_bytes);

            // Insert into SQLite as a leaf (minimal — no announcement data)
            let inserted = self.store.insert_leaf_from_seed(
                i as i64,
                &arr,
                "localnet-seed",
            ).unwrap_or(false);

            if inserted {
                count += 1;
            }
        }

        if count > 0 { Some(count) } else { None }
    }

    /// Fetch PoolState + CommitmentTree via a single `getMultipleAccounts` RPC call
    async fn fetch_on_chain_state(&self) -> Result<OnChainState, String> {
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getMultipleAccounts",
            "params": [
                [&self.pool_state_pubkey, &self.commitment_tree_pubkey],
                { "encoding": "base64" }
            ]
        });

        let resp = self.http_client
            .post(&self.rpc_url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("RPC request failed: {}", e))?;

        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("RPC response parse failed: {}", e))?;

        let accounts = json["result"]["value"]
            .as_array()
            .ok_or("missing result.value array")?;

        if accounts.len() < 2 {
            return Err("expected 2 accounts in response".into());
        }

        // Parse PoolState
        let pool_data = Self::decode_account_data(&accounts[0])?;
        if pool_data.is_empty() || pool_data[0] != POOL_DISC {
            return Err(format!("invalid pool discriminator: expected {:#x}", POOL_DISC));
        }
        if pool_data.len() < POOL_TOTAL_SHIELDED_OFFSET + 8 {
            return Err("pool account data too short".into());
        }

        let deposit_count = u64::from_le_bytes(
            pool_data[POOL_DEPOSIT_COUNT_OFFSET..POOL_DEPOSIT_COUNT_OFFSET + 8]
                .try_into().unwrap()
        );
        let total_minted = u64::from_le_bytes(
            pool_data[POOL_TOTAL_MINTED_OFFSET..POOL_TOTAL_MINTED_OFFSET + 8]
                .try_into().unwrap()
        );
        let total_burned = u64::from_le_bytes(
            pool_data[POOL_TOTAL_BURNED_OFFSET..POOL_TOTAL_BURNED_OFFSET + 8]
                .try_into().unwrap()
        );
        let pending_redemptions = u64::from_le_bytes(
            pool_data[POOL_PENDING_REDEMPTIONS_OFFSET..POOL_PENDING_REDEMPTIONS_OFFSET + 8]
                .try_into().unwrap()
        );
        let total_shielded = u64::from_le_bytes(
            pool_data[POOL_TOTAL_SHIELDED_OFFSET..POOL_TOTAL_SHIELDED_OFFSET + 8]
                .try_into().unwrap()
        );

        // Parse CommitmentTree
        let tree_data = Self::decode_account_data(&accounts[1])?;
        if tree_data.is_empty() || tree_data[0] != TREE_DISC {
            return Err(format!("invalid tree discriminator: expected {:#x}", TREE_DISC));
        }
        if tree_data.len() < TREE_NEXT_INDEX_OFFSET + 8 {
            return Err("tree account data too short".into());
        }

        let tree_next_index = u64::from_le_bytes(
            tree_data[TREE_NEXT_INDEX_OFFSET..TREE_NEXT_INDEX_OFFSET + 8]
                .try_into().unwrap()
        );
        let tree_root = hex::encode(&tree_data[TREE_ROOT_OFFSET..TREE_ROOT_OFFSET + 32]);

        Ok(OnChainState {
            deposit_count,
            total_minted,
            total_burned,
            total_shielded,
            pending_redemptions,
            tree_next_index,
            tree_root,
        })
    }

    /// Decode base64 account data from RPC JSON response
    fn decode_account_data(account_json: &serde_json::Value) -> Result<Vec<u8>, String> {
        if account_json.is_null() {
            return Err("account not found (null)".into());
        }

        let data_arr = account_json["data"]
            .as_array()
            .ok_or("missing data array")?;

        let b64 = data_arr
            .first()
            .and_then(|v| v.as_str())
            .ok_or("missing base64 data")?;

        use base64::Engine;
        base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| format!("base64 decode error: {}", e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pool_state_offsets() {
        // Verify offsets match the repr(C) struct layout:
        // disc(1) + bump(1) + flags(1) + pad(1) + authority(32) + mint(32) + vault(32) + frost(32) = 132
        assert_eq!(POOL_DEPOSIT_COUNT_OFFSET, 1 + 1 + 1 + 1 + 32 + 32 + 32 + 32);
        assert_eq!(POOL_TOTAL_MINTED_OFFSET, POOL_DEPOSIT_COUNT_OFFSET + 8);
        assert_eq!(POOL_TOTAL_BURNED_OFFSET, POOL_TOTAL_MINTED_OFFSET + 8);
        assert_eq!(POOL_PENDING_REDEMPTIONS_OFFSET, POOL_TOTAL_BURNED_OFFSET + 8);
        // pending_redemptions(8) + last_update(8) + min_deposit(8) + max_deposit(8) = 32 after pending_redemptions
        assert_eq!(POOL_TOTAL_SHIELDED_OFFSET, POOL_PENDING_REDEMPTIONS_OFFSET + 8 + 8 + 8 + 8);
    }

    #[test]
    fn test_tree_offsets() {
        // disc(1) + bump(1) + padding(6) + root(32) = 40
        assert_eq!(TREE_NEXT_INDEX_OFFSET, 1 + 1 + 6 + 32);
    }

    #[test]
    fn test_parse_pool_data() {
        let mut data = vec![0u8; 256];
        data[0] = POOL_DISC;
        // Set deposit_count = 42
        data[POOL_DEPOSIT_COUNT_OFFSET..POOL_DEPOSIT_COUNT_OFFSET + 8]
            .copy_from_slice(&42u64.to_le_bytes());
        // Set total_shielded = 100000
        data[POOL_TOTAL_SHIELDED_OFFSET..POOL_TOTAL_SHIELDED_OFFSET + 8]
            .copy_from_slice(&100_000u64.to_le_bytes());

        assert_eq!(data[0], POOL_DISC);
        let deposit_count = u64::from_le_bytes(
            data[POOL_DEPOSIT_COUNT_OFFSET..POOL_DEPOSIT_COUNT_OFFSET + 8]
                .try_into().unwrap()
        );
        assert_eq!(deposit_count, 42);
        let total_shielded = u64::from_le_bytes(
            data[POOL_TOTAL_SHIELDED_OFFSET..POOL_TOTAL_SHIELDED_OFFSET + 8]
                .try_into().unwrap()
        );
        assert_eq!(total_shielded, 100_000);
    }

    #[test]
    fn test_parse_tree_data() {
        let mut data = vec![0u8; 128];
        data[0] = TREE_DISC;
        data[TREE_NEXT_INDEX_OFFSET..TREE_NEXT_INDEX_OFFSET + 8]
            .copy_from_slice(&7u64.to_le_bytes());

        let next_index = u64::from_le_bytes(
            data[TREE_NEXT_INDEX_OFFSET..TREE_NEXT_INDEX_OFFSET + 8]
                .try_into().unwrap()
        );
        assert_eq!(next_index, 7);
    }
}
