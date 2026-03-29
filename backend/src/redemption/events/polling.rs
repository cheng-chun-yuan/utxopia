//! Polling-based account update stream.
//!
//! Calls getProgramAccounts on interval. Simple, reliable fallback
//! for when WebSocket/gRPC is unavailable.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use solana_client::rpc_client::RpcClient;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::commitment_config::CommitmentConfig;

use super::{AccountUpdate, AccountUpdateStream, StreamError, UpdateCallback};

pub struct PollingStream {
    rpc_url: String,
    program_id: Pubkey,
    interval_secs: u64,
    running: Arc<AtomicBool>,
}

impl PollingStream {
    pub fn new(rpc_url: &str, program_id: &Pubkey, interval_secs: u64) -> Self {
        Self {
            rpc_url: rpc_url.to_string(),
            program_id: *program_id,
            interval_secs,
            running: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[async_trait::async_trait]
impl AccountUpdateStream for PollingStream {
    async fn start(&self, callback: UpdateCallback) -> Result<(), StreamError> {
        let rpc = RpcClient::new_with_commitment(&self.rpc_url, CommitmentConfig::confirmed());
        self.running.store(true, Ordering::Relaxed);

        println!("[polling-stream] Started ({}s interval, program: {})", self.interval_secs, &self.program_id.to_string()[..8]);

        while self.running.load(Ordering::Relaxed) {
            match rpc.get_program_accounts(&self.program_id) {
                Ok(accounts) => {
                    for (pubkey, account) in &accounts {
                        callback(AccountUpdate {
                            pubkey: pubkey.to_string(),
                            data: account.data.clone(),
                            data_len: account.data.len(),
                            slot: 0,
                        });
                    }
                }
                Err(e) => {
                    eprintln!("[polling-stream] getProgramAccounts error: {}", e);
                }
            }

            tokio::time::sleep(tokio::time::Duration::from_secs(self.interval_secs)).await;
        }

        Ok(())
    }

    async fn stop(&self) {
        self.running.store(false, Ordering::Relaxed);
        println!("[polling-stream] Stopped");
    }

    fn name(&self) -> &str {
        "polling"
    }
}
