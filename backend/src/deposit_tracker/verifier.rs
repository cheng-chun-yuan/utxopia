//! SPV Verifier
//!
//! Submits sweep transactions for SPV verification on Solana.
//! Uses btc-light-client's verify_transaction to create a VerifiedTransaction PDA,
//! then calls aegis's verify_stealth_deposit with that PDA.
//!
//! Raw Bitcoin transactions are uploaded to ChadBuffer accounts before verification.
//! Core SPV utilities (ChadBuffer upload/close, strip_witness, etc.) live in
//! `crate::solana::spv` and are reused by both this module and the redemption service.

use solana_client::rpc_client::RpcClient;
use solana_sdk::{
    commitment_config::CommitmentConfig,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer as SolanaSigner},
    transaction::Transaction,
};
use solana_sdk::pubkey;
use std::str::FromStr;
use thiserror::Error;

use super::watcher::{AddressWatcher, MerkleProofData, WatcherError};
use crate::solana::spv;

// =============================================================================
// Constants
// =============================================================================

/// Token-2022 program ID
const TOKEN_2022_PROGRAM_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/// Get Aegis program ID from env or use devnet default
fn aegis_program_id() -> String {
    std::env::var("AEGIS_PROGRAM_ID")
        .unwrap_or_else(|_| "7JJeVjVCy1fZqCDWvf41R7LuTWirTjX7Tp6suC2WVUMQ".to_string())
}

/// Get BTC light client program ID from env or use devnet default
fn btc_light_client_program_id() -> String {
    std::env::var("BTC_LIGHT_CLIENT_PROGRAM_ID")
        .unwrap_or_else(|_| "Ho6UTeF8yFnRdCK15tSZtcJozvkDABJZWYxkgGyWAfyq".to_string())
}

// =============================================================================
// Error & Result Types
// =============================================================================

#[derive(Debug, Error)]
pub enum VerifierError {
    #[error("Watcher error: {0}")]
    Watcher(#[from] WatcherError),

    #[error("RPC error: {0}")]
    RpcError(String),

    #[error("Invalid address: {0}")]
    InvalidAddress(String),

    #[error("Transaction not confirmed")]
    TxNotConfirmed,

    #[error("Block header not found at height {0}")]
    BlockHeaderNotFound(u64),

    #[error("No payer keypair set")]
    NoPayerSet,

    #[error("Verification failed: {0}")]
    VerificationFailed(String),
}

#[derive(Debug, Clone)]
pub struct VerificationResult {
    pub solana_tx: String,
    pub leaf_index: u64,
    pub block_height: u64,
}

// =============================================================================
// SpvVerifier
// =============================================================================

pub struct SpvVerifier {
    rpc: RpcClient,
    payer: Option<Keypair>,
    watcher: AddressWatcher,
    program_id: Pubkey,
    light_client_program_id: Pubkey,
}

impl SpvVerifier {
    pub fn new_testnet(solana_rpc: &str) -> Self {
        Self {
            rpc: RpcClient::new_with_commitment(solana_rpc, CommitmentConfig::confirmed()),
            payer: None,
            watcher: AddressWatcher::from_network(crate::config::Network::Devnet),
            program_id: Pubkey::from_str(&aegis_program_id()).unwrap(),
            light_client_program_id: Pubkey::from_str(&btc_light_client_program_id()).unwrap(),
        }
    }

    pub fn new(solana_rpc: &str, esplora_url: &str, program_id: &str) -> Result<Self, VerifierError> {
        Ok(Self {
            rpc: RpcClient::new_with_commitment(solana_rpc, CommitmentConfig::confirmed()),
            payer: None,
            watcher: AddressWatcher::new(esplora_url),
            program_id: Pubkey::from_str(program_id)
                .map_err(|e| VerifierError::InvalidAddress(e.to_string()))?,
            light_client_program_id: Pubkey::from_str(&btc_light_client_program_id())
                .map_err(|e| VerifierError::InvalidAddress(e.to_string()))?,
        })
    }

    pub fn set_payer(&mut self, keypair: Keypair) {
        self.payer = Some(keypair);
    }

    pub fn set_payer_from_file(&mut self, path: &str) -> Result<(), VerifierError> {
        let content = std::fs::read_to_string(path)
            .map_err(|e| VerifierError::RpcError(format!("Failed to read keypair: {}", e)))?;
        let bytes: Vec<u8> = serde_json::from_str(&content)
            .map_err(|e| VerifierError::RpcError(format!("Failed to parse keypair: {}", e)))?;
        let keypair = Keypair::try_from(bytes.as_slice())
            .map_err(|e| VerifierError::RpcError(format!("Invalid keypair: {}", e)))?;
        self.payer = Some(keypair);
        Ok(())
    }

    pub fn payer_pubkey(&self) -> Option<Pubkey> {
        self.payer.as_ref().map(|k| k.pubkey())
    }

    // =========================================================================
    // Public API
    // =========================================================================

    /// Verify a Bitcoin deposit via SPV proof on Solana.
    ///
    /// Uploads raw sweep + deposit transactions to ChadBuffer accounts, then sends
    /// two instructions: btc-light-client verify_transaction + aegis verify_stealth_deposit.
    pub async fn verify_deposit(
        &self,
        sweep_txid: &str,
        deposit_txid: &str,
    ) -> Result<VerificationResult, VerifierError> {
        let payer = self.payer.as_ref().ok_or(VerifierError::NoPayerSet)?;

        // Get transaction confirmation status
        let tx_status = self.watcher.get_tx_confirmations(sweep_txid).await?;
        if !tx_status.confirmed {
            return Err(VerifierError::TxNotConfirmed);
        }

        let block_height = tx_status
            .block_height
            .ok_or(VerifierError::TxNotConfirmed)?;

        // Get merkle proof for sweep TX
        let merkle_proof = self.watcher.get_merkle_proof(sweep_txid).await?;

        // Get block header
        let block_header = self.watcher.get_block_header(block_height).await?;

        // Fetch raw transactions from Esplora and strip witness data
        // Bitcoin txid = hash(non-witness serialization), so we must strip witness data
        let sweep_raw_full = self.watcher.get_raw_tx(sweep_txid).await?;
        let deposit_raw_full = self.watcher.get_raw_tx(deposit_txid).await?;

        let sweep_raw_tx = spv::strip_witness_data(&sweep_raw_full)
            .map_err(|e| VerifierError::VerificationFailed(e.to_string()))?;
        let deposit_raw_tx = spv::strip_witness_data(&deposit_raw_full)
            .map_err(|e| VerifierError::VerificationFailed(e.to_string()))?;

        println!(
            "[verifier] Raw txs: sweep={} bytes (from {}), deposit={} bytes (from {})",
            sweep_raw_tx.len(), sweep_raw_full.len(),
            deposit_raw_tx.len(), deposit_raw_full.len(),
        );

        // Convert txids to internal byte order
        let sweep_txid_internal = spv::txid_to_internal(sweep_txid)
            .map_err(|e| VerifierError::VerificationFailed(e.to_string()))?;
        let deposit_txid_internal = spv::txid_to_internal(deposit_txid)
            .map_err(|e| VerifierError::VerificationFailed(e.to_string()))?;

        // Compute block hash from raw header (double SHA256)
        let header_bytes = hex::decode(block_header.header_hex.trim())
            .map_err(|e| VerifierError::VerificationFailed(format!("invalid header hex: {}", e)))?;
        let block_hash = spv::double_sha256(&header_bytes);

        // Upload raw transactions to ChadBuffer accounts
        let (sweep_buffer_pubkey, sweep_buffer_keypair) =
            spv::upload_to_chadbuffer(&self.rpc, payer, &sweep_raw_tx)
                .map_err(|e| VerifierError::RpcError(e.to_string()))?;
        let (deposit_buffer_pubkey, deposit_buffer_keypair) =
            spv::upload_to_chadbuffer(&self.rpc, payer, &deposit_raw_tx)
                .map_err(|e| VerifierError::RpcError(e.to_string()))?;

        // Build and send verification transaction
        let result = self
            .send_verify_deposit_tx(
                payer,
                &sweep_txid_internal,
                &deposit_txid_internal,
                &merkle_proof,
                block_height,
                &block_hash,
                &sweep_buffer_pubkey,
                sweep_raw_tx.len() as u32,
                &deposit_buffer_pubkey,
                deposit_raw_tx.len() as u32,
            )
            .await;

        // Clean up ChadBuffer accounts regardless of verification result
        let _ = spv::close_chadbuffer(&self.rpc, payer, &sweep_buffer_pubkey);
        let _ = spv::close_chadbuffer(&self.rpc, payer, &deposit_buffer_pubkey);
        // Drop keypairs (no longer needed after close)
        drop(sweep_buffer_keypair);
        drop(deposit_buffer_keypair);

        let solana_tx = result?;

        // Get leaf index from the transaction's log events
        let leaf_index = self.get_leaf_index_from_tx(&solana_tx).await?;

        Ok(VerificationResult {
            solana_tx,
            leaf_index,
            block_height,
        })
    }

    /// Check if block header is available in the BTC light client
    pub async fn block_header_available(&self, height: u64) -> Result<bool, VerifierError> {
        let (height_index_pda, _) = Pubkey::find_program_address(
            &[b"height_index", &height.to_le_bytes()],
            &self.light_client_program_id,
        );

        match self.rpc.get_account(&height_index_pda) {
            Ok(account) => Ok(account.data.len() >= 48 && account.data[0] == 0x09),
            Err(_) => Ok(false),
        }
    }

    /// Check if a deposit has already been verified by looking up the
    /// deposit receipt PDA (created by verify_stealth_deposit on-chain).
    pub async fn is_already_verified(
        &self,
        deposit_txid: &str,
    ) -> Result<bool, VerifierError> {
        let txid_internal = spv::txid_to_internal(deposit_txid)
            .map_err(|e| VerifierError::VerificationFailed(e.to_string()))?;

        let (deposit_receipt_pda, _) = Pubkey::find_program_address(
            &[b"deposit_receipt", &txid_internal],
            &self.program_id,
        );

        match self.rpc.get_account(&deposit_receipt_pda) {
            Ok(account) => Ok(!account.data.is_empty() && account.data[0] == 0x06),
            Err(_) => Ok(false),
        }
    }

    /// Register a DepositIntent PDA on Solana (disc 24).
    ///
    /// Creates a PDA with seeds ["deposit_intent", npk] storing ephemeral_pub + npk.
    /// This is called before sweep for OP_RETURN-free deposits.
    pub async fn register_deposit_intent(
        &self,
        ephemeral_pub_hex: &str,
        npk_hex: &str,
    ) -> Result<String, VerifierError> {
        let payer = self.payer.as_ref().ok_or(VerifierError::NoPayerSet)?;

        let ephemeral_pub = hex::decode(ephemeral_pub_hex)
            .map_err(|e| VerifierError::VerificationFailed(format!("invalid ephemeral_pub hex: {}", e)))?;
        let npk = hex::decode(npk_hex)
            .map_err(|e| VerifierError::VerificationFailed(format!("invalid npk hex: {}", e)))?;

        if ephemeral_pub.len() != 32 || npk.len() != 32 {
            return Err(VerifierError::VerificationFailed("ephemeral_pub and npk must be 32 bytes".to_string()));
        }

        // Derive DepositIntent PDA
        let (deposit_intent_pda, _) = Pubkey::find_program_address(
            &[b"deposit_intent", &npk],
            &self.program_id,
        );

        // Check if PDA already exists
        if let Ok(account) = self.rpc.get_account(&deposit_intent_pda) {
            if !account.data.is_empty() && account.data[0] == 0x07 {
                println!("[verifier] DepositIntent PDA already exists: {}", deposit_intent_pda);
                return Ok(String::new()); // Idempotent
            }
        }

        // Build instruction: disc(24) + ephemeral_pub(32) + npk(32)
        let mut ix_data = Vec::with_capacity(65);
        ix_data.push(24u8); // discriminator
        ix_data.extend_from_slice(&ephemeral_pub);
        ix_data.extend_from_slice(&npk);

        let accounts = vec![
            AccountMeta::new(payer.pubkey(), true),           // payer
            AccountMeta::new(deposit_intent_pda, false),       // deposit_intent PDA
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false), // system_program
        ];

        let ix = Instruction {
            program_id: self.program_id,
            accounts,
            data: ix_data,
        };

        let blockhash = self.rpc.get_latest_blockhash()
            .map_err(|e| VerifierError::RpcError(format!("Failed to get blockhash: {}", e)))?;

        let tx = Transaction::new_signed_with_payer(
            &[ix],
            Some(&payer.pubkey()),
            &[payer],
            blockhash,
        );

        let sig = self.rpc.send_and_confirm_transaction(&tx)
            .map_err(|e| VerifierError::RpcError(format!("register_deposit_intent failed: {}", e)))?;

        println!("[verifier] DepositIntent PDA created: {} (tx: {})", deposit_intent_pda, sig);
        Ok(sig.to_string())
    }

    /// Verify a deposit using v2 instruction (disc 25) which reads from DepositIntent PDA.
    ///
    /// This eliminates the need for a deposit TX ChadBuffer.
    pub async fn verify_deposit_v2(
        &self,
        sweep_txid: &str,
        deposit_txid: &str,
        npk_hex: &str,
    ) -> Result<VerificationResult, VerifierError> {
        let payer = self.payer.as_ref().ok_or(VerifierError::NoPayerSet)?;

        // Get sweep tx confirmation status
        let tx_status = self.watcher.get_tx_confirmations(sweep_txid).await?;
        if !tx_status.confirmed {
            return Err(VerifierError::TxNotConfirmed);
        }
        let block_height = tx_status.block_height.ok_or(VerifierError::TxNotConfirmed)?;

        // Get merkle proof + block header + raw sweep tx
        let merkle_proof = self.watcher.get_merkle_proof(sweep_txid).await?;
        let block_header = self.watcher.get_block_header(block_height).await?;
        let sweep_raw_full = self.watcher.get_raw_tx(sweep_txid).await?;
        let sweep_raw_tx = spv::strip_witness_data(&sweep_raw_full)
            .map_err(|e| VerifierError::VerificationFailed(e.to_string()))?;

        println!("[verifier-v2] Sweep raw tx: {} bytes (from {})", sweep_raw_tx.len(), sweep_raw_full.len());

        // Convert txids to internal byte order
        let sweep_txid_internal = spv::txid_to_internal(sweep_txid)
            .map_err(|e| VerifierError::VerificationFailed(e.to_string()))?;
        let deposit_txid_internal = spv::txid_to_internal(deposit_txid)
            .map_err(|e| VerifierError::VerificationFailed(e.to_string()))?;

        // Compute block hash
        let header_bytes = hex::decode(block_header.header_hex.trim())
            .map_err(|e| VerifierError::VerificationFailed(format!("invalid header hex: {}", e)))?;
        let block_hash = spv::double_sha256(&header_bytes);

        // Upload only sweep TX to ChadBuffer (no deposit TX needed!)
        let (sweep_buffer_pubkey, sweep_buffer_keypair) =
            spv::upload_to_chadbuffer(&self.rpc, payer, &sweep_raw_tx)
                .map_err(|e| VerifierError::RpcError(e.to_string()))?;

        // Build and send v2 verification transaction
        let result = self.send_verify_deposit_v2_tx(
            payer,
            &sweep_txid_internal,
            &deposit_txid_internal,
            &merkle_proof,
            block_height,
            &block_hash,
            &sweep_buffer_pubkey,
            sweep_raw_tx.len() as u32,
            npk_hex,
        ).await;

        // Clean up ChadBuffer
        let _ = spv::close_chadbuffer(&self.rpc, payer, &sweep_buffer_pubkey);
        drop(sweep_buffer_keypair);

        let solana_tx = result?;
        let leaf_index = self.get_leaf_index_from_tx(&solana_tx).await?;

        Ok(VerificationResult {
            solana_tx,
            leaf_index,
            block_height,
        })
    }

    /// Send verify_deposit_v2 transaction (btc-light-client verify + aegis disc 25)
    #[allow(clippy::too_many_arguments)]
    async fn send_verify_deposit_v2_tx(
        &self,
        payer: &Keypair,
        sweep_txid: &[u8; 32],
        deposit_txid: &[u8; 32],
        merkle_proof: &MerkleProofData,
        block_height: u64,
        block_hash: &[u8; 32],
        sweep_buffer: &Pubkey,
        sweep_tx_size: u32,
        npk_hex: &str,
    ) -> Result<String, VerifierError> {
        // Derive PDAs (same as v1)
        let (pool_state, _) = Pubkey::find_program_address(&[b"pool_state"], &self.program_id);
        let (light_client, _) = Pubkey::find_program_address(
            &[b"btc_light_client"], &self.light_client_program_id,
        );
        let (block_header_pda, _) = Pubkey::find_program_address(
            &[b"block", block_hash], &self.light_client_program_id,
        );
        let (verified_tx_pda, _) = Pubkey::find_program_address(
            &[b"verified_tx", block_hash, sweep_txid], &self.light_client_program_id,
        );
        let (commitment_tree, _) = Pubkey::find_program_address(
            &[b"commitment_tree"], &self.program_id,
        );

        // Read pool state for mint/vault
        let pool_account = self.rpc.get_account(&pool_state)
            .map_err(|e| VerifierError::RpcError(format!("Failed to get pool state: {}", e)))?;
        if pool_account.data.len() < 100 {
            return Err(VerifierError::VerificationFailed("pool state too small".to_string()));
        }
        let zkbtc_mint = Pubkey::try_from(&pool_account.data[36..68])
            .map_err(|_| VerifierError::VerificationFailed("invalid zkbtc_mint".to_string()))?;
        let pool_vault = Pubkey::try_from(&pool_account.data[68..100])
            .map_err(|_| VerifierError::VerificationFailed("invalid pool_vault".to_string()))?;

        // Derive DepositIntent PDA from npk
        let npk_bytes = hex::decode(npk_hex)
            .map_err(|e| VerifierError::VerificationFailed(format!("invalid npk: {}", e)))?;
        let (deposit_intent_pda, _) = Pubkey::find_program_address(
            &[b"deposit_intent", &npk_bytes], &self.program_id,
        );

        // Derive deposit receipt PDA
        let (deposit_receipt_pda, _) = Pubkey::find_program_address(
            &[b"deposit_receipt", deposit_txid], &self.program_id,
        );

        // --- Instruction 1: btc-light-client verify_transaction ---
        let verify_tx_ix = self.build_verify_transaction_ix(
            payer, sweep_txid, merkle_proof, block_hash, sweep_tx_size,
            &light_client, &block_header_pda, &verified_tx_pda, sweep_buffer,
        )?;

        // --- Instruction 2: aegis verify_deposit_v2 (disc 25) ---
        // Layout: disc(1) + sweep_txid(32) + block_height(8) + sweep_tx_size(4) + deposit_txid(32) = 77
        let mut v2_data = Vec::with_capacity(77);
        v2_data.push(25u8); // discriminator
        v2_data.extend_from_slice(sweep_txid);
        v2_data.extend_from_slice(&block_height.to_le_bytes());
        v2_data.extend_from_slice(&sweep_tx_size.to_le_bytes());
        v2_data.extend_from_slice(deposit_txid);

        let v2_accounts = vec![
            AccountMeta::new(pool_state, false),                         // 0: pool_state
            AccountMeta::new_readonly(verified_tx_pda, false),           // 1: verified_tx
            AccountMeta::new_readonly(light_client, false),              // 2: light_client
            AccountMeta::new(commitment_tree, false),                    // 3: commitment_tree
            AccountMeta::new_readonly(*sweep_buffer, false),             // 4: sweep_tx_buffer
            AccountMeta::new(payer.pubkey(), true),                      // 5: authority/payer
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false), // 6: system_program
            AccountMeta::new(zkbtc_mint, false),                         // 7: zkbtc_mint
            AccountMeta::new(pool_vault, false),                         // 8: pool_vault
            AccountMeta::new_readonly(TOKEN_2022_PROGRAM_ID, false),     // 9: token_program
            AccountMeta::new(deposit_intent_pda, false),                 // 10: deposit_intent PDA
            AccountMeta::new(deposit_receipt_pda, false),                // 11: deposit_receipt
        ];

        let v2_ix = Instruction {
            program_id: self.program_id,
            accounts: v2_accounts,
            data: v2_data,
        };

        let recent_blockhash = self.rpc.get_latest_blockhash()
            .map_err(|e| VerifierError::RpcError(format!("Failed to get blockhash: {}", e)))?;

        let tx = Transaction::new_signed_with_payer(
            &[verify_tx_ix, v2_ix],
            Some(&payer.pubkey()),
            &[payer],
            recent_blockhash,
        );

        let sig = self.rpc.send_and_confirm_transaction(&tx)
            .map_err(|e| VerifierError::RpcError(format!("v2 verification tx failed: {}", e)))?;

        Ok(sig.to_string())
    }

    // =========================================================================
    // Verification Transaction
    // =========================================================================

    /// Get leaf index from a verify_stealth_deposit transaction's log events.
    ///
    /// Parses the stealth_announcement event (disc=0x03) emitted by the program.
    /// Event layout: disc(1) + type(1) + ephemeral_pub(32) + encrypted_amount(8) + commitment(32) + leaf_index(4)
    async fn get_leaf_index_from_tx(&self, signature: &str) -> Result<u64, VerifierError> {
        use base64::Engine;

        // Use raw JSON-RPC (same approach as event_indexer) to avoid solana-transaction-status dep
        let client = reqwest::Client::new();
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getTransaction",
            "params": [
                signature,
                { "encoding": "json", "maxSupportedTransactionVersion": 0, "commitment": "confirmed" }
            ],
        });

        let resp = client
            .post(self.rpc.url())
            .json(&body)
            .send()
            .await
            .map_err(|e| VerifierError::RpcError(format!("Failed to fetch tx: {}", e)))?;

        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| VerifierError::RpcError(format!("Failed to parse tx response: {}", e)))?;

        let logs = json["result"]["meta"]["logMessages"]
            .as_array()
            .ok_or_else(|| VerifierError::VerificationFailed("No log messages in tx".to_string()))?;

        for log_val in logs {
            let line = log_val.as_str().unwrap_or("");
            if let Some(b64) = line.strip_prefix("Program data: ") {
                let segments: Vec<Vec<u8>> = b64
                    .split_whitespace()
                    .filter_map(|s| base64::engine::general_purpose::STANDARD.decode(s).ok())
                    .collect();

                // Check disc segment = 0x03 (stealth announcement)
                if segments.is_empty() || segments[0].len() != 1 || segments[0][0] != 0x03 {
                    continue;
                }
                if segments.len() < 6 {
                    continue;
                }

                // leaf_index is segment[5], 4 bytes LE (u32)
                let li_bytes = &segments[5];
                if li_bytes.len() == 4 {
                    let leaf_index = u32::from_le_bytes(li_bytes[..4].try_into().unwrap());
                    return Ok(leaf_index as u64);
                }
            }
        }

        Err(VerifierError::VerificationFailed(
            "No stealth announcement event found in transaction logs".to_string(),
        ))
    }

    /// Send the verify_deposit transaction to Solana (two instructions).
    ///
    /// 1. btc-light-client verify_transaction (disc 2) — creates VerifiedTransaction PDA
    /// 2. aegis verify_stealth_deposit (disc 1) — reads ChadBuffer accounts, extracts npk
    #[allow(clippy::too_many_arguments)]
    async fn send_verify_deposit_tx(
        &self,
        payer: &Keypair,
        sweep_txid: &[u8; 32],
        deposit_txid: &[u8; 32],
        merkle_proof: &MerkleProofData,
        block_height: u64,
        block_hash: &[u8; 32],
        sweep_buffer: &Pubkey,
        sweep_tx_size: u32,
        deposit_buffer: &Pubkey,
        deposit_tx_size: u32,
    ) -> Result<String, VerifierError> {
        // Derive PDAs
        let (pool_state, _) = Pubkey::find_program_address(&[b"pool_state"], &self.program_id);
        let (light_client, _) = Pubkey::find_program_address(
            &[b"btc_light_client"],
            &self.light_client_program_id,
        );
        let (block_header_pda, _) = Pubkey::find_program_address(
            &[b"block", block_hash],
            &self.light_client_program_id,
        );
        let (verified_tx_pda, _) = Pubkey::find_program_address(
            &[b"verified_tx", block_hash, sweep_txid],
            &self.light_client_program_id,
        );
        let (commitment_tree, _) =
            Pubkey::find_program_address(&[b"commitment_tree"], &self.program_id);

        // Read zkbtc_mint and pool_vault from pool state account (not PDAs)
        let pool_account = self
            .rpc
            .get_account(&pool_state)
            .map_err(|e| VerifierError::RpcError(format!("Failed to get pool state: {}", e)))?;
        // PoolState layout: disc(1) + bump(1) + flags(1) + pad(1) + authority(32) + zkbtc_mint(32) + pool_vault(32)
        if pool_account.data.len() < 100 {
            return Err(VerifierError::VerificationFailed("pool state too small".to_string()));
        }
        let zkbtc_mint = Pubkey::try_from(&pool_account.data[36..68])
            .map_err(|_| VerifierError::VerificationFailed("invalid zkbtc_mint".to_string()))?;
        let pool_vault = Pubkey::try_from(&pool_account.data[68..100])
            .map_err(|_| VerifierError::VerificationFailed("invalid pool_vault".to_string()))?;
        println!("[verifier] zkbtc_mint: {}, pool_vault: {}", zkbtc_mint, pool_vault);

        // --- Instruction 1: btc-light-client verify_transaction (disc 2) ---
        let verify_tx_ix = self.build_verify_transaction_ix(
            payer,
            sweep_txid,
            merkle_proof,
            block_hash,
            sweep_tx_size,
            &light_client,
            &block_header_pda,
            &verified_tx_pda,
            sweep_buffer,
        )?;

        // --- Instruction 2: aegis verify_stealth_deposit (disc 1) ---
        // Layout: disc(1) + sweep_txid(32) + block_height(8) + sweep_tx_size(4) + deposit_tx_size(4) + deposit_txid(32)
        let mut deposit_data = Vec::with_capacity(81);
        deposit_data.push(1u8); // discriminator
        deposit_data.extend_from_slice(sweep_txid);
        deposit_data.extend_from_slice(&block_height.to_le_bytes());
        deposit_data.extend_from_slice(&sweep_tx_size.to_le_bytes());
        deposit_data.extend_from_slice(&deposit_tx_size.to_le_bytes());
        deposit_data.extend_from_slice(deposit_txid);

        // Derive deposit receipt PDA (prevents duplicate verification)
        let (deposit_receipt_pda, _) = Pubkey::find_program_address(
            &[b"deposit_receipt", deposit_txid],
            &self.program_id,
        );

        // 12 accounts for verify_stealth_deposit
        let deposit_accounts = vec![
            AccountMeta::new(pool_state, false),                        // 0: pool_state
            AccountMeta::new_readonly(verified_tx_pda, false),          // 1: verified_tx
            AccountMeta::new_readonly(light_client, false),             // 2: light_client
            AccountMeta::new(commitment_tree, false),                   // 3: commitment_tree
            AccountMeta::new_readonly(*sweep_buffer, false),            // 4: sweep_tx_buffer
            AccountMeta::new(payer.pubkey(), true),                     // 5: authority/payer
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false), // 6: system_program
            AccountMeta::new(zkbtc_mint, false),                        // 7: zkbtc_mint
            AccountMeta::new(pool_vault, false),                        // 8: pool_vault
            AccountMeta::new_readonly(TOKEN_2022_PROGRAM_ID, false),    // 9: token_program
            AccountMeta::new_readonly(*deposit_buffer, false),          // 10: deposit_tx_buffer
            AccountMeta::new(deposit_receipt_pda, false),               // 11: deposit_receipt
        ];

        let deposit_ix = Instruction {
            program_id: self.program_id,
            accounts: deposit_accounts,
            data: deposit_data,
        };

        // Get recent blockhash and send
        let recent_blockhash = self
            .rpc
            .get_latest_blockhash()
            .map_err(|e| VerifierError::RpcError(format!("Failed to get blockhash: {}", e)))?;

        let tx = Transaction::new_signed_with_payer(
            &[verify_tx_ix, deposit_ix],
            Some(&payer.pubkey()),
            &[payer],
            recent_blockhash,
        );

        let sig = self
            .rpc
            .send_and_confirm_transaction(&tx)
            .map_err(|e| VerifierError::RpcError(format!("Verification transaction failed: {}", e)))?;

        Ok(sig.to_string())
    }

    /// Build btc-light-client verify_transaction instruction (disc 2)
    #[allow(clippy::too_many_arguments)]
    fn build_verify_transaction_ix(
        &self,
        payer: &Keypair,
        txid: &[u8; 32],
        merkle_proof: &MerkleProofData,
        block_hash: &[u8; 32],
        tx_size: u32,
        light_client: &Pubkey,
        block_header_pda: &Pubkey,
        verified_tx_pda: &Pubkey,
        tx_buffer: &Pubkey,
    ) -> Result<Instruction, VerifierError> {
        let mut data = Vec::new();
        data.push(2u8); // discriminator

        // txid (32)
        data.extend_from_slice(txid);
        // block_hash (32)
        data.extend_from_slice(block_hash);
        // tx_size (4) — actual raw tx size
        data.extend_from_slice(&tx_size.to_le_bytes());

        // Merkle proof: [txid(32)][path_bits(4)][path_len(1)][tx_index(4)][siblings...]
        data.extend_from_slice(txid);
        data.extend_from_slice(&merkle_proof.pos.to_le_bytes());
        data.push(merkle_proof.merkle.len() as u8);
        data.extend_from_slice(&(merkle_proof.pos as u32).to_le_bytes());

        for sibling_hex in &merkle_proof.merkle {
            let sibling_bytes = hex::decode(sibling_hex)
                .map_err(|e| VerifierError::VerificationFailed(format!("invalid merkle: {}", e)))?;
            let mut sibling = [0u8; 32];
            sibling.copy_from_slice(&sibling_bytes);
            sibling.reverse();
            data.extend_from_slice(&sibling);
        }

        let accounts = vec![
            AccountMeta::new(*verified_tx_pda, false),
            AccountMeta::new_readonly(*light_client, false),
            AccountMeta::new_readonly(*block_header_pda, false),
            AccountMeta::new_readonly(*tx_buffer, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
        ];

        Ok(Instruction {
            program_id: self.light_client_program_id,
            accounts,
            data,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_verifier_creation() {
        let verifier = SpvVerifier::new_testnet("https://api.devnet.solana.com");
        assert!(verifier.payer_pubkey().is_none());
    }
}
