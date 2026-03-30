//! Solana logsSubscribe WebSocket client for real-time event detection.
//!
//! Subscribes to program log events via Solana's WebSocket RPC,
//! parses disc=0x01/0x02/0x03 events, stores in SQLite, and
//! broadcasts via TreeCache channels.
//!
//! The existing poll loop in service.rs acts as catch-up for any
//! events missed during WS reconnections.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use super::parser::{parse_program_events, ProgramEvent};
use super::storage::EventStore;
use super::tree_cache::TreeCache;

/// Configuration for the Solana WebSocket subscriber
pub struct SolanaWsConfig {
    /// Solana WebSocket RPC URL (e.g. wss://api.devnet.solana.com)
    pub ws_url: String,
    /// Aegis program ID (base58)
    pub program_id: String,
}

/// Solana logsSubscribe WebSocket client
pub struct SolanaWsSubscriber {
    config: SolanaWsConfig,
    store: Arc<EventStore>,
    tree_cache: Arc<TreeCache>,
}

impl SolanaWsSubscriber {
    pub fn new(
        config: SolanaWsConfig,
        store: Arc<EventStore>,
        tree_cache: Arc<TreeCache>,
    ) -> Self {
        Self {
            config,
            store,
            tree_cache,
        }
    }

    /// Run the subscriber loop with automatic reconnection
    pub async fn run(&self) {
        crate::common::reconnect::reconnect_loop(
            "solana-ws",
            Duration::from_secs(1),
            Duration::from_secs(60),
            || async { self.connect_and_listen().await },
        )
        .await;
    }

    /// Connect to Solana WS and process log notifications
    async fn connect_and_listen(&self) -> Result<(), String> {
        let (ws_stream, _) = connect_async(&self.config.ws_url)
            .await
            .map_err(|e| format!("WS connect error: {}", e))?;

        let (mut write, mut read) = ws_stream.split();

        // Send logsSubscribe request
        let subscribe_msg = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "logsSubscribe",
            "params": [
                { "mentions": [&self.config.program_id] },
                { "commitment": "confirmed" }
            ]
        });

        write
            .send(Message::Text(subscribe_msg.to_string()))
            .await
            .map_err(|e| format!("WS send error: {}", e))?;

        tracing::info!("Solana logsSubscribe active");

        // Process incoming messages
        while let Some(msg) = read.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    self.handle_message(&text);
                }
                Ok(Message::Ping(data)) => {
                    let _ = write.send(Message::Pong(data)).await;
                }
                Ok(Message::Close(_)) => {
                    tracing::info!("Solana WS server sent close");
                    break;
                }
                Err(e) => {
                    return Err(format!("WS read error: {}", e));
                }
                _ => {}
            }
        }

        Ok(())
    }

    /// Handle a single WS message (logsNotification)
    fn handle_message(&self, text: &str) {
        let json: serde_json::Value = match serde_json::from_str(text) {
            Ok(v) => v,
            Err(_) => return,
        };

        // Skip subscription confirmation
        if json.get("result").is_some() && json.get("id").is_some() {
            tracing::debug!("Solana WS subscription confirmed");
            return;
        }

        // Parse logsNotification
        let method = json.get("method").and_then(|m| m.as_str());
        if method != Some("logsNotification") {
            return;
        }

        let value = match json
            .pointer("/params/result/value")
        {
            Some(v) => v,
            None => return,
        };

        // Extract logs array
        let logs: Vec<String> = match value.get("logs").and_then(|l| l.as_array()) {
            Some(arr) => arr
                .iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect(),
            None => return,
        };

        // Extract signature for dedup/storage
        let signature = value
            .get("signature")
            .and_then(|s| s.as_str())
            .unwrap_or("unknown");

        // Extract slot
        let slot = json
            .pointer("/params/result/context/slot")
            .and_then(|s| s.as_i64())
            .unwrap_or(0);

        // Parse events
        let events = parse_program_events(&logs);
        if events.is_empty() {
            return;
        }

        tracing::debug!(
            signature,
            event_count = events.len(),
            "Processing real-time events"
        );

        // Separate events by type
        let mut announcements = Vec::new();
        let mut nullifiers = Vec::new();

        for event in events {
            match event {
                ProgramEvent::StealthAnnouncement(e) => announcements.push(e),
                ProgramEvent::NullifierSpent(e) => nullifiers.push(e),
                ProgramEvent::RedemptionCompleted(_) => {} // handled by poll indexer
                ProgramEvent::RedemptionRequested(_) => {} // handled by poll indexer
                ProgramEvent::RedemptionProcessing(_) => {} // handled by poll indexer
                ProgramEvent::DepositVerified(_) => {} // handled by poll indexer
                ProgramEvent::UnshieldMeta(_) => {} // handled by poll indexer
                ProgramEvent::UtxoCreated(_) => {} // handled by poll indexer
                ProgramEvent::UtxoConsumed(_) => {} // handled by poll indexer
                ProgramEvent::ShieldMeta(_) => {} // handled by poll indexer
            }
        }

        // Process announcements — leaf data derived from announcement
        for ann in &announcements {
            let leaf_index = ann.leaf_index as i64;

            if let Ok(inserted) = self.store.insert_leaf_from_announcement(leaf_index, &ann.commitment, signature, slot, 0) {
                if inserted {
                    let tree_cache = self.tree_cache.clone();
                    let commitment = ann.commitment;
                    tokio::spawn(async move {
                        tree_cache.on_leaf_inserted(leaf_index as u64, commitment).await;
                    });
                }
            }

            // Insert announcement (is_verified=false from WS; poll service upgrades it later)
            if let Ok(inserted) = self.store.insert_announcement(&super::storage::InsertAnnouncementParams {
                event: ann,
                tx_signature: signature,
                slot,
                block_time: 0,
                is_verified: false,
                btc_deposit_txid: None,
                btc_sweep_txid: None,
                btc_deposit_amount_sats: None,
                deposit_gross_amount: None,
                deposit_fee: None,
            }) {
                if inserted {
                    self.tree_cache.broadcast_announcement(ann);
                    tracing::debug!(leaf_index = ann.leaf_index, "Real-time stealth announcement indexed");
                }
            }
        }

        // Handle nullifiers
        for null in &nullifiers {
            if let Ok(inserted) = self.store.insert_nullifier(&super::storage::InsertNullifierParams {
                event: null,
                tx_signature: signature,
                slot,
                block_time: 0,
                instruction_disc: None,
                unshield_amount: None,
                unshield_recipient: None,
                transfer_type: None,
                token_id: None,
                unshield_fee: None,
                unshield_payout: None,
                unshield_output_count: None,
                unshield_outputs_json: None,
            }) {
                if inserted {
                    self.tree_cache.broadcast_nullifier(&hex::encode(null.nullifier_hash), slot);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn create_test_subscriber() -> SolanaWsSubscriber {
        let db_path = format!("/tmp/test_solana_ws_{}.db", std::process::id());
        let store = Arc::new(EventStore::new(&db_path).unwrap());
        let tree_cache = Arc::new(TreeCache::new(store.clone()).unwrap());
        SolanaWsSubscriber::new(
            SolanaWsConfig {
                ws_url: "wss://test.example.com".to_string(),
                program_id: "7JJeVjVCy1fZqCDWvf41R7LuTWirTjX7Tp6suC2WVUMQ".to_string(),
            },
            store,
            tree_cache,
        )
    }

    #[test]
    fn test_handle_subscription_confirmation() {
        let sub = create_test_subscriber();
        // Subscription confirmations should be silently handled
        let msg = r#"{"jsonrpc":"2.0","result":42,"id":1}"#;
        sub.handle_message(msg); // should not panic
    }

    #[test]
    fn test_handle_invalid_json() {
        let sub = create_test_subscriber();
        sub.handle_message("not json"); // should not panic
    }

    #[test]
    fn test_handle_non_logs_notification() {
        let sub = create_test_subscriber();
        let msg = r#"{"method":"accountNotification","params":{}}"#;
        sub.handle_message(msg); // should not panic — wrong method
    }

    #[test]
    fn test_handle_empty_logs() {
        let sub = create_test_subscriber();
        let msg = r#"{
            "method": "logsNotification",
            "params": {
                "result": {
                    "context": {"slot": 100},
                    "value": {
                        "signature": "abc123",
                        "logs": []
                    }
                }
            }
        }"#;
        sub.handle_message(msg); // should not panic — empty logs
    }

    #[test]
    fn test_handle_logs_with_no_program_events() {
        let sub = create_test_subscriber();
        let msg = r#"{
            "method": "logsNotification",
            "params": {
                "result": {
                    "context": {"slot": 100},
                    "value": {
                        "signature": "xyz789",
                        "logs": ["Program log: something unrelated"]
                    }
                }
            }
        }"#;
        sub.handle_message(msg); // should not panic — no matching events
    }

    #[test]
    fn test_config_creation() {
        let config = SolanaWsConfig {
            ws_url: "wss://api.devnet.solana.com".to_string(),
            program_id: "11111111111111111111111111111111".to_string(),
        };
        assert_eq!(config.ws_url, "wss://api.devnet.solana.com");
        assert_eq!(config.program_id, "11111111111111111111111111111111");
    }
}
