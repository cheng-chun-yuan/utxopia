//! Bitcoin Signer Module
//!
//! # FROST Migration Path
//!
//! Currently uses a single private key for signing. The `Signer` trait
//! abstracts the signing operation, allowing future migration to FROST
//! threshold signatures without changing the rest of the codebase.
//!
//! ## Migration Steps:
//! 1. Implement `Signer` trait for FrostSigner
//! 2. FrostSigner coordinates with threshold signers via MPC
//! 3. Replace SingleKeySigner with FrostSigner

use bitcoin::key::{Keypair, Secp256k1};
use bitcoin::secp256k1::{self, Message, SecretKey};
use bitcoin::XOnlyPublicKey;
use serde::{Deserialize, Serialize};

/// Signer trait - abstracts signing for FROST migration
///
/// # FROST Migration
///
/// To migrate to FROST:
/// 1. Implement this trait for a FrostSigner struct
/// 2. FrostSigner would coordinate with threshold signers
/// 3. Replace SingleKeySigner with FrostSigner in the pool
pub trait Signer: Send + Sync {
    /// Get the aggregated public key (x-only for Taproot)
    fn public_key(&self) -> XOnlyPublicKey;

    /// Sign a message (sighash) and return Schnorr signature
    /// For FROST: this would coordinate threshold signing
    fn sign(&self, sighash: &[u8; 32]) -> Result<[u8; 64], SignerError>;

    /// Sign with a specific tweak (for tweaked key path spending)
    fn sign_tweaked(&self, sighash: &[u8; 32], tweak: &[u8; 32]) -> Result<[u8; 64], SignerError>;
}

/// Single-key signer (POC - will be replaced with FROST)
///
/// # WARNING: POC ONLY
///
/// In production, this should be replaced with FROST threshold signing
/// where no single party holds the complete private key.
pub struct SingleKeySigner {
    keypair: Keypair,
    secp: Secp256k1<secp256k1::All>,
}

impl SingleKeySigner {
    /// Create from a secret key
    ///
    /// # WARNING: POC ONLY - Do not use with real funds
    pub fn new(secret_key: SecretKey) -> Self {
        eprintln!("WARNING: Using single-key signer - DO NOT USE WITH REAL FUNDS!");
        eprintln!("         In production, use FROST threshold signatures.");

        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret_key);

        Self { keypair, secp }
    }

    /// Create from a seed (deterministic - POC only)
    pub fn from_seed(seed: &[u8]) -> Self {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(seed);
        let hash: [u8; 32] = hasher.finalize().into();

        let secret_key = SecretKey::from_slice(&hash).expect("valid secret key from hash");
        Self::new(secret_key)
    }

    /// Get the tweaked keypair for a specific commitment
    fn tweaked_keypair(&self, tweak: &[u8; 32]) -> Result<Keypair, SignerError> {
        let scalar =
            secp256k1::Scalar::from_be_bytes(*tweak).map_err(|_| SignerError::InvalidTweak)?;

        self.keypair
            .add_xonly_tweak(&self.secp, &scalar)
            .map_err(|_| SignerError::TweakFailed)
    }
}

impl Signer for SingleKeySigner {
    fn public_key(&self) -> XOnlyPublicKey {
        self.keypair.x_only_public_key().0
    }

    fn sign(&self, sighash: &[u8; 32]) -> Result<[u8; 64], SignerError> {
        let msg = Message::from_digest(*sighash);
        let sig = self.secp.sign_schnorr(&msg, &self.keypair);
        Ok(sig.serialize())
    }

    fn sign_tweaked(&self, sighash: &[u8; 32], tweak: &[u8; 32]) -> Result<[u8; 64], SignerError> {
        let tweaked = self.tweaked_keypair(tweak)?;
        let msg = Message::from_digest(*sighash);
        let sig = self.secp.sign_schnorr(&msg, &tweaked);
        Ok(sig.serialize())
    }
}

/// Signer errors
#[derive(Debug, thiserror::Error)]
pub enum SignerError {
    #[error("invalid tweak value")]
    InvalidTweak,
    #[error("failed to apply tweak")]
    TweakFailed,
    #[error("signing failed: {0}")]
    SigningFailed(String),
}

/// Placeholder for future FROST signer
///
/// # FROST Migration
///
/// This struct shows the interface for FROST threshold signing.
/// Implementation would involve:
/// 1. DKG (Distributed Key Generation) setup
/// 2. Coordinating signing rounds with threshold participants
/// 3. Aggregating partial signatures
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FrostConfig {
    /// Threshold (t of n)
    pub threshold: u32,
    /// Total participants
    pub total: u32,
    /// Aggregated public key (from DKG)
    pub aggregate_pubkey: Option<String>,
}

impl Default for FrostConfig {
    fn default() -> Self {
        Self {
            threshold: 5,
            total: 7,
            aggregate_pubkey: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_single_key_signer() {
        let signer = SingleKeySigner::from_seed(b"test_seed_for_signer");
        let pubkey = signer.public_key();

        // Verify we can sign
        let message = [0x42u8; 32];
        let sig = signer.sign(&message).unwrap();

        assert_eq!(sig.len(), 64);
        println!("Public key: {}", hex::encode(pubkey.serialize()));
    }

    #[test]
    fn test_tweaked_signing() {
        let signer = SingleKeySigner::from_seed(b"test_seed_for_signer");
        let tweak = [0x01u8; 32];
        let message = [0x42u8; 32];

        let sig = signer.sign_tweaked(&message, &tweak).unwrap();
        assert_eq!(sig.len(), 64);
    }
}
