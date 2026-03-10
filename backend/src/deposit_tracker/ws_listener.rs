//! mempool.space WebSocket Listener
//!
//! Connects to `wss://mempool.space/testnet4/api/v1/ws` for:
//! 1. Real-time block detection — triggers block scanning for deposit auto-detection
//! 2. Block header relay on new block events (replaces separate TypeScript service)
//!
//! Falls back gracefully: if WS disconnects, the poll loop in service.rs continues.

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio::time::Duration;
use tokio_tungstenite::{connect_async, tungstenite::Message};

use super::header_relayer::HeaderRelayer;
use super::types::TrackerConfig;

#[derive(Debug, Clone)]
pub enum WsEvent {
    NewBlock { height: u64, hash: String },
    Connected,
    Disconnected,
}

// mempool.space WS response types

#[derive(Debug, Deserialize)]
struct WsMessage {
    block: Option<BlockRef>,
}

#[derive(Debug, Deserialize)]
struct BlockRef {
    height: u64,
    id: String,
}

pub struct MempoolWsListener {
    ws_url: String,
    event_tx: mpsc::UnboundedSender<WsEvent>,
    header_relayer: Option<Arc<HeaderRelayer>>,
}

impl MempoolWsListener {
    pub fn new(
        config: &TrackerConfig,
        event_tx: mpsc::UnboundedSender<WsEvent>,
        header_relayer: Option<Arc<HeaderRelayer>>,
    ) -> Self {
        Self {
            ws_url: config.ws_url.clone(),
            event_tx,
            header_relayer,
        }
    }

    /// Run forever with automatic reconnection (spawn as background task).
    pub async fn run(&self) {
        crate::common::reconnect::reconnect_loop(
            "mempool-ws",
            Duration::from_secs(5),
            Duration::from_secs(120),
            || async {
                let result = self.connect_and_listen().await;
                let _ = self.event_tx.send(WsEvent::Disconnected);
                result
            },
        )
        .await;
    }

    async fn connect_and_listen(&self) -> Result<(), String> {
        let (ws_stream, _) = connect_async(&self.ws_url)
            .await
            .map_err(|e| format!("connect failed: {}", e))?;

        let (mut write, mut read) = ws_stream.split();

        let _ = self.event_tx.send(WsEvent::Connected);

        // Subscribe to new blocks only (deposits are detected via block scanning)
        write
            .send(Message::Text(
                serde_json::json!({"action": "want", "data": ["blocks"]}).to_string().into(),
            ))
            .await
            .map_err(|e| format!("send want blocks: {}", e))?;

        while let Some(msg) = read.next().await {
            match msg {
                Ok(Message::Text(text)) => self.handle_message(&text).await,
                Ok(Message::Ping(data)) => {
                    let _ = write.send(Message::Pong(data)).await;
                }
                Ok(Message::Close(_)) => break,
                Err(e) => return Err(format!("read error: {}", e)),
                _ => {}
            }
        }

        Ok(())
    }

    async fn handle_message(&self, text: &str) {
        let msg: WsMessage = match serde_json::from_str(text) {
            Ok(m) => m,
            Err(_) => return, // Ignore non-matching messages (welcome, etc.)
        };

        // Handle new block
        if let Some(block) = msg.block {
            println!("[ws] New block: height={}, hash={}...", block.height, &block.id[..16]);

            let _ = self.event_tx.send(WsEvent::NewBlock {
                height: block.height,
                hash: block.id.clone(),
            });

            // Trigger header relay
            if let Some(relayer) = &self.header_relayer {
                let relayer = Arc::clone(relayer);
                let height = block.height;
                tokio::spawn(async move {
                    match relayer.on_new_block(height).await {
                        Ok(n) if n > 0 => {
                            println!("[ws/header-relay] Relayed {} headers to block {}", n, height);
                        }
                        Ok(_) => {}
                        Err(e) => {
                            eprintln!("[ws/header-relay] Error at block {}: {}", height, e);
                        }
                    }
                });
            }
        }
    }
}
