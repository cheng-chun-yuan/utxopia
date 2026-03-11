//! Event indexer service
//!
//! Polls Solana for new transactions, parses events from logs,
//! and stores them in SQLite.

use std::sync::Arc;
use tokio::time::{interval, Duration};

use super::parser::{parse_program_events, ProgramEvent};
use super::storage::EventStore;
use super::tree_cache::TreeCache;

/// BTC Light Client program ID — used to detect real vs demo deposits.
/// Transactions that reference this account are SPV-verified BTC deposits.
const BTC_LIGHT_CLIENT_PROGRAM_ID: &str = "Ho6UTeF8yFnRdCK15tSZtcJozvkDABJZWYxkgGyWAfyq";

/// Configuration for the event indexer
#[derive(Debug, Clone)]
pub struct EventIndexerConfig {
    /// Solana RPC URL
    pub rpc_url: String,
    /// Aegis program ID (base58)
    pub program_id: String,
    /// Poll interval in seconds
    pub poll_interval_secs: u64,
}

/// Event indexer service that polls for new transactions
pub struct EventIndexerService {
    config: EventIndexerConfig,
    store: Arc<EventStore>,
    http: reqwest::Client,
    /// Optional tree cache for in-memory Merkle tree updates
    tree_cache: Option<Arc<TreeCache>>,
}

/// Aegis program ID — used to find verify_stealth_deposit instructions.
const AEGIS_PROGRAM_ID: &str = "4Gt66pJd6N3hYEVWnaWTSLfxotsPvShYEWYvbUB9Ubx1";

/// Data extracted from a getTransaction RPC response
struct TransactionData {
    logs: Vec<String>,
    block_time: i64,
    /// Whether the tx references the BTC light client program (SPV-verified deposit)
    is_verified_deposit: bool,
    /// BTC deposit txid (extracted from verify_stealth_deposit instruction data)
    btc_deposit_txid: Option<String>,
    /// BTC sweep txid (extracted from verify_stealth_deposit instruction data)
    btc_sweep_txid: Option<String>,
    /// Original BTC deposit amount in sats (fetched from mempool)
    btc_deposit_amount_sats: Option<i64>,
    /// Aegis instruction discriminator (first byte of instruction data)
    instruction_disc: Option<u8>,
    /// Token transfer amount in sats (unshield txs only, from postTokenBalances)
    unshield_amount: Option<i64>,
    /// Token transfer recipient wallet (unshield txs only, from postTokenBalances)
    unshield_recipient: Option<String>,
}

/// Mempool.space API base URL for testnet4
const MEMPOOL_API_URL: &str = "https://mempool.space/testnet4/api";

impl EventIndexerService {
    pub fn new(config: EventIndexerConfig, store: Arc<EventStore>) -> Result<Self, String> {
        Ok(Self {
            config,
            store,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|e| format!("http client error: {}", e))?,
            tree_cache: None,
        })
    }

    /// Set the tree cache for in-memory Merkle tree updates
    pub fn with_tree_cache(mut self, cache: Arc<TreeCache>) -> Self {
        self.tree_cache = Some(cache);
        self
    }

    /// Start the indexer loop
    pub async fn run(&mut self) {
        tracing::info!(
            program_id = %self.config.program_id,
            poll_interval = self.config.poll_interval_secs,
            "Starting event indexer"
        );

        // Initial backfill
        if let Err(e) = self.backfill().await {
            eprintln!("[event-indexer] Backfill FAILED: {}", e);
        }

        // Ongoing polling
        let mut poll = interval(Duration::from_secs(self.config.poll_interval_secs));
        loop {
            poll.tick().await;
            if let Err(e) = self.poll_new_transactions().await {
                tracing::warn!(error = %e, "Poll cycle failed");
            }
        }
    }

    /// Backfill: scan all historical transactions for the program
    async fn backfill(&mut self) -> Result<(), String> {
        tracing::info!(program_id = %self.config.program_id, "Starting backfill");

        let last_sig = self.store.get_last_signature()?;
        let mut before: Option<String> = None;
        let mut total_processed = 0u64;

        loop {
            let signatures = self
                .get_signatures_for_address(&self.config.program_id, before.as_deref(), last_sig.as_deref())
                .await?;

            if signatures.is_empty() {
                break;
            }

            // Process oldest first
            for sig_info in signatures.iter().rev() {
                let sig = &sig_info.signature;
                let slot = sig_info.slot;

                let mut retries = 0u32;
                loop {
                    match self.process_transaction(sig, slot).await {
                        Ok(_) => break,
                        Err(e) if e.contains("429") && retries < 5 => {
                            retries += 1;
                            let backoff = Duration::from_secs(2u64.pow(retries));
                            eprintln!("[event-indexer] Rate limited on {}..., retry {} in {:?}", &sig[..20], retries, backoff);
                            tokio::time::sleep(backoff).await;
                        }
                        Err(e) => {
                            eprintln!("[event-indexer] Failed to process tx {}...: {}", &sig[..20], e);
                            break;
                        }
                    }
                }
                total_processed += 1;
                // Delay between RPC calls to avoid rate limiting on devnet
                tokio::time::sleep(Duration::from_millis(500)).await;
            }

            // Track pagination
            before = Some(signatures.last().unwrap().signature.clone());

            // Save checkpoint
            if let Some(first) = signatures.first() {
                self.store.set_last_signature(&first.signature)?;
            }
        }

        tracing::info!(total_processed, "Backfill complete");
        Ok(())
    }

    /// Poll for new transactions since the last known signature.
    /// If no checkpoint exists (e.g. after a reset), triggers a full backfill.
    async fn poll_new_transactions(&mut self) -> Result<(), String> {
        let last_sig = self.store.get_last_signature()?;

        // No checkpoint = fresh state (after reset). Do a full backfill instead of
        // just fetching the latest 100 signatures, which would miss older txs.
        if last_sig.is_none() {
            tracing::info!("No checkpoint found — running full backfill");
            return self.backfill().await;
        }

        let signatures = self
            .get_signatures_for_address(&self.config.program_id, None, None)
            .await?;

        if signatures.is_empty() {
            return Ok(());
        }

        // Find new signatures (stop at last_sig)
        let mut new_sigs: Vec<&SignatureInfo> = Vec::new();
        for sig_info in &signatures {
            if Some(&sig_info.signature) == last_sig.as_ref() {
                break;
            }
            new_sigs.push(sig_info);
        }

        if new_sigs.is_empty() {
            return Ok(());
        }

        // Process oldest first
        for sig_info in new_sigs.iter().rev() {
            if let Err(e) = self.process_transaction(&sig_info.signature, sig_info.slot).await {
                tracing::warn!(signature = %sig_info.signature, error = %e, "Failed to process tx");
            }
        }

        // Update checkpoint to newest
        self.store.set_last_signature(&new_sigs[0].signature)?;

        tracing::debug!(count = new_sigs.len(), "Processed new transactions");
        Ok(())
    }

    /// Process a single transaction: fetch logs + blockTime, parse events, store.
    ///
    /// Uses the on-chain `leaf_index` from StealthAnnouncement events (which carry
    /// the authoritative leaf_index) to assign leaf indices to LeafInserted events.
    /// This eliminates the need for an in-memory counter and avoids race conditions
    /// between the poll service and the WebSocket subscriber.
    async fn process_transaction(&mut self, signature: &str, slot: i64) -> Result<(), String> {
        let tx_data = self.get_transaction_data(signature).await?;
        let events = parse_program_events(&tx_data.logs);
        if events.is_empty() {
            return Ok(());
        }

        tracing::debug!(signature = &signature[..20], count = events.len(), block_time = tx_data.block_time, "Parsed events");

        let block_time = tx_data.block_time;
        let is_verified = tx_data.is_verified_deposit;

        // Separate events by type
        let mut leaf_events = Vec::new();
        let mut announcements = Vec::new();
        let mut nullifiers = Vec::new();
        let mut redemption_completions = Vec::new();
        let mut redemption_requests = Vec::new();

        for event in events {
            match event {
                ProgramEvent::LeafInserted(e) => leaf_events.push(e),
                ProgramEvent::StealthAnnouncement(e) => announcements.push(e),
                ProgramEvent::NullifierSpent(e) => nullifiers.push(e),
                ProgramEvent::RedemptionCompleted(e) => redemption_completions.push(e),
                ProgramEvent::RedemptionRequested(e) => redemption_requests.push(e),
                ProgramEvent::PoolPaused(e) => {
                    tracing::info!(is_paused = e.is_paused, timestamp = e.timestamp, "Pool paused/unpaused event");
                }
                ProgramEvent::RedemptionProcessing(e) => {
                    tracing::info!(
                        request_id = e.request_id,
                        amount_sats = e.amount_sats,
                        processing_slot = e.processing_slot,
                        "Redemption processing event"
                    );
                }
            }
        }

        // Match LeafInserted with StealthAnnouncement by commitment.
        // The announcement carries the authoritative on-chain leaf_index.
        for ann in &announcements {
            let leaf_index = ann.leaf_index as i64;

            // Find matching leaf event by commitment
            if let Some(leaf) = leaf_events.iter().find(|l| l.commitment == ann.commitment) {
                let inserted = self.store.insert_leaf(leaf_index, leaf, signature, slot, block_time)?;
                if inserted {
                    if let Some(ref cache) = self.tree_cache {
                        cache.on_leaf_inserted(leaf_index as u64, leaf.commitment).await;
                    }
                }
                tracing::debug!(leaf_index, inserted, "Indexed leaf");
            }

            // Insert announcement (with is_verified flag + BTC txids + deposit amount for real deposits)
            let inserted = self.store.insert_announcement(
                ann, signature, slot, block_time, is_verified,
                tx_data.btc_deposit_txid.as_deref(), tx_data.btc_sweep_txid.as_deref(),
                tx_data.btc_deposit_amount_sats,
            )?;
            if inserted {
                if let Some(ref cache) = self.tree_cache {
                    cache.broadcast_announcement(ann);
                }
            }
            tracing::debug!(leaf_index = ann.leaf_index, is_verified, "Indexed stealth announcement");
        }

        // Handle nullifiers
        let instruction_disc = tx_data.instruction_disc;
        for null in &nullifiers {
            let inserted = self.store.insert_nullifier(
                null, signature, slot, block_time, instruction_disc,
                tx_data.unshield_amount, tx_data.unshield_recipient.as_deref(),
            )?;
            if inserted {
                if let Some(ref cache) = self.tree_cache {
                    cache.broadcast_nullifier(&hex::encode(null.nullifier_hash), slot);
                }
            }
            tracing::debug!(nullifier = hex::encode(&null.nullifier_hash[..8]), disc = ?instruction_disc, "Indexed nullifier");
        }

        // Handle redemption completions
        for rc in &redemption_completions {
            let inserted = self.store.insert_redemption_completed(rc, signature, slot, block_time)?;
            tracing::info!(
                request_id = rc.request_id,
                amount_sats = rc.amount_sats,
                inserted,
                "Indexed redemption completion"
            );
        }

        // Handle redemption requests
        for rr in &redemption_requests {
            let inserted = self.store.insert_redemption_requested(rr, signature, slot, block_time)?;
            tracing::info!(
                request_id = rr.request_id,
                amount_sats = rr.amount_sats,
                inserted,
                "Indexed redemption request"
            );
        }

        Ok(())
    }

    // =========================================================================
    // Solana RPC helpers
    // =========================================================================

    async fn get_signatures_for_address(
        &self,
        address: &str,
        before: Option<&str>,
        until: Option<&str>,
    ) -> Result<Vec<SignatureInfo>, String> {
        let mut params = serde_json::json!([
            address,
            { "limit": 100, "commitment": "confirmed" }
        ]);

        if let Some(b) = before {
            params[1]["before"] = serde_json::Value::String(b.to_string());
        }
        if let Some(u) = until {
            params[1]["until"] = serde_json::Value::String(u.to_string());
        }

        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getSignaturesForAddress",
            "params": params,
        });

        let resp = self
            .http
            .post(&self.config.rpc_url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("rpc error: {}", e))?;

        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("json error: {}", e))?;

        let result = json["result"]
            .as_array()
            .ok_or("missing result array")?;

        let mut signatures = Vec::new();
        for item in result {
            // Skip errored transactions
            if !item["err"].is_null() {
                continue;
            }
            if let (Some(sig), Some(slot)) = (item["signature"].as_str(), item["slot"].as_i64()) {
                signatures.push(SignatureInfo {
                    signature: sig.to_string(),
                    slot,
                });
            }
        }

        Ok(signatures)
    }

    async fn get_transaction_data(&self, signature: &str) -> Result<TransactionData, String> {
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getTransaction",
            "params": [
                signature,
                { "encoding": "json", "maxSupportedTransactionVersion": 0, "commitment": "confirmed" }
            ],
        });

        let resp = self
            .http
            .post(&self.config.rpc_url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("rpc error: {}", e))?;

        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("json error: {}", e))?;

        // Check for RPC errors
        if let Some(err) = json.get("error") {
            return Err(format!("RPC error for {}: {}", &signature[..20], err));
        }
        if json["result"].is_null() {
            return Err(format!("Null result for tx {}", &signature[..20]));
        }

        let logs = json["result"]["meta"]["logMessages"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();

        // Extract blockTime (Unix timestamp from the validator)
        let block_time = json["result"]["blockTime"].as_i64().unwrap_or(0);

        let account_keys: Vec<&str> = json["result"]["transaction"]["message"]["accountKeys"]
            .as_array()
            .map(|keys| keys.iter().filter_map(|k| k.as_str()).collect())
            .unwrap_or_default();

        // Detect if this tx references the BTC light client program (real SPV-verified deposit)
        let is_verified_deposit = account_keys.iter().any(|k| *k == BTC_LIGHT_CLIENT_PROGRAM_ID);

        // Extract BTC txids from verify_stealth_deposit instruction data (disc=0x01, 81 bytes)
        let (btc_deposit_txid, btc_sweep_txid) = if is_verified_deposit {
            Self::extract_btc_txids(&json["result"]["transaction"]["message"]["instructions"], &account_keys)
                .or_else(|| {
                    // Also check inner instructions
                    json["result"]["meta"]["innerInstructions"].as_array().and_then(|inners| {
                        for inner in inners {
                            if let Some(result) = Self::extract_btc_txids(&inner["instructions"], &account_keys) {
                                return Some(result);
                            }
                        }
                        None
                    })
                })
                .unwrap_or((None, None))
        } else {
            (None, None)
        };

        // Fetch original BTC deposit amount from mempool using the sweep tx.
        // The sweep tx's input spends the deposit output, so vin[].prevout.value
        // gives us the exact deposit amount (not all P2TR outputs which includes change).
        let btc_deposit_amount_sats = if let Some(ref sweep_txid) = btc_sweep_txid {
            self.fetch_btc_deposit_amount_from_sweep(sweep_txid, btc_deposit_txid.as_deref()).await
        } else {
            None
        };

        // Extract Aegis instruction discriminator (first byte of instruction data)
        let instruction_disc = Self::extract_aegis_instruction_disc(
            &json["result"]["transaction"]["message"]["instructions"],
            &account_keys,
        );

        // Extract withdrawal amount + recipient from instruction data (disc=15 unshield, disc=16 redeem)
        let (unshield_amount, unshield_recipient) = match instruction_disc {
            Some(15) => {
                // Unshield: extract SPL token amount + Solana recipient
                Self::extract_unshield_from_ix_data(
                    &json["result"]["transaction"]["message"]["instructions"],
                    &account_keys,
                ).or_else(|| {
                    tracing::debug!(sig = &signature[..20], "Falling back to token balance extraction");
                    Self::extract_unshield_from_token_balances(&json["result"]["meta"])
                }).unwrap_or((None, None))
            }
            Some(16) => {
                // Redeem: extract BTC amount + BTC address from instruction data
                Self::extract_redeem_from_ix_data(
                    &json["result"]["transaction"]["message"]["instructions"],
                    &account_keys,
                ).unwrap_or((None, None))
            }
            _ => (None, None),
        };

        Ok(TransactionData { logs, block_time, is_verified_deposit, btc_deposit_txid, btc_sweep_txid, btc_deposit_amount_sats, instruction_disc, unshield_amount, unshield_recipient })
    }
}

impl EventIndexerService {
    /// Fetch the original BTC deposit amount using the sweep transaction.
    ///
    /// The sweep tx spends the deposit output, so we look at its inputs:
    /// - Find the vin that references the deposit_txid
    /// - Return vin.prevout.value — the exact amount deposited to the pool address
    ///
    /// This avoids the bug of summing all P2TR outputs from the deposit tx
    /// (which includes the sender's change output).
    async fn fetch_btc_deposit_amount_from_sweep(
        &self,
        sweep_txid: &str,
        deposit_txid: Option<&str>,
    ) -> Option<i64> {
        let url = format!("{}/tx/{}", MEMPOOL_API_URL, sweep_txid);
        let resp = self.http.get(&url).send().await.ok()?;
        if !resp.status().is_success() {
            tracing::debug!(txid = sweep_txid, "Mempool fetch failed for sweep tx");
            return None;
        }
        let json: serde_json::Value = resp.json().await.ok()?;
        let vins = json["vin"].as_array()?;

        // If we have the deposit txid, find the exact input that spends it
        if let Some(dep_txid) = deposit_txid {
            for vin in vins {
                if vin["txid"].as_str() == Some(dep_txid) {
                    let amount = vin["prevout"]["value"].as_i64()?;
                    tracing::debug!(sweep = sweep_txid, deposit = dep_txid, amount, "Got deposit amount from sweep vin");
                    return Some(amount);
                }
            }
        }

        // Fallback: if only one input, use its prevout value
        if vins.len() == 1 {
            let amount = vins[0]["prevout"]["value"].as_i64()?;
            tracing::debug!(sweep = sweep_txid, amount, "Got deposit amount from single sweep vin");
            return Some(amount);
        }

        None
    }

    /// Extract BTC deposit_txid and sweep_txid from verify_stealth_deposit instruction data.
    ///
    /// Instruction layout (after 1-byte discriminator 0x01):
    ///   [0..32]  sweep_txid      (internal byte order)
    ///   [32..40] block_height    (u64 LE)
    ///   [40..44] sweep_tx_size   (u32 LE)
    ///   [44..48] deposit_tx_size (u32 LE)
    ///   [48..80] deposit_txid    (internal byte order)
    fn extract_btc_txids(
        instructions: &serde_json::Value,
        account_keys: &[&str],
    ) -> Option<(Option<String>, Option<String>)> {
        let ixs = instructions.as_array()?;
        for ix in ixs {
            let program_idx = ix["programIdIndex"].as_u64()? as usize;
            if program_idx >= account_keys.len() || account_keys[program_idx] != AEGIS_PROGRAM_ID {
                continue;
            }
            let data_b58 = ix["data"].as_str()?;
            let data = bs58::decode(data_b58).into_vec().ok()?;
            // disc(1) + 80 bytes = 81 total, disc must be 0x01 (verify_stealth_deposit)
            if data.len() < 81 || data[0] != 0x01 {
                continue;
            }
            let ix_data = &data[1..];
            let sweep_txid = Self::btc_internal_to_hex(&ix_data[0..32]);
            let deposit_txid = Self::btc_internal_to_hex(&ix_data[48..80]);
            return Some((Some(deposit_txid), Some(sweep_txid)));
        }
        None
    }

    /// Extract the Aegis program instruction discriminator from transaction instructions.
    /// Returns the first byte of instruction data for the Aegis program invocation.
    fn extract_aegis_instruction_disc(
        instructions: &serde_json::Value,
        account_keys: &[&str],
    ) -> Option<u8> {
        let ixs = instructions.as_array()?;
        for ix in ixs {
            let program_idx = ix["programIdIndex"].as_u64()? as usize;
            if program_idx >= account_keys.len() || account_keys[program_idx] != AEGIS_PROGRAM_ID {
                continue;
            }
            let data_b58 = ix["data"].as_str()?;
            let data = bs58::decode(data_b58).into_vec().ok()?;
            if !data.is_empty() {
                return Some(data[0]);
            }
        }
        None
    }

    /// Extract unshield amount + recipient from instruction data (primary method).
    ///
    /// Instruction data layout after disc(1) — unshield always has inline proof:
    ///   [0]        n_inputs (u8)
    ///   [1]        n_outputs (u8)
    ///   [2..258]   proof (256 bytes, always inline)
    ///   [258..290] merkle_root (32)
    ///   [290..322] bound_params_hash (32)
    ///   [322..]    nullifiers: [u8; 32] × n_inputs
    ///   [..]       commitments_out: [u8; 32] × n_outputs
    ///   [..]       stealth_data: (ephemeral_pub(32) + encrypted_amount(8)) × (n_outputs-1)
    ///   [8 bytes]  unshield_amount (u64 LE)
    ///   [32 bytes] unshield_address (pubkey)
    fn extract_unshield_from_ix_data(
        instructions: &serde_json::Value,
        account_keys: &[&str],
    ) -> Option<(Option<i64>, Option<String>)> {
        let ixs = instructions.as_array()?;
        for ix in ixs {
            let program_idx = ix["programIdIndex"].as_u64()? as usize;
            if program_idx >= account_keys.len() || account_keys[program_idx] != AEGIS_PROGRAM_ID {
                continue;
            }
            let data_b58 = ix["data"].as_str()?;
            let data = bs58::decode(data_b58).into_vec().ok()?;
            if data.is_empty() || data[0] != 15 {
                continue;
            }
            let ix_data = &data[1..]; // skip disc byte
            if ix_data.len() < 3 {
                continue;
            }
            let n_inputs = ix_data[0] as usize;
            let n_outputs = ix_data[1] as usize;
            if n_outputs == 0 {
                continue;
            }
            let n_tree_outputs = n_outputs - 1;

            // Unshield (disc=15) always uses inline proof, no proof_source field
            // Header: n_inputs(1) + n_outputs(1) + proof(256) + root(32) + bph(32) = 322
            let stealth_end = 322
                + (n_inputs * 32)       // nullifiers
                + (n_outputs * 32)      // commitments_out
                + (n_tree_outputs * 40); // stealth_data

            let needed = stealth_end + 8 + 32; // amount(8) + address(32)
            if ix_data.len() < needed {
                tracing::debug!(
                    ix_len = ix_data.len(), needed, n_inputs, n_outputs,
                    "Unshield ix data too short"
                );
                continue;
            }

            let amount_bytes: [u8; 8] = ix_data[stealth_end..stealth_end + 8].try_into().ok()?;
            let amount = u64::from_le_bytes(amount_bytes) as i64;

            let address_bytes = &ix_data[stealth_end + 8..stealth_end + 40];
            let recipient = bs58::encode(address_bytes).into_string();

            tracing::debug!(amount, recipient = %recipient, "Extracted unshield from instruction data");
            return Some((Some(amount), Some(recipient)));
        }
        None
    }

    /// Extract redeem amount + BTC address from instruction data (disc=16).
    ///
    /// Layout after disc(1): same as unshield but ends with:
    ///   [8 bytes]            redeem_amount (u64 LE)
    ///   [1 byte]             btc_script_len
    ///   [btc_script_len]     btc_script (raw scriptPubKey)
    ///   [8 bytes]            request_nonce (u64 LE)
    fn extract_redeem_from_ix_data(
        instructions: &serde_json::Value,
        account_keys: &[&str],
    ) -> Option<(Option<i64>, Option<String>)> {
        let ixs = instructions.as_array()?;
        for ix in ixs {
            let program_idx = ix["programIdIndex"].as_u64()? as usize;
            if program_idx >= account_keys.len() || account_keys[program_idx] != AEGIS_PROGRAM_ID {
                continue;
            }
            let data_b58 = ix["data"].as_str()?;
            let data = bs58::decode(data_b58).into_vec().ok()?;
            if data.is_empty() || data[0] != 16 {
                continue;
            }
            let ix_data = &data[1..];
            if ix_data.len() < 3 {
                continue;
            }
            let n_inputs = ix_data[0] as usize;
            let n_outputs = ix_data[1] as usize;
            let proof_source = ix_data[2];
            if n_outputs == 0 {
                continue;
            }
            let n_tree_outputs = n_outputs - 1;

            // Header size depends on proof_source:
            // 3 (n_inputs + n_outputs + proof_source) + proof(256 if inline, 0 if buffer) + root(32) + bph(32)
            let proof_data_size = if proof_source == 0 { 256 } else { 0 };
            let header_size = 3 + proof_data_size + 32 + 32;

            let stealth_end = header_size
                + (n_inputs * 32)
                + (n_outputs * 32)
                + (n_tree_outputs * 40);

            // redeem_amount(8) + btc_script_len(1) + at least 1 byte script
            if ix_data.len() < stealth_end + 10 {
                tracing::debug!(ix_len = ix_data.len(), needed = stealth_end + 10, proof_source, "Redeem ix data too short");
                continue;
            }

            let amount_bytes: [u8; 8] = ix_data[stealth_end..stealth_end + 8].try_into().ok()?;
            let amount = u64::from_le_bytes(amount_bytes) as i64;

            let script_len = ix_data[stealth_end + 8] as usize;
            if ix_data.len() < stealth_end + 9 + script_len {
                continue;
            }
            let btc_script = &ix_data[stealth_end + 9..stealth_end + 9 + script_len];

            // Convert scriptPubKey to testnet4 bech32m address
            let btc_address = Self::script_to_testnet_address(btc_script)
                .unwrap_or_else(|| hex::encode(btc_script));

            tracing::debug!(amount, btc_address = %btc_address, "Extracted redeem from instruction data");
            return Some((Some(amount), Some(btc_address)));
        }
        None
    }

    /// Convert a scriptPubKey to a testnet bech32m address.
    /// Handles P2TR (OP_1 + PUSH32 + 32 bytes) and P2WPKH/P2WSH.
    fn script_to_testnet_address(script: &[u8]) -> Option<String> {
        if script.len() < 4 { return None; }
        let version = if script[0] == 0x00 { 0u8 } else if script[0] >= 0x51 && script[0] <= 0x60 { script[0] - 0x50 } else { return None };
        let prog_len = script[1] as usize;
        if script.len() < 2 + prog_len { return None; }
        let program = &script[2..2 + prog_len];

        // Convert to 5-bit groups
        let mut data5 = vec![version];
        let mut acc: u32 = 0;
        let mut bits = 0u32;
        for &b in program {
            acc = (acc << 8) | b as u32;
            bits += 8;
            while bits >= 5 {
                bits -= 5;
                data5.push(((acc >> bits) & 31) as u8);
            }
        }
        if bits > 0 {
            data5.push(((acc << (5 - bits)) & 31) as u8);
        }

        let hrp = "tb";
        let use_bech32m = version > 0;
        let gen: [u32; 5] = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
        let charset = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";

        let hrp_expand: Vec<u8> = hrp.bytes().map(|c| c >> 5).chain(std::iter::once(0)).chain(hrp.bytes().map(|c| c & 31)).collect();
        let values: Vec<u8> = hrp_expand.iter().chain(data5.iter()).chain(&[0, 0, 0, 0, 0, 0]).copied().collect();
        let check_const: u32 = if use_bech32m { 0x2bc830a3 } else { 1 };

        let mut chk: u32 = 1;
        for &v in &values {
            let b = chk >> 25;
            chk = ((chk & 0x1ffffff) << 5) ^ v as u32;
            for i in 0..5 {
                if (b >> i) & 1 != 0 { chk ^= gen[i]; }
            }
        }
        let pm = chk ^ check_const;
        let checksum: Vec<u8> = (0..6).map(|i| ((pm >> (5 * (5 - i))) & 31) as u8).collect();

        let encoded: String = data5.iter().chain(checksum.iter())
            .map(|&v| charset[v as usize] as char)
            .collect();
        Some(format!("{}1{}", hrp, encoded))
    }

    /// Fallback: extract unshield details from pre/post token balance delta.
    fn extract_unshield_from_token_balances(
        meta: &serde_json::Value,
    ) -> Option<(Option<i64>, Option<String>)> {
        const ZKBTC_MINT: &str = "GvFAyHsbWDbwvHxecaFnnGrhM1MR72E3cSX78qQbAyC7";
        const POOL_STATE: &str = "4654vJpq3E3A6nwtUwNWeJuTkHDcqT761uoBX7AHjm5x";

        let post_balances = meta.get("postTokenBalances").and_then(|b| b.as_array())?;
        let pre_balances = meta.get("preTokenBalances").and_then(|b| b.as_array());

        for post in post_balances {
            let mint = post.get("mint").and_then(|m| m.as_str()).unwrap_or("");
            if mint != ZKBTC_MINT {
                continue;
            }
            let owner = post.get("owner").and_then(|o| o.as_str()).unwrap_or("");
            if owner == POOL_STATE || owner.is_empty() {
                continue;
            }

            let post_amount_str = post
                .pointer("/uiTokenAmount/amount")
                .and_then(|a| a.as_str())
                .unwrap_or("0");
            let post_amount: i64 = post_amount_str.parse().unwrap_or(0);

            let account_index = post.get("accountIndex").and_then(|i| i.as_u64());
            let pre_amount: i64 = pre_balances
                .and_then(|pbs| {
                    pbs.iter().find(|pb| {
                        pb.get("accountIndex").and_then(|i| i.as_u64()) == account_index
                            && pb.get("mint").and_then(|m| m.as_str()) == Some(ZKBTC_MINT)
                    })
                })
                .and_then(|pb| pb.pointer("/uiTokenAmount/amount").and_then(|a| a.as_str()))
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);

            let delta = post_amount - pre_amount;
            if delta > 0 {
                tracing::debug!(recipient = owner, amount = delta, "Extracted unshield from token balances (fallback)");
                return Some((Some(delta), Some(owner.to_string())));
            }
        }
        None
    }

    /// Convert BTC internal byte order (little-endian txid) to display hex (big-endian).
    fn btc_internal_to_hex(bytes: &[u8]) -> String {
        let mut reversed = bytes.to_vec();
        reversed.reverse();
        hex::encode(reversed)
    }
}

#[derive(Debug)]
struct SignatureInfo {
    signature: String,
    slot: i64,
}
