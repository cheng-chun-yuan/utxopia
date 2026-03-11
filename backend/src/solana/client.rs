//! Solana Relayer Client
//!
//! Simple relayer that calls Aegis contract instructions.
//! All logic (merkle tree, token minting) is handled by the contract.
//!
//! Flow:
//! 1. BTC deposit confirmed → call record_deposit (contract stores commitment + mints zkBTC to vault)
//! 2. User withdraws → call withdraw (contract verifies proof + transfers zkBTC from vault to user)

use solana_client::rpc_client::RpcClient;
use solana_client::rpc_config::RpcProgramAccountsConfig;
use solana_client::rpc_filter::{Memcmp, RpcFilterType};
use solana_account_decoder::UiAccountEncoding;
use solana_sdk::{
    commitment_config::CommitmentConfig,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer as SolanaSigner},
    transaction::Transaction,
};
use sha2::{Sha256, Digest};
use std::str::FromStr;

fn double_sha256_header(data: &[u8]) -> [u8; 32] {
    let first = Sha256::digest(data);
    Sha256::digest(&first).into()
}

use crate::config::AEGISConfig;
use crate::redemption::types::ParsedRedemption;

// ============================================================================
// Constants
// ============================================================================

/// Solana devnet RPC endpoint (default, override via AEGISConfig)
pub const DEVNET_RPC: &str = "https://api.devnet.solana.com";

/// Token-2022 program ID
pub const TOKEN_2022_PROGRAM_ID: Pubkey =
    solana_sdk::pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/// Associated Token Account program ID
pub const ATA_PROGRAM_ID: Pubkey =
    solana_sdk::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/// BTC Light Client program ID
pub const BTC_LIGHT_CLIENT_PROGRAM_ID: Pubkey =
    solana_sdk::pubkey!("Ho6UTeF8yFnRdCK15tSZtcJozvkDABJZWYxkgGyWAfyq");

// ============================================================================
// Devnet Defaults (used when AEGIS_NETWORK=devnet and no env vars set)
// For production, all addresses MUST come from environment variables.
// ============================================================================

/// Aegis program ID (devnet default)
pub const DEVNET_PROGRAM_ID: &str = "4Gt66pJd6N3hYEVWnaWTSLfxotsPvShYEWYvbUB9Ubx1";

/// Pool state PDA (devnet default)
pub const DEVNET_POOL_STATE: &str = "4654vJpq3E3A6nwtUwNWeJuTkHDcqT761uoBX7AHjm5x";

/// Commitment tree PDA (devnet default)
pub const DEVNET_COMMITMENT_TREE: &str = "2bjcEufNf6Xa7YwH1ci99k1NjRg6jjirCQXsPjC5Qgk6";

/// zkBTC mint address (devnet default)
pub const DEVNET_ZKBTC_MINT: &str = "GvFAyHsbWDbwvHxecaFnnGrhM1MR72E3cSX78qQbAyC7";

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
    zkbtc_mint: Pubkey,
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
            zkbtc_mint: parse_pubkey(DEVNET_ZKBTC_MINT).unwrap(),
        }
    }

    /// Create a new client with the same config (program IDs, RPC) but no payer.
    pub fn new_like(other: &SolClient) -> Self {
        let rpc = RpcClient::new_with_commitment(
            other.rpc.url(),
            CommitmentConfig::confirmed(),
        );
        Self {
            rpc,
            payer: None,
            program_id: other.program_id,
            pool_state: other.pool_state,
            commitment_tree: other.commitment_tree,
            zkbtc_mint: other.zkbtc_mint,
        }
    }

    /// Create new client from AEGISConfig (preferred for production)
    pub fn from_config(config: &AEGISConfig) -> Result<Self, SolError> {
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
            zkbtc_mint: parse_pubkey(&config.zkbtc_mint)?,
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

    /// Get a reference to the underlying RPC client
    pub fn rpc(&self) -> &RpcClient {
        &self.rpc
    }

    /// Get a reference to the payer keypair (if set)
    pub fn payer_keypair(&self) -> Option<&Keypair> {
        self.payer.as_ref()
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
    /// Contract handles: store commitment in merkle tree + mint zkBTC to vault
    pub async fn record_deposit(
        &self,
        commitment: &[u8; 32],
        amount_sats: u64,
        btc_txid: &str,
    ) -> Result<String, SolError> {
        let payer = self.payer.as_ref().ok_or(SolError::NoPayerSet)?;

        // Derive vault PDA (holds zkBTC backing all commitments)
        let (vault, _) = Pubkey::find_program_address(
            &[b"vault", self.zkbtc_mint.as_ref()],
            &self.program_id,
        );
        let vault_ata = get_ata(&vault, &self.zkbtc_mint);

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
            AccountMeta::new(self.zkbtc_mint, false),
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
    /// Contract handles: verify ZK proof + transfer zkBTC from vault to user
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
            &[b"vault", self.zkbtc_mint.as_ref()],
            &self.program_id,
        );
        let vault_ata = get_ata(&vault, &self.zkbtc_mint);

        // User's ATA for zkBTC
        let user_ata = get_ata(&recipient_pubkey, &self.zkbtc_mint);

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
            AccountMeta::new(self.zkbtc_mint, false),
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
            &[b"block", &double_sha256_header(raw_header)],
            &self.program_id,
        );

        // Derive height index PDA
        let (height_index, _) = Pubkey::find_program_address(
            &[b"height_index", &height.to_le_bytes()],
            &self.program_id,
        );

        // NOTE: extend_blockchain requires min 2 headers and a parent anchor PDA.
        // This single-header method is a simplified stub — production code should
        // use the header-relayer TypeScript service for batch submission.
        // Build instruction data: disc(1) + num_headers(1) + raw_header(80)
        let mut data = Vec::with_capacity(1 + 1 + 80);
        data.push(1); // disc = EXTEND_BLOCKCHAIN
        data.push(1); // num_headers = 1 (will fail min=2 check on-chain)
        data.extend_from_slice(raw_header);

        let accounts = vec![
            AccountMeta::new(light_client, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
            // TODO: parent block header PDA needed here as anchor
            AccountMeta::new(block_header, false),
            AccountMeta::new(height_index, false),
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
        block_hash: &[u8; 32],
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
            &[b"block", block_hash],
            &self.program_id,
        );

        let (deposit_record, _) = Pubkey::find_program_address(
            &[b"deposit", txid],
            &self.program_id,
        );

        // NOTE: This uses an old Anchor-style format that is no longer compatible
        // with the Pinocchio-based program. The actual deposit verification is done
        // by deposit_tracker/verifier.rs. This method is kept as a reference stub.
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

    /// Get vault zkBTC balance (total backing for all commitments)
    pub async fn get_vault_balance(&self) -> Result<u64, SolError> {
        let (vault, _) = Pubkey::find_program_address(
            &[b"vault", self.zkbtc_mint.as_ref()],
            &self.program_id,
        );
        let vault_ata = get_ata(&vault, &self.zkbtc_mint);

        match self.rpc.get_token_account_balance(&vault_ata) {
            Ok(balance) => Ok(balance.amount.parse().unwrap_or(0)),
            Err(_) => Ok(0),
        }
    }

    /// Get user's zkBTC balance
    pub async fn get_user_balance(&self, address: &str) -> Result<u64, SolError> {
        let owner = parse_pubkey(address)?;
        let user_ata = get_ata(&owner, &self.zkbtc_mint);

        match self.rpc.get_token_account_balance(&user_ata) {
            Ok(balance) => Ok(balance.amount.parse().unwrap_or(0)),
            Err(_) => Ok(0),
        }
    }

    // ========================================================================
    // Redemption Instructions
    // ========================================================================

    /// Fetch all on-chain RedemptionRequest PDAs (90-byte accounts with discriminator 0x04)
    pub fn fetch_redemption_pdas(&self) -> Result<Vec<ParsedRedemption>, SolError> {
        let config = RpcProgramAccountsConfig {
            filters: Some(vec![
                RpcFilterType::DataSize(90),
                RpcFilterType::Memcmp(Memcmp::new_raw_bytes(0, vec![0x04])),
            ]),
            account_config: solana_client::rpc_config::RpcAccountInfoConfig {
                encoding: Some(UiAccountEncoding::Base64),
                ..Default::default()
            },
            ..Default::default()
        };

        let accounts = self
            .rpc
            .get_program_accounts_with_config(&self.program_id, config)
            .map_err(|e| SolError::RpcError(e.to_string()))?;

        let mut results = Vec::new();
        for (pubkey, account) in accounts {
            let data = &account.data;
            if data.len() < 90 {
                continue;
            }

            let status = data[1];
            let btc_script_len = data[2] as usize;
            // data[3] is padding
            let processing_slot = u32::from_le_bytes([data[4], data[5], data[6], data[7]]);
            let request_id = u64::from_le_bytes([
                data[8], data[9], data[10], data[11],
                data[12], data[13], data[14], data[15],
            ]);
            let requester = Pubkey::try_from(&data[16..48])
                .map_err(|e| SolError::RpcError(format!("invalid requester pubkey: {}", e)))?;
            let amount_sats = u64::from_le_bytes([
                data[48], data[49], data[50], data[51],
                data[52], data[53], data[54], data[55],
            ]);
            let script_end = 56 + btc_script_len.min(34);
            let btc_script = data[56..script_end].to_vec();

            results.push(ParsedRedemption {
                pda_address: pubkey.to_string(),
                status,
                requester: requester.to_string(),
                amount_sats,
                btc_script,
                request_id,
                processing_slot,
            });
        }

        Ok(results)
    }

    /// Check if a Solana account exists on-chain
    pub fn account_exists(&self, pubkey: &Pubkey) -> Result<bool, SolError> {
        match self.rpc.get_account(pubkey) {
            Ok(_) => Ok(true),
            Err(e) => {
                let err_str = e.to_string();
                if err_str.contains("AccountNotFound")
                    || err_str.contains("could not find account")
                {
                    Ok(false)
                } else {
                    Err(SolError::RpcError(err_str))
                }
            }
        }
    }

    /// Return the program ID as a base58 string
    pub fn program_id_str(&self) -> String {
        self.program_id.to_string()
    }

    /// Send mark_processing instruction (disc=0x02) for a RedemptionRequest PDA
    pub async fn send_mark_processing(
        &self,
        redemption_pda: &Pubkey,
    ) -> Result<String, SolError> {
        let payer = self.payer.as_ref().ok_or(SolError::NoPayerSet)?;

        let data = vec![0x02u8];

        let accounts = vec![
            AccountMeta::new(self.pool_state, false),
            AccountMeta::new(*redemption_pda, false),
            AccountMeta::new(payer.pubkey(), true),
        ];

        let ix = Instruction {
            program_id: self.program_id,
            accounts,
            data,
        };

        self.send_transaction(&[ix], &[payer]).await
    }

    /// Send complete_redemption instruction (disc=0x06) for a RedemptionRequest PDA
    pub async fn send_complete_redemption(
        &self,
        redemption_pda: &Pubkey,
        btc_txid: &[u8; 32],
        verified_tx_pda: &Pubkey,
        tx_buffer: &Pubkey,
        tx_size: u32,
    ) -> Result<String, SolError> {
        let payer = self.payer.as_ref().ok_or(SolError::NoPayerSet)?;

        // Data: [0x06] + btc_txid(32) + tx_size(4) = 37 bytes
        let mut data = Vec::with_capacity(37);
        data.push(0x06u8);
        data.extend_from_slice(btc_txid);
        data.extend_from_slice(&tx_size.to_le_bytes());

        // Derive light_client PDA under BTC_LIGHT_CLIENT_PROGRAM_ID
        let (light_client_pda, _) = Pubkey::find_program_address(
            &[b"btc_light_client"],
            &BTC_LIGHT_CLIENT_PROGRAM_ID,
        );

        // Derive pool_vault PDA
        let (pool_vault, _) = Pubkey::find_program_address(
            &[b"vault", self.zkbtc_mint.as_ref()],
            &self.program_id,
        );

        let accounts = vec![
            AccountMeta::new(self.pool_state, false),                   // 0: pool_state (writable)
            AccountMeta::new(*redemption_pda, false),                   // 1: redemption_pda (writable)
            AccountMeta::new(payer.pubkey(), true),                     // 2: payer/authority (signer)
            AccountMeta::new_readonly(payer.pubkey(), false),           // 3: payer (rent recipient)
            AccountMeta::new_readonly(*verified_tx_pda, false),        // 4: verified_tx_pda
            AccountMeta::new_readonly(light_client_pda, false),        // 5: light_client PDA
            AccountMeta::new_readonly(*tx_buffer, false),              // 6: tx_buffer
            AccountMeta::new(self.zkbtc_mint, false),                  // 7: zkbtc_mint (writable)
            AccountMeta::new(pool_vault, false),                       // 8: pool_vault (writable)
            AccountMeta::new_readonly(TOKEN_2022_PROGRAM_ID, false),   // 9: TOKEN_2022
        ];

        let ix = Instruction {
            program_id: self.program_id,
            accounts,
            data,
        };

        self.send_transaction(&[ix], &[payer]).await
    }

    /// Derive the verified_tx PDA from block_hash and txid
    pub fn derive_verified_tx_pda(
        block_hash: &[u8; 32],
        txid: &[u8; 32],
    ) -> Pubkey {
        let (pda, _) = Pubkey::find_program_address(
            &[b"verified_tx", block_hash, txid],
            &BTC_LIGHT_CLIENT_PROGRAM_ID,
        );
        pda
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
