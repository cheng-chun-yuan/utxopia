//! Event indexer service
//!
//! Polls Solana for new transactions targeting the UTXOpia program,
//! parses sol_log_data events from transaction logs, and stores them in SQLite.
//!
//! Event discriminators parsed:
//! - 0x01 LeafInserted — new commitment added to merkle tree
//! - 0x02 NullifierSpent — note consumed (nullifier published)
//! - 0x03 StealthAnnouncement — deposit/transfer stealth data (ephemeral pub + encrypted amount)
//! - 0x07 RedemptionCompleted — BTC withdrawal finalized on-chain
//! - 0x08 RedemptionStatusChanged — withdrawal status update
//!
//! Also supports real-time indexing via Solana logsSubscribe WebSocket (solana_ws module).

use std::sync::Arc;
use tokio::time::{interval, Duration};

use super::parser::{
    parse_program_events, NullifierSpentEvent, ProgramEvent, RedemptionCompletedEvent,
    RedemptionRequestedEvent, StealthAnnouncementEvent, UnshieldMetaEvent,
};
use super::storage::EventStore;
use super::tree_cache::TreeCache;

/// BTC Light Client program ID — used to detect real vs demo deposits.
/// Transactions that reference this account are SPV-verified BTC deposits.
/// Configuration for the event indexer
#[derive(Debug, Clone)]
pub struct EventIndexerConfig {
    /// Solana RPC URL
    pub rpc_url: String,
    /// UTXOpia program ID (base58)
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

// UTXOpia program ID is read from config.program_id (set via UTXOPIA_PROGRAM_ID env var)

/// Data extracted from a getTransaction RPC response
struct TransactionData {
    logs: Vec<String>,
    block_time: i64,
    /// Whether the tx references the BTC light client program (SPV-verified deposit)

    /// BTC deposit txid (extracted from verify_stealth_deposit instruction data)
    btc_deposit_txid: Option<String>,
    /// BTC sweep txid (extracted from verify_stealth_deposit instruction data)
    btc_sweep_txid: Option<String>,
    /// Original BTC deposit amount in sats (fetched from mempool)
    btc_deposit_amount_sats: Option<i64>,
    /// UTXOpia instruction discriminator (first byte of instruction data)
    instruction_disc: Option<u8>,
}

/// Mempool/Esplora API base URL — configurable via MEMPOOL_API_URL env var
fn mempool_api_url() -> String {
    std::env::var("MEMPOOL_API_URL").unwrap_or_else(|_| "https://mempool.space/testnet4/api".to_string())
}

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
            if let Some(last) = signatures.last() {
                before = Some(last.signature.clone());
            }

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
        let poll_start = std::time::Instant::now();
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

        tracing::info!(
            operation = "event_indexer_poll",
            events_processed = new_sigs.len(),
            duration_ms = poll_start.elapsed().as_millis() as u64,
            "indexer poll cycle completed"
        );
        Ok(())
    }

    /// Classify a transaction's transfer type from its parsed events.
    ///
    /// Returns `(unshield_amount, unshield_recipient, transfer_type)` where
    /// `transfer_type` is one of: "unshield", "redeem", "deposit", "private_transfer".
    fn classify_transfer(
        unshield_metas: &[UnshieldMetaEvent],
        redemption_requests: &[RedemptionRequestedEvent],
        redemption_completions: &[RedemptionCompletedEvent],
        nullifier_disc: Option<u8>,
        nullifiers: &[NullifierSpentEvent],
        announcements: &[StealthAnnouncementEvent],
    ) -> (Option<i64>, Option<String>, &'static str) {
        // For multi-output: return first meta as tx-level summary; per-nullifier data handled in caller
        if let Some(um) = unshield_metas.first() {
            let recipient = bs58::encode(&um.recipient).into_string();
            let total_amount: u64 = unshield_metas.iter().map(|m| m.amount).sum();
            tracing::debug!(total_amount, outputs = unshield_metas.len(), recipient = %recipient, "Using event-sourced unshield data");
            return (Some(total_amount as i64), Some(recipient), "unshield");
        }

        if !redemption_requests.is_empty() {
            let rr = &redemption_requests[0];
            let btc_addr = Self::script_to_testnet_address(&rr.btc_script)
                .unwrap_or_else(|| hex::encode(&rr.btc_script));
            tracing::debug!(amount = rr.amount_sats, btc_addr = %btc_addr, "Using event-sourced redemption data");
            return (Some(rr.amount_sats as i64), Some(btc_addr), "redeem");
        }

        if !redemption_completions.is_empty() {
            return (None, None, "redeem");
        }

        if matches!(nullifier_disc, Some(5) | Some(16)) {
            // NullifierSpent with ix_disc=5 (request_redemption) or 16 (legacy redeem)
            // No structured RedemptionRequested event — classify from nullifier disc
            tracing::debug!(disc = ?nullifier_disc, "Classified as redeem from nullifier instruction_disc");
            return (None, None, "redeem");
        }

        if !nullifiers.is_empty() {
            let op = nullifiers[0].operation_type;
            if op == 0 {
                // FullWithdrawal without UnshieldMeta → unshield (disc=30/15)
                return (None, None, "unshield");
            }
            return (None, None, "private_transfer");
        }

        if !announcements.is_empty() && announcements[0].announcement_type == 0 {
            return (None, None, "deposit");
        }

        (None, None, "private_transfer")
    }

    /// Process a single transaction: fetch logs + blockTime, parse events, store.
    ///
    /// Leaf data is derived from StealthAnnouncement events (which carry
    /// commitment + leaf_index). LeafInserted is no longer emitted on-chain.
    async fn process_transaction(&mut self, signature: &str, slot: i64) -> Result<(), String> {
        let tx_data = self.get_transaction_data(signature).await?;
        let events = parse_program_events(&tx_data.logs);
        if events.is_empty() {
            return Ok(());
        }

        tracing::debug!(signature = &signature[..20], count = events.len(), block_time = tx_data.block_time, "Parsed events");

        let block_time = tx_data.block_time;
        // Determine is_verified from instruction discriminator or DepositVerified event:
        //   disc 11 (verify_stealth_deposit) or 25 (verify_deposit_v2) = real SPV deposit
        //   Also: DepositVerified event presence is authoritative (event-first)
        let has_deposit_verified = events.iter().any(|e| matches!(e, ProgramEvent::DepositVerified(_)));
        let is_verified = has_deposit_verified || matches!(tx_data.instruction_disc, Some(11) | Some(25));

        // Separate events by type
        let mut announcements = Vec::new();
        let mut nullifiers = Vec::new();
        let mut redemption_completions = Vec::new();
        let mut redemption_requests = Vec::new();
        let mut deposit_verified: Option<super::parser::DepositVerifiedEvent> = None;
        let mut unshield_metas: Vec<UnshieldMetaEvent> = Vec::new();
        let mut shield_meta: Option<super::parser::ShieldMetaEvent> = None;

        for event in events {
            match event {
                ProgramEvent::StealthAnnouncement(e) => announcements.push(e),
                ProgramEvent::NullifierSpent(e) => nullifiers.push(e),
                ProgramEvent::RedemptionCompleted(e) => redemption_completions.push(e),
                ProgramEvent::RedemptionRequested(e) => redemption_requests.push(e),
                ProgramEvent::RedemptionProcessing(e) => {
                    let inserted = self.store.insert_redemption_processing(&e, signature, slot, block_time)
                        .unwrap_or(false);
                    tracing::info!(
                        request_id = e.request_id,
                        amount_sats = e.amount_sats,
                        processing_slot = e.processing_slot,
                        inserted,
                        "Indexed redemption processing"
                    );
                }
                ProgramEvent::DepositVerified(e) => {
                    deposit_verified = Some(e);
                }
                ProgramEvent::UnshieldMeta(e) => {
                    unshield_metas.push(e);
                }
                ProgramEvent::ShieldMeta(e) => {
                    shield_meta = Some(e);
                }
                ProgramEvent::UtxoCreated(e) => {
                    let txid_hex = Self::btc_internal_to_hex(&e.txid);
                    tracing::info!(txid = %txid_hex, vout = e.vout, amount = e.amount_sats, "UTXO created");
                }
                ProgramEvent::UtxoConsumed(e) => {
                    let txid_hex = Self::btc_internal_to_hex(&e.txid);
                    tracing::info!(txid = %txid_hex, vout = e.vout, amount = e.amount_sats, "UTXO consumed");
                }
            }
        }

        // Prefer event-sourced BTC txids (from DepositVerified event) over instruction data extraction
        // For btc_deposit_amount_sats (original deposit amount):
        //   1. DepositVerified.original_amount (on-chain, extracted from deposit TX)
        //   2. Mempool fetch via sweep tx input (tx_data.btc_deposit_amount_sats)
        //   3. DepositVerified.amount_sats (sweep output, last resort)
        let (btc_deposit_txid, btc_sweep_txid, btc_deposit_amount_sats) = if let Some(ref dv) = deposit_verified {
            let dep_txid = Self::btc_internal_to_hex(&dv.deposit_txid);
            let sweep_txid = Self::btc_internal_to_hex(&dv.sweep_txid);
            let original = if dv.original_amount > 0 {
                Some(dv.original_amount as i64)
            } else {
                tx_data.btc_deposit_amount_sats.or(Some(dv.amount_sats as i64))
            };
            tracing::debug!(deposit = %dep_txid, sweep = %sweep_txid, sweep_amount = dv.amount_sats, original = ?original, "Using event-sourced deposit data");
            (Some(dep_txid), Some(sweep_txid), original)
        } else {
            (tx_data.btc_deposit_txid, tx_data.btc_sweep_txid, tx_data.btc_deposit_amount_sats)
        };

        // Event-first classification: derive transfer_type from events.
        // For multi-output unshield/redeem, per-nullifier data is matched by index below.
        let nullifier_disc = nullifiers.first().map(|n| n.instruction_disc).or(tx_data.instruction_disc);
        let unshield_token_id: Option<String> = unshield_metas.first().map(|um| hex::encode(um.token_id));

        let (unshield_amount, unshield_recipient, transfer_type) = Self::classify_transfer(
            &unshield_metas,
            &redemption_requests,
            &redemption_completions,
            nullifier_disc,
            &nullifiers,
            &announcements,
        );

        // Process announcements — leaf data derived from announcement (commitment + leaf_index)
        for ann in &announcements {
            let leaf_index = ann.leaf_index as i64;

            let inserted = self.store.insert_leaf_from_announcement(leaf_index, &ann.commitment, signature, slot, block_time)?;
            if inserted {
                if let Some(ref cache) = self.tree_cache {
                    cache.on_leaf_inserted(leaf_index as u64, ann.commitment).await;
                }
            }
            tracing::debug!(leaf_index, inserted, "Indexed leaf");

            // Insert announcement (with is_verified flag + BTC txids + deposit amount for real deposits)
            let inserted = self.store.insert_announcement(&super::storage::InsertAnnouncementParams {
                event: ann,
                tx_signature: signature,
                slot,
                block_time,
                is_verified,
                btc_deposit_txid: btc_deposit_txid.as_deref(),
                btc_sweep_txid: btc_sweep_txid.as_deref(),
                btc_deposit_amount_sats,
                deposit_gross_amount: shield_meta.as_ref().map(|sm| sm.gross_amount as i64),
                deposit_fee: shield_meta.as_ref().map(|sm| sm.fee as i64),
            })?;
            if inserted {
                if let Some(ref cache) = self.tree_cache {
                    cache.broadcast_announcement(ann);
                }
            }
            tracing::debug!(leaf_index = ann.leaf_index, is_verified, "Indexed stealth announcement");
        }

        // Build per-output JSON array from all UnshieldMeta events
        let outputs_json = if !unshield_metas.is_empty() {
            let arr: Vec<serde_json::Value> = unshield_metas.iter().map(|um| {
                serde_json::json!({
                    "type": if !redemption_requests.is_empty() { "withdraw" } else { "unshield" },
                    "amount": um.amount,
                    "fee": um.fee,
                    "payout": um.payout,
                    "recipient": bs58::encode(&um.recipient).into_string(),
                })
            }).collect();
            Some(serde_json::to_string(&arr).unwrap_or_default())
        } else {
            None
        };

        // Handle nullifiers — match each nullifier to its UnshieldMeta by index for multi-output support.
        for (null_idx, null) in nullifiers.iter().enumerate() {
            let disc = if null.instruction_disc > 0 {
                Some(null.instruction_disc)
            } else {
                tx_data.instruction_disc
            };
            // Per-nullifier unshield data: match by index, fall back to tx-level classify_transfer result
            let (null_amount, null_recipient, null_fee, null_payout) = if let Some(um) = unshield_metas.get(null_idx) {
                (
                    Some(um.amount as i64),
                    Some(bs58::encode(&um.recipient).into_string()),
                    Some(um.fee as i64),
                    Some(um.payout as i64),
                )
            } else {
                (unshield_amount, unshield_recipient.clone(), None, None)
            };
            let output_count = if !unshield_metas.is_empty() {
                Some(unshield_metas.len() as i64)
            } else {
                None
            };
            let inserted = self.store.insert_nullifier(&super::storage::InsertNullifierParams {
                event: null,
                tx_signature: signature,
                slot,
                block_time,
                instruction_disc: disc,
                unshield_amount: null_amount,
                unshield_recipient: null_recipient.as_deref(),
                transfer_type: Some(transfer_type),
                token_id: unshield_token_id.as_deref(),
                unshield_fee: null_fee,
                unshield_payout: null_payout,
                unshield_output_count: output_count,
                unshield_outputs_json: outputs_json.as_deref(),
            })?;
            if inserted {
                if let Some(ref cache) = self.tree_cache {
                    cache.broadcast_nullifier(&hex::encode(null.nullifier_hash), slot);
                }
            }
            tracing::debug!(nullifier = hex::encode(&null.nullifier_hash[..8]), disc = ?disc, "Indexed nullifier");
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
        // If blockTime is null (can happen on some RPC providers), fetch via getBlockTime
        let block_time = match json["result"]["blockTime"].as_i64() {
            Some(bt) if bt > 0 => bt,
            _ => {
                let slot = json["result"]["slot"].as_i64().unwrap_or(0);
                if slot > 0 {
                    match self.get_block_time(slot).await {
                        Ok(bt) if bt > 0 => bt,
                        _ => {
                            tracing::warn!(signature = &signature[..20], slot, "blockTime unavailable, using current time");
                            std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_secs() as i64)
                                .unwrap_or(0)
                        }
                    }
                } else {
                    tracing::warn!(signature = &signature[..20], "No blockTime or slot available");
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0)
                }
            }
        };

        // Collect all account keys: static keys + loaded addresses (v0 address lookup tables)
        let mut account_keys_owned: Vec<String> = json["result"]["transaction"]["message"]["accountKeys"]
            .as_array()
            .map(|keys| keys.iter().filter_map(|k| k.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default();
        // V0 transactions may have additional keys from address lookup tables
        if let Some(loaded) = json["result"]["meta"]["loadedAddresses"].as_object() {
            for field in &["writable", "readonly"] {
                if let Some(arr) = loaded.get(*field).and_then(|v| v.as_array()) {
                    for k in arr {
                        if let Some(s) = k.as_str() {
                            account_keys_owned.push(s.to_string());
                        }
                    }
                }
            }
        }
        let account_keys: Vec<&str> = account_keys_owned.iter().map(|s| s.as_str()).collect();

        // Extract BTC txids from verify_stealth_deposit instruction data (disc=0x01, 81 bytes)
        let (btc_deposit_txid, btc_sweep_txid) = Self::extract_btc_txids(&json["result"]["transaction"]["message"]["instructions"], &account_keys, &self.config.program_id)
            .or_else(|| {
                // Also check inner instructions
                json["result"]["meta"]["innerInstructions"].as_array().and_then(|inners| {
                    for inner in inners {
                        if let Some(result) = Self::extract_btc_txids(&inner["instructions"], &account_keys, &self.config.program_id) {
                            return Some(result);
                        }
                    }
                    None
                })
            })
            .unwrap_or((None, None));

        // Fetch original BTC deposit amount from mempool using the sweep tx.
        // The sweep tx's input spends the deposit output, so vin[].prevout.value
        // gives us the exact deposit amount (not all P2TR outputs which includes change).
        let btc_deposit_amount_sats = if let Some(ref sweep_txid) = btc_sweep_txid {
            self.fetch_btc_deposit_amount_from_sweep(sweep_txid, btc_deposit_txid.as_deref()).await
        } else {
            None
        };

        // Extract UTXOpia instruction discriminator (first byte of instruction data)
        let instruction_disc = Self::extract_utxopia_instruction_disc(
            &json["result"]["transaction"]["message"]["instructions"],
            &account_keys,
            &self.config.program_id,
        );

        // Event-first: unshield/redeem data comes from on-chain events (UnshieldMeta, RedemptionRequested),
        // NOT from parsing raw instruction bytes. This avoids garbage values from layout mismatches.
        // instruction_disc is still extracted for metadata, but never used for amount/recipient extraction.

        Ok(TransactionData { logs, block_time, btc_deposit_txid, btc_sweep_txid, btc_deposit_amount_sats, instruction_disc })
    }
}

impl EventIndexerService {
    /// Fetch blockTime for a given slot via getBlockTime RPC.
    async fn get_block_time(&self, slot: i64) -> Result<i64, String> {
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getBlockTime",
            "params": [slot],
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

        json["result"]
            .as_i64()
            .ok_or_else(|| format!("getBlockTime returned null for slot {}", slot))
    }

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
        let url = format!("{}/tx/{}", mempool_api_url(), sweep_txid);
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
        program_id: &str,
    ) -> Option<(Option<String>, Option<String>)> {
        let ixs = instructions.as_array()?;
        for ix in ixs {
            let program_idx = ix["programIdIndex"].as_u64()? as usize;
            if program_idx >= account_keys.len() || account_keys[program_idx] != program_id {
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

    /// Extract the UTXOpia program instruction discriminator from transaction instructions.
    /// Returns the first byte of instruction data for the UTXOpia program invocation.
    fn extract_utxopia_instruction_disc(
        instructions: &serde_json::Value,
        account_keys: &[&str],
        program_id: &str,
    ) -> Option<u8> {
        let ixs = instructions.as_array()?;
        for ix in ixs {
            let program_idx = ix["programIdIndex"].as_u64()? as usize;
            if program_idx >= account_keys.len() || account_keys[program_idx] != program_id {
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

    // extract_unshield_from_ix_data: REMOVED — replaced by UnshieldMeta on-chain event (0x0E)
    // extract_redeem_from_ix_data: REMOVED — replaced by RedemptionRequested on-chain event (0x08)

    /// Convert a scriptPubKey to a bech32/bech32m address.
    /// Handles P2TR (OP_1 + PUSH32 + 32 bytes) and P2WPKH/P2WSH.
    /// Uses UTXOPIA_NETWORK env var to determine HRP (tb for testnet, bcrt for regtest, bc for mainnet).
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

        let hrp = match std::env::var("UTXOPIA_NETWORK").unwrap_or_default().as_str() {
            "mainnet" | "main" => "bc",
            "regtest" | "localnet" | "local" => "bcrt",
            _ => "tb",
        };
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
            for (i, &g) in gen.iter().enumerate() {
                if (b >> i) & 1 != 0 { chk ^= g; }
            }
        }
        let pm = chk ^ check_const;
        let checksum: Vec<u8> = (0..6).map(|i| ((pm >> (5 * (5 - i))) & 31) as u8).collect();

        let encoded: String = data5.iter().chain(checksum.iter())
            .map(|&v| charset[v as usize] as char)
            .collect();
        Some(format!("{}1{}", hrp, encoded))
    }

    // extract_unshield_from_token_balances: REMOVED — replaced by UnshieldMeta on-chain event (0x0E)

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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_event_indexer_config() {
        let config = EventIndexerConfig {
            rpc_url: "http://localhost:8899".to_string(),
            program_id: "7JJeVjVCy1fZqCDWvf41R7LuTWirTjX7Tp6suC2WVUMQ".to_string(),
            poll_interval_secs: 10,
        };
        assert_eq!(config.poll_interval_secs, 10);
    }

    #[test]
    fn test_event_indexer_creation() {
        let db_path = format!("/tmp/test_indexer_create_{}.db", std::process::id());
        let store = Arc::new(EventStore::new(&db_path).unwrap());
        let config = EventIndexerConfig {
            rpc_url: "http://localhost:8899".to_string(),
            program_id: "7JJeVjVCy1fZqCDWvf41R7LuTWirTjX7Tp6suC2WVUMQ".to_string(),
            poll_interval_secs: 5,
        };
        let service = EventIndexerService::new(config, store.clone());
        assert!(service.is_ok());
    }

    #[test]
    fn test_event_indexer_with_tree_cache() {
        let db_path = format!("/tmp/test_indexer_cache_{}.db", std::process::id());
        let store = Arc::new(EventStore::new(&db_path).unwrap());
        let tree_cache = Arc::new(TreeCache::new(store.clone()).unwrap());
        let config = EventIndexerConfig {
            rpc_url: "http://localhost:8899".to_string(),
            program_id: "test_program".to_string(),
            poll_interval_secs: 5,
        };
        let service = EventIndexerService::new(config, store)
            .unwrap()
            .with_tree_cache(tree_cache);
        assert!(service.tree_cache.is_some());
    }

    #[test]
    fn test_btc_internal_to_hex() {
        // btc_internal_to_hex reverses byte order
        let bytes = vec![0xab, 0xcd, 0xef, 0x01];
        let result = EventIndexerService::btc_internal_to_hex(&bytes);
        assert_eq!(result, "01efcdab");
    }

    #[test]
    fn test_btc_internal_to_hex_roundtrip() {
        let bytes = [1u8, 2, 3, 4];
        let hex = EventIndexerService::btc_internal_to_hex(&bytes);
        assert_eq!(hex, "04030201");
    }
}
