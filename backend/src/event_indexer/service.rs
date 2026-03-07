//! Event indexer service
//!
//! Polls Solana for new transactions, parses events from logs,
//! and stores them in SQLite.

use std::sync::Arc;
use tokio::time::{interval, Duration};

use super::parser::{parse_program_events, ProgramEvent};
use super::storage::EventStore;
use super::tree_cache::TreeCache;

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
    /// Running leaf counter (tracks insertion order)
    next_leaf_index: i64,
    /// Optional tree cache for in-memory Merkle tree updates
    tree_cache: Option<Arc<TreeCache>>,
}

impl EventIndexerService {
    pub fn new(config: EventIndexerConfig, store: Arc<EventStore>) -> Result<Self, String> {
        let next_leaf_index = store.get_next_leaf_index()?;

        Ok(Self {
            config,
            store,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|e| format!("http client error: {}", e))?,
            next_leaf_index,
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
            next_leaf_index = self.next_leaf_index,
            "Starting event indexer"
        );

        // Initial backfill
        if let Err(e) = self.backfill().await {
            tracing::error!(error = %e, "Backfill failed");
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
        tracing::info!("Starting backfill from last known signature");

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

                if let Err(e) = self.process_transaction(sig, slot).await {
                    tracing::warn!(signature = %sig, error = %e, "Failed to process tx");
                }
                total_processed += 1;
            }

            // Track pagination
            before = Some(signatures.last().unwrap().signature.clone());

            // Save checkpoint
            if let Some(first) = signatures.first() {
                self.store.set_last_signature(&first.signature)?;
            }
        }

        tracing::info!(total = total_processed, "Backfill complete");
        Ok(())
    }

    /// Poll for new transactions since the last known signature
    async fn poll_new_transactions(&mut self) -> Result<(), String> {
        let last_sig = self.store.get_last_signature()?;

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

    /// Process a single transaction: fetch logs, parse events, store
    async fn process_transaction(&mut self, signature: &str, slot: i64) -> Result<(), String> {
        let logs = self.get_transaction_logs(signature).await?;
        let events = parse_program_events(&logs);

        for event in events {
            match event {
                ProgramEvent::LeafInserted(e) => {
                    let leaf_index = self.next_leaf_index;
                    let inserted = self.store.insert_leaf(leaf_index, &e, signature, slot)?;
                    self.next_leaf_index += 1;

                    // Update in-memory tree cache
                    if inserted {
                        if let Some(ref cache) = self.tree_cache {
                            cache.on_leaf_inserted(leaf_index as u64, e.commitment).await;
                        }
                    }

                    tracing::debug!(leaf_index, "Indexed leaf");
                }
                ProgramEvent::NullifierSpent(e) => {
                    self.store.insert_nullifier(&e, signature, slot)?;
                    tracing::debug!(
                        nullifier = hex::encode(&e.nullifier_hash[..8]),
                        "Indexed nullifier"
                    );
                }
                ProgramEvent::StealthAnnouncement(e) => {
                    let inserted = self.store.insert_announcement(&e, signature, slot)?;
                    if inserted {
                        if let Some(ref cache) = self.tree_cache {
                            cache.broadcast_announcement(&e);
                        }
                    }
                    tracing::debug!(leaf_index = e.leaf_index, "Indexed stealth announcement");
                }
            }
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

    async fn get_transaction_logs(&self, signature: &str) -> Result<Vec<String>, String> {
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

        let logs = json["result"]["meta"]["logMessages"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();

        Ok(logs)
    }
}

#[derive(Debug)]
struct SignatureInfo {
    signature: String,
    slot: i64,
}
