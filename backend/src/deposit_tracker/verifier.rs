//! SPV Verifier
//!
//! Submits sweep transactions for SPV verification on Solana.
//! Uses the BTC light client to verify transaction inclusion.

use solana_client::rpc_client::RpcClient;
use solana_sdk::{
    commitment_config::CommitmentConfig,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer as SolanaSigner},
    transaction::Transaction,
};
use std::str::FromStr;
use thiserror::Error;

use super::watcher::{AddressWatcher, MerkleProofData, WatcherError};

/// zVault program ID (devnet)
pub const ZVAULT_PROGRAM_ID: &str = "BDH9iTYp2nBptboCcSmTn7GTkzYTzaMr7MMG5D5sXXRp";

/// BTC Light Client program ID (devnet)
pub const BTC_LIGHT_CLIENT_PROGRAM_ID: &str = "8qntLj65faXiqMKcQypyJ389Yq6MBU5X7AB5qsLnvKgy";

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

    #[error("Invalid commitment: {0}")]
    InvalidCommitment(String),
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
            program_id: Pubkey::from_str(ZVAULT_PROGRAM_ID).unwrap(),
            light_client_program_id: Pubkey::from_str(BTC_LIGHT_CLIENT_PROGRAM_ID).unwrap(),
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
            light_client_program_id: Pubkey::from_str(BTC_LIGHT_CLIENT_PROGRAM_ID)
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

    /// Verify a Bitcoin deposit via SPV
    ///
    /// # Arguments
    /// * `sweep_txid` - The sweep transaction ID (NOT the original deposit)
    /// * `vout` - Output index in the sweep transaction
    /// * `commitment` - The commitment (hex) to verify
    /// * `amount_sats` - Expected amount in satoshis
    ///
    /// # Returns
    /// Verification result with Solana tx and leaf index
    pub async fn verify_deposit(
        &self,
        sweep_txid: &str,
        vout: u32,
        commitment: &str,
        amount_sats: u64,
    ) -> Result<VerificationResult, VerifierError> {
        let payer = self.payer.as_ref().ok_or(VerifierError::NoPayerSet)?;

        // Parse commitment
        let commitment_bytes = hex::decode(commitment)
            .map_err(|e| VerifierError::InvalidCommitment(format!("invalid hex: {}", e)))?;
        if commitment_bytes.len() != 32 {
            return Err(VerifierError::InvalidCommitment(format!(
                "wrong length: {}",
                commitment_bytes.len()
            )));
        }
        let mut commitment_arr = [0u8; 32];
        commitment_arr.copy_from_slice(&commitment_bytes);

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

        // Get block header
        let block_header = self.watcher.get_block_header(block_height).await?;

        // Get transaction details for the output pubkey
        let tx = self.watcher.get_tx(sweep_txid).await?;
        let output = tx.vout.get(vout as usize).ok_or_else(|| {
            VerifierError::VerificationFailed(format!("output {} not found", vout))
        })?;

        // Parse scriptpubkey to get expected pubkey (for P2TR, it's the tweaked pubkey)
        let expected_pubkey = parse_p2tr_pubkey(&output.scriptpubkey)?;

        // Convert txid to internal byte order
        let txid_bytes = hex::decode(sweep_txid)
            .map_err(|e| VerifierError::VerificationFailed(format!("invalid txid: {}", e)))?;
        let mut txid_internal = [0u8; 32];
        txid_internal.copy_from_slice(&txid_bytes);
        txid_internal.reverse();

        // Build and send verification transaction
        let solana_tx = self
            .send_verify_deposit_tx(
                payer,
                &txid_internal,
                &merkle_proof,
                &block_header.header_hex,
                block_height,
                amount_sats,
                &expected_pubkey,
                vout,
                &commitment_arr,
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

        // Parse leaf index from account data
        // The account layout depends on the program, but typically leaf_index is at a known offset
        // For now, we'll use a placeholder that reads from a fixed offset
        if account.data.len() >= 16 {
            // Assuming leaf_index is a u64 at offset 8 (after discriminator)
            let leaf_index = u64::from_le_bytes(
                account.data[8..16]
                    .try_into()
                    .map_err(|_| VerifierError::VerificationFailed("Invalid account data".to_string()))?,
            );
            Ok(leaf_index)
        } else {
            // If we can't read it, return 0 as a placeholder
            Ok(0)
        }
    }

    /// Send the verify_deposit transaction to Solana
    async fn send_verify_deposit_tx(
        &self,
        payer: &Keypair,
        txid: &[u8; 32],
        merkle_proof: &MerkleProofData,
        block_header_hex: &str,
        block_height: u64,
        amount_sats: u64,
        expected_pubkey: &[u8; 32],
        vout: u32,
        commitment: &[u8; 32],
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

        let (deposit_record, _) =
            Pubkey::find_program_address(&[b"deposit", txid], &self.program_id);

        let (commitment_tree, _) =
            Pubkey::find_program_address(&[b"commitment_tree"], &self.program_id);

        // Build instruction data
        // Discriminator for VERIFY_DEPOSIT = 8
        let discriminator: u8 = 8;

        let mut data = Vec::new();
        data.push(discriminator);

        // Transaction ID
        data.extend_from_slice(txid);

        // Raw block header (80 bytes)
        let header_bytes = hex::decode(block_header_hex)
            .map_err(|e| VerifierError::VerificationFailed(format!("invalid header hex: {}", e)))?;
        data.extend_from_slice(&header_bytes);

        // Block height
        data.extend_from_slice(&block_height.to_le_bytes());

        // Merkle proof siblings
        data.extend_from_slice(&(merkle_proof.merkle.len() as u32).to_le_bytes());
        for sibling_hex in &merkle_proof.merkle {
            let sibling_bytes = hex::decode(sibling_hex)
                .map_err(|e| VerifierError::VerificationFailed(format!("invalid merkle: {}", e)))?;
            let mut sibling = [0u8; 32];
            sibling.copy_from_slice(&sibling_bytes);
            sibling.reverse(); // Internal byte order
            data.extend_from_slice(&sibling);
        }

        // Merkle position
        data.extend_from_slice(&merkle_proof.pos.to_le_bytes());

        // Output details
        data.extend_from_slice(&amount_sats.to_le_bytes());
        data.extend_from_slice(expected_pubkey);
        data.extend_from_slice(&vout.to_le_bytes());

        // Commitment
        data.extend_from_slice(commitment);

        let accounts = vec![
            AccountMeta::new(pool_state, false),
            AccountMeta::new_readonly(light_client, false),
            AccountMeta::new_readonly(block_header_pda, false),
            AccountMeta::new(deposit_record, false),
            AccountMeta::new(commitment_tree, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
        ];

        let ix = Instruction {
            program_id: self.program_id,
            accounts,
            data,
        };

        // Get recent blockhash
        let recent_blockhash = self
            .rpc
            .get_latest_blockhash()
            .map_err(|e| VerifierError::RpcError(format!("Failed to get blockhash: {}", e)))?;

        // Build and sign transaction
        let tx = Transaction::new_signed_with_payer(
            &[ix],
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
