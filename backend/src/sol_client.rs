//! Solana Relayer Client
//!
//! Simple relayer that calls zVault contract instructions.
//! All logic (merkle tree, token minting) is handled by the contract.
//!
//! Flow:
//! 1. BTC deposit confirmed → call record_deposit (contract stores commitment + mints zBTC to vault)
//! 2. User withdraws → call withdraw (contract verifies proof + transfers zBTC from vault to user)

use solana_client::rpc_client::RpcClient;
use solana_sdk::{
    commitment_config::CommitmentConfig,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer as SolanaSigner},
    transaction::Transaction,
};
use std::str::FromStr;

// ============================================================================
// Constants
// ============================================================================

/// Solana devnet RPC endpoint (default, override via ZVaultConfig)
pub const DEVNET_RPC: &str = "https://api.devnet.solana.com";

/// Token-2022 program ID
pub const TOKEN_2022_PROGRAM_ID: Pubkey =
    solana_sdk::pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/// Associated Token Account program ID
pub const ATA_PROGRAM_ID: Pubkey =
    solana_sdk::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// ============================================================================
// Devnet Defaults (used when ZVAULT_NETWORK=devnet and no env vars set)
// For production, all addresses MUST come from environment variables.
// ============================================================================

/// zVault program ID (devnet default)
pub const DEVNET_PROGRAM_ID: &str = "AtztELZfz3GHA8hFQCv7aT9Mt47Xhknv3ZCNb3fmXsgf";

/// Pool state PDA (devnet default)
pub const DEVNET_POOL_STATE: &str = "8bbcVecB619HHsHn2TQMraJ8R8WjQjApdZY7h9JCJW7b";

/// Commitment tree PDA (devnet default)
pub const DEVNET_COMMITMENT_TREE: &str = "HtfDXZ5mBQNBdZrDxJMbXCDkyUqFdTDj7zAqo3aqrqiA";

/// zBTC mint address (devnet default)
pub const DEVNET_ZBTC_MINT: &str = "HiDyAcEBTS7SRiLA49BZ5B6XMBAksgwLEAHpvteR8vbV";

// Legacy aliases for backward compatibility
pub const PROGRAM_ID: &str = DEVNET_PROGRAM_ID;
pub const POOL_STATE: &str = DEVNET_POOL_STATE;
pub const COMMITMENT_TREE: &str = DEVNET_COMMITMENT_TREE;
pub const ZBTC_MINT: &str = DEVNET_ZBTC_MINT;

// ============================================================================
// Helper Functions
// ============================================================================

/// Compute associated token address for Token-2022
fn get_ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), TOKEN_2022_PROGRAM_ID.as_ref(), mint.as_ref()],
        &ATA_PROGRAM_ID,
    )
    .0
}

/// Parse pubkey from string
fn parse_pubkey(s: &str) -> Result<Pubkey, SolError> {
    Pubkey::from_str(s).map_err(|e| SolError::InvalidAddress(e.to_string()))
}

// ============================================================================
// Configuration
// ============================================================================

#[derive(Clone, Debug)]
pub struct SolConfig {
    pub rpc_url: String,
}

impl Default for SolConfig {
    fn default() -> Self {
        Self {
            rpc_url: DEVNET_RPC.to_string(),
        }
    }
}

// ============================================================================
// SPV Merkle Proof (Backend representation)
// ============================================================================

/// SPV Merkle proof for verifying a Bitcoin transaction in a block
#[derive(Clone, Debug)]
pub struct SpvMerkleProof {
    /// Transaction ID (txid) - 32 bytes
    pub txid: [u8; 32],
    /// Merkle proof siblings (from leaf to root)
    pub siblings: Vec<[u8; 32]>,
    /// Path indices (false = left, true = right)
    pub path: Vec<bool>,
    /// Transaction index in the block
    pub tx_index: u32,
}

impl SpvMerkleProof {
    /// Create a new merkle proof
    pub fn new(txid: [u8; 32], siblings: Vec<[u8; 32]>, path: Vec<bool>, tx_index: u32) -> Self {
        Self {
            txid,
            siblings,
            path,
            tx_index,
        }
    }
}

// ============================================================================
// Solana Relayer Client
// ============================================================================

pub struct SolClient {
    rpc: RpcClient,
    payer: Option<Keypair>,
    program_id: Pubkey,
    pool_state: Pubkey,
    commitment_tree: Pubkey,
    zbtc_mint: Pubkey,
}

impl SolClient {
    /// Create new client with devnet defaults
    pub fn new(config: SolConfig) -> Self {
        let rpc = RpcClient::new_with_commitment(config.rpc_url, CommitmentConfig::confirmed());

        Self {
            rpc,
            payer: None,
            program_id: parse_pubkey(DEVNET_PROGRAM_ID).unwrap(),
            pool_state: parse_pubkey(DEVNET_POOL_STATE).unwrap(),
            commitment_tree: parse_pubkey(DEVNET_COMMITMENT_TREE).unwrap(),
            zbtc_mint: parse_pubkey(DEVNET_ZBTC_MINT).unwrap(),
        }
    }

    /// Create new client from ZVaultConfig (preferred for production)
    pub fn from_config(config: &crate::config::ZVaultConfig) -> Result<Self, SolError> {
        let rpc = RpcClient::new_with_commitment(
            config.solana_rpc.clone(),
            CommitmentConfig::confirmed(),
        );

        Ok(Self {
            rpc,
            payer: None,
            program_id: parse_pubkey(&config.program_id)?,
            pool_state: parse_pubkey(&config.pool_state)?,
            commitment_tree: parse_pubkey(&config.commitment_tree)?,
            zbtc_mint: parse_pubkey(&config.zbtc_mint)?,
        })
    }

    /// Set relayer keypair
    pub fn set_payer(&mut self, keypair: Keypair) {
        self.payer = Some(keypair);
    }

    /// Set payer from bytes
    pub fn set_payer_from_bytes(&mut self, bytes: &[u8]) -> Result<(), SolError> {
        let keypair =
            Keypair::try_from(bytes).map_err(|e| SolError::InvalidKeypair(e.to_string()))?;
        self.payer = Some(keypair);
        Ok(())
    }

    /// Get payer pubkey
    pub fn payer_pubkey(&self) -> Option<Pubkey> {
        self.payer.as_ref().map(|k| k.pubkey())
    }

    /// Check connection
    pub fn is_connected(&self) -> bool {
        self.rpc.get_health().is_ok()
    }

    /// Get SOL balance
    pub fn get_balance(&self) -> Result<u64, SolError> {
        let payer = self.payer.as_ref().ok_or(SolError::NoPayerSet)?;
        self.rpc
            .get_balance(&payer.pubkey())
            .map_err(|e| SolError::RpcError(e.to_string()))
    }

    /// Request airdrop (devnet)
    pub fn request_airdrop(&self, lamports: u64) -> Result<String, SolError> {
        let payer = self.payer.as_ref().ok_or(SolError::NoPayerSet)?;
        let sig = self
            .rpc
            .request_airdrop(&payer.pubkey(), lamports)
            .map_err(|e| SolError::RpcError(e.to_string()))?;
        self.rpc
            .confirm_transaction(&sig)
            .map_err(|e| SolError::RpcError(e.to_string()))?;
        Ok(sig.to_string())
    }

    /// Get current slot
    pub fn get_slot(&self) -> Result<u64, SolError> {
        self.rpc
            .get_slot()
            .map_err(|e| SolError::RpcError(e.to_string()))
    }

    // ========================================================================
    // Contract Instructions (Relayer just builds and submits)
    // ========================================================================

    /// Call contract's record_deposit instruction
    /// Contract handles: store commitment in merkle tree + mint zBTC to vault
    pub async fn record_deposit(
        &self,
        commitment: &[u8; 32],
        amount_sats: u64,
        btc_txid: &str,
    ) -> Result<String, SolError> {
        let payer = self.payer.as_ref().ok_or(SolError::NoPayerSet)?;

        // Derive vault PDA (holds zBTC backing all commitments)
        let (vault, _) = Pubkey::find_program_address(
            &[b"vault", self.zbtc_mint.as_ref()],
            &self.program_id,
        );
        let vault_ata = get_ata(&vault, &self.zbtc_mint);

        // Derive deposit record PDA
        let (deposit_record, _) = Pubkey::find_program_address(
            &[b"deposit", commitment],
            &self.program_id,
        );

        // Build instruction data
        // Anchor discriminator for "record_deposit"
        let discriminator: [u8; 8] = [0xf2, 0x23, 0xc6, 0x89, 0x52, 0xe1, 0x31, 0xf0];

        let mut data = Vec::with_capacity(8 + 32 + 8 + 32);
        data.extend_from_slice(&discriminator);
        data.extend_from_slice(commitment);
        data.extend_from_slice(&amount_sats.to_le_bytes());
        // BTC txid (32 bytes, padded)
        let mut txid_bytes = [0u8; 32];
        let decoded = hex::decode(btc_txid).unwrap_or_default();
        let len = decoded.len().min(32);
        txid_bytes[..len].copy_from_slice(&decoded[..len]);
        data.extend_from_slice(&txid_bytes);

        let accounts = vec![
            AccountMeta::new(self.pool_state, false),
            AccountMeta::new(self.commitment_tree, false),
            AccountMeta::new(deposit_record, false),
            AccountMeta::new(self.zbtc_mint, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(vault_ata, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(TOKEN_2022_PROGRAM_ID, false),
            AccountMeta::new_readonly(ATA_PROGRAM_ID, false),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
        ];

        let ix = Instruction {
            program_id: self.program_id,
            accounts,
            data,
        };

        self.send_transaction(&[ix], &[payer]).await
    }

    /// Call contract's withdraw instruction
    /// Contract handles: verify ZK proof + transfer zBTC from vault to user
    pub async fn withdraw(
        &self,
        proof: &[u8],
        root: &[u8; 32],
        nullifier_hash: &[u8; 32],
        amount: u64,
        recipient: &str,
    ) -> Result<String, SolError> {
        let payer = self.payer.as_ref().ok_or(SolError::NoPayerSet)?;
        let recipient_pubkey = parse_pubkey(recipient)?;

        // Derive vault PDA
        let (vault, _) = Pubkey::find_program_address(
            &[b"vault", self.zbtc_mint.as_ref()],
            &self.program_id,
        );
        let vault_ata = get_ata(&vault, &self.zbtc_mint);

        // User's ATA for zBTC
        let user_ata = get_ata(&recipient_pubkey, &self.zbtc_mint);

        // Nullifier record PDA (prevents double-spend)
        let (nullifier_record, _) = Pubkey::find_program_address(
            &[b"nullifier", nullifier_hash],
            &self.program_id,
        );

        // Build instruction data
        // Anchor discriminator for "withdraw"
        let discriminator: [u8; 8] = [0xb7, 0x12, 0x46, 0x9c, 0x94, 0x6d, 0xa1, 0x22];

        let mut data = Vec::with_capacity(8 + proof.len() + 32 + 32 + 8);
        data.extend_from_slice(&discriminator);
        data.extend_from_slice(proof);
        data.extend_from_slice(root);
        data.extend_from_slice(nullifier_hash);
        data.extend_from_slice(&amount.to_le_bytes());

        let accounts = vec![
            AccountMeta::new(self.pool_state, false),
            AccountMeta::new_readonly(self.commitment_tree, false),
            AccountMeta::new(nullifier_record, false),
            AccountMeta::new(self.zbtc_mint, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(vault_ata, false),
            AccountMeta::new(user_ata, false),
            AccountMeta::new(recipient_pubkey, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(TOKEN_2022_PROGRAM_ID, false),
            AccountMeta::new_readonly(ATA_PROGRAM_ID, false),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
        ];

        let ix = Instruction {
            program_id: self.program_id,
            accounts,
            data,
        };

        self.send_transaction(&[ix], &[payer]).await
    }

    // ========================================================================
    // SPV Verification Instructions
    // ========================================================================

    /// Initialize the Bitcoin light client
    pub async fn init_light_client(
        &self,
        genesis_hash: &[u8; 32],
        network: u8,
    ) -> Result<String, SolError> {
        let payer = self.payer.as_ref().ok_or(SolError::NoPayerSet)?;

        // Derive light client PDA
        let (light_client, _) = Pubkey::find_program_address(
            &[b"btc_light_client"],
            &self.program_id,
        );

        // Build instruction data
        // Anchor discriminator for "init_light_client"
        let discriminator: [u8; 8] = [0x4f, 0x01, 0xc3, 0xa2, 0x8b, 0xd7, 0x6e, 0x19];

        let mut data = Vec::with_capacity(8 + 32 + 1);
        data.extend_from_slice(&discriminator);
        data.extend_from_slice(genesis_hash);
        data.push(network);

        let accounts = vec![
            AccountMeta::new(light_client, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
        ];

        let ix = Instruction {
            program_id: self.program_id,
            accounts,
            data,
        };

        self.send_transaction(&[ix], &[payer]).await
    }

    /// Submit a Bitcoin block header
    pub async fn submit_block_header(
        &self,
        raw_header: &[u8; 80],
        height: u64,
    ) -> Result<String, SolError> {
        let payer = self.payer.as_ref().ok_or(SolError::NoPayerSet)?;

        // Derive light client PDA
        let (light_client, _) = Pubkey::find_program_address(
            &[b"btc_light_client"],
            &self.program_id,
        );

        // Derive block header PDA
        let (block_header, _) = Pubkey::find_program_address(
            &[b"block_header", &height.to_le_bytes()],
            &self.program_id,
        );

        // Build instruction data
        // Anchor discriminator for "submit_header"
        let discriminator: [u8; 8] = [0x9c, 0xe1, 0xf4, 0x6b, 0x22, 0xa7, 0x5d, 0x3c];

        let mut data = Vec::with_capacity(8 + 80 + 8);
        data.extend_from_slice(&discriminator);
        data.extend_from_slice(raw_header);
        data.extend_from_slice(&height.to_le_bytes());

        let accounts = vec![
            AccountMeta::new(light_client, false),
            AccountMeta::new(block_header, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
        ];

        let ix = Instruction {
            program_id: self.program_id,
            accounts,
            data,
        };

        self.send_transaction(&[ix], &[payer]).await
    }

    /// Verify a Bitcoin deposit via SPV proof
    pub async fn verify_btc_deposit(
        &self,
        txid: &[u8; 32],
        merkle_proof: &SpvMerkleProof,
        block_height: u64,
        amount_sats: u64,
        expected_pubkey: &[u8; 32],
        vout: u32,
        commitment: &[u8; 32],
    ) -> Result<String, SolError> {
        let payer = self.payer.as_ref().ok_or(SolError::NoPayerSet)?;

        // Derive PDAs
        let (light_client, _) = Pubkey::find_program_address(
            &[b"btc_light_client"],
            &self.program_id,
        );

        let (block_header, _) = Pubkey::find_program_address(
            &[b"block_header", &block_height.to_le_bytes()],
            &self.program_id,
        );

        let (deposit_record, _) = Pubkey::find_program_address(
            &[b"deposit", txid],
            &self.program_id,
        );

        // Build instruction data
        // Anchor discriminator for "verify_deposit"
        let discriminator: [u8; 8] = [0x5a, 0x88, 0xd1, 0x4e, 0x7c, 0x32, 0xb9, 0x06];

        let mut data = Vec::new();
        data.extend_from_slice(&discriminator);
        data.extend_from_slice(txid);

        // Serialize merkle proof
        data.extend_from_slice(merkle_proof.txid.as_slice());
        // Number of siblings (u32)
        data.extend_from_slice(&(merkle_proof.siblings.len() as u32).to_le_bytes());
        for sibling in &merkle_proof.siblings {
            data.extend_from_slice(sibling);
        }
        // Path indices
        data.extend_from_slice(&(merkle_proof.path.len() as u32).to_le_bytes());
        for is_right in &merkle_proof.path {
            data.push(if *is_right { 1 } else { 0 });
        }
        data.extend_from_slice(&merkle_proof.tx_index.to_le_bytes());

        // Block height
        data.extend_from_slice(&block_height.to_le_bytes());

        // Transaction output
        data.extend_from_slice(&amount_sats.to_le_bytes());
        data.extend_from_slice(expected_pubkey);
        data.extend_from_slice(&vout.to_le_bytes());

        // Commitment
        data.extend_from_slice(commitment);

        let accounts = vec![
            AccountMeta::new(self.pool_state, false),
            AccountMeta::new_readonly(light_client, false),
            AccountMeta::new_readonly(block_header, false),
            AccountMeta::new(deposit_record, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
        ];

        let ix = Instruction {
            program_id: self.program_id,
            accounts,
            data,
        };

        self.send_transaction(&[ix], &[payer]).await
    }

    // ========================================================================
    // Read Operations
    // ========================================================================

    /// Get vault zBTC balance (total backing for all commitments)
    pub async fn get_vault_balance(&self) -> Result<u64, SolError> {
        let (vault, _) = Pubkey::find_program_address(
            &[b"vault", self.zbtc_mint.as_ref()],
            &self.program_id,
        );
        let vault_ata = get_ata(&vault, &self.zbtc_mint);

        match self.rpc.get_token_account_balance(&vault_ata) {
            Ok(balance) => Ok(balance.amount.parse().unwrap_or(0)),
            Err(_) => Ok(0),
        }
    }

    /// Get user's zBTC balance
    pub async fn get_user_balance(&self, address: &str) -> Result<u64, SolError> {
        let owner = parse_pubkey(address)?;
        let user_ata = get_ata(&owner, &self.zbtc_mint);

        match self.rpc.get_token_account_balance(&user_ata) {
            Ok(balance) => Ok(balance.amount.parse().unwrap_or(0)),
            Err(_) => Ok(0),
        }
    }

    // ========================================================================
    // Transaction Helper
    // ========================================================================

    async fn send_transaction(
        &self,
        instructions: &[Instruction],
        signers: &[&Keypair],
    ) -> Result<String, SolError> {
        let recent_blockhash = self
            .rpc
            .get_latest_blockhash()
            .map_err(|e| SolError::RpcError(e.to_string()))?;

        let tx = Transaction::new_signed_with_payer(
            instructions,
            Some(&signers[0].pubkey()),
            signers,
            recent_blockhash,
        );

        let sig = self
            .rpc
            .send_and_confirm_transaction(&tx)
            .map_err(|e| SolError::RpcError(format!("Transaction failed: {}", e)))?;

        println!("Transaction confirmed: {}", sig);
        Ok(sig.to_string())
    }
}

// ============================================================================
// Errors
// ============================================================================

#[derive(Debug, thiserror::Error)]
pub enum SolError {
    #[error("no payer keypair set")]
    NoPayerSet,

    #[error("invalid keypair: {0}")]
    InvalidKeypair(String),

    #[error("invalid address: {0}")]
    InvalidAddress(String),

    #[error("RPC error: {0}")]
    RpcError(String),
}

// ============================================================================
// Helpers
// ============================================================================

pub fn generate_keypair() -> Keypair {
    Keypair::new()
}

pub fn load_keypair_from_file(path: &str) -> Result<Keypair, SolError> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| SolError::InvalidKeypair(e.to_string()))?;
    let bytes: Vec<u8> = serde_json::from_str(&content)
        .map_err(|e| SolError::InvalidKeypair(e.to_string()))?;
    Keypair::try_from(bytes.as_slice())
        .map_err(|e| SolError::InvalidKeypair(e.to_string()))
}
