//! WebSocket-based account update stream using Solana programSubscribe.
//!
//! Subscribes to all account changes for the Aegis program via
//! Solana's native WebSocket RPC. Free on devnet, low-latency (~200-400ms).
//!
//! For mainnet production, replace with GeyserStream (Yellowstone gRPC)
//! for guaranteed delivery and <50ms latency.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use solana_client::nonblocking::pubsub_client::PubsubClient;
use solana_client::rpc_config::{RpcAccountInfoConfig, RpcProgramAccountsConfig};
use solana_account_decoder::UiAccountEncoding;
use solana_sdk::commitment_config::CommitmentConfig;
use solana_sdk::pubkey::Pubkey;
use futures_util::StreamExt;

use super::{AccountUpdate, AccountUpdateStream, StreamError, UpdateCallback};

pub struct WebSocketStream {
    ws_url: String,
    program_id: Pubkey,
    running: Arc<AtomicBool>,
}

impl WebSocketStream {
    /// Create a new WebSocket stream.
    ///
    /// `ws_url` should be the WebSocket RPC endpoint, e.g.:
    /// - devnet: `wss://api.devnet.solana.com`
    /// - mainnet: `wss://api.mainnet-beta.solana.com`
    pub fn new(ws_url: &str, program_id: &Pubkey) -> Self {
        Self {
            ws_url: ws_url.to_string(),
            program_id: *program_id,
            running: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Derive WebSocket URL from HTTP RPC URL.
    /// `https://api.devnet.solana.com` → `wss://api.devnet.solana.com`
    pub fn from_rpc_url(rpc_url: &str, program_id: &Pubkey) -> Self {
        let ws_url = rpc_url
            .replace("https://", "wss://")
            .replace("http://", "ws://");
        Self::new(&ws_url, program_id)
    }
}

#[async_trait::async_trait]
impl AccountUpdateStream for WebSocketStream {
    async fn start(&self, callback: UpdateCallback) -> Result<(), StreamError> {
        self.running.store(true, Ordering::Relaxed);

        println!(
            "[ws-stream] Connecting to {} (program: {})",
            &self.ws_url, &self.program_id.to_string()[..8]
        );

        // Reconnect loop — handles dropped connections
        // On reconnect, fire callback with empty update to trigger a full re-sync
        let mut first_connect = true;
        while self.running.load(Ordering::Relaxed) {
            if !first_connect {
                // After reconnect, trigger a sync to catch anything missed
                println!("[ws-stream] Reconnected — triggering re-sync");
                callback(AccountUpdate {
                    pubkey: "reconnect".to_string(),
                    data: Vec::new(),
                    data_len: 0,
                    slot: 0,
                });
            }
            first_connect = false;

            match self.subscribe_loop(&callback).await {
                Ok(()) => {
                    if self.running.load(Ordering::Relaxed) {
                        println!("[ws-stream] Subscription ended, reconnecting in 5s...");
                        tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                    }
                }
                Err(e) => {
                    eprintln!("[ws-stream] Error: {}, reconnecting in 10s...", e);
                    tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;
                }
            }
        }

        Ok(())
    }

    async fn stop(&self) {
        self.running.store(false, Ordering::Relaxed);
        println!("[ws-stream] Stopped");
    }

    fn name(&self) -> &str {
        "websocket"
    }
}

impl WebSocketStream {
    async fn subscribe_loop(&self, callback: &UpdateCallback) -> Result<(), StreamError> {
        let pubsub = PubsubClient::new(&self.ws_url)
            .await
            .map_err(|e| StreamError::ConnectionFailed(e.to_string()))?;

        let config = RpcProgramAccountsConfig {
            filters: None, // All accounts owned by program
            account_config: RpcAccountInfoConfig {
                encoding: Some(UiAccountEncoding::Base64),
                commitment: Some(CommitmentConfig::confirmed()),
                ..Default::default()
            },
            with_context: Some(true),
            sort_results: None,
        };

        let (mut stream, _unsub) = pubsub
            .program_subscribe(&self.program_id, Some(config))
            .await
            .map_err(|e| StreamError::ConnectionFailed(format!("programSubscribe: {}", e)))?;

        println!("[ws-stream] Subscribed to program account changes");

        while self.running.load(Ordering::Relaxed) {
            match tokio::time::timeout(
                tokio::time::Duration::from_secs(60), // ping timeout
                stream.next(),
            )
            .await
            {
                Ok(Some(response)) => {
                    let keyed = response.value;
                    let pubkey = keyed.pubkey;

                    // Decode base64 account data
                    if let solana_account_decoder::UiAccountData::Binary(b64_data, _encoding) =
                        keyed.account.data
                    {
                        match base64::Engine::decode(
                            &base64::engine::general_purpose::STANDARD,
                            &b64_data,
                        ) {
                            Ok(data) => {
                                let data_len = data.len();
                                callback(AccountUpdate {
                                    pubkey,
                                    data,
                                    data_len,
                                    slot: response.context.slot,
                                });
                            }
                            Err(e) => {
                                eprintln!("[ws-stream] Base64 decode error for {}: {}", &pubkey[..8], e);
                            }
                        }
                    }
                }
                Ok(None) => {
                    // Stream ended
                    return Ok(());
                }
                Err(_) => {
                    // Timeout — no updates in 60s, connection may be stale
                    // This is normal if no account changes happened
                }
            }
        }

        Ok(())
    }
}
