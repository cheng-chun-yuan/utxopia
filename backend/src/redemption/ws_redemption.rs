//! Solana WebSocket listener for RedemptionRequest PDA changes.
//! Subscribes to program account changes via programSubscribe.
//! Notifies the service loop to trigger an immediate PDA scan.

use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio::sync::Notify;
use tokio::time::{sleep, Duration, Instant};
use tokio_tungstenite::{connect_async, tungstenite::Message};

pub struct RedemptionWsListener {
    ws_url: String,
    program_id: String,
    notify: Arc<Notify>,
}

impl RedemptionWsListener {
    pub fn new(ws_url: String, program_id: String, notify: Arc<Notify>) -> Self {
        Self {
            ws_url,
            program_id,
            notify,
        }
    }

    /// Run forever with automatic reconnection and exponential backoff.
    /// Spawn as a background task.
    pub async fn run(&self) {
        let mut backoff_secs = 1u64;

        loop {
            println!(
                "[redemption-ws] Connecting to {} (program={})...",
                self.ws_url,
                &self.program_id[..8]
            );

            match self.connect_and_listen().await {
                Ok(()) => {
                    println!("[redemption-ws] Connection closed, reconnecting...");
                    backoff_secs = 1;
                }
                Err(e) => {
                    eprintln!(
                        "[redemption-ws] Error: {}, reconnecting in {}s...",
                        e, backoff_secs
                    );
                }
            }

            sleep(Duration::from_secs(backoff_secs)).await;
            backoff_secs = (backoff_secs * 2).min(60);
        }
    }

    async fn connect_and_listen(&self) -> Result<(), String> {
        let (ws_stream, _) = connect_async(&self.ws_url)
            .await
            .map_err(|e| format!("connect failed: {}", e))?;

        let (mut write, mut read) = ws_stream.split();

        println!("[redemption-ws] Connected, subscribing to program changes...");

        // Subscribe to RedemptionRequest PDA changes:
        // - dataSize: 90 filters for RedemptionRequest accounts
        // - memcmp offset 0, bytes "5" is base58 of discriminator byte 0x04
        let subscribe_msg = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "programSubscribe",
            "params": [
                self.program_id,
                {
                    "encoding": "base64",
                    "commitment": "confirmed",
                    "filters": [
                        { "dataSize": 90 },
                        { "memcmp": { "offset": 0, "bytes": "5" } }
                    ]
                }
            ]
        });

        write
            .send(Message::Text(subscribe_msg.to_string().into()))
            .await
            .map_err(|e| format!("send programSubscribe: {}", e))?;

        // Rate-limit notifications: minimum 5 seconds between signals
        let mut last_notify = Instant::now() - Duration::from_secs(10);

        while let Some(msg) = read.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    // Check if this is a programNotification
                    if text.contains("\"method\"")
                        && text.contains("\"programNotification\"")
                    {
                        let now = Instant::now();
                        if now.duration_since(last_notify) >= Duration::from_secs(5) {
                            println!("[redemption-ws] PDA change detected, triggering scan");
                            self.notify.notify_one();
                            last_notify = now;
                        }
                    }
                }
                Ok(Message::Ping(data)) => {
                    let _ = write.send(Message::Pong(data)).await;
                }
                Ok(Message::Close(_)) => {
                    println!("[redemption-ws] Server sent close frame");
                    break;
                }
                Err(e) => return Err(format!("read error: {}", e)),
                _ => {}
            }
        }

        Ok(())
    }
}
