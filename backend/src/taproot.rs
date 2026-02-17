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
use bitcoin::secp256k1::{self, SecretKey};
use bitcoin::taproot::{TaprootBuilder, LeafVersion, TaprootSpendInfo};
use bitcoin::opcodes::all::*;
use bitcoin::script::Builder as ScriptBuilder;
use bitcoin::{Address, Network, ScriptBuf, XOnlyPublicKey};
use serde::{Deserialize, Serialize};
use sha2::{Sha256, Digest};

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
    /// - Production: Loads key from ZVAULT_BTC_SIGNER_KEY environment variable
    /// - Devnet: Falls back to derived key if env var not set (with warning)
    ///
    /// For mainnet, FROST DKG should be used instead of single-key signing.
    pub fn new() -> Self {
        use std::env;

        let secp = Secp256k1::new();

        // Try to load from environment variable first
        let secret_key = match env::var("ZVAULT_BTC_SIGNER_KEY") {
            Ok(hex_key) if !hex_key.is_empty() => {
                let bytes = hex::decode(&hex_key)
                    .expect("ZVAULT_BTC_SIGNER_KEY must be valid hex");
                SecretKey::from_slice(&bytes)
                    .expect("ZVAULT_BTC_SIGNER_KEY must be a valid secp256k1 secret key")
            }
            _ => {
                // Check if we're on devnet (allow fallback) or production (error)
                let network = env::var("ZVAULT_NETWORK").unwrap_or_else(|_| "devnet".to_string());
                if network == "mainnet" {
                    panic!(
                        "ZVAULT_BTC_SIGNER_KEY environment variable is required for mainnet. \
                         For production, use FROST DKG instead of single-key signing."
                    );
                }

                // Devnet/testnet fallback with warning
                eprintln!("WARNING: Using derived key for {} - DO NOT USE WITH REAL FUNDS!", network);
                eprintln!("Set ZVAULT_BTC_SIGNER_KEY environment variable for custom keys.");

                // Use environment-specific seed (not fully deterministic)
                let seed_input = format!(
                    "zvault_devnet_key_{}",
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
        let secret_key = SecretKey::from_slice(&hash)
            .expect("valid secret key");

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

/// Compute SHA256 hash
fn sha256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finalize().into()
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
    let scalar = secp256k1::Scalar::from_be_bytes(tweak_bytes)
        .map_err(|_| TaprootError::InvalidScalar)?;

    // Apply tweak to get output key
    // Q = P + tweak*G (this is what bitcoin library does internally)
    let tweaked = pool_keys.internal_key
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

    // Build the refund script (user can spend after timelock)
    let refund_script = build_timelock_script(user_pubkey, timelock_blocks);

    // Build the taproot tree with the refund script as a leaf
    let builder = TaprootBuilder::new()
        .add_leaf(0, refund_script.clone())
        .map_err(|_| TaprootError::TaprootBuildFailed)?;

    // Compute the taproot spend info
    // Internal key is the pool's key - allows admin to spend via key path
    let taproot_spend_info = builder
        .finalize(secp, pool_keys.internal_key)
        .map_err(|_| TaprootError::TaprootBuildFailed)?;

    // Get the tweaked output key
    let output_key = taproot_spend_info.output_key();

    // Now we need to incorporate the commitment into the final address
    // We do this by tweaking the output key with the commitment
    // This ensures each commitment gets a unique address
    let commitment_tweak = compute_commitment_tweak(&output_key.to_inner(), commitment);
    let scalar = secp256k1::Scalar::from_be_bytes(commitment_tweak)
        .map_err(|_| TaprootError::InvalidScalar)?;

    let final_output_key = output_key.to_inner()
        .add_tweak(secp, &scalar)
        .map_err(|_| TaprootError::TweakFailed)?;

    let (final_x_only, _parity) = final_output_key;

    // Create the Taproot address
    let address = Address::p2tr_tweaked(
        TweakedPublicKey::dangerous_assume_tweaked(final_x_only),
        network,
    );

    // Get script leaf hash
    let script_leaf_hash = taproot_spend_info
        .control_block(&(refund_script.clone(), LeafVersion::TapScript))
        .map(|cb| {
            // The leaf hash is part of the control block computation
            // For simplicity, we compute it from the script
            compute_tapleaf_hash(&refund_script)
        })
        .unwrap_or_else(|| compute_tapleaf_hash(&refund_script));

    Ok(TaprootDepositDualPathRaw {
        address: address.to_string(),
        output_key: final_x_only,
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

/// Compute commitment tweak: H_commitment(output_key || commitment)
fn compute_commitment_tweak(output_key: &XOnlyPublicKey, commitment: &[u8; 32]) -> [u8; 32] {
    // Use a tagged hash for domain separation
    let tag_hash = sha256(b"zVault/CommitmentTweak");

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

    #[test]
    fn test_pool_keys_deterministic() {
        let keys1 = PoolKeys::new();
        let keys2 = PoolKeys::new();

        // Should produce same keys from same seed
        assert_eq!(keys1.internal_key, keys2.internal_key);
    }

    #[test]
    fn test_generate_deposit_address() {
        let keys = PoolKeys::new();
        let commitment = [0x42u8; 32]; // dummy commitment

        let deposit = generate_deposit_address(&keys, &commitment, Network::Testnet).unwrap();

        // Should be a valid bech32m testnet address
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

        // Different commitments should produce different addresses
        assert_ne!(addr1.address, addr2.address);
        assert_ne!(addr1.output_key, addr2.output_key);
    }

    #[test]
    fn test_unlock_criteria() {
        let criteria = get_unlock_criteria();
        assert_eq!(criteria.steps.len(), 4);

        // Print for documentation
        println!("\n{}", criteria.description);
        for step in &criteria.steps {
            println!("\nStep {}: {}", step.step, step.name);
            println!("  {}", step.description);
            println!("  Verified by: {}", step.verified_by);
        }
    }
}
