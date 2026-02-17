//! Encrypted key share storage
//!
//! Key shares are encrypted at rest using AES-256-GCM with a password-derived key.

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use frost_secp256k1_tr as frost;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;
use thiserror::Error;

/// Key store errors
#[derive(Debug, Error)]
pub enum KeystoreError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("encryption error: {0}")]
    Encryption(String),
    #[error("decryption error: {0}")]
    Decryption(String),
    #[error("FROST error: {0}")]
    Frost(String),
    #[error("key not found")]
    KeyNotFound,
    #[error("invalid password")]
    InvalidPassword,
}

/// Encrypted key file format
#[derive(Debug, Serialize, Deserialize)]
struct EncryptedKeyFile {
    /// Version for future format changes
    version: u8,
    /// Signer identifier
    signer_id: u16,
    /// Salt for key derivation (hex-encoded)
    salt: String,
    /// Nonce for AES-GCM (hex-encoded)
    nonce: String,
    /// Encrypted key share (hex-encoded)
    ciphertext: String,
    /// Group public key (hex-encoded, for verification)
    group_public_key: String,
}

/// Key share data before encryption
#[derive(Debug, Serialize, Deserialize)]
pub struct KeyShareData {
    /// Serialized FROST key package
    pub key_package: Vec<u8>,
    /// Serialized FROST public key package
    pub public_key_package: Vec<u8>,
}

/// Encrypted keystore manager
pub struct Keystore {
    /// Path to key file
    key_path: std::path::PathBuf,
    /// Signer identifier
    signer_id: u16,
}

impl Keystore {
    /// Create a new keystore for a specific signer
    pub fn new(key_path: impl AsRef<Path>, signer_id: u16) -> Self {
        Self {
            key_path: key_path.as_ref().to_path_buf(),
            signer_id,
        }
    }

    /// Check if key file exists
    pub fn exists(&self) -> bool {
        self.key_path.exists()
    }

    /// Derive encryption key from password using SHA-256
    fn derive_key(password: &str, salt: &[u8]) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update(password.as_bytes());
        hasher.update(salt);
        hasher.update(b"frost-keystore-v1");
        hasher.finalize().into()
    }

    /// Save key share encrypted with password
    pub fn save(
        &self,
        key_package: &frost::keys::KeyPackage,
        public_key_package: &frost::keys::PublicKeyPackage,
        password: &str,
    ) -> Result<(), KeystoreError> {
        // Serialize FROST packages
        let key_bytes = key_package
            .serialize()
            .map_err(|e| KeystoreError::Frost(e.to_string()))?;
        let pubkey_bytes = public_key_package
            .serialize()
            .map_err(|e| KeystoreError::Frost(e.to_string()))?;

        let data = KeyShareData {
            key_package: key_bytes,
            public_key_package: pubkey_bytes,
        };

        let plaintext = serde_json::to_vec(&data)?;

        // Generate salt and nonce
        let mut salt = [0u8; 16];
        let mut nonce_bytes = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut salt);
        rand::thread_rng().fill_bytes(&mut nonce_bytes);

        // Derive key and encrypt
        let key = Self::derive_key(password, &salt);
        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|e| KeystoreError::Encryption(e.to_string()))?;
        let nonce = Nonce::from_slice(&nonce_bytes);

        let ciphertext = cipher
            .encrypt(nonce, plaintext.as_ref())
            .map_err(|e| KeystoreError::Encryption(e.to_string()))?;

        // Get group public key for metadata
        let group_pubkey = public_key_package.verifying_key();
        let group_pubkey_bytes = group_pubkey
            .serialize()
            .map_err(|e| KeystoreError::Frost(e.to_string()))?;

        // Create encrypted file
        let encrypted = EncryptedKeyFile {
            version: 1,
            signer_id: self.signer_id,
            salt: hex::encode(salt),
            nonce: hex::encode(nonce_bytes),
            ciphertext: hex::encode(ciphertext),
            group_public_key: hex::encode(group_pubkey_bytes),
        };

        // Write to file
        let json = serde_json::to_string_pretty(&encrypted)?;

        // Create parent directories if needed
        if let Some(parent) = self.key_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        std::fs::write(&self.key_path, json)?;

        tracing::info!(
            signer_id = self.signer_id,
            path = %self.key_path.display(),
            "Saved encrypted key share"
        );

        Ok(())
    }

    /// Load key share decrypted with password
    pub fn load(
        &self,
        password: &str,
    ) -> Result<(frost::keys::KeyPackage, frost::keys::PublicKeyPackage), KeystoreError> {
        if !self.exists() {
            return Err(KeystoreError::KeyNotFound);
        }

        let json = std::fs::read_to_string(&self.key_path)?;
        let encrypted: EncryptedKeyFile = serde_json::from_str(&json)?;

        // Verify signer ID matches
        if encrypted.signer_id != self.signer_id {
            return Err(KeystoreError::Decryption(format!(
                "Signer ID mismatch: expected {}, got {}",
                self.signer_id, encrypted.signer_id
            )));
        }

        // Decode hex values
        let salt = hex::decode(&encrypted.salt)
            .map_err(|e| KeystoreError::Decryption(e.to_string()))?;
        let nonce_bytes = hex::decode(&encrypted.nonce)
            .map_err(|e| KeystoreError::Decryption(e.to_string()))?;
        let ciphertext = hex::decode(&encrypted.ciphertext)
            .map_err(|e| KeystoreError::Decryption(e.to_string()))?;

        // Derive key and decrypt
        let key = Self::derive_key(password, &salt);
        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|e| KeystoreError::Decryption(e.to_string()))?;
        let nonce = Nonce::from_slice(&nonce_bytes);

        let plaintext = cipher
            .decrypt(nonce, ciphertext.as_ref())
            .map_err(|_| KeystoreError::InvalidPassword)?;

        // Deserialize key share data
        let data: KeyShareData = serde_json::from_slice(&plaintext)?;

        // Deserialize FROST packages
        let key_package = frost::keys::KeyPackage::deserialize(&data.key_package)
            .map_err(|e| KeystoreError::Frost(e.to_string()))?;
        let public_key_package =
            frost::keys::PublicKeyPackage::deserialize(&data.public_key_package)
                .map_err(|e| KeystoreError::Frost(e.to_string()))?;

        tracing::info!(
            signer_id = self.signer_id,
            path = %self.key_path.display(),
            "Loaded key share"
        );

        Ok((key_package, public_key_package))
    }

    /// Get group public key from file without decryption
    pub fn get_group_public_key(&self) -> Result<String, KeystoreError> {
        if !self.exists() {
            return Err(KeystoreError::KeyNotFound);
        }

        let json = std::fs::read_to_string(&self.key_path)?;
        let encrypted: EncryptedKeyFile = serde_json::from_str(&json)?;

        Ok(encrypted.group_public_key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use frost_secp256k1_tr as frost;
    use rand::rngs::OsRng;

    #[test]
    fn test_key_derivation_deterministic() {
        let key1 = Keystore::derive_key("password123", b"salt");
        let key2 = Keystore::derive_key("password123", b"salt");
        assert_eq!(key1, key2);

        let key3 = Keystore::derive_key("password123", b"different_salt");
        assert_ne!(key1, key3);
    }

    #[test]
    fn test_keystore_round_trip() {
        use tempfile::tempdir;

        let dir = tempdir().unwrap();
        let key_path = dir.path().join("test_key.enc");

        // Generate test keys using DKG
        let mut rng = OsRng;
        let max_signers = 3u16;
        let min_signers = 2u16;

        // Run DKG to get valid key packages
        let (shares, pubkeys) =
            frost::keys::generate_with_dealer(max_signers, min_signers, frost::keys::IdentifierList::Default, &mut rng)
                .expect("DKG failed");

        // Get first participant's secret share and convert to KeyPackage
        let identifier = frost::Identifier::try_from(1u16).unwrap();
        let secret_share = shares.get(&identifier).unwrap().clone();
        let key_package = frost::keys::KeyPackage::try_from(secret_share).unwrap();
        let public_key_package = pubkeys;

        // Test save and load
        let keystore = Keystore::new(&key_path, 1);
        keystore
            .save(&key_package, &public_key_package, "test_password")
            .unwrap();

        assert!(keystore.exists());

        let (loaded_key, loaded_pubkey) = keystore.load("test_password").unwrap();

        // Verify loaded keys match
        assert_eq!(
            key_package.verifying_share().serialize().unwrap(),
            loaded_key.verifying_share().serialize().unwrap()
        );
        assert_eq!(
            public_key_package.verifying_key().serialize().unwrap(),
            loaded_pubkey.verifying_key().serialize().unwrap()
        );
    }

    #[test]
    fn test_keystore_wrong_password() {
        use tempfile::tempdir;

        let dir = tempdir().unwrap();
        let key_path = dir.path().join("test_key.enc");

        // Generate test keys
        let mut rng = OsRng;
        let (shares, pubkeys) =
            frost::keys::generate_with_dealer(3, 2, frost::keys::IdentifierList::Default, &mut rng).unwrap();
        let identifier = frost::Identifier::try_from(1u16).unwrap();
        let secret_share = shares.get(&identifier).unwrap().clone();
        let key_package = frost::keys::KeyPackage::try_from(secret_share).unwrap();

        let keystore = Keystore::new(&key_path, 1);
        keystore.save(&key_package, &pubkeys, "correct").unwrap();

        // Try loading with wrong password
        let result = keystore.load("wrong");
        assert!(matches!(result, Err(KeystoreError::InvalidPassword)));
    }
}
