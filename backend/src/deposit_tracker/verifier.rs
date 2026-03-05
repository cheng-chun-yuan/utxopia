//! SPV Verifier
//!
//! Submits sweep transactions for SPV verification on Solana.
//! Uses btc-light-client's verify_transaction to create a VerifiedTransaction PDA,
//! then calls aegis's verify_stealth_deposit with that PDA.
//!
//! Raw Bitcoin transactions are uploaded to ChadBuffer accounts before verification.

use solana_client::rpc_client::RpcClient;
use solana_sdk::{
    commitment_config::CommitmentConfig,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer as SolanaSigner},
    system_instruction,
    transaction::Transaction,
};
use solana_sdk::pubkey;
use std::str::FromStr;
use thiserror::Error;

use super::watcher::{AddressWatcher, MerkleProofData, WatcherError};

// =============================================================================
// Constants
// =============================================================================

/// Token-2022 program ID
const TOKEN_2022_PROGRAM_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/// ChadBuffer program ID (deployed to devnet)
const CHADBUFFER_PROGRAM_ID: Pubkey = pubkey!("C5RpjtTMFXKVZCtXSzKXD4CDNTaWBg3dVeMfYvjZYHDF");

/// ChadBuffer authority header size (32 bytes for payer pubkey)
const CHADBUFFER_AUTHORITY_SIZE: usize = 32;

/// Solana transaction size limit
const SOLANA_TX_SIZE_LIMIT: usize = 1232;

/// ChadBuffer write TX overhead (signature + header + accounts + instruction header + disc + offset)
const CHADBUFFER_WRITE_TX_OVERHEAD: usize = 176;

/// Maximum data bytes per ChadBuffer write transaction
const CHADBUFFER_MAX_DATA_PER_WRITE: usize = SOLANA_TX_SIZE_LIMIT - CHADBUFFER_WRITE_TX_OVERHEAD;

/// Get Aegis program ID from env or use devnet default
fn aegis_program_id() -> String {
    std::env::var("AEGIS_PROGRAM_ID")
        .unwrap_or_else(|_| "25eTdotdeY9EqfJy5tfXSAD5Dg8XTL29sQYVgz1tJkTM".to_string())
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

        let sweep_raw_tx = strip_witness_data(&sweep_raw_full)?;
        let deposit_raw_tx = strip_witness_data(&deposit_raw_full)?;

        println!(
            "[verifier] Raw txs: sweep={} bytes (from {}), deposit={} bytes (from {})",
            sweep_raw_tx.len(), sweep_raw_full.len(),
            deposit_raw_tx.len(), deposit_raw_full.len(),
        );

        // Convert txids to internal byte order
        let sweep_txid_internal = txid_to_internal(sweep_txid)?;
        let deposit_txid_internal = txid_to_internal(deposit_txid)?;

        // Compute block hash from raw header (double SHA256)
        let header_bytes = hex::decode(block_header.header_hex.trim())
            .map_err(|e| VerifierError::VerificationFailed(format!("invalid header hex: {}", e)))?;
        let block_hash = double_sha256(&header_bytes);

        // Upload raw transactions to ChadBuffer accounts
        let (sweep_buffer_pubkey, sweep_buffer_keypair) =
            self.upload_to_chadbuffer(payer, &sweep_raw_tx)?;
        let (deposit_buffer_pubkey, deposit_buffer_keypair) =
            self.upload_to_chadbuffer(payer, &deposit_raw_tx)?;

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
        let _ = self.close_chadbuffer(payer, &sweep_buffer_pubkey);
        let _ = self.close_chadbuffer(payer, &deposit_buffer_pubkey);
        // Drop keypairs (no longer needed after close)
        drop(sweep_buffer_keypair);
        drop(deposit_buffer_keypair);

        let solana_tx = result?;

        // Get leaf index from the stealth announcement PDA
        let leaf_index = self.get_leaf_index(&sweep_txid_internal).await?;

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

    /// Check if a deposit has already been verified
    pub async fn is_already_verified(&self, sweep_txid: &str) -> Result<bool, VerifierError> {
        let txid_internal = txid_to_internal(sweep_txid)?;

        let (deposit_record, _) = Pubkey::find_program_address(
            &[b"stealth", &txid_internal],
            &self.program_id,
        );

        match self.rpc.get_account(&deposit_record) {
            Ok(_) => Ok(true),
            Err(_) => Ok(false),
        }
    }

    // =========================================================================
    // ChadBuffer Upload / Close
    // =========================================================================

    /// Upload raw transaction data to a ChadBuffer account.
    ///
    /// Creates a new account owned by the ChadBuffer program, then initializes it
    /// with the payer as authority and writes raw tx data in chunks.
    ///
    /// Buffer format: `[authority_pubkey (32 bytes)][raw_tx_data...]`
    fn upload_to_chadbuffer(
        &self,
        payer: &Keypair,
        raw_tx: &[u8],
    ) -> Result<(Pubkey, Keypair), VerifierError> {
        let buffer_keypair = Keypair::new();
        let space = CHADBUFFER_AUTHORITY_SIZE + raw_tx.len();

        // Get rent exemption
        let rent = self
            .rpc
            .get_minimum_balance_for_rent_exemption(space)
            .map_err(|e| VerifierError::RpcError(format!("Failed to get rent: {}", e)))?;

        // TX 1: Create account owned by ChadBuffer program
        let create_ix = system_instruction::create_account(
            &payer.pubkey(),
            &buffer_keypair.pubkey(),
            rent,
            space as u64,
            &CHADBUFFER_PROGRAM_ID,
        );

        let blockhash = self
            .rpc
            .get_latest_blockhash()
            .map_err(|e| VerifierError::RpcError(format!("Failed to get blockhash: {}", e)))?;

        let tx = Transaction::new_signed_with_payer(
            &[create_ix],
            Some(&payer.pubkey()),
            &[payer, &buffer_keypair],
            blockhash,
        );

        self.rpc
            .send_and_confirm_transaction(&tx)
            .map_err(|e| VerifierError::RpcError(format!("Failed to create buffer account: {}", e)))?;

        // Split raw tx into chunks
        let chunks = split_into_chunks(raw_tx, CHADBUFFER_MAX_DATA_PER_WRITE);

        // TX 2: ChadBuffer Init (disc 0) with first chunk
        let mut init_data = Vec::with_capacity(1 + chunks[0].len());
        init_data.push(0u8); // ChadBuffer::Create discriminator
        init_data.extend_from_slice(&chunks[0]);

        let init_ix = Instruction {
            program_id: CHADBUFFER_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new(buffer_keypair.pubkey(), false),
            ],
            data: init_data,
        };

        let blockhash = self
            .rpc
            .get_latest_blockhash()
            .map_err(|e| VerifierError::RpcError(format!("Failed to get blockhash: {}", e)))?;

        let tx = Transaction::new_signed_with_payer(
            &[init_ix],
            Some(&payer.pubkey()),
            &[payer],
            blockhash,
        );

        self.rpc
            .send_and_confirm_transaction(&tx)
            .map_err(|e| VerifierError::RpcError(format!("Failed to init buffer: {}", e)))?;

        // TX 3+: Write remaining chunks
        let mut offset = chunks[0].len();
        for chunk in &chunks[1..] {
            let mut write_data = Vec::with_capacity(4 + chunk.len());
            write_data.push(2u8); // ChadBuffer::Write discriminator
            // u24 offset (little-endian)
            write_data.push((offset & 0xff) as u8);
            write_data.push(((offset >> 8) & 0xff) as u8);
            write_data.push(((offset >> 16) & 0xff) as u8);
            write_data.extend_from_slice(chunk);

            let write_ix = Instruction {
                program_id: CHADBUFFER_PROGRAM_ID,
                accounts: vec![
                    AccountMeta::new(payer.pubkey(), true),
                    AccountMeta::new(buffer_keypair.pubkey(), false),
                ],
                data: write_data,
            };

            let blockhash = self
                .rpc
                .get_latest_blockhash()
                .map_err(|e| VerifierError::RpcError(format!("Failed to get blockhash: {}", e)))?;

            let tx = Transaction::new_signed_with_payer(
                &[write_ix],
                Some(&payer.pubkey()),
                &[payer],
                blockhash,
            );

            self.rpc
                .send_and_confirm_transaction(&tx)
                .map_err(|e| VerifierError::RpcError(format!("Failed to write buffer chunk: {}", e)))?;

            offset += chunk.len();
        }

        tracing::debug!(
            "ChadBuffer uploaded: {} ({} bytes, {} chunks)",
            buffer_keypair.pubkey(),
            raw_tx.len(),
            chunks.len()
        );

        Ok((buffer_keypair.pubkey(), buffer_keypair))
    }

    /// Close a ChadBuffer account and reclaim rent lamports.
    fn close_chadbuffer(&self, payer: &Keypair, buffer_pubkey: &Pubkey) -> Result<(), VerifierError> {
        let close_ix = Instruction {
            program_id: CHADBUFFER_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new(*buffer_pubkey, false),
            ],
            data: vec![3u8], // ChadBuffer::Close discriminator
        };

        let blockhash = self
            .rpc
            .get_latest_blockhash()
            .map_err(|e| VerifierError::RpcError(format!("Failed to get blockhash: {}", e)))?;

        let tx = Transaction::new_signed_with_payer(
            &[close_ix],
            Some(&payer.pubkey()),
            &[payer],
            blockhash,
        );

        self.rpc
            .send_and_confirm_transaction(&tx)
            .map_err(|e| VerifierError::RpcError(format!("Failed to close buffer: {}", e)))?;

        Ok(())
    }

    // =========================================================================
    // Verification Transaction
    // =========================================================================

    /// Get leaf index for a verified deposit
    async fn get_leaf_index(&self, txid: &[u8; 32]) -> Result<u64, VerifierError> {
        let (stealth_pda, _) = Pubkey::find_program_address(
            &[b"stealth", txid],
            &self.program_id,
        );

        let account = self
            .rpc
            .get_account(&stealth_pda)
            .map_err(|e| VerifierError::RpcError(format!("Failed to get stealth announcement: {}", e)))?;

        // StealthAnnouncement layout (82 bytes):
        //   discriminator: u8          (offset 0)
        //   announcement_type: u8      (offset 1)
        //   ephemeral_pub: [u8; 32]    (offset 2)
        //   amount_bytes: [u8; 8]      (offset 34)
        //   commitment: [u8; 32]       (offset 42)
        //   leaf_index: [u8; 8]        (offset 74)
        const LEAF_INDEX_OFFSET: usize = 74;
        const LEAF_INDEX_END: usize = LEAF_INDEX_OFFSET + 8;

        if account.data.len() < LEAF_INDEX_END {
            return Err(VerifierError::VerificationFailed(format!(
                "stealth announcement too small: {} bytes, need at least {}",
                account.data.len(),
                LEAF_INDEX_END
            )));
        }

        let leaf_index = u64::from_le_bytes(
            account.data[LEAF_INDEX_OFFSET..LEAF_INDEX_END]
                .try_into()
                .map_err(|_| VerifierError::VerificationFailed("Invalid leaf_index bytes".to_string()))?,
        );
        Ok(leaf_index)
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
        let (stealth_announcement, _) =
            Pubkey::find_program_address(&[b"stealth", sweep_txid], &self.program_id);
        let (commitment_tree, _) =
            Pubkey::find_program_address(&[b"commitment_tree"], &self.program_id);

        // Read zbtc_mint and pool_vault from pool state account (not PDAs)
        let pool_account = self
            .rpc
            .get_account(&pool_state)
            .map_err(|e| VerifierError::RpcError(format!("Failed to get pool state: {}", e)))?;
        // PoolState layout: disc(1) + bump(1) + flags(1) + pad(1) + authority(32) + zbtc_mint(32) + pool_vault(32)
        if pool_account.data.len() < 100 {
            return Err(VerifierError::VerificationFailed("pool state too small".to_string()));
        }
        let zbtc_mint = Pubkey::try_from(&pool_account.data[36..68])
            .map_err(|_| VerifierError::VerificationFailed("invalid zbtc_mint".to_string()))?;
        let pool_vault = Pubkey::try_from(&pool_account.data[68..100])
            .map_err(|_| VerifierError::VerificationFailed("invalid pool_vault".to_string()))?;
        println!("[verifier] zbtc_mint: {}, pool_vault: {}", zbtc_mint, pool_vault);

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

        // 12 accounts for verify_stealth_deposit
        let deposit_accounts = vec![
            AccountMeta::new(pool_state, false),                        // 0: pool_state
            AccountMeta::new_readonly(verified_tx_pda, false),          // 1: verified_tx
            AccountMeta::new_readonly(light_client, false),             // 2: light_client
            AccountMeta::new(commitment_tree, false),                   // 3: commitment_tree
            AccountMeta::new(stealth_announcement, false),              // 4: stealth_announcement
            AccountMeta::new_readonly(*sweep_buffer, false),            // 5: sweep_tx_buffer
            AccountMeta::new(payer.pubkey(), true),                     // 6: authority/payer
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false), // 7: system_program
            AccountMeta::new(zbtc_mint, false),                         // 8: zbtc_mint
            AccountMeta::new(pool_vault, false),                        // 9: pool_vault
            AccountMeta::new_readonly(TOKEN_2022_PROGRAM_ID, false),    // 10: token_program
            AccountMeta::new_readonly(*deposit_buffer, false),          // 11: deposit_tx_buffer
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

// =============================================================================
// Helpers
// =============================================================================

/// Convert display-order hex txid to internal byte order (reversed)
fn txid_to_internal(txid_hex: &str) -> Result<[u8; 32], VerifierError> {
    let bytes = hex::decode(txid_hex)
        .map_err(|e| VerifierError::VerificationFailed(format!("invalid txid: {}", e)))?;
    if bytes.len() != 32 {
        return Err(VerifierError::VerificationFailed(format!(
            "txid must be 32 bytes, got {}",
            bytes.len()
        )));
    }
    let mut internal = [0u8; 32];
    internal.copy_from_slice(&bytes);
    internal.reverse();
    Ok(internal)
}

/// Double SHA256 hash
fn double_sha256(data: &[u8]) -> [u8; 32] {
    use sha2::{Sha256, Digest};
    let first = Sha256::digest(data);
    let second = Sha256::digest(&first);
    let mut result = [0u8; 32];
    result.copy_from_slice(&second);
    result
}

/// Strip witness data from a segwit transaction to get the non-witness serialization.
///
/// Bitcoin txid = double_sha256(non-witness serialization), but the raw tx from
/// Esplora includes witness data. For segwit txs (marker=0x00, flag=0x01 after version),
/// we need to strip the marker, flag, and all witness items.
///
/// Non-witness format: [version(4)][input_count][inputs...][output_count][outputs...][locktime(4)]
/// Witness format:     [version(4)][0x00][0x01][input_count][inputs...][output_count][outputs...][witness...][locktime(4)]
fn strip_witness_data(raw_tx: &[u8]) -> Result<Vec<u8>, VerifierError> {
    if raw_tx.len() < 10 {
        return Err(VerifierError::VerificationFailed("tx too short".to_string()));
    }

    // Check if this is a segwit transaction (marker=0x00, flag=0x01 after 4-byte version)
    if raw_tx[4] != 0x00 || raw_tx[5] != 0x01 {
        // Not segwit — already in non-witness format
        return Ok(raw_tx.to_vec());
    }

    let mut result = Vec::with_capacity(raw_tx.len());
    // Copy version (4 bytes)
    result.extend_from_slice(&raw_tx[0..4]);

    // Skip marker (0x00) and flag (0x01) — start parsing from offset 6
    let mut pos = 6;

    // Read input count (varint)
    let (input_count, varint_len) = read_varint(&raw_tx[pos..])?;
    let input_start = pos;

    // Skip past all inputs
    pos += varint_len;
    for _ in 0..input_count {
        // txid(32) + vout(4)
        pos += 36;
        // script_len (varint) + script
        let (script_len, vl) = read_varint(&raw_tx[pos..])?;
        pos += vl + script_len as usize;
        // sequence (4)
        pos += 4;
    }

    // Read output count (varint)
    let (output_count, vl) = read_varint(&raw_tx[pos..])?;
    pos += vl;

    // Skip past all outputs
    for _ in 0..output_count {
        // value (8 bytes)
        pos += 8;
        // script_len (varint) + script
        let (script_len, vl) = read_varint(&raw_tx[pos..])?;
        pos += vl + script_len as usize;
    }

    // pos is now past all outputs. Copy inputs + outputs (from input_start to pos)
    result.extend_from_slice(&raw_tx[input_start..pos]);

    // Locktime is always the last 4 bytes of the raw transaction
    if raw_tx.len() < 4 {
        return Err(VerifierError::VerificationFailed("tx too short for locktime".to_string()));
    }
    result.extend_from_slice(&raw_tx[raw_tx.len() - 4..]);

    Ok(result)
}

/// Read a Bitcoin varint (CompactSize) from a byte slice.
/// Returns (value, bytes_consumed).
fn read_varint(data: &[u8]) -> Result<(u64, usize), VerifierError> {
    if data.is_empty() {
        return Err(VerifierError::VerificationFailed("unexpected end of tx data".to_string()));
    }
    match data[0] {
        0..=0xfc => Ok((data[0] as u64, 1)),
        0xfd => {
            if data.len() < 3 {
                return Err(VerifierError::VerificationFailed("truncated varint".to_string()));
            }
            Ok((u16::from_le_bytes([data[1], data[2]]) as u64, 3))
        }
        0xfe => {
            if data.len() < 5 {
                return Err(VerifierError::VerificationFailed("truncated varint".to_string()));
            }
            Ok((u32::from_le_bytes([data[1], data[2], data[3], data[4]]) as u64, 5))
        }
        0xff => {
            if data.len() < 9 {
                return Err(VerifierError::VerificationFailed("truncated varint".to_string()));
            }
            Ok((u64::from_le_bytes(data[1..9].try_into().unwrap()), 9))
        }
    }
}

/// Split data into chunks of at most `chunk_size` bytes
fn split_into_chunks(data: &[u8], chunk_size: usize) -> Vec<&[u8]> {
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < data.len() {
        let end = std::cmp::min(start + chunk_size, data.len());
        chunks.push(&data[start..end]);
        start = end;
    }
    if chunks.is_empty() {
        chunks.push(&data[..0]); // empty chunk for zero-length data
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_verifier_creation() {
        let verifier = SpvVerifier::new_testnet("https://api.devnet.solana.com");
        assert!(verifier.payer_pubkey().is_none());
    }

    #[test]
    fn test_txid_to_internal() {
        let txid = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
        let internal = txid_to_internal(txid).unwrap();
        // Should be reversed byte order
        assert_eq!(internal[0], 0x89);
        assert_eq!(internal[31], 0xab);
    }

    #[test]
    fn test_split_into_chunks() {
        let data = vec![1u8; 2500];
        let chunks = split_into_chunks(&data, 1000);
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].len(), 1000);
        assert_eq!(chunks[1].len(), 1000);
        assert_eq!(chunks[2].len(), 500);
    }

    #[test]
    fn test_split_single_chunk() {
        let data = vec![1u8; 500];
        let chunks = split_into_chunks(&data, 1000);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].len(), 500);
    }
}
