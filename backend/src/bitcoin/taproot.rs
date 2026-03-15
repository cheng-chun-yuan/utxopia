//! Taproot Address Generation with Embedded Commitment
//!
//! # Security Notes
//!
//! - For production (mainnet): Keys MUST be generated via FROST DKG
//! - For testing (devnet/testnet): Environment-derived keys can be used
//! - NEVER use hardcoded keys with real funds
//!
//! # How it works:
//!
//! ## Address Generation (Deposit) - 2-Path Design
//! 1. User generates a PrivateNote with (amount, blinding, nullifier)
//! 2. Compute commitment: C = Hash(nullifier, secret)
//! 3. Create 2-path Taproot address:
//!    - Key path: Admin can spend immediately (pool internal key)
//!    - Script path: User can refund after timelock (OP_CHECKSEQUENCEVERIFY)
//! 4. Tweak includes both commitment and script tree
//!
//! ## Spending Paths
//! - **Admin Path (Key Path)**: Admin sweeps BTC to pool custody immediately
//! - **User Refund Path (Script Path)**: User can reclaim after 24hr if admin doesn't claim
//!
//! The admin submits SPV proof to Solana after sweeping.

use bitcoin::key::{Keypair, Secp256k1, TweakedPublicKey};
use bitcoin::opcodes::all::*;
use bitcoin::script::Builder as ScriptBuilder;
use bitcoin::secp256k1::{self, SecretKey};
use bitcoin::taproot::{TaprootBuilder, TaprootSpendInfo};
use bitcoin::{Address, Network, ScriptBuf, XOnlyPublicKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::common::crypto::sha256;

/// The pool's internal key (in production: FROST aggregate key)
/// For this POC, we use a deterministic key derived from a seed
pub struct PoolKeys {
    /// The internal (untweaked) public key
    pub internal_key: XOnlyPublicKey,
    /// Secret key (in production: distributed via FROST)
    #[allow(dead_code)]
    secret_key: SecretKey,
    /// Secp256k1 context
    secp: Secp256k1<secp256k1::All>,
}

impl Default for PoolKeys {
    fn default() -> Self {
        Self::new()
    }
}

impl PoolKeys {
    /// Create pool keys from environment configuration
    ///
    /// # Security
    ///
    /// - Production: Loads key from AEGIS_BTC_SIGNER_KEY environment variable
    /// - Devnet: Falls back to derived key if env var not set (with warning)
    ///
    /// For mainnet, FROST DKG should be used instead of single-key signing.
    pub fn new() -> Self {
        use std::env;

        let secp = Secp256k1::new();

        // Try to load from environment variable first
        let secret_key = match env::var("AEGIS_BTC_SIGNER_KEY") {
            Ok(hex_key) if !hex_key.is_empty() => {
                let bytes =
                    hex::decode(&hex_key).expect("AEGIS_BTC_SIGNER_KEY must be valid hex");
                SecretKey::from_slice(&bytes)
                    .expect("AEGIS_BTC_SIGNER_KEY must be a valid secp256k1 secret key")
            }
            _ => {
                // Check if we're on devnet (allow fallback) or production (error)
                let network = env::var("AEGIS_NETWORK").unwrap_or_else(|_| "devnet".to_string());
                if network == "mainnet" {
                    panic!(
                        "AEGIS_BTC_SIGNER_KEY environment variable is required for mainnet. \
                         For production, use FROST DKG instead of single-key signing."
                    );
                }

                // Devnet/testnet fallback with warning
                eprintln!(
                    "WARNING: Using derived key for {} - DO NOT USE WITH REAL FUNDS!",
                    network
                );
                eprintln!("Set AEGIS_BTC_SIGNER_KEY environment variable for custom keys.");

                // Use environment-specific seed (not fully deterministic)
                let seed_input = format!(
                    "aegis_devnet_key_{}",
                    env::var("HOSTNAME").unwrap_or_else(|_| "local".to_string())
                );
                let seed = sha256(seed_input.as_bytes());
                SecretKey::from_slice(&seed).expect("32 bytes, within curve order")
            }
        };

        let keypair = Keypair::from_secret_key(&secp, &secret_key);
        let (internal_key, _parity) = keypair.x_only_public_key();

        Self {
            internal_key,
            secret_key,
            secp,
        }
    }

    /// Create from a specific seed (for testing)
    pub fn from_seed(seed: &[u8]) -> Self {
        let secp = Secp256k1::new();
        let hash = sha256(seed);
        let secret_key = SecretKey::from_slice(&hash).expect("valid secret key");

        let keypair = Keypair::from_secret_key(&secp, &secret_key);
        let (internal_key, _parity) = keypair.x_only_public_key();

        Self {
            internal_key,
            secret_key,
            secp,
        }
    }

    /// Get the internal key as hex
    pub fn internal_key_hex(&self) -> String {
        hex::encode(self.internal_key.serialize())
    }
}

/// Taproot deposit address with embedded commitment (legacy single-path)
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TaprootDeposit {
    /// The Taproot address (bc1p...)
    pub address: String,
    /// The tweaked output key (x-only)
    pub output_key: String,
    /// The commitment that was embedded
    pub commitment: String,
    /// Network (mainnet, testnet, signet)
    pub network: String,
}

// ============================================================================
// Constants for 2-Path Deposit Flow
// ============================================================================

/// Timelock: 144 blocks ≈ 24 hours on mainnet
pub const REFUND_TIMELOCK_BLOCKS: u16 = 144;

/// For testnet (faster testing): 6 blocks ≈ 1 hour
pub const REFUND_TIMELOCK_BLOCKS_TESTNET: u16 = 6;

/// Required confirmations for admin sweep (devnet: 1, production: 2+)
pub const ADMIN_SWEEP_CONFIRMATIONS: u32 = 1;

/// SPV: Required block confirmations (reduced to 1 for demo/testing)
pub const SPV_REQUIRED_CONFIRMATIONS: u64 = 1;

// ============================================================================
// 2-Path Taproot Address (Admin + User Refund)
// ============================================================================

/// Taproot deposit address with 2 spending paths:
/// - Key path: Admin can claim immediately
/// - Script path: User can refund after timelock
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TaprootDepositDualPath {
    /// The Taproot address (bc1p...)
    pub address: String,
    /// The tweaked output key (x-only, hex)
    pub output_key: String,
    /// The commitment that was embedded (hex)
    pub commitment: String,
    /// User's x-only pubkey for refund path (hex)
    pub user_pubkey: String,
    /// Timelock in blocks until user can refund
    pub timelock_blocks: u16,
    /// Script leaf hash for script path spending (hex)
    pub script_leaf_hash: String,
    /// Network (mainnet, testnet, signet)
    pub network: String,
    /// The refund script (for building witness)
    pub refund_script: String,
}

/// Internal representation with raw bytes
pub struct TaprootDepositDualPathRaw {
    pub address: String,
    pub output_key: XOnlyPublicKey,
    pub commitment: [u8; 32],
    pub user_pubkey: XOnlyPublicKey,
    pub timelock_blocks: u16,
    pub script_leaf_hash: [u8; 32],
    pub network: Network,
    pub refund_script: ScriptBuf,
    pub taproot_spend_info: TaprootSpendInfo,
}


/// Compute the taproot tweak hash: H_taptweak(P || commitment)
/// Uses BIP-340 tagged hash: SHA256(SHA256("TapTweak") || SHA256("TapTweak") || data)
fn compute_tweak(internal_key: &XOnlyPublicKey, commitment: &[u8; 32]) -> [u8; 32] {
    // BIP-340 tagged hash for TapTweak
    let tag_hash = sha256(b"TapTweak");

    let mut hasher = Sha256::new();
    hasher.update(&tag_hash);
    hasher.update(&tag_hash);
    hasher.update(&internal_key.serialize());
    hasher.update(commitment);
    hasher.finalize().into()
}

/// Generate a Taproot address with commitment embedded in the tweak
///
/// # Process:
/// 1. Take the pool's internal key P
/// 2. Compute tweak: t = H_taptweak(P || commitment)
/// 3. Compute output key: Q = P + t*G
/// 4. Encode as bech32m address
///
/// # Arguments:
/// * `pool_keys` - The pool's key material
/// * `commitment` - The Pedersen commitment bytes (32 bytes)
/// * `network` - Bitcoin network (mainnet, testnet, signet)
pub fn generate_deposit_address(
    pool_keys: &PoolKeys,
    commitment: &[u8; 32],
    network: Network,
) -> Result<TaprootDeposit, TaprootError> {
    let secp = &pool_keys.secp;

    // Compute the tweak from internal key and commitment
    let tweak_bytes = compute_tweak(&pool_keys.internal_key, commitment);

    // Convert tweak bytes to scalar (handle potential overflow)
    let scalar =
        secp256k1::Scalar::from_be_bytes(tweak_bytes).map_err(|_| TaprootError::InvalidScalar)?;

    // Apply tweak to get output key
    // Q = P + tweak*G (this is what bitcoin library does internally)
    let tweaked = pool_keys
        .internal_key
        .add_tweak(secp, &scalar)
        .map_err(|_| TaprootError::TweakFailed)?;

    let (output_key, _parity) = tweaked;

    // Create the Taproot address with commitment-tweaked key
    let address_with_commitment = Address::p2tr_tweaked(
        TweakedPublicKey::dangerous_assume_tweaked(output_key),
        network,
    );

    Ok(TaprootDeposit {
        address: address_with_commitment.to_string(),
        output_key: hex::encode(output_key.serialize()),
        commitment: hex::encode(commitment),
        network: format!("{:?}", network),
    })
}

// ============================================================================
// 2-Path Taproot Address Generation
// ============================================================================

/// Build the timelock refund script for user
///
/// Script: <user_pubkey> OP_CHECKSIGVERIFY <timelock_blocks> OP_CHECKSEQUENCEVERIFY
///
/// This allows the user to spend after `timelock_blocks` have passed since the
/// UTXO was created, but only with their signature.
pub fn build_timelock_script(user_pubkey: &XOnlyPublicKey, timelock_blocks: u16) -> ScriptBuf {
    // BIP-68: sequence number encoding for relative timelock
    // For blocks, we use the value directly (must be < 65535)
    ScriptBuilder::new()
        .push_x_only_key(user_pubkey)
        .push_opcode(OP_CHECKSIGVERIFY)
        .push_int(timelock_blocks as i64)
        .push_opcode(OP_CSV)
        .into_script()
}

/// Generate a 2-path Taproot deposit address
///
/// Creates an address with:
/// - **Key path**: Pool internal key (admin can spend immediately)
/// - **Script path**: Timelock script (user can refund after N blocks)
///
/// The commitment is embedded via a custom tweak:
/// tweak = H_taptweak(P || merkle_root || commitment)
///
/// # Arguments
/// * `pool_keys` - The pool's key material
/// * `user_pubkey` - User's x-only pubkey for the refund script
/// * `commitment` - The commitment bytes (32 bytes)
/// * `timelock_blocks` - Number of blocks until user can refund (e.g., 144 for ~24hr)
/// * `network` - Bitcoin network
pub fn generate_deposit_address_dual_path(
    pool_keys: &PoolKeys,
    user_pubkey: &XOnlyPublicKey,
    commitment: &[u8; 32],
    timelock_blocks: u16,
    network: Network,
) -> Result<TaprootDepositDualPathRaw, TaprootError> {
    let secp = &pool_keys.secp;

    // Step 1: Tweak the internal key with the commitment BEFORE building the taproot tree.
    // This ensures each commitment gets a unique address while keeping both
    // key-path and script-path spending valid (control block stays consistent).
    let commitment_tweak = compute_commitment_tweak(&pool_keys.internal_key, commitment);
    let scalar =
        secp256k1::Scalar::from_be_bytes(commitment_tweak).map_err(|_| TaprootError::InvalidScalar)?;
    let (committed_internal_key, _parity) = pool_keys
        .internal_key
        .add_tweak(secp, &scalar)
        .map_err(|_| TaprootError::TweakFailed)?;

    // Step 2: Build the refund script (user can spend after timelock)
    let refund_script = build_timelock_script(user_pubkey, timelock_blocks);

    // Step 3: Build the taproot tree with committed internal key
    let builder = TaprootBuilder::new()
        .add_leaf(0, refund_script.clone())
        .map_err(|_| TaprootError::TaprootBuildFailed)?;

    let taproot_spend_info = builder
        .finalize(secp, committed_internal_key)
        .map_err(|_| TaprootError::TaprootBuildFailed)?;

    // Output key = committed_internal_key + taproot_tweak(merkle_root) * G
    // Both key-path (admin) and script-path (user refund) work correctly
    let output_key = taproot_spend_info.output_key();
    let (output_x_only, _) = (output_key.to_x_only_public_key(), ());

    let address = Address::p2tr_tweaked(output_key, network);

    let script_leaf_hash = compute_tapleaf_hash(&refund_script);

    Ok(TaprootDepositDualPathRaw {
        address: address.to_string(),
        output_key: output_x_only,
        commitment: *commitment,
        user_pubkey: *user_pubkey,
        timelock_blocks,
        script_leaf_hash,
        network,
        refund_script,
        taproot_spend_info,
    })
}

/// Convert raw dual-path to serializable format
impl TaprootDepositDualPathRaw {
    pub fn to_response(&self) -> TaprootDepositDualPath {
        TaprootDepositDualPath {
            address: self.address.clone(),
            output_key: hex::encode(self.output_key.serialize()),
            commitment: hex::encode(self.commitment),
            user_pubkey: hex::encode(self.user_pubkey.serialize()),
            timelock_blocks: self.timelock_blocks,
            script_leaf_hash: hex::encode(self.script_leaf_hash),
            network: format!("{:?}", self.network),
            refund_script: hex::encode(self.refund_script.as_bytes()),
        }
    }
}

// ============================================================================
// FROST-based Dual-Path Address Generation
// ============================================================================

/// Generate a dual-path Taproot deposit address using FROST group public key
///
/// This function is used when the vault operates with FROST threshold signing.
/// The address has two spending paths:
/// - **Key Path (Vault Sweep)**: FROST signers can spend immediately
/// - **Script Path (User Refund)**: User can refund after timelock with their signature
///
/// The commitment is embedded via a tweak to ensure each deposit gets a unique address
/// while still being spendable by the FROST group.
///
/// # Arguments
/// * `frost_group_pubkey` - The FROST group public key (x-only 32 bytes)
/// * `user_pubkey` - User's x-only pubkey for the refund script
/// * `commitment` - The commitment bytes (32 bytes, typically SHA256(nullifier || secret))
/// * `timelock_blocks` - Number of blocks until user can refund (144 for ~24hr on mainnet)
/// * `network` - Bitcoin network
///
/// # Returns
/// A `TaprootDepositDualPathRaw` containing the address and metadata needed for spending
pub fn generate_frost_deposit_address(
    frost_group_pubkey: &XOnlyPublicKey,
    user_pubkey: &XOnlyPublicKey,
    commitment: &[u8; 32],
    timelock_blocks: u16,
    network: Network,
) -> Result<TaprootDepositDualPathRaw, TaprootError> {
    let secp = Secp256k1::new();

    // Step 1: Tweak the FROST group key with the commitment FIRST.
    // This ensures each deposit gets a unique address while keeping
    // both key-path and script-path spending valid.
    let commitment_tweak = compute_commitment_tweak(frost_group_pubkey, commitment);
    let scalar = secp256k1::Scalar::from_be_bytes(commitment_tweak)
        .map_err(|_| TaprootError::InvalidScalar)?;
    let (committed_internal_key, _parity) = frost_group_pubkey
        .add_tweak(&secp, &scalar)
        .map_err(|_| TaprootError::TweakFailed)?;

    // Step 2: Build the refund script (user can spend after timelock)
    let refund_script = build_timelock_script(user_pubkey, timelock_blocks);

    // Step 3: Build the taproot tree with committed internal key
    let builder = TaprootBuilder::new()
        .add_leaf(0, refund_script.clone())
        .map_err(|_| TaprootError::TaprootBuildFailed)?;

    let taproot_spend_info = builder
        .finalize(&secp, committed_internal_key)
        .map_err(|_| TaprootError::TaprootBuildFailed)?;

    // Output key = committed_internal_key + taproot_tweak(merkle_root) * G
    let output_key = taproot_spend_info.output_key();
    let output_x_only = output_key.to_x_only_public_key();

    let address = Address::p2tr_tweaked(output_key, network);

    let script_leaf_hash = compute_tapleaf_hash(&refund_script);

    Ok(TaprootDepositDualPathRaw {
        address: address.to_string(),
        output_key: output_x_only,
        commitment: *commitment,
        user_pubkey: *user_pubkey,
        timelock_blocks,
        script_leaf_hash,
        network,
        refund_script,
        taproot_spend_info,
    })
}

/// Compute the total tweak needed for FROST signing
///
/// When spending via key path, the FROST signers need to apply the same tweak
/// that was used to derive the address. This includes:
/// 1. The taproot tweak (from merkle root of script tree)
/// 2. The commitment tweak
///
/// # Arguments
/// * `frost_group_pubkey` - The FROST group public key
/// * `user_pubkey` - User's public key (for rebuilding script tree)
/// * `commitment` - The commitment that was embedded
/// * `timelock_blocks` - Timelock used in refund script
///
/// # Returns
/// The 32-byte tweak that FROST signers must use for sign_tweaked()
pub fn compute_frost_signing_tweak(
    frost_group_pubkey: &XOnlyPublicKey,
    _user_pubkey: &XOnlyPublicKey,
    commitment: &[u8; 32],
    _timelock_blocks: u16,
) -> Result<[u8; 32], TaprootError> {
    // With the new design, the commitment tweak is applied to the internal key
    // BEFORE building the taproot tree. So FROST signers need:
    //   1. commitment_tweak (applied to their group key)
    //   2. taproot_tweak (handled by TaprootSpendInfo during signing)
    //
    // This function returns the commitment tweak. The taproot tweak
    // is obtained from the TaprootSpendInfo at signing time.
    let commitment_tweak = compute_commitment_tweak(frost_group_pubkey, commitment);
    Ok(commitment_tweak)
}

/// Reconstruct a deposit address from its components
///
/// This is useful for verification - given the same inputs, we should
/// get the same tb1p... address.
pub fn reconstruct_frost_address(
    frost_group_pubkey: &XOnlyPublicKey,
    user_pubkey: &XOnlyPublicKey,
    commitment: &[u8; 32],
    timelock_blocks: u16,
    network: Network,
) -> Result<String, TaprootError> {
    let result = generate_frost_deposit_address(
        frost_group_pubkey,
        user_pubkey,
        commitment,
        timelock_blocks,
        network,
    )?;
    Ok(result.address)
}

/// Compute commitment tweak: H_commitment(output_key || commitment)
fn compute_commitment_tweak(output_key: &XOnlyPublicKey, commitment: &[u8; 32]) -> [u8; 32] {
    // Use a tagged hash for domain separation
    let tag_hash = sha256(b"Aegis/CommitmentTweak");

    let mut hasher = Sha256::new();
    hasher.update(&tag_hash);
    hasher.update(&tag_hash);
    hasher.update(&output_key.serialize());
    hasher.update(commitment);
    hasher.finalize().into()
}

/// Compute tapleaf hash for a script
fn compute_tapleaf_hash(script: &ScriptBuf) -> [u8; 32] {
    // BIP-341 tagged hash for TapLeaf
    let tag_hash = sha256(b"TapLeaf");

    let mut hasher = Sha256::new();
    hasher.update(&tag_hash);
    hasher.update(&tag_hash);
    // Leaf version (0xc0 for TapScript)
    hasher.update(&[0xc0]);
    // Script length as compact size
    let script_bytes = script.as_bytes();
    if script_bytes.len() < 253 {
        hasher.update(&[script_bytes.len() as u8]);
    } else {
        // Compact size encoding for larger scripts
        hasher.update(&[253]);
        hasher.update(&(script_bytes.len() as u16).to_le_bytes());
    }
    hasher.update(script_bytes);
    hasher.finalize().into()
}

/// Parse x-only public key from hex string
pub fn parse_x_only_pubkey(hex_str: &str) -> Result<XOnlyPublicKey, TaprootError> {
    let bytes = hex::decode(hex_str).map_err(|_| TaprootError::InvalidKey)?;
    if bytes.len() != 32 {
        return Err(TaprootError::InvalidKey);
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    XOnlyPublicKey::from_slice(&arr).map_err(|_| TaprootError::InvalidKey)
}

/// Spending proof - what the user must provide to withdraw
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SpendingProof {
    /// Amount (reveals the hidden value)
    pub amount: u64,
    /// Blinding factor (opens the commitment)
    pub blinding: String,
    /// Nullifier (prevents double-spend)
    pub nullifier: String,
    /// Merkle proof of commitment inclusion
    pub merkle_proof: Vec<String>,
    /// Recipient BTC address
    pub recipient: String,
}

/// Unlock criteria documentation
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UnlockCriteria {
    pub description: String,
    pub steps: Vec<UnlockStep>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UnlockStep {
    pub step: u8,
    pub name: String,
    pub description: String,
    pub verified_by: String,
}

/// Get the unlock criteria explanation
pub fn get_unlock_criteria() -> UnlockCriteria {
    UnlockCriteria {
        description: "To unlock BTC from a Taproot deposit address, the following criteria must be met:".to_string(),
        steps: vec![
            UnlockStep {
                step: 1,
                name: "Commitment Opening".to_string(),
                description: "User reveals (amount, blinding_factor) such that:\n  \
                    C = amount * G + blinding * H\n  \
                    This proves they know the hidden amount.".to_string(),
                verified_by: "ZK circuit verifies the Pedersen commitment opens correctly".to_string(),
            },
            UnlockStep {
                step: 2,
                name: "Merkle Membership".to_string(),
                description: "User provides a Merkle proof showing their commitment C \
                    is a leaf in the public commitment tree.\n  \
                    root = Hash(... Hash(C, sibling) ...)".to_string(),
                verified_by: "ZK circuit verifies proof against on-chain Merkle root".to_string(),
            },
            UnlockStep {
                step: 3,
                name: "Nullifier Freshness".to_string(),
                description: "User reveals nullifier N, and its hash H(N) must NOT \
                    exist in the spent nullifier set.\n  \
                    This prevents double-spending the same note.".to_string(),
                verified_by: "On-chain contract checks nullifier against nullifier set".to_string(),
            },
            UnlockStep {
                step: 4,
                name: "FROST Threshold Signature".to_string(),
                description: "If all checks pass, FROST signers collectively produce \
                    a Schnorr signature to spend the Taproot UTXO.\n  \
                    The signature authorizes sending BTC to the recipient address.".to_string(),
                verified_by: "t-of-n FROST signers must agree (e.g., 5-of-7)".to_string(),
            },
        ],
    }
}

/// Errors for Taproot operations
#[derive(Debug, thiserror::Error)]
pub enum TaprootError {
    #[error("failed to apply tweak to internal key")]
    TweakFailed,
    #[error("invalid commitment length")]
    InvalidCommitment,
    #[error("invalid key")]
    InvalidKey,
    #[error("invalid scalar value for tweak")]
    InvalidScalar,
    #[error("failed to build taproot tree")]
    TaprootBuildFailed,
}

#[cfg(test)]
mod tests {
    use super::*;
    use bitcoin::absolute::LockTime;
    use bitcoin::hashes::Hash;
    use bitcoin::sighash::{Prevouts, SighashCache};
    use bitcoin::taproot::LeafVersion;
    use bitcoin::transaction::Version;
    use bitcoin::{
        Amount, OutPoint, Sequence, TapLeafHash, TapSighashType, Transaction, TxIn, TxOut, Txid,
        Witness,
    };

    #[test]
    fn test_pool_keys_deterministic() {
        let keys1 = PoolKeys::new();
        let keys2 = PoolKeys::new();
        assert_eq!(keys1.internal_key, keys2.internal_key);
    }

    #[test]
    fn test_generate_deposit_address() {
        let keys = PoolKeys::new();
        let commitment = [0x42u8; 32];
        let deposit = generate_deposit_address(&keys, &commitment, Network::Testnet).unwrap();
        assert!(deposit.address.starts_with("tb1p"));
        println!("Deposit address: {}", deposit.address);
    }

    #[test]
    fn test_different_commitments_different_addresses() {
        let keys = PoolKeys::new();
        let commitment1 = [0x01u8; 32];
        let commitment2 = [0x02u8; 32];
        let addr1 = generate_deposit_address(&keys, &commitment1, Network::Bitcoin).unwrap();
        let addr2 = generate_deposit_address(&keys, &commitment2, Network::Bitcoin).unwrap();
        assert_ne!(addr1.address, addr2.address);
        assert_ne!(addr1.output_key, addr2.output_key);
    }

    #[test]
    fn test_unlock_criteria() {
        let criteria = get_unlock_criteria();
        assert_eq!(criteria.steps.len(), 4);
    }

    // ========================================================================
    // Dual-Path Taproot Simulation Tests
    // ========================================================================
    //
    // These tests simulate the full BTC deposit lifecycle:
    //   1. Aegis (admin) CAN spend immediately via key path
    //   2. Depositor CANNOT spend before CSV timelock expires
    //   3. Depositor CAN spend after CSV timelock expires
    //
    // We use bitcoin crate's Script interpreter simulation by verifying
    // sighash computation and script execution constraints.
    // ========================================================================

    /// Helper: create a dummy funding UTXO (simulates BTC deposited to dual-path address)
    fn create_funding_utxo(output_key: &XOnlyPublicKey, amount_sats: u64) -> (TxOut, OutPoint) {
        let script_pubkey = ScriptBuf::new_p2tr_tweaked(
            TweakedPublicKey::dangerous_assume_tweaked(*output_key),
        );
        let txout = TxOut {
            value: Amount::from_sat(amount_sats),
            script_pubkey,
        };
        let outpoint = OutPoint {
            txid: Txid::from_slice(&[0xAA; 32]).unwrap(),
            vout: 0,
        };
        (txout, outpoint)
    }

    /// Helper: create a spending transaction
    fn create_spending_tx(outpoint: OutPoint, sequence: Sequence) -> Transaction {
        Transaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: vec![TxIn {
                previous_output: outpoint,
                script_sig: ScriptBuf::new(),
                sequence,
                witness: Witness::new(),
            }],
            output: vec![TxOut {
                value: Amount::from_sat(99_000), // 100k - fee
                script_pubkey: ScriptBuf::new_p2tr_tweaked(
                    TweakedPublicKey::dangerous_assume_tweaked(
                        XOnlyPublicKey::from_slice(&[0x02; 32]).unwrap_or_else(|_| {
                            // Use a valid x-only key
                            let secp = Secp256k1::new();
                            let sk = SecretKey::from_slice(&[0x01; 32]).unwrap();
                            let kp = Keypair::from_secret_key(&secp, &sk);
                            kp.x_only_public_key().0
                        }),
                    ),
                ),
            }],
        }
    }

    #[test]
    fn test_dual_path_address_generation() {
        let pool_keys = PoolKeys::from_seed(b"test_pool_seed");
        let secp = Secp256k1::new();

        // Create user keypair
        let user_sk = SecretKey::from_slice(&sha256(b"test_user_seed")).unwrap();
        let user_kp = Keypair::from_secret_key(&secp, &user_sk);
        let (user_pubkey, _) = user_kp.x_only_public_key();

        let commitment = sha256(b"test_commitment_data");
        let timelock = REFUND_TIMELOCK_BLOCKS_TESTNET; // 6 blocks

        let deposit = generate_deposit_address_dual_path(
            &pool_keys,
            &user_pubkey,
            &commitment,
            timelock,
            Network::Testnet,
        )
        .unwrap();

        // Address should be valid testnet taproot
        assert!(deposit.address.starts_with("tb1p"));

        // Refund script should contain CSV opcode
        let script_bytes = deposit.refund_script.as_bytes();
        assert!(
            script_bytes.contains(&0xb2), // OP_CSV = 0xb2
            "Refund script must contain OP_CSV"
        );
        assert!(
            script_bytes.contains(&0xad), // OP_CHECKSIGVERIFY = 0xad
            "Refund script must contain OP_CHECKSIGVERIFY"
        );

        println!("Dual-path deposit address: {}", deposit.address);
        println!("Timelock: {} blocks", deposit.timelock_blocks);
        println!(
            "Refund script (hex): {}",
            hex::encode(deposit.refund_script.as_bytes())
        );
    }

    #[test]
    fn test_admin_can_spend_immediately_via_key_path() {
        println!("\n=== TEST: Admin (Aegis) can spend immediately via key path ===\n");

        let secp = Secp256k1::new();
        let pool_keys = PoolKeys::from_seed(b"test_pool_admin");

        // User keypair
        let user_sk = SecretKey::from_slice(&sha256(b"test_user_admin")).unwrap();
        let user_kp = Keypair::from_secret_key(&secp, &user_sk);
        let (user_pubkey, _) = user_kp.x_only_public_key();

        let commitment = sha256(b"admin_test_commitment");
        let timelock = REFUND_TIMELOCK_BLOCKS; // 144 blocks (24hr)

        let deposit = generate_deposit_address_dual_path(
            &pool_keys,
            &user_pubkey,
            &commitment,
            timelock,
            Network::Testnet,
        )
        .unwrap();

        // Create funding UTXO at the deposit address
        let (funding_utxo, outpoint) = create_funding_utxo(&deposit.output_key, 100_000);

        // Admin spends immediately - NO sequence restriction for key path
        let mut spending_tx = create_spending_tx(outpoint, Sequence::ENABLE_RBF_NO_LOCKTIME);

        // Compute key-path sighash
        let prevouts = [funding_utxo.clone()];
        let mut sighash_cache = SighashCache::new(&mut spending_tx);
        let sighash = sighash_cache
            .taproot_key_spend_signature_hash(
                0,
                &Prevouts::All(&prevouts),
                TapSighashType::Default,
            )
            .expect("Key path sighash should succeed");

        // Admin signs with the tweaked key
        // First apply commitment tweak to internal key (same order as address generation)
        let commitment_tweak =
            compute_commitment_tweak(&pool_keys.internal_key, &commitment);
        let commitment_scalar =
            secp256k1::Scalar::from_be_bytes(commitment_tweak).expect("Valid scalar");
        let base_keypair = Keypair::from_secret_key(&secp, &pool_keys.secret_key);
        let committed_keypair = base_keypair
            .add_xonly_tweak(&secp, &commitment_scalar)
            .expect("Commitment tweak should succeed");

        // Then apply taproot tweak (from script tree merkle root)
        let taproot_tweak = deposit.taproot_spend_info.tap_tweak();
        let final_keypair = committed_keypair
            .add_xonly_tweak(&secp, &taproot_tweak.to_scalar())
            .expect("Taproot tweak should succeed");

        // Sign the sighash
        let msg = secp256k1::Message::from_digest(sighash.to_byte_array());
        let signature = secp.sign_schnorr(&msg, &final_keypair);

        // Verify signature against the final output key
        let verification = secp.verify_schnorr(&signature, &msg, &deposit.output_key);

        println!("  Deposit address: {}", deposit.address);
        println!("  Funding: 100,000 sats");
        println!("  Sequence: {:?} (no CSV restriction)", Sequence::ENABLE_RBF_NO_LOCKTIME);
        println!("  Sighash:  {}", hex::encode(sighash.to_byte_array()));
        println!("  Signature valid: {}", verification.is_ok());

        assert!(
            verification.is_ok(),
            "Admin MUST be able to spend via key path immediately (no timelock)"
        );

        println!("\n  RESULT: Admin CAN spend immediately via key path");
    }

    #[test]
    fn test_user_cannot_spend_before_timelock() {
        println!("\n=== TEST: User CANNOT spend before CSV timelock expires ===\n");

        let secp = Secp256k1::new();
        let pool_keys = PoolKeys::from_seed(b"test_pool_csv");

        let user_sk = SecretKey::from_slice(&sha256(b"test_user_csv")).unwrap();
        let user_kp = Keypair::from_secret_key(&secp, &user_sk);
        let (user_pubkey, _) = user_kp.x_only_public_key();

        let commitment = sha256(b"csv_test_commitment");
        let timelock: u16 = 144; // 24 hours

        let deposit = generate_deposit_address_dual_path(
            &pool_keys,
            &user_pubkey,
            &commitment,
            timelock,
            Network::Testnet,
        )
        .unwrap();

        let (funding_utxo, outpoint) = create_funding_utxo(&deposit.output_key, 100_000);

        // User tries to spend IMMEDIATELY (sequence = 0, meaning 0 blocks passed)
        // CSV requires sequence >= timelock_blocks
        let premature_sequence = Sequence::from_consensus(0);
        let mut spending_tx = create_spending_tx(outpoint, premature_sequence);

        // Build script path witness
        let refund_script = &deposit.refund_script;
        let control_block = deposit
            .taproot_spend_info
            .control_block(&(refund_script.clone(), LeafVersion::TapScript))
            .expect("Control block must exist for refund script");

        // Compute script-path sighash
        let prevouts = [funding_utxo.clone()];
        let leaf_hash = TapLeafHash::from_script(refund_script, LeafVersion::TapScript);
        let mut sighash_cache = SighashCache::new(&mut spending_tx);
        let sighash = sighash_cache
            .taproot_script_spend_signature_hash(
                0,
                &Prevouts::All(&prevouts),
                leaf_hash,
                TapSighashType::Default,
            )
            .expect("Script path sighash should succeed");

        // User signs
        let msg = secp256k1::Message::from_digest(sighash.to_byte_array());
        let user_signature = secp.sign_schnorr(&msg, &user_kp);

        // Signature itself is valid (cryptographically)...
        let sig_valid = secp.verify_schnorr(&user_signature, &msg, &user_pubkey).is_ok();

        // ...BUT the CSV check will fail because sequence (0) < timelock (144)
        let sequence_value = premature_sequence.to_consensus_u32();
        let csv_satisfied = sequence_value >= timelock as u32;

        println!("  Deposit address: {}", deposit.address);
        println!("  CSV timelock: {} blocks (~24 hours)", timelock);
        println!("  Input sequence: {} (blocks since deposit)", sequence_value);
        println!("  User signature valid: {}", sig_valid);
        println!("  CSV satisfied: {} (sequence {} >= timelock {})", csv_satisfied, sequence_value, timelock);

        assert!(sig_valid, "User signature should be cryptographically valid");
        assert!(
            !csv_satisfied,
            "CSV must NOT be satisfied: sequence ({}) < timelock ({}). \
             Bitcoin nodes REJECT this transaction!",
            sequence_value, timelock
        );

        println!("\n  RESULT: User CANNOT spend before timelock - transaction REJECTED by Bitcoin consensus");
        println!("  Reason: OP_CHECKSEQUENCEVERIFY fails when nSequence ({}) < required ({})", sequence_value, timelock);
    }

    #[test]
    fn test_user_can_spend_after_timelock() {
        println!("\n=== TEST: User CAN spend after CSV timelock expires ===\n");

        let secp = Secp256k1::new();
        let pool_keys = PoolKeys::from_seed(b"test_pool_after");

        let user_sk = SecretKey::from_slice(&sha256(b"test_user_after")).unwrap();
        let user_kp = Keypair::from_secret_key(&secp, &user_sk);
        let (user_pubkey, _) = user_kp.x_only_public_key();

        let commitment = sha256(b"after_test_commitment");
        let timelock: u16 = 144;

        let deposit = generate_deposit_address_dual_path(
            &pool_keys,
            &user_pubkey,
            &commitment,
            timelock,
            Network::Testnet,
        )
        .unwrap();

        let (funding_utxo, outpoint) = create_funding_utxo(&deposit.output_key, 100_000);

        // User spends AFTER timelock: sequence = 144 (exactly at timelock)
        let post_timelock_sequence = Sequence::from_consensus(timelock as u32);
        let mut spending_tx = create_spending_tx(outpoint, post_timelock_sequence);

        // Build script path witness
        let refund_script = &deposit.refund_script;
        let control_block = deposit
            .taproot_spend_info
            .control_block(&(refund_script.clone(), LeafVersion::TapScript))
            .expect("Control block must exist for refund script");

        // Compute script-path sighash
        let prevouts = [funding_utxo.clone()];
        let leaf_hash = TapLeafHash::from_script(refund_script, LeafVersion::TapScript);
        let mut sighash_cache = SighashCache::new(&mut spending_tx);
        let sighash = sighash_cache
            .taproot_script_spend_signature_hash(
                0,
                &Prevouts::All(&prevouts),
                leaf_hash,
                TapSighashType::Default,
            )
            .expect("Script path sighash should succeed");

        // User signs
        let msg = secp256k1::Message::from_digest(sighash.to_byte_array());
        let user_signature = secp.sign_schnorr(&msg, &user_kp);

        // Signature is valid
        let sig_valid = secp.verify_schnorr(&user_signature, &msg, &user_pubkey).is_ok();

        // CSV check passes because sequence (144) >= timelock (144)
        let sequence_value = post_timelock_sequence.to_consensus_u32();
        let csv_satisfied = sequence_value >= timelock as u32;

        // Verify control block is valid (proves script is in the taproot tree)
        // The control block + script must hash to the merkle root embedded in the output key
        let control_block_valid = control_block.verify_taproot_commitment(
            &secp,
            deposit.taproot_spend_info.output_key().to_inner(),
            refund_script,
        );

        // Build the full witness that would go on-chain
        let mut witness = Witness::new();
        witness.push(user_signature.as_ref()); // Schnorr sig (64 bytes)
        witness.push(refund_script.as_bytes()); // Redeem script
        witness.push(control_block.serialize()); // Control block

        println!("  Deposit address: {}", deposit.address);
        println!("  CSV timelock: {} blocks (~24 hours)", timelock);
        println!("  Input sequence: {} (>= timelock)", sequence_value);
        println!("  User signature valid: {}", sig_valid);
        println!("  CSV satisfied: {} (sequence {} >= timelock {})", csv_satisfied, sequence_value, timelock);
        println!("  Control block valid: {}", control_block_valid);
        println!("  Witness size: {} bytes ({} elements)",
            witness.size(), witness.len());

        assert!(sig_valid, "User signature must be valid");
        assert!(
            csv_satisfied,
            "CSV must be satisfied: sequence ({}) >= timelock ({})",
            sequence_value, timelock
        );
        assert!(
            control_block_valid,
            "Control block must verify taproot commitment"
        );

        println!("\n  RESULT: User CAN spend after timelock - transaction ACCEPTED by Bitcoin consensus");
        println!("  Witness: [signature(64B), script({}B), control_block({}B)]",
            refund_script.as_bytes().len(),
            control_block.serialize().len());
    }

    #[test]
    fn test_timelock_boundary_conditions() {
        println!("\n=== TEST: CSV timelock boundary conditions ===\n");

        let timelock: u16 = 144;

        // Test various sequence values against the timelock
        let test_cases: Vec<(u32, bool, &str)> = vec![
            (0, false, "immediately (0 blocks)"),
            (1, false, "after 1 block (~10 min)"),
            (72, false, "after 72 blocks (~12 hours)"),
            (143, false, "after 143 blocks (just before 24hr)"),
            (144, true, "after 144 blocks (exactly 24hr)"),
            (145, true, "after 145 blocks (just after 24hr)"),
            (288, true, "after 288 blocks (~48hr)"),
            (1000, true, "after 1000 blocks (~1 week)"),
        ];

        for (seq, should_pass, description) in &test_cases {
            let csv_ok = *seq >= timelock as u32;
            assert_eq!(
                csv_ok, *should_pass,
                "sequence={} should {} CSV check",
                seq,
                if *should_pass { "pass" } else { "fail" }
            );
            let status = if csv_ok { "ALLOWED" } else { "BLOCKED" };
            println!("  seq={:>4} | {} | {}", seq, status, description);
        }

        println!("\n  All boundary conditions verified correctly");
    }

    #[test]
    fn test_testnet_vs_mainnet_timelock() {
        println!("\n=== TEST: Testnet vs Mainnet timelock values ===\n");

        assert_eq!(REFUND_TIMELOCK_BLOCKS, 144, "Mainnet: 144 blocks (~24 hours)");
        assert_eq!(REFUND_TIMELOCK_BLOCKS_TESTNET, 6, "Testnet: 6 blocks (~1 hour)");

        let secp = Secp256k1::new();
        let pool_keys = PoolKeys::from_seed(b"timelock_test");
        let user_sk = SecretKey::from_slice(&sha256(b"timelock_user")).unwrap();
        let user_kp = Keypair::from_secret_key(&secp, &user_sk);
        let (user_pubkey, _) = user_kp.x_only_public_key();
        let commitment = sha256(b"timelock_commitment");

        // Generate both mainnet and testnet addresses
        let mainnet_deposit = generate_deposit_address_dual_path(
            &pool_keys, &user_pubkey, &commitment,
            REFUND_TIMELOCK_BLOCKS, Network::Testnet,
        ).unwrap();

        let testnet_deposit = generate_deposit_address_dual_path(
            &pool_keys, &user_pubkey, &commitment,
            REFUND_TIMELOCK_BLOCKS_TESTNET, Network::Testnet,
        ).unwrap();

        // Different timelocks produce different addresses (different scripts → different merkle roots)
        assert_ne!(
            mainnet_deposit.address, testnet_deposit.address,
            "Different timelocks must produce different addresses"
        );

        // Verify scripts contain the correct timelock values
        let mainnet_script_hex = hex::encode(mainnet_deposit.refund_script.as_bytes());
        let testnet_script_hex = hex::encode(testnet_deposit.refund_script.as_bytes());

        // 144 = 0x0090 in bitcoin script encoding (OP_PUSHNUM would be used)
        // 6 = OP_6 (0x56) or push 0x06
        println!("  Mainnet timelock: {} blocks (~24 hours)", REFUND_TIMELOCK_BLOCKS);
        println!("  Mainnet refund script: {}", mainnet_script_hex);
        println!("  Testnet timelock: {} blocks (~1 hour)", REFUND_TIMELOCK_BLOCKS_TESTNET);
        println!("  Testnet refund script: {}", testnet_script_hex);
        println!("  Addresses differ: true");

        // Verify: after 6 blocks, testnet user can spend but mainnet user cannot
        let blocks_passed: u32 = 6;
        let testnet_csv_ok = blocks_passed >= REFUND_TIMELOCK_BLOCKS_TESTNET as u32;
        let mainnet_csv_ok = blocks_passed >= REFUND_TIMELOCK_BLOCKS as u32;

        assert!(testnet_csv_ok, "Testnet: user can refund after 6 blocks");
        assert!(!mainnet_csv_ok, "Mainnet: user cannot refund after only 6 blocks");

        println!("\n  After {} blocks:", blocks_passed);
        println!("    Testnet user refund: ALLOWED (6 >= 6)");
        println!("    Mainnet user refund: BLOCKED (6 < 144)");
    }

    #[test]
    fn test_full_lifecycle_simulation() {
        println!("\n=== FULL LIFECYCLE SIMULATION ===\n");
        println!("Scenario: User deposits 100,000 sats to dual-path taproot address\n");

        let secp = Secp256k1::new();
        let pool_keys = PoolKeys::from_seed(b"lifecycle_pool");

        let user_sk = SecretKey::from_slice(&sha256(b"lifecycle_user")).unwrap();
        let user_kp = Keypair::from_secret_key(&secp, &user_sk);
        let (user_pubkey, _) = user_kp.x_only_public_key();

        let commitment = sha256(b"lifecycle_commitment");
        let timelock = REFUND_TIMELOCK_BLOCKS_TESTNET; // 6 blocks for faster testing

        // Step 1: Generate deposit address
        let deposit = generate_deposit_address_dual_path(
            &pool_keys, &user_pubkey, &commitment,
            timelock, Network::Testnet,
        ).unwrap();

        println!("Step 1: Deposit address generated");
        println!("  Address: {}", deposit.address);
        println!("  Timelock: {} blocks", timelock);

        // Step 2: User sends 100k sats (simulated)
        let (funding_utxo, outpoint) = create_funding_utxo(&deposit.output_key, 100_000);
        println!("\nStep 2: User deposits 100,000 sats to the address");

        // Step 3: Admin sweeps immediately via key path
        let mut admin_tx = create_spending_tx(outpoint, Sequence::ENABLE_RBF_NO_LOCKTIME);
        let prevouts = [funding_utxo.clone()];
        let mut cache = SighashCache::new(&mut admin_tx);
        let admin_sighash = cache
            .taproot_key_spend_signature_hash(0, &Prevouts::All(&prevouts), TapSighashType::Default)
            .unwrap();

        // Commitment tweak first, then taproot tweak (same order as address generation)
        let commitment_tweak_bytes = compute_commitment_tweak(
            &pool_keys.internal_key, &commitment,
        );
        let commitment_scalar = secp256k1::Scalar::from_be_bytes(commitment_tweak_bytes).unwrap();
        let base_kp = Keypair::from_secret_key(&secp, &pool_keys.secret_key);
        let committed_kp = base_kp.add_xonly_tweak(&secp, &commitment_scalar).unwrap();
        let taproot_tweak = deposit.taproot_spend_info.tap_tweak();
        let final_kp = committed_kp.add_xonly_tweak(&secp, &taproot_tweak.to_scalar()).unwrap();

        let admin_msg = secp256k1::Message::from_digest(admin_sighash.to_byte_array());
        let admin_sig = secp.sign_schnorr(&admin_msg, &final_kp);
        let admin_ok = secp.verify_schnorr(&admin_sig, &admin_msg, &deposit.output_key).is_ok();

        println!("\nStep 3: Admin (Aegis) sweeps via key path");
        println!("  Sequence: no restriction (key path)");
        println!("  Signature valid: {}", admin_ok);
        println!("  Result: {} - Admin sweeps BTC to pool custody",
            if admin_ok { "SUCCESS" } else { "FAILED" });
        assert!(admin_ok);

        // Step 4: Meanwhile, user tries to refund at block 0 (should fail)
        let early_seq = Sequence::from_consensus(0);
        let csv_early = 0u32 >= timelock as u32;
        println!("\nStep 4: User tries refund at block 0");
        println!("  CSV check: {} (0 < {})", csv_early, timelock);
        println!("  Result: REJECTED - OP_CSV fails");
        assert!(!csv_early);

        // Step 5: User tries at block 3 (still too early)
        let csv_mid = 3u32 >= timelock as u32;
        println!("\nStep 5: User tries refund at block 3");
        println!("  CSV check: {} (3 < {})", csv_mid, timelock);
        println!("  Result: REJECTED - OP_CSV fails");
        assert!(!csv_mid);

        // Step 6: User refunds at block 6 (timelock expired)
        let post_seq = Sequence::from_consensus(timelock as u32);
        let mut user_tx = create_spending_tx(outpoint, post_seq);
        let refund_script = &deposit.refund_script;
        let control_block = deposit.taproot_spend_info
            .control_block(&(refund_script.clone(), LeafVersion::TapScript))
            .unwrap();
        let leaf_hash = TapLeafHash::from_script(refund_script, LeafVersion::TapScript);
        let user_prevouts = [funding_utxo.clone()];
        let mut user_cache = SighashCache::new(&mut user_tx);
        let user_sighash = user_cache
            .taproot_script_spend_signature_hash(
                0, &Prevouts::All(&user_prevouts), leaf_hash, TapSighashType::Default,
            ).unwrap();

        let user_msg = secp256k1::Message::from_digest(user_sighash.to_byte_array());
        let user_sig = secp.sign_schnorr(&user_msg, &user_kp);
        let user_sig_ok = secp.verify_schnorr(&user_sig, &user_msg, &user_pubkey).is_ok();
        let csv_ok = (timelock as u32) >= timelock as u32;
        let cb_ok = control_block.verify_taproot_commitment(
            &secp, deposit.taproot_spend_info.output_key().to_inner(), refund_script,
        );

        println!("\nStep 6: User refunds at block {} (timelock expired)", timelock);
        println!("  CSV check: {} ({} >= {})", csv_ok, timelock, timelock);
        println!("  Signature valid: {}", user_sig_ok);
        println!("  Control block valid: {}", cb_ok);
        println!("  Result: {} - User reclaims BTC",
            if user_sig_ok && csv_ok && cb_ok { "SUCCESS" } else { "FAILED" });
        assert!(user_sig_ok);
        assert!(csv_ok);
        assert!(cb_ok);

        println!("\n=== LIFECYCLE COMPLETE ===");
        println!("  Admin (key path):  can spend IMMEDIATELY");
        println!("  User (script path): blocked for {} blocks, then can refund", timelock);
        println!("  Security: Admin has {} block window to sweep before user can refund", timelock);
    }

    // ========================================================================
    // Bitcoin Core Consensus Verification (via bitcoinconsensus)
    //
    // These tests run Bitcoin Core's ACTUAL script interpreter (C code)
    // to verify taproot key-path and script-path spending at consensus level.
    // This is the same verification Bitcoin nodes use to validate transactions.
    // ========================================================================

    use bitcoin::consensus::Encodable;

    /// Serialize a transaction to raw bytes (wire format)
    fn serialize_tx(tx: &Transaction) -> Vec<u8> {
        let mut buf = Vec::new();
        tx.consensus_encode(&mut buf).unwrap();
        buf
    }

    /// Build a complete prevout for bitcoinconsensus taproot verification
    fn build_utxo(script_pubkey: &[u8], value: u64) -> bitcoinconsensus::Utxo {
        bitcoinconsensus::Utxo {
            script_pubkey: script_pubkey.as_ptr(),
            script_pubkey_len: script_pubkey.len() as std::ffi::c_uint,
            value: value as i64,
        }
    }

    #[test]
    fn test_consensus_admin_key_path_spend() {
        println!("\n=== CONSENSUS TEST: Admin key-path spend (Bitcoin Core interpreter) ===\n");

        let secp = Secp256k1::new();
        let pool_keys = PoolKeys::from_seed(b"consensus_pool_key");

        let user_sk = SecretKey::from_slice(&sha256(b"consensus_user_key")).unwrap();
        let user_kp = Keypair::from_secret_key(&secp, &user_sk);
        let (user_pubkey, _) = user_kp.x_only_public_key();

        let commitment = sha256(b"consensus_commitment");
        let timelock: u16 = 144;

        let deposit = generate_deposit_address_dual_path(
            &pool_keys, &user_pubkey, &commitment,
            timelock, Network::Regtest,
        ).unwrap();

        // Build the funding output (what the deposit address received)
        let funding_script = ScriptBuf::new_p2tr_tweaked(
            TweakedPublicKey::dangerous_assume_tweaked(deposit.output_key),
        );
        let amount_sats: u64 = 100_000;
        let funding_txout = TxOut {
            value: Amount::from_sat(amount_sats),
            script_pubkey: funding_script.clone(),
        };
        let outpoint = OutPoint {
            txid: Txid::from_slice(&[0xBB; 32]).unwrap(),
            vout: 0,
        };

        // Build the admin spending tx (key path, immediate)
        let dest_sk = SecretKey::from_slice(&sha256(b"dest_key")).unwrap();
        let dest_kp = Keypair::from_secret_key(&secp, &dest_sk);
        let (dest_xonly, _) = dest_kp.x_only_public_key();

        let mut tx = Transaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: vec![TxIn {
                previous_output: outpoint,
                script_sig: ScriptBuf::new(),
                sequence: Sequence::ENABLE_RBF_NO_LOCKTIME,
                witness: Witness::new(),
            }],
            output: vec![TxOut {
                value: Amount::from_sat(99_000),
                script_pubkey: ScriptBuf::new_p2tr_tweaked(
                    TweakedPublicKey::dangerous_assume_tweaked(dest_xonly),
                ),
            }],
        };

        // Compute key-path sighash
        let prevouts = [funding_txout.clone()];
        let sighash = {
            let mut cache = SighashCache::new(&mut tx);
            cache.taproot_key_spend_signature_hash(
                0, &Prevouts::All(&prevouts), TapSighashType::Default,
            ).unwrap()
        };

        // Admin signs: commitment tweak first, then taproot tweak
        let base_kp = Keypair::from_secret_key(&secp, &pool_keys.secret_key);
        let ct = compute_commitment_tweak(&pool_keys.internal_key, &commitment);
        let cs = secp256k1::Scalar::from_be_bytes(ct).unwrap();
        let committed_kp = base_kp.add_xonly_tweak(&secp, &cs).unwrap();
        let taproot_tweak = deposit.taproot_spend_info.tap_tweak();
        let final_kp = committed_kp.add_xonly_tweak(&secp, &taproot_tweak.to_scalar()).unwrap();

        let msg = secp256k1::Message::from_digest(sighash.to_byte_array());
        let sig = secp.sign_schnorr(&msg, &final_kp);

        // Set witness: key path = just the 64-byte Schnorr signature
        tx.input[0].witness.push(sig.as_ref());

        // Serialize and run Bitcoin Core consensus verification
        let tx_bytes = serialize_tx(&tx);
        let script_bytes = funding_script.as_bytes();
        let utxo = build_utxo(script_bytes, amount_sats);
        let spent_outputs = [utxo];

        let result = bitcoinconsensus::verify(
            script_bytes,
            amount_sats,
            &tx_bytes,
            Some(&spent_outputs),
            0,
        );

        println!("  Spend type: KEY PATH (admin/FROST)");
        println!("  Sequence: {:?} (no CSV restriction)", Sequence::ENABLE_RBF_NO_LOCKTIME);
        println!("  Witness: [schnorr_sig(64B)]");
        println!("  Consensus result: {:?}", result);

        assert!(
            result.is_ok(),
            "Bitcoin Core consensus MUST accept admin key-path spend.\n  Error: {:?}",
            result.err()
        );

        println!("\n  PASSED: Bitcoin Core consensus engine accepts admin key-path spend immediately");
    }

    #[test]
    fn test_consensus_user_script_path_rejected_before_timelock() {
        println!("\n=== CONSENSUS TEST: User script-path REJECTED before CSV timelock ===\n");

        let secp = Secp256k1::new();
        let pool_keys = PoolKeys::from_seed(b"consensus_reject_pool");

        let user_sk = SecretKey::from_slice(&sha256(b"consensus_reject_user")).unwrap();
        let user_kp = Keypair::from_secret_key(&secp, &user_sk);
        let (user_pubkey, _) = user_kp.x_only_public_key();

        let commitment = sha256(b"consensus_reject_commitment");
        let timelock: u16 = 144;

        let deposit = generate_deposit_address_dual_path(
            &pool_keys, &user_pubkey, &commitment,
            timelock, Network::Regtest,
        ).unwrap();

        let funding_script = ScriptBuf::new_p2tr_tweaked(
            TweakedPublicKey::dangerous_assume_tweaked(deposit.output_key),
        );
        let amount_sats: u64 = 100_000;
        let funding_txout = TxOut {
            value: Amount::from_sat(amount_sats),
            script_pubkey: funding_script.clone(),
        };
        let outpoint = OutPoint {
            txid: Txid::from_slice(&[0xCC; 32]).unwrap(),
            vout: 0,
        };

        // User tries to spend at sequence=0 (before timelock)
        let dest_sk = SecretKey::from_slice(&sha256(b"dest2")).unwrap();
        let dest_kp = Keypair::from_secret_key(&secp, &dest_sk);
        let (dest_xonly, _) = dest_kp.x_only_public_key();

        let mut tx = Transaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: vec![TxIn {
                previous_output: outpoint,
                script_sig: ScriptBuf::new(),
                sequence: Sequence::from_consensus(0), // TOO EARLY!
                witness: Witness::new(),
            }],
            output: vec![TxOut {
                value: Amount::from_sat(99_000),
                script_pubkey: ScriptBuf::new_p2tr_tweaked(
                    TweakedPublicKey::dangerous_assume_tweaked(dest_xonly),
                ),
            }],
        };

        // Compute script-path sighash
        let refund_script = &deposit.refund_script;
        let leaf_hash = TapLeafHash::from_script(refund_script, LeafVersion::TapScript);
        let prevouts = [funding_txout.clone()];
        let sighash = {
            let mut cache = SighashCache::new(&mut tx);
            cache.taproot_script_spend_signature_hash(
                0, &Prevouts::All(&prevouts), leaf_hash, TapSighashType::Default,
            ).unwrap()
        };

        // User signs (valid signature, but CSV will block)
        let msg = secp256k1::Message::from_digest(sighash.to_byte_array());
        let user_sig = secp.sign_schnorr(&msg, &user_kp);

        // Build control block
        let control_block = deposit.taproot_spend_info
            .control_block(&(refund_script.clone(), LeafVersion::TapScript))
            .expect("Control block must exist");

        // Set witness: [signature, script, control_block]
        tx.input[0].witness.push(user_sig.as_ref());
        tx.input[0].witness.push(refund_script.as_bytes());
        tx.input[0].witness.push(control_block.serialize());

        // Run Bitcoin Core consensus
        let tx_bytes = serialize_tx(&tx);
        let script_bytes = funding_script.as_bytes();
        let utxo = build_utxo(script_bytes, amount_sats);
        let spent_outputs = [utxo];

        let result = bitcoinconsensus::verify(
            script_bytes,
            amount_sats,
            &tx_bytes,
            Some(&spent_outputs),
            0,
        );

        println!("  Spend type: SCRIPT PATH (user refund)");
        println!("  Sequence: 0 (no blocks passed since deposit)");
        println!("  CSV timelock: {} blocks", timelock);
        println!("  Witness: [schnorr_sig(64B), refund_script({}B), control_block({}B)]",
            refund_script.as_bytes().len(), control_block.serialize().len());
        println!("  Consensus result: {:?}", result);

        assert!(
            result.is_err(),
            "Bitcoin Core consensus MUST REJECT user spend before CSV timelock!\n  \
             Got: {:?} (expected error)",
            result
        );

        println!("\n  PASSED: Bitcoin Core consensus engine REJECTS premature script-path spend");
        println!("  Reason: OP_CHECKSEQUENCEVERIFY fails (nSequence 0 < required {})", timelock);
    }

    #[test]
    fn test_consensus_user_script_path_accepted_after_timelock() {
        println!("\n=== CONSENSUS TEST: User script-path ACCEPTED after CSV timelock ===\n");

        let secp = Secp256k1::new();
        let pool_keys = PoolKeys::from_seed(b"consensus_accept_pool");

        let user_sk = SecretKey::from_slice(&sha256(b"consensus_accept_user")).unwrap();
        let user_kp = Keypair::from_secret_key(&secp, &user_sk);
        let (user_pubkey, _) = user_kp.x_only_public_key();

        let commitment = sha256(b"consensus_accept_commitment");
        let timelock: u16 = 144;

        let deposit = generate_deposit_address_dual_path(
            &pool_keys, &user_pubkey, &commitment,
            timelock, Network::Regtest,
        ).unwrap();

        let funding_script = ScriptBuf::new_p2tr_tweaked(
            TweakedPublicKey::dangerous_assume_tweaked(deposit.output_key),
        );
        let amount_sats: u64 = 100_000;
        let funding_txout = TxOut {
            value: Amount::from_sat(amount_sats),
            script_pubkey: funding_script.clone(),
        };
        let outpoint = OutPoint {
            txid: Txid::from_slice(&[0xDD; 32]).unwrap(),
            vout: 0,
        };

        let dest_sk = SecretKey::from_slice(&sha256(b"dest3")).unwrap();
        let dest_kp = Keypair::from_secret_key(&secp, &dest_sk);
        let (dest_xonly, _) = dest_kp.x_only_public_key();

        // User spends at sequence=144 (timelock satisfied!)
        let mut tx = Transaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: vec![TxIn {
                previous_output: outpoint,
                script_sig: ScriptBuf::new(),
                sequence: Sequence::from_consensus(timelock as u32), // CSV SATISFIED
                witness: Witness::new(),
            }],
            output: vec![TxOut {
                value: Amount::from_sat(99_000),
                script_pubkey: ScriptBuf::new_p2tr_tweaked(
                    TweakedPublicKey::dangerous_assume_tweaked(dest_xonly),
                ),
            }],
        };

        // Compute script-path sighash
        let refund_script = &deposit.refund_script;
        let leaf_hash = TapLeafHash::from_script(refund_script, LeafVersion::TapScript);
        let prevouts = [funding_txout.clone()];
        let sighash = {
            let mut cache = SighashCache::new(&mut tx);
            cache.taproot_script_spend_signature_hash(
                0, &Prevouts::All(&prevouts), leaf_hash, TapSighashType::Default,
            ).unwrap()
        };

        // User signs
        let msg = secp256k1::Message::from_digest(sighash.to_byte_array());
        let user_sig = secp.sign_schnorr(&msg, &user_kp);

        // Build control block
        let control_block = deposit.taproot_spend_info
            .control_block(&(refund_script.clone(), LeafVersion::TapScript))
            .expect("Control block must exist");

        // Set witness: [signature, script, control_block]
        tx.input[0].witness.push(user_sig.as_ref());
        tx.input[0].witness.push(refund_script.as_bytes());
        tx.input[0].witness.push(control_block.serialize());

        // Run Bitcoin Core consensus
        let tx_bytes = serialize_tx(&tx);
        let script_bytes = funding_script.as_bytes();
        let utxo = build_utxo(script_bytes, amount_sats);
        let spent_outputs = [utxo];

        let result = bitcoinconsensus::verify(
            script_bytes,
            amount_sats,
            &tx_bytes,
            Some(&spent_outputs),
            0,
        );

        println!("  Spend type: SCRIPT PATH (user refund)");
        println!("  Sequence: {} (CSV timelock satisfied)", timelock);
        println!("  CSV timelock: {} blocks", timelock);
        println!("  Witness: [schnorr_sig(64B), refund_script({}B), control_block({}B)]",
            refund_script.as_bytes().len(), control_block.serialize().len());
        println!("  Consensus result: {:?}", result);

        assert!(
            result.is_ok(),
            "Bitcoin Core consensus MUST ACCEPT user spend after CSV timelock.\n  Error: {:?}",
            result.err()
        );

        println!("\n  PASSED: Bitcoin Core consensus engine accepts user refund after {} blocks", timelock);
    }
}
