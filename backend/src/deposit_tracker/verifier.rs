//! SPV Verifier
//!
//! Submits sweep transactions for SPV verification on Solana.
//! Uses btc-light-client's verify_transaction to create a VerifiedTransaction PDA,
//! then calls zvault's verify_stealth_deposit with that PDA.

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

/// Token-2022 program ID (inline constant to avoid spl-token-2022 crate dependency)
const TOKEN_2022_PROGRAM_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

use super::watcher::{AddressWatcher, MerkleProofData, WatcherError};

/// Get zVault program ID from env or use devnet default
fn zvault_program_id() -> String {
    std::env::var("ZVAULT_PROGRAM_ID")
        .unwrap_or_else(|_| "25eTdotdeY9EqfJy5tfXSAD5Dg8XTL29sQYVgz1tJkTM".to_string())
}

/// Get BTC light client program ID from env or use devnet default
fn btc_light_client_program_id() -> String {
    std::env::var("BTC_LIGHT_CLIENT_PROGRAM_ID")
        .unwrap_or_else(|_| "Ho6UTeF8yFnRdCK15tSZtcJozvkDABJZWYxkgGyWAfyq".to_string())
}

/// Verifier errors
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

/// Result of successful verification
#[derive(Debug, Clone)]
pub struct VerificationResult {
    /// Solana transaction signature
    pub solana_tx: String,
    /// Leaf index in commitment tree
    pub leaf_index: u64,
    /// Block height where tx was included
    pub block_height: u64,
}

/// SPV Verifier for submitting deposits to Solana
pub struct SpvVerifier {
    /// Solana RPC client
    rpc: RpcClient,
    /// Payer keypair for transactions
    payer: Option<Keypair>,
    /// Bitcoin address watcher
    watcher: AddressWatcher,
    /// zVault program ID
    program_id: Pubkey,
    /// BTC Light Client program ID
    light_client_program_id: Pubkey,
}

impl SpvVerifier {
    /// Create verifier for devnet/testnet
    pub fn new_testnet(solana_rpc: &str) -> Self {
        Self {
            rpc: RpcClient::new_with_commitment(solana_rpc, CommitmentConfig::confirmed()),
            payer: None,
            watcher: AddressWatcher::from_network(crate::config::Network::Devnet),
            program_id: Pubkey::from_str(&zvault_program_id()).unwrap(),
            light_client_program_id: Pubkey::from_str(&btc_light_client_program_id()).unwrap(),
        }
    }

    /// Create verifier with custom configuration
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

    /// Set payer keypair
    pub fn set_payer(&mut self, keypair: Keypair) {
        self.payer = Some(keypair);
    }

    /// Set payer from JSON file
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

    /// Get payer pubkey
    pub fn payer_pubkey(&self) -> Option<Pubkey> {
        self.payer.as_ref().map(|k| k.pubkey())
    }

    /// Verify a Bitcoin deposit via VerifiedTransaction PDA (trustless npk extraction)
    ///
    /// The on-chain program now extracts npk + ephemeral_pub directly from the deposit TX's
    /// OP_RETURN. The backend no longer passes these as instruction data — instead it uploads
    /// both the sweep TX and deposit TX to ChadBuffer accounts.
    ///
    /// # Arguments
    /// * `sweep_txid` - The sweep transaction ID (hex, display order)
    /// * `vout` - Output index in the sweep transaction
    /// * `deposit_txid` - The original deposit transaction ID (hex, display order)
    ///
    /// # Returns
    /// Verification result with Solana tx and leaf index
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

        // Get block header (needed for verify_transaction)
        let block_header = self.watcher.get_block_header(block_height).await?;

        // Convert sweep txid to internal byte order
        let sweep_txid_bytes = hex::decode(sweep_txid)
            .map_err(|e| VerifierError::VerificationFailed(format!("invalid sweep txid: {}", e)))?;
        let mut sweep_txid_internal = [0u8; 32];
        sweep_txid_internal.copy_from_slice(&sweep_txid_bytes);
        sweep_txid_internal.reverse();

        // Convert deposit txid to internal byte order
        let deposit_txid_bytes = hex::decode(deposit_txid)
            .map_err(|e| VerifierError::VerificationFailed(format!("invalid deposit txid: {}", e)))?;
        let mut deposit_txid_internal = [0u8; 32];
        deposit_txid_internal.copy_from_slice(&deposit_txid_bytes);
        deposit_txid_internal.reverse();

        // Compute block hash from raw header (double SHA256)
        let header_bytes = hex::decode(&block_header.header_hex)
            .map_err(|e| VerifierError::VerificationFailed(format!("invalid header hex: {}", e)))?;
        let block_hash = double_sha256(&header_bytes);

        // Build and send verification transaction
        let solana_tx = self
            .send_verify_deposit_tx(
                payer,
                &sweep_txid_internal,
                &deposit_txid_internal,
                &merkle_proof,
                block_height,
                &block_hash,
            )
            .await?;

        // Get leaf index from the deposit record PDA
        let leaf_index = self.get_leaf_index(&sweep_txid_internal).await?;

        Ok(VerificationResult {
            solana_tx,
            leaf_index,
            block_height,
        })
    }

    /// Check if block header is available in the BTC light client
    ///
    /// Uses HeightIndex PDA to check if any canonical block exists at this height.
    pub async fn block_header_available(&self, height: u64) -> Result<bool, VerifierError> {
        // Derive the HeightIndex PDA
        let (height_index_pda, _) = Pubkey::find_program_address(
            &[b"height_index", &height.to_le_bytes()],
            &self.light_client_program_id,
        );

        // Check if the HeightIndex account exists
        match self.rpc.get_account(&height_index_pda) {
            Ok(account) => {
                // HeightIndex is 48 bytes, discriminator 0x09
                Ok(account.data.len() >= 48 && account.data[0] == 0x09)
            }
            Err(_) => Ok(false),
        }
    }

    /// Check if a deposit has already been verified
    pub async fn is_already_verified(&self, sweep_txid: &str) -> Result<bool, VerifierError> {
        // Convert txid to internal byte order
        let txid_bytes = hex::decode(sweep_txid)
            .map_err(|e| VerifierError::VerificationFailed(format!("invalid txid: {}", e)))?;
        let mut txid_internal = [0u8; 32];
        txid_internal.copy_from_slice(&txid_bytes);
        txid_internal.reverse();

        // Derive stealth announcement PDA (unified: ["stealth", txid])
        let (deposit_record, _) = Pubkey::find_program_address(
            &[b"stealth", &txid_internal],
            &self.program_id,
        );

        // Check if account exists
        match self.rpc.get_account(&deposit_record) {
            Ok(_) => Ok(true),
            Err(_) => Ok(false),
        }
    }

    /// Get leaf index for a verified deposit
    async fn get_leaf_index(&self, txid: &[u8; 32]) -> Result<u64, VerifierError> {
        // Derive stealth announcement PDA (unified: ["stealth", txid])
        let (stealth_pda, _) = Pubkey::find_program_address(
            &[b"stealth", txid],
            &self.program_id,
        );

        // Get account data
        let account = self
            .rpc
            .get_account(&stealth_pda)
            .map_err(|e| VerifierError::RpcError(format!("Failed to get stealth announcement: {}", e)))?;

        // Parse leaf index from on-chain StealthAnnouncement layout (90 bytes):
        //   discriminator: u8          (offset 0)
        //   announcement_type: u8      (offset 1)
        //   ephemeral_pub: [u8; 32]    (offset 2)
        //   amount_bytes: [u8; 8]      (offset 34)
        //   commitment: [u8; 32]       (offset 42)
        //   leaf_index: [u8; 8]        (offset 74)
        //   created_at: [u8; 8]        (offset 82)
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

    /// Send the verify_deposit transaction to Solana (two instructions)
    ///
    /// 1. btc-light-client verify_transaction (disc 3) — creates VerifiedTransaction PDA
    /// 2. zvault verify_stealth_deposit (disc 1) — uses VerifiedTransaction PDA
    ///    npk + ephemeral_pub are extracted on-chain from the deposit TX's OP_RETURN
    async fn send_verify_deposit_tx(
        &self,
        payer: &Keypair,
        sweep_txid: &[u8; 32],
        deposit_txid: &[u8; 32],
        merkle_proof: &MerkleProofData,
        block_height: u64,
        block_hash: &[u8; 32],
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

        // --- Instruction 1: btc-light-client verify_transaction (disc 3) ---
        let verify_tx_ix = self.build_verify_transaction_ix(
            payer,
            sweep_txid,
            merkle_proof,
            block_hash,
            &light_client,
            &block_header_pda,
            &verified_tx_pda,
        )?;

        // --- Instruction 2: zvault verify_stealth_deposit (disc 1) ---
        // New layout: sweep_txid(32) + block_height(8) + sweep_tx_size(4) + deposit_tx_size(4) + deposit_txid(32) = 80 bytes
        let mut deposit_data = Vec::new();
        deposit_data.push(1u8); // discriminator

        // sweep_txid (32)
        deposit_data.extend_from_slice(sweep_txid);
        // block_height (8)
        deposit_data.extend_from_slice(&block_height.to_le_bytes());
        // sweep_tx_size (4) — raw tx size in ChadBuffer (placeholder, set by ChadBuffer upload)
        deposit_data.extend_from_slice(&0u32.to_le_bytes());
        // deposit_tx_size (4) — raw deposit tx size in ChadBuffer (placeholder)
        deposit_data.extend_from_slice(&0u32.to_le_bytes());
        // deposit_txid (32)
        deposit_data.extend_from_slice(deposit_txid);

        // 12 accounts for verify_stealth_deposit:
        //   0.  pool_state (writable)
        //   1.  verified_tx (readonly, owned by btc-light-client)
        //   2.  light_client (readonly, owned by btc-light-client)
        //   3.  commitment_tree (writable)
        //   4.  stealth_announcement (writable)
        //   5.  sweep_tx_buffer (readonly) — ChadBuffer with sweep TX
        //   6.  authority/payer (signer)
        //   7.  system_program (readonly)
        //   8.  zbtc_mint (writable)
        //   9.  pool_vault (writable)
        //   10. token_program (readonly)
        //   11. deposit_tx_buffer (readonly) — ChadBuffer with deposit TX
        let deposit_accounts = vec![
            AccountMeta::new(pool_state, false),
            AccountMeta::new_readonly(verified_tx_pda, false),
            AccountMeta::new_readonly(light_client, false),
            AccountMeta::new(commitment_tree, false),
            AccountMeta::new(stealth_announcement, false),
            // sweep_tx_buffer — placeholder, must be set by caller via ChadBuffer upload
            AccountMeta::new_readonly(Pubkey::default(), false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
            // zbtc_mint and pool_vault — must be derived from pool state
            AccountMeta::new(Pubkey::default(), false), // zbtc_mint placeholder
            AccountMeta::new(Pubkey::default(), false), // pool_vault placeholder
            AccountMeta::new_readonly(TOKEN_2022_PROGRAM_ID, false),
            // deposit_tx_buffer — placeholder, must be set by caller via ChadBuffer upload
            AccountMeta::new_readonly(Pubkey::default(), false),
        ];

        let deposit_ix = Instruction {
            program_id: self.program_id,
            accounts: deposit_accounts,
            data: deposit_data,
        };

        // Get recent blockhash
        let recent_blockhash = self
            .rpc
            .get_latest_blockhash()
            .map_err(|e| VerifierError::RpcError(format!("Failed to get blockhash: {}", e)))?;

        // Build and sign transaction with both instructions
        let tx = Transaction::new_signed_with_payer(
            &[verify_tx_ix, deposit_ix],
            Some(&payer.pubkey()),
            &[payer],
            recent_blockhash,
        );

        // Send transaction
        let sig = self
            .rpc
            .send_and_confirm_transaction(&tx)
            .map_err(|e| VerifierError::RpcError(format!("Transaction failed: {}", e)))?;

        Ok(sig.to_string())
    }

    /// Build btc-light-client verify_transaction instruction (disc 2)
    fn build_verify_transaction_ix(
        &self,
        payer: &Keypair,
        txid: &[u8; 32],
        merkle_proof: &MerkleProofData,
        block_hash: &[u8; 32],
        light_client: &Pubkey,
        block_header_pda: &Pubkey,
        verified_tx_pda: &Pubkey,
    ) -> Result<Instruction, VerifierError> {
        let mut data = Vec::new();
        data.push(2u8); // discriminator (verify_transaction = 2 in new dispatch)

        // txid (32)
        data.extend_from_slice(txid);
        // block_hash (32) — was block_height(8) in old version
        data.extend_from_slice(block_hash);
        // tx_size (4) — placeholder, validated on-chain from ChadBuffer
        data.extend_from_slice(&0u32.to_le_bytes());

        // Merkle proof: [txid(32)][path_bits(4)][path_len(1)][tx_index(4)][siblings...]
        data.extend_from_slice(txid); // proof txid
        data.extend_from_slice(&merkle_proof.pos.to_le_bytes()); // path_bits
        data.push(merkle_proof.merkle.len() as u8); // path_len
        data.extend_from_slice(&(merkle_proof.pos as u32).to_le_bytes()); // tx_index

        // Merkle siblings
        for sibling_hex in &merkle_proof.merkle {
            let sibling_bytes = hex::decode(sibling_hex)
                .map_err(|e| VerifierError::VerificationFailed(format!("invalid merkle: {}", e)))?;
            let mut sibling = [0u8; 32];
            sibling.copy_from_slice(&sibling_bytes);
            sibling.reverse(); // Internal byte order
            data.extend_from_slice(&sibling);
        }

        // tx_buffer — placeholder account (ChadBuffer with raw tx)
        // In production, caller uploads raw tx to ChadBuffer first

        let accounts = vec![
            AccountMeta::new(*verified_tx_pda, false),
            AccountMeta::new_readonly(*light_client, false),
            AccountMeta::new_readonly(*block_header_pda, false),
            AccountMeta::new_readonly(Pubkey::default(), false), // tx_buffer placeholder
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

/// Double SHA256 hash
fn double_sha256(data: &[u8]) -> [u8; 32] {
    use sha2::{Sha256, Digest};
    let first = Sha256::digest(data);
    let second = Sha256::digest(&first);
    let mut result = [0u8; 32];
    result.copy_from_slice(&second);
    result
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
