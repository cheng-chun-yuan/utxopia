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
            .send(Message::Text(subscribe_msg.to_string().into()))
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
        let mut leaf_events = Vec::new();
        let mut announcements = Vec::new();
        let mut nullifiers = Vec::new();

        for event in events {
            match event {
                ProgramEvent::LeafInserted(e) => leaf_events.push(e),
                ProgramEvent::StealthAnnouncement(e) => announcements.push(e),
                ProgramEvent::NullifierSpent(e) => nullifiers.push(e),
            }
        }

        // Match LeafInserted with StealthAnnouncement by commitment.
        // The announcement carries the authoritative on-chain leaf_index.
        for ann in &announcements {
            let leaf_index = ann.leaf_index as i64;

            // Find matching leaf event by commitment
            if let Some(leaf) = leaf_events.iter().find(|l| l.commitment == ann.commitment) {
                if let Ok(inserted) = self.store.insert_leaf(leaf_index, leaf, signature, slot, 0) {
                    if inserted {
                        let tree_cache = self.tree_cache.clone();
                        let commitment = leaf.commitment;
                        tokio::spawn(async move {
                            tree_cache.on_leaf_inserted(leaf_index as u64, commitment).await;
                        });
                    }
                }
            }

            // Insert announcement (is_verified=false from WS; poll service upgrades it later)
            if let Ok(inserted) = self.store.insert_announcement(ann, signature, slot, 0, false, None, None, None) {
                if inserted {
                    self.tree_cache.broadcast_announcement(ann);
                    tracing::debug!(leaf_index = ann.leaf_index, "Real-time stealth announcement indexed");
                }
            }
        }

        // Handle nullifiers
        for null in &nullifiers {
            if let Ok(inserted) = self.store.insert_nullifier(null, signature, slot, 0, None, None, None) {
                if inserted {
                    self.tree_cache.broadcast_nullifier(&hex::encode(null.nullifier_hash), slot);
                }
            }
        }
    }
}
