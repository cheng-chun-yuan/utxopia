//! SPV Verifier
//!
//! Submits sweep transactions for SPV verification on Solana.
//! Uses btc-relay's verify_transaction to create a VerifiedTransaction PDA,
//! then calls zvault's verify_stealth_deposit with that PDA.

use bitcoin::consensus::encode::deserialize as btc_deserialize;
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

use super::sweeper::extract_deposit_op_return_from_transaction;
use super::watcher::{AddressWatcher, MerkleProofData, WatcherError};

/// Get zVault program ID from env or use devnet default
fn zvault_program_id() -> String {
    std::env::var("ZVAULT_PROGRAM_ID")
        .unwrap_or_else(|_| "2dBmKyfLibkqdxgyEWUhHos3g56oU2wXLVrucY2dCpGV".to_string())
}

/// Get BTC light client program ID from env or use devnet default
fn btc_light_client_program_id() -> String {
    std::env::var("BTC_LIGHT_CLIENT_PROGRAM_ID")
        .or_else(|_| std::env::var("BTC_RELAY_PROGRAM_ID"))
        .unwrap_or_else(|_| "DeDut4fkjbWBPY4FRUU3q9BUcvwTisHczj1EQmqX5avS".to_string())
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

    #[error("Invalid npk: {0}")]
    InvalidNpk(String),
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
            watcher: AddressWatcher::testnet(),
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

    /// Verify a Bitcoin deposit via VerifiedTransaction PDA
    ///
    /// Two-step process:
    /// 1. Call btc-relay's verify_transaction (disc 3) to create VerifiedTransaction PDA
    /// 2. Call zvault's verify_stealth_deposit with VerifiedTransaction PDA
    ///
    /// # Arguments
    /// * `sweep_txid` - The sweep transaction ID (NOT the original deposit)
    /// * `vout` - Output index in the sweep transaction
    /// * `npk` - The note public key (hex) for on-chain commitment computation
    /// * `ephemeral_pub` - The ephemeral Ed25519 public key (hex) for stealth scanning
    /// * `amount_sats` - Expected amount in satoshis
    ///
    /// # Returns
    /// Verification result with Solana tx and leaf index
    pub async fn verify_deposit(
        &self,
        sweep_txid: &str,
        vout: u32,
        npk: &str,
        ephemeral_pub: &str,
        amount_sats: u64,
    ) -> Result<VerificationResult, VerifierError> {
        let payer = self.payer.as_ref().ok_or(VerifierError::NoPayerSet)?;

        // Parse npk
        let npk_bytes = hex::decode(npk)
            .map_err(|e| VerifierError::InvalidNpk(format!("invalid hex: {}", e)))?;
        if npk_bytes.len() != 32 {
            return Err(VerifierError::InvalidNpk(format!(
                "wrong length: {}",
                npk_bytes.len()
            )));
        }
        let mut npk_arr = [0u8; 32];
        npk_arr.copy_from_slice(&npk_bytes);

        // Parse ephemeral_pub
        let eph_bytes = hex::decode(ephemeral_pub)
            .map_err(|e| VerifierError::InvalidNpk(format!("invalid ephemeral_pub hex: {}", e)))?;
        if eph_bytes.len() != 32 {
            return Err(VerifierError::InvalidNpk(format!(
                "wrong ephemeral_pub length: {}",
                eph_bytes.len()
            )));
        }
        let mut eph_arr = [0u8; 32];
        eph_arr.copy_from_slice(&eph_bytes);

        // Get transaction confirmation status
        let tx_status = self.watcher.get_tx_confirmations(sweep_txid).await?;
        if !tx_status.confirmed {
            return Err(VerifierError::TxNotConfirmed);
        }

        let block_height = tx_status
            .block_height
            .ok_or(VerifierError::TxNotConfirmed)?;

        // Get merkle proof
        let merkle_proof = self.watcher.get_merkle_proof(sweep_txid).await?;

        // Get block header (needed for verify_transaction)
        let block_header = self.watcher.get_block_header(block_height).await?;

        // Convert txid to internal byte order
        let txid_bytes = hex::decode(sweep_txid)
            .map_err(|e| VerifierError::VerificationFailed(format!("invalid txid: {}", e)))?;
        let mut txid_internal = [0u8; 32];
        txid_internal.copy_from_slice(&txid_bytes);
        txid_internal.reverse();

        // Compute block hash from raw header (double SHA256)
        let header_bytes = hex::decode(&block_header.header_hex)
            .map_err(|e| VerifierError::VerificationFailed(format!("invalid header hex: {}", e)))?;
        let block_hash = double_sha256(&header_bytes);

        // Build and send verification transaction
        let solana_tx = self
            .send_verify_deposit_tx(
                payer,
                &txid_internal,
                &merkle_proof,
                &block_header.header_hex,
                block_height,
                amount_sats,
                &eph_arr,
                &npk_arr,
                &block_hash,
            )
            .await?;

        // Get leaf index from the deposit record PDA
        let leaf_index = self.get_leaf_index(&txid_internal).await?;

        Ok(VerificationResult {
            solana_tx,
            leaf_index,
            block_height,
        })
    }

    /// Verify a Bitcoin deposit by extracting npk + ephemeral_pub from the sweep tx's OP_RETURN.
    ///
    /// This is the trustless version — the npk and ephemeral_pub are read directly
    /// from the Bitcoin transaction's 64-byte OP_RETURN rather than passed as parameters.
    /// The on-chain program computes the commitment from npk + amount.
    ///
    /// # Arguments
    /// * `sweep_txid` - The sweep transaction ID
    /// * `vout` - Output index of the P2TR payment (not the OP_RETURN)
    /// * `amount_sats` - Expected amount in satoshis
    pub async fn verify_deposit_from_tx(
        &self,
        sweep_txid: &str,
        vout: u32,
        amount_sats: u64,
    ) -> Result<VerificationResult, VerifierError> {
        // Fetch raw transaction hex from Esplora and decode
        let tx_hex = self.watcher.get_tx_hex(sweep_txid).await?;
        let raw_tx = hex::decode(tx_hex.trim())
            .map_err(|e| VerifierError::VerificationFailed(format!("invalid tx hex: {}", e)))?;

        // Parse raw transaction and extract OP_RETURN data (ephemeral_pub + npk)
        let tx: bitcoin::Transaction = btc_deserialize(&raw_tx)
            .map_err(|e| VerifierError::VerificationFailed(format!("invalid tx: {}", e)))?;

        let op_return_data = extract_deposit_op_return_from_transaction(&tx).ok_or_else(|| {
            VerifierError::InvalidNpk(
                "no deposit OP_RETURN found in sweep transaction".to_string(),
            )
        })?;

        let npk_hex = hex::encode(op_return_data.npk);
        let eph_hex = hex::encode(op_return_data.ephemeral_pub);
        self.verify_deposit(sweep_txid, vout, &npk_hex, &eph_hex, amount_sats)
            .await
    }

    /// Check if block header is available in the BTC light client
    ///
    /// This verifies that the header-relayer has synced the required block
    /// before attempting SPV verification.
    pub async fn block_header_available(&self, height: u64) -> Result<bool, VerifierError> {
        // Derive the block header PDA
        let (block_header_pda, _) = Pubkey::find_program_address(
            &[b"block_header", &height.to_le_bytes()],
            &self.light_client_program_id,
        );

        // Check if the account exists and has data
        match self.rpc.get_account(&block_header_pda) {
            Ok(account) => {
                // Account exists - check if it has sufficient data for a block header
                // Block header account should have at least 80 bytes for the raw header
                Ok(account.data.len() >= 80)
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

        // Derive deposit record PDA
        let (deposit_record, _) = Pubkey::find_program_address(
            &[b"deposit", &txid_internal],
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
        // Derive deposit record PDA
        let (deposit_record, _) = Pubkey::find_program_address(
            &[b"deposit", txid],
            &self.program_id,
        );

        // Get account data
        let account = self
            .rpc
            .get_account(&deposit_record)
            .map_err(|e| VerifierError::RpcError(format!("Failed to get deposit record: {}", e)))?;

        // Parse leaf index from on-chain DepositRecord account layout (200 bytes):
        //   discriminator: u8     (offset 0)
        //   minted: u8            (offset 1)
        //   _padding: [u8; 6]     (offset 2)
        //   commitment: [u8; 32]  (offset 8)   — computed on-chain
        //   amount_sats: [u8; 8]  (offset 40)
        //   btc_txid: [u8; 32]    (offset 48)
        //   block_height: [u8; 8] (offset 80)
        //   leaf_index: [u8; 8]   (offset 88)
        //   depositor: [u8; 32]   (offset 96)
        //   timestamp: [u8; 8]    (offset 128)
        //   ephemeral_pub: [u8;32](offset 136)
        //   npk: [u8; 32]         (offset 168)
        const LEAF_INDEX_OFFSET: usize = 88;
        const LEAF_INDEX_END: usize = LEAF_INDEX_OFFSET + 8;

        if account.data.len() < LEAF_INDEX_END {
            return Err(VerifierError::VerificationFailed(format!(
                "deposit record too small: {} bytes, need at least {}",
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
    /// 1. btc-relay verify_transaction (disc 3) — creates VerifiedTransaction PDA
    /// 2. zvault verify_stealth_deposit (disc 1) — uses VerifiedTransaction PDA
    async fn send_verify_deposit_tx(
        &self,
        payer: &Keypair,
        txid: &[u8; 32],
        merkle_proof: &MerkleProofData,
        block_header_hex: &str,
        block_height: u64,
        amount_sats: u64,
        ephemeral_pub: &[u8; 32],
        npk: &[u8; 32],
        block_hash: &[u8; 32],
    ) -> Result<String, VerifierError> {
        // Derive PDAs
        let (pool_state, _) = Pubkey::find_program_address(&[b"pool_state"], &self.program_id);

        let (light_client, _) = Pubkey::find_program_address(
            &[b"btc_light_client"],
            &self.light_client_program_id,
        );

        let (block_header_pda, _) = Pubkey::find_program_address(
            &[b"block_header", &block_height.to_le_bytes()],
            &self.light_client_program_id,
        );

        let (verified_tx_pda, _) = Pubkey::find_program_address(
            &[b"verified_tx", block_hash, txid],
            &self.light_client_program_id,
        );

        let (deposit_record, _) =
            Pubkey::find_program_address(&[b"deposit", txid], &self.program_id);

        let (commitment_tree, _) =
            Pubkey::find_program_address(&[b"commitment_tree"], &self.program_id);

        // --- Instruction 1: btc-relay verify_transaction (disc 3) ---
        let verify_tx_ix = self.build_verify_transaction_ix(
            payer,
            txid,
            merkle_proof,
            block_height,
            block_hash,
            &light_client,
            &block_header_pda,
            &verified_tx_pda,
        )?;

        // --- Instruction 2: zvault verify_stealth_deposit (disc 1) ---
        let mut deposit_data = Vec::new();
        deposit_data.push(1u8); // discriminator

        // txid (32)
        deposit_data.extend_from_slice(txid);
        // block_height (8)
        deposit_data.extend_from_slice(&block_height.to_le_bytes());
        // amount_sats (8)
        deposit_data.extend_from_slice(&amount_sats.to_le_bytes());
        // tx_size (4) — estimate from raw tx; will be validated on-chain
        // We need to get the raw tx size. For now, pass 0 and let ChadBuffer handle it.
        // In practice, the caller should upload the tx to ChadBuffer first.
        deposit_data.extend_from_slice(&0u32.to_le_bytes());
        // ephemeral_pub (32)
        deposit_data.extend_from_slice(ephemeral_pub);
        // npk (32)
        deposit_data.extend_from_slice(npk);

        // 11 accounts for verify_stealth_deposit:
        //   0. pool_state (writable)
        //   1. verified_tx (readonly, owned by btc-relay)
        //   2. light_client (readonly, owned by btc-relay)
        //   3. commitment_tree (writable)
        //   4. deposit_record (writable)
        //   5. tx_buffer (readonly) — ChadBuffer
        //   6. authority/payer (signer)
        //   7. system_program (readonly)
        //   8. zbtc_mint (writable)
        //   9. pool_vault (writable)
        //   10. token_program (readonly)
        // Note: zbtc_mint and pool_vault need to be provided by the caller
        // For now, we use placeholder accounts that the caller must fill in
        let deposit_accounts = vec![
            AccountMeta::new(pool_state, false),
            AccountMeta::new_readonly(verified_tx_pda, false),
            AccountMeta::new_readonly(light_client, false),
            AccountMeta::new(commitment_tree, false),
            AccountMeta::new(deposit_record, false),
            // tx_buffer — placeholder, must be set by caller via ChadBuffer upload
            AccountMeta::new_readonly(Pubkey::default(), false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
            // zbtc_mint and pool_vault — must be derived from pool state
            // These would need to be passed in from the caller
            AccountMeta::new(Pubkey::default(), false), // zbtc_mint placeholder
            AccountMeta::new(Pubkey::default(), false), // pool_vault placeholder
            AccountMeta::new_readonly(TOKEN_2022_PROGRAM_ID, false),
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

    /// Build btc-relay verify_transaction instruction (disc 3)
    fn build_verify_transaction_ix(
        &self,
        payer: &Keypair,
        txid: &[u8; 32],
        merkle_proof: &MerkleProofData,
        block_height: u64,
        block_hash: &[u8; 32],
        light_client: &Pubkey,
        block_header_pda: &Pubkey,
        verified_tx_pda: &Pubkey,
    ) -> Result<Instruction, VerifierError> {
        let mut data = Vec::new();
        data.push(3u8); // discriminator

        // txid (32)
        data.extend_from_slice(txid);
        // block_height (8)
        data.extend_from_slice(&block_height.to_le_bytes());
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

/// Parse P2TR scriptpubkey to get the x-only pubkey
fn parse_p2tr_pubkey(scriptpubkey_hex: &str) -> Result<[u8; 32], VerifierError> {
    let script_bytes = hex::decode(scriptpubkey_hex)
        .map_err(|e| VerifierError::VerificationFailed(format!("invalid scriptpubkey: {}", e)))?;

    // P2TR format: OP_1 (0x51) + OP_PUSHBYTES_32 (0x20) + 32-byte pubkey
    if script_bytes.len() != 34 {
        return Err(VerifierError::VerificationFailed(format!(
            "invalid P2TR script length: {}",
            script_bytes.len()
        )));
    }

    if script_bytes[0] != 0x51 || script_bytes[1] != 0x20 {
        return Err(VerifierError::VerificationFailed(
            "not a P2TR script".to_string(),
        ));
    }

    let mut pubkey = [0u8; 32];
    pubkey.copy_from_slice(&script_bytes[2..34]);
    Ok(pubkey)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_p2tr_pubkey() {
        // Valid P2TR scriptpubkey
        let script = "5120".to_string() + &"ab".repeat(32);
        let result = parse_p2tr_pubkey(&script);
        assert!(result.is_ok());

        let pubkey = result.unwrap();
        assert_eq!(pubkey, [0xab; 32]);
    }

    #[test]
    fn test_parse_p2tr_pubkey_invalid() {
        // Invalid length
        let result = parse_p2tr_pubkey("5120ab");
        assert!(result.is_err());

        // Wrong prefix (P2WPKH instead of P2TR)
        let script = "0014".to_string() + &"ab".repeat(20);
        let result = parse_p2tr_pubkey(&script);
        assert!(result.is_err());
    }

    #[test]
    fn test_verifier_creation() {
        let verifier = SpvVerifier::new_testnet("https://api.devnet.solana.com");
        assert!(verifier.payer_pubkey().is_none());
    }
}
