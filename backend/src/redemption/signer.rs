//! Transaction Signer
//!
//! Signs BTC transactions for withdrawals.
//! POC uses single-key signing; production will use MPC.

use bitcoin::{
    hashes::Hash,
    secp256k1::{self, Message, Secp256k1, SecretKey},
    sighash::{Prevouts, SighashCache, TapSighashType},
    Amount, TapTweakHash, Transaction, TxOut, Witness, XOnlyPublicKey,
};

use crate::redemption::builder::UnsignedTx;

/// Trait for transaction signers
pub trait TxSigner: Send + Sync {
    /// Sign a transaction
    fn sign(&self, unsigned: &UnsignedTx) -> Result<Transaction, SignerError>;

    /// Get the signer's public key
    fn public_key(&self) -> XOnlyPublicKey;

    /// Get signer type description
    fn signer_type(&self) -> &'static str;
}

/// Single-key signer for POC
pub struct SingleKeySigner {
    secret_key: SecretKey,
    secp: Secp256k1<secp256k1::All>,
}

impl SingleKeySigner {
    /// Create from secret key bytes
    pub fn from_bytes(bytes: &[u8; 32]) -> Result<Self, SignerError> {
        let secp = Secp256k1::new();
        let secret_key = SecretKey::from_slice(bytes)
            .map_err(|e| SignerError::InvalidKey(e.to_string()))?;

        Ok(Self { secret_key, secp })
    }

    /// Create from hex string
    pub fn from_hex(hex: &str) -> Result<Self, SignerError> {
        let bytes = hex::decode(hex)
            .map_err(|e| SignerError::InvalidKey(e.to_string()))?;

        if bytes.len() != 32 {
            return Err(SignerError::InvalidKey("key must be 32 bytes".to_string()));
        }

        let mut arr = [0u8; 32];
        arr.copy_from_slice(&bytes);
        Self::from_bytes(&arr)
    }

    /// Generate a new random signer
    pub fn generate() -> Self {
        let secp = Secp256k1::new();
        let secret_key = SecretKey::new(&mut rand::thread_rng());
        Self { secret_key, secp }
    }

    /// Get secret key bytes (for backup)
    pub fn secret_bytes(&self) -> [u8; 32] {
        self.secret_key.secret_bytes()
    }

    /// Get secret key hex (for backup)
    pub fn secret_hex(&self) -> String {
        hex::encode(self.secret_bytes())
    }
}

impl TxSigner for SingleKeySigner {
    fn sign(&self, unsigned: &UnsignedTx) -> Result<Transaction, SignerError> {
        let mut tx = unsigned.tx.clone();

        // Build prevouts for sighash
        let prevouts: Vec<TxOut> = unsigned
            .utxos
            .iter()
            .map(|utxo| {
                let script_pubkey = hex::decode(&utxo.script_pubkey)
                    .map(|bytes| bitcoin::ScriptBuf::from_bytes(bytes))
                    .unwrap_or_else(|_| bitcoin::ScriptBuf::new());

                TxOut {
                    value: Amount::from_sat(utxo.amount_sats),
                    script_pubkey,
                }
            })
            .collect();

        let prevouts = Prevouts::All(&prevouts);

        // Get tweaked keypair for Taproot
        let keypair = bitcoin::secp256k1::Keypair::from_secret_key(&self.secp, &self.secret_key);
        let (internal_key, _parity) = XOnlyPublicKey::from_keypair(&keypair);

        // Tweak the keypair
        let tweak = TapTweakHash::from_key_and_tweak(internal_key, None);
        let tweaked_keypair = keypair
            .add_xonly_tweak(&self.secp, &tweak.to_scalar())
            .map_err(|e| SignerError::SigningFailed(e.to_string()))?;

        // Sign each input
        for i in 0..tx.input.len() {
            let mut sighash_cache = SighashCache::new(&tx);

            let sighash = sighash_cache
                .taproot_key_spend_signature_hash(i, &prevouts, TapSighashType::Default)
                .map_err(|e| SignerError::SigningFailed(e.to_string()))?;

            let msg = Message::from_digest_slice(sighash.as_byte_array())
                .map_err(|e| SignerError::SigningFailed(e.to_string()))?;

            let sig = self.secp.sign_schnorr(&msg, &tweaked_keypair);

            // Create witness with signature
            let signature = bitcoin::taproot::Signature {
                signature: sig,
                sighash_type: TapSighashType::Default,
            };

            tx.input[i].witness = Witness::from_slice(&[signature.to_vec()]);
        }

        Ok(tx)
    }

    fn public_key(&self) -> XOnlyPublicKey {
        let keypair = bitcoin::secp256k1::Keypair::from_secret_key(&self.secp, &self.secret_key);
        XOnlyPublicKey::from_keypair(&keypair).0
    }

    fn signer_type(&self) -> &'static str {
        "single-key"
    }
}

/// Placeholder MPC signer (for future implementation)
pub struct MpcSigner {
    /// MPC coordinator endpoint
    pub endpoint: String,
    /// Session ID
    pub session_id: String,
    /// Public key
    pub public_key: XOnlyPublicKey,
}

impl MpcSigner {
    /// Create a new MPC signer (placeholder)
    pub fn new(endpoint: String, session_id: String, public_key: XOnlyPublicKey) -> Self {
        Self {
            endpoint,
            session_id,
            public_key,
        }
    }
}

impl TxSigner for MpcSigner {
    fn sign(&self, _unsigned: &UnsignedTx) -> Result<Transaction, SignerError> {
        // In production, this would:
        // 1. Send unsigned tx to MPC coordinator
        // 2. Participate in threshold signing protocol
        // 3. Receive signature shares
        // 4. Aggregate into final signature
        Err(SignerError::MpcNotImplemented)
    }

    fn public_key(&self) -> XOnlyPublicKey {
        self.public_key
    }

    fn signer_type(&self) -> &'static str {
        "mpc-frost"
    }
}

/// Signer errors
#[derive(Debug, thiserror::Error)]
pub enum SignerError {
    #[error("invalid key: {0}")]
    InvalidKey(String),

    #[error("signing failed: {0}")]
    SigningFailed(String),

    #[error("MPC signing not implemented")]
    MpcNotImplemented,

    #[error("MPC session error: {0}")]
    MpcSessionError(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_single_key_signer() {
        let signer = SingleKeySigner::generate();

        // Check public key
        let pubkey = signer.public_key();
        assert_eq!(pubkey.serialize().len(), 32);

        // Check type
        assert_eq!(signer.signer_type(), "single-key");
    }

    #[test]
    fn test_signer_from_hex() {
        let hex = "0000000000000000000000000000000000000000000000000000000000000001";
        let signer = SingleKeySigner::from_hex(hex).unwrap();

        assert_eq!(signer.secret_hex(), hex);
    }
}
