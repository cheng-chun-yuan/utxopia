//! Integrated Block Header Relayer
//!
//! Ports the TypeScript header-relayer to Rust so it shares the same
//! mempool.space WebSocket connection as the deposit listener.
//!
//! On new block events, fetches raw 80-byte headers from Esplora REST
//! and submits them to btc-light-client via `extend_blockchain`.

use reqwest::Client;
use sha2::{Digest, Sha256};
use solana_client::rpc_client::RpcClient;
use solana_sdk::{
    compute_budget::ComputeBudgetInstruction,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::Keypair,
    signer::Signer,
    transaction::Transaction,
};
use std::str::FromStr;
use thiserror::Error;

// PDA seeds — must match btc-light-client Pinocchio program
const LIGHT_CLIENT_SEED: &[u8] = b"btc_light_client";
const BLOCK_SEED: &[u8] = b"block";
const HEIGHT_INDEX_SEED: &[u8] = b"height_index";

const BTC_LIGHT_CLIENT_DISC: u8 = 0x06;
const EXTEND_BLOCKCHAIN_DISC: u8 = 1;

#[derive(Debug, Error)]
pub enum RelayerError {
    #[error("Solana RPC: {0}")]
    Rpc(String),
    #[error("HTTP: {0}")]
    Http(#[from] reqwest::Error),
    #[error("Parse: {0}")]
    Parse(String),
    #[error("Light client not initialized")]
    NotInitialized,
    #[error("Already at tip")]
    AlreadyAtTip,
}

#[derive(Debug)]
pub struct LightClientState {
    pub tip_hash: [u8; 32],
    pub tip_height: u64,
}

pub struct HeaderRelayer {
    rpc: RpcClient,
    http: Client,
    esplora_url: String,
    program_id: Pubkey,
    payer: Keypair,
    batch_size: u8,
}

impl HeaderRelayer {
    pub fn new(
        solana_rpc: &str,
        esplora_url: &str,
        program_id: &str,
        payer: Keypair,
        batch_size: u8,
    ) -> Result<Self, RelayerError> {
        Ok(Self {
            rpc: RpcClient::new(solana_rpc.to_string()),
            http: Client::new(),
            esplora_url: esplora_url.trim_end_matches('/').to_string(),
            program_id: Pubkey::from_str(program_id)
                .map_err(|e| RelayerError::Parse(format!("invalid program id: {}", e)))?,
            payer,
            batch_size: batch_size.clamp(1, 10),
        })
    }

    // ── PDA derivation ──

    fn light_client_pda(&self) -> Pubkey {
        Pubkey::find_program_address(&[LIGHT_CLIENT_SEED], &self.program_id).0
    }

    fn block_header_pda(&self, block_hash: &[u8; 32]) -> Pubkey {
        Pubkey::find_program_address(&[BLOCK_SEED, block_hash], &self.program_id).0
    }

    fn height_index_pda(&self, height: u64) -> Pubkey {
        Pubkey::find_program_address(
            &[HEIGHT_INDEX_SEED, &height.to_le_bytes()],
            &self.program_id,
        )
        .0
    }

    fn compute_block_hash(raw_header: &[u8]) -> [u8; 32] {
        let first = Sha256::digest(raw_header);
        Sha256::digest(first).into()
    }

    // ── Queries ──

    pub fn get_light_client_state(&self) -> Result<Option<LightClientState>, RelayerError> {
        let account = self
            .rpc
            .get_account(&self.light_client_pda())
            .map_err(|e| RelayerError::Rpc(e.to_string()))?;

        if account.data.is_empty() || account.data[0] != BTC_LIGHT_CLIENT_DISC {
            return Ok(None);
        }

        let mut tip_hash = [0u8; 32];
        tip_hash.copy_from_slice(&account.data[72..104]);

        let tip_height = u64::from_le_bytes(
            account.data[136..144]
                .try_into()
                .map_err(|_| RelayerError::Parse("tip_height".into()))?,
        );

        Ok(Some(LightClientState { tip_hash, tip_height }))
    }

    async fn get_btc_tip_height(&self) -> Result<u64, RelayerError> {
        let text = self
            .http
            .get(format!("{}/blocks/tip/height", self.esplora_url))
            .send()
            .await?
            .text()
            .await?;
        text.trim()
            .parse()
            .map_err(|e| RelayerError::Parse(format!("tip height: {}", e)))
    }

    async fn get_raw_header(&self, height: u64) -> Result<Vec<u8>, RelayerError> {
        let block_hash = self
            .http
            .get(format!("{}/block-height/{}", self.esplora_url, height))
            .send()
            .await?
            .text()
            .await?;

        let header_hex = self
            .http
            .get(format!(
                "{}/block/{}/header",
                self.esplora_url,
                block_hash.trim()
            ))
            .send()
            .await?
            .text()
            .await?;

        hex::decode(header_hex.trim())
            .map_err(|e| RelayerError::Parse(format!("header hex: {}", e)))
    }

    // ── Sync ──

    /// Sync from on-chain tip to Bitcoin tip. Returns number of headers submitted.
    pub async fn sync_headers(&self) -> Result<u32, RelayerError> {
        let state = self
            .get_light_client_state()?
            .ok_or(RelayerError::NotInitialized)?;

        let btc_tip = self.get_btc_tip_height().await?;

        if state.tip_height >= btc_tip {
            return Err(RelayerError::AlreadyAtTip);
        }

        println!(
            "[header-relay] Syncing {} blocks ({} -> {})",
            btc_tip - state.tip_height,
            state.tip_height + 1,
            btc_tip
        );

        let mut parent_hash = state.tip_hash;
        let mut parent_height = state.tip_height;
        let mut height = state.tip_height + 1;
        let mut total = 0u32;

        while height <= btc_tip {
            let batch_size = (self.batch_size as u64).min(btc_tip - height + 1);

            let mut raw_headers = Vec::with_capacity(batch_size as usize);
            for i in 0..batch_size {
                if height + i > btc_tip {
                    break;
                }
                raw_headers.push(self.get_raw_header(height + i).await?);
            }

            if raw_headers.is_empty() {
                break;
            }

            let batch_len = raw_headers.len() as u64;

            match self.submit_batch(&parent_hash, &raw_headers, parent_height) {
                Ok(sig) => {
                    println!(
                        "[header-relay] Batch {} headers ({} -> {}): {}",
                        batch_len, height, height + batch_len - 1, sig
                    );
                    total += batch_len as u32;
                }
                Err(e) if e.to_string().contains("already in use") || e.to_string().contains("0x0") => {
                    println!("[header-relay] Batch at {} already submitted, skipping", height);
                }
                Err(e) => return Err(e),
            }

            // Advance past this batch
            parent_hash = Self::compute_block_hash(&raw_headers[raw_headers.len() - 1]);
            parent_height = height + batch_len - 1;
            height = parent_height + 1;
        }

        Ok(total)
    }

    fn submit_batch(
        &self,
        parent_hash: &[u8; 32],
        raw_headers: &[Vec<u8>],
        parent_height: u64,
    ) -> Result<String, RelayerError> {
        let n = raw_headers.len();

        // Instruction data: disc(1) + num_headers(1) + N*80 bytes
        let mut data = Vec::with_capacity(2 + n * 80);
        data.push(EXTEND_BLOCKCHAIN_DISC);
        data.push(n as u8);
        for header in raw_headers {
            data.extend_from_slice(header);
        }

        // Build account list
        let mut accounts = vec![
            AccountMeta::new(self.light_client_pda(), false),
            AccountMeta::new(self.payer.pubkey(), true),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
            AccountMeta::new_readonly(self.block_header_pda(parent_hash), false),
        ];

        let (bh_keys, hi_keys): (Vec<_>, Vec<_>) = raw_headers
            .iter()
            .enumerate()
            .map(|(i, header)| {
                let hash = Self::compute_block_hash(header);
                (
                    AccountMeta::new(self.block_header_pda(&hash), false),
                    AccountMeta::new(self.height_index_pda(parent_height + i as u64 + 1), false),
                )
            })
            .unzip();

        accounts.extend(bh_keys);
        accounts.extend(hi_keys);

        let ix = Instruction {
            program_id: self.program_id,
            accounts,
            data,
        };

        let blockhash = self
            .rpc
            .get_latest_blockhash()
            .map_err(|e| RelayerError::Rpc(e.to_string()))?;

        let tx = Transaction::new_signed_with_payer(
            &[ComputeBudgetInstruction::set_compute_unit_limit(400_000), ix],
            Some(&self.payer.pubkey()),
            &[&self.payer],
            blockhash,
        );

        self.rpc
            .send_and_confirm_transaction(&tx)
            .map(|sig| sig.to_string())
            .map_err(|e| RelayerError::Rpc(e.to_string()))
    }

    /// Triggered by WS new block event. Syncs headers up to BTC tip.
    pub async fn on_new_block(&self, _new_height: u64) -> Result<u32, RelayerError> {
        match self.sync_headers().await {
            Ok(n) => Ok(n),
            Err(RelayerError::AlreadyAtTip) => Ok(0),
            Err(e) => Err(e),
        }
    }
}
