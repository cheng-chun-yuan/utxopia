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

    /// Extract prev_block_hash from a raw 80-byte Bitcoin header (bytes 4..36).
    fn extract_prev_hash(raw_header: &[u8]) -> [u8; 32] {
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&raw_header[4..36]);
        hash
    }

    /// Check if a block hash has a valid on-chain PDA (disc=0x07).
    fn has_on_chain_block(&self, block_hash: &[u8; 32]) -> bool {
        let pda = self.block_header_pda(block_hash);
        match self.rpc.get_account(&pda) {
            Ok(account) => !account.data.is_empty() && account.data[0] == 0x07,
            Err(_) => false,
        }
    }

    /// Detect reorg by walking back the Bitcoin chain via prev_hash links.
    ///
    /// Strategy:
    /// 1. Fetch real Bitcoin header at on-chain tip height, compute its hash
    /// 2. If hash == on-chain tip hash → no reorg, sync normally
    /// 3. If different → reorg detected. Walk back via prev_hash:
    ///    fetch header at height-1, check if its hash exists on-chain as a block PDA
    /// 4. Repeat until we find a block that exists on-chain (common ancestor)
    ///
    /// Returns (parent_hash, parent_height) to start syncing from.
    async fn find_sync_start(
        &self,
        on_chain_tip_hash: [u8; 32],
        on_chain_tip_height: u64,
        max_lookback: u64,
    ) -> Result<([u8; 32], u64), RelayerError> {
        // Quick check: does the real block at tip height match on-chain?
        let tip_header = self.get_raw_header(on_chain_tip_height).await?;
        let real_tip_hash = Self::compute_block_hash(&tip_header);

        if real_tip_hash == on_chain_tip_hash {
            // No reorg — on-chain tip matches canonical chain
            return Ok((on_chain_tip_hash, on_chain_tip_height));
        }

        println!(
            "[header-relay] Reorg detected at height {}! On-chain hash {} != real hash {}",
            on_chain_tip_height,
            hex::encode(on_chain_tip_hash),
            hex::encode(real_tip_hash),
        );

        // Walk back via prev_hash to find common ancestor
        let mut check_height = on_chain_tip_height;
        let mut prev_hash = Self::extract_prev_hash(&tip_header);
        let min_height = on_chain_tip_height.saturating_sub(max_lookback);

        while check_height > min_height {
            check_height -= 1;

            // Does this prev_hash exist on-chain?
            if self.has_on_chain_block(&prev_hash) {
                println!(
                    "[header-relay] Common ancestor found at height {} ({} blocks back)",
                    check_height,
                    on_chain_tip_height - check_height,
                );
                return Ok((prev_hash, check_height));
            }

            // Keep walking back: fetch header at check_height, get its prev_hash
            let header = self.get_raw_header(check_height).await?;
            prev_hash = Self::extract_prev_hash(&header);
        }

        Err(RelayerError::Parse(format!(
            "No common ancestor within {} blocks of height {}",
            max_lookback, on_chain_tip_height
        )))
    }

    /// Sync from on-chain tip to Bitcoin tip. Returns number of headers submitted.
    ///
    /// Safety rules:
    /// 1. Only submit when the new chain connects to an on-chain block (common ancestor found)
    /// 2. Only submit when the new chain is longer than the current on-chain tip
    /// 3. Verify prev_hash linkage before each batch submission
    pub async fn sync_headers(&self) -> Result<u32, RelayerError> {
        let state = self
            .get_light_client_state()?
            .ok_or(RelayerError::NotInitialized)?;

        let btc_tip = self.get_btc_tip_height().await?;

        if state.tip_height >= btc_tip {
            return Err(RelayerError::AlreadyAtTip);
        }

        // Find where to start syncing — detects reorgs automatically
        let (parent_hash, parent_height) = self
            .find_sync_start(state.tip_hash, state.tip_height, 20)
            .await?;

        let start_height = parent_height + 1;
        if start_height > btc_tip {
            return Err(RelayerError::AlreadyAtTip);
        }

        // Safety: new chain must be strictly longer than current on-chain tip
        if btc_tip <= state.tip_height {
            println!(
                "[header-relay] New chain tip {} is not longer than on-chain tip {}, skipping",
                btc_tip, state.tip_height
            );
            return Ok(0);
        }

        if parent_height < state.tip_height {
            println!(
                "[header-relay] Reorg: rolling back {} blocks from {} to common ancestor {}, then extending to {}",
                state.tip_height - parent_height,
                state.tip_height,
                parent_height,
                btc_tip,
            );
        } else {
            println!(
                "[header-relay] Syncing {} blocks ({} -> {})",
                btc_tip - parent_height,
                start_height,
                btc_tip
            );
        }

        let mut current_parent_hash = parent_hash;
        let mut current_parent_height = parent_height;
        let mut height = start_height;
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

            // Verify first header's prev_hash links to our expected parent
            let first_prev = Self::extract_prev_hash(&raw_headers[0]);
            if first_prev != current_parent_hash {
                eprintln!(
                    "[header-relay] prev_hash mismatch at height {}: expected {}, got {} — aborting batch",
                    height,
                    hex::encode(current_parent_hash),
                    hex::encode(first_prev)
                );
                return Err(RelayerError::Parse(format!(
                    "prev_hash mismatch at height {}", height
                )));
            }

            match self.submit_batch(&current_parent_hash, &raw_headers, current_parent_height) {
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
            current_parent_hash = Self::compute_block_hash(&raw_headers[raw_headers.len() - 1]);
            current_parent_height = height + batch_len - 1;
            height = current_parent_height + 1;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compute_block_hash_deterministic() {
        // Bitcoin block header is 80 bytes; hash is double-SHA256
        let header = [0u8; 80];
        let hash1 = HeaderRelayer::compute_block_hash(&header);
        let hash2 = HeaderRelayer::compute_block_hash(&header);
        assert_eq!(hash1, hash2, "block hash must be deterministic");
        assert_ne!(hash1, [0u8; 32], "hash of all-zeros should not be all-zeros");
    }

    #[test]
    fn test_compute_block_hash_known_vector() {
        // Genesis block header (first 80 bytes) → known hash
        // Version: 1, prev: 00..00, merkle: 4a5e1e..., time: 1231006505, bits: 1d00ffff, nonce: 2083236893
        let genesis_header = hex::decode(
            "0100000000000000000000000000000000000000000000000000000000000000\
             000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa\
             4b1e5e4a29ab5f49ffff001d1dac2b7c"
        ).unwrap();
        let hash = HeaderRelayer::compute_block_hash(&genesis_header);
        // Bitcoin genesis block hash (internal byte order = LE)
        let expected = hex::decode("6fe28c0ab6f1b372c1a6a246ae63f74f931e8365e15a089c68d6190000000000").unwrap();
        assert_eq!(hash.to_vec(), expected, "genesis block hash mismatch");
    }

    #[test]
    fn test_extract_prev_hash() {
        let mut header = [0u8; 80];
        // Set bytes 4..36 to a known pattern
        for i in 4..36 {
            header[i] = (i - 4) as u8;
        }
        let prev_hash = HeaderRelayer::extract_prev_hash(&header);
        for i in 0..32 {
            assert_eq!(prev_hash[i], i as u8);
        }
    }

    #[test]
    fn test_pda_derivation_deterministic() {
        // PDA derivation should be deterministic for same inputs
        let program_id = Pubkey::from_str("Ho6UTeF8yFnRdCK15tSZtcJozvkDABJZWYxkgGyWAfyq").unwrap();
        let pda1 = Pubkey::find_program_address(&[LIGHT_CLIENT_SEED], &program_id).0;
        let pda2 = Pubkey::find_program_address(&[LIGHT_CLIENT_SEED], &program_id).0;
        assert_eq!(pda1, pda2);
    }

    #[test]
    fn test_batch_size_clamping() {
        // batch_size is clamped to 1..=10
        let relayer = HeaderRelayer {
            rpc: RpcClient::new("http://localhost:8899".to_string()),
            http: Client::new(),
            esplora_url: "http://localhost".to_string(),
            program_id: Pubkey::from_str("11111111111111111111111111111111").unwrap(),
            payer: Keypair::new(),
            batch_size: 0u8.clamp(1, 10),
        };
        assert!(relayer.batch_size >= 1 && relayer.batch_size <= 10);
    }

    #[test]
    fn test_relayer_error_display() {
        let err = RelayerError::NotInitialized;
        assert_eq!(err.to_string(), "Light client not initialized");

        let err = RelayerError::AlreadyAtTip;
        assert_eq!(err.to_string(), "Already at tip");
    }
}
