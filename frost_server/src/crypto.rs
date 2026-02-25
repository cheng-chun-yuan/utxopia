//! Crypto utilities: commitment digest (broadcast verification) + X25519/AES-GCM (E2E DKG)

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::Aes256Gcm;
use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use thiserror::Error;
use x25519_dalek::{PublicKey, StaticSecret};

#[derive(Debug, Error)]
pub enum CryptoError {
    #[error("encryption failed: {0}")]
    EncryptionFailed(String),
    #[error("decryption failed: {0}")]
    DecryptionFailed(String),
    #[error("invalid ciphertext: too short")]
    CiphertextTooShort,
    #[error("invalid public key length: expected 32 bytes, got {0}")]
    InvalidPublicKeyLength(usize),
}

const HKDF_INFO: &[u8] = b"frost-dkg-round2";
const NONCE_SIZE: usize = 12;

// ─── Broadcast Verification ───

/// SHA-256 digest over canonical commitment data (sorted by signer_id).
pub fn compute_commitment_digest(
    commitments: &BTreeMap<u16, String>,
    identifier_map: &BTreeMap<u16, String>,
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for (signer_id, commitment_hex) in commitments {
        hasher.update(signer_id.to_be_bytes());
        if let Some(frost_id_hex) = identifier_map.get(signer_id) {
            hasher.update(frost_id_hex.as_bytes());
        }
        hasher.update(commitment_hex.as_bytes());
    }
    hasher.finalize().into()
}

// ─── X25519 + AES-256-GCM ───

pub struct EphemeralKeypair {
    pub private: StaticSecret,
    pub public: PublicKey,
}

impl EphemeralKeypair {
    pub fn generate() -> Self {
        let private = StaticSecret::random_from_rng(rand::thread_rng());
        let public = PublicKey::from(&private);
        Self { private, public }
    }

    pub fn public_key_hex(&self) -> String {
        hex::encode(self.public.as_bytes())
    }
}

fn derive_key(shared_secret: &[u8; 32]) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(None, shared_secret);
    let mut okm = [0u8; 32];
    hk.expand(HKDF_INFO, &mut okm).expect("HKDF expand failed");
    okm
}

/// Encrypt with X25519 ECDH + AES-256-GCM. Returns `nonce(12) || ciphertext || tag(16)`.
pub fn encrypt_for_recipient(
    own_private: &StaticSecret,
    target_public: &PublicKey,
    plaintext: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    let shared = own_private.diffie_hellman(target_public);
    let key = derive_key(shared.as_bytes());
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;
    let nonce_bytes: [u8; NONCE_SIZE] = rand::random();
    let nonce = aes_gcm::Nonce::from_slice(&nonce_bytes);
    let ct = cipher.encrypt(nonce, plaintext).map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;
    let mut out = Vec::with_capacity(NONCE_SIZE + ct.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Decrypt `nonce(12) || ciphertext || tag(16)` with X25519 ECDH + AES-256-GCM.
pub fn decrypt_from_sender(
    own_private: &StaticSecret,
    sender_public: &PublicKey,
    data: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    if data.len() < NONCE_SIZE + 16 {
        return Err(CryptoError::CiphertextTooShort);
    }
    let shared = own_private.diffie_hellman(sender_public);
    let key = derive_key(shared.as_bytes());
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| CryptoError::DecryptionFailed(e.to_string()))?;
    let nonce = aes_gcm::Nonce::from_slice(&data[..NONCE_SIZE]);
    cipher
        .decrypt(nonce, &data[NONCE_SIZE..])
        .map_err(|e| CryptoError::DecryptionFailed(e.to_string()))
}

pub fn parse_x25519_pubkey(hex_str: &str) -> Result<PublicKey, CryptoError> {
    let bytes = hex::decode(hex_str).map_err(|_| CryptoError::InvalidPublicKeyLength(0))?;
    if bytes.len() != 32 {
        return Err(CryptoError::InvalidPublicKeyLength(bytes.len()));
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    Ok(PublicKey::from(arr))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encryption_roundtrip() {
        let alice = EphemeralKeypair::generate();
        let bob = EphemeralKeypair::generate();
        let plaintext = b"secret DKG round2 package";
        let encrypted = encrypt_for_recipient(&alice.private, &bob.public, plaintext).unwrap();
        let decrypted = decrypt_from_sender(&bob.private, &alice.public, &encrypted).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_wrong_key_fails() {
        let alice = EphemeralKeypair::generate();
        let bob = EphemeralKeypair::generate();
        let eve = EphemeralKeypair::generate();
        let encrypted = encrypt_for_recipient(&alice.private, &bob.public, b"secret").unwrap();
        assert!(decrypt_from_sender(&eve.private, &alice.public, &encrypted).is_err());
    }

    #[test]
    fn test_digest_deterministic() {
        let mut c = BTreeMap::new();
        c.insert(1u16, "aabb".to_string());
        c.insert(2u16, "ccdd".to_string());
        let id = BTreeMap::new();
        assert_eq!(compute_commitment_digest(&c, &id), compute_commitment_digest(&c, &id));
    }

    #[test]
    fn test_digest_differs() {
        let id = BTreeMap::new();
        let mut c1 = BTreeMap::new();
        c1.insert(1u16, "aabb".to_string());
        let mut c2 = BTreeMap::new();
        c2.insert(1u16, "ccdd".to_string());
        assert_ne!(compute_commitment_digest(&c1, &id), compute_commitment_digest(&c2, &id));
    }

    #[test]
    fn test_ciphertext_too_short() {
        let a = EphemeralKeypair::generate();
        let b = EphemeralKeypair::generate();
        assert!(matches!(decrypt_from_sender(&b.private, &a.public, &[0; 10]), Err(CryptoError::CiphertextTooShort)));
    }

    #[test]
    fn test_parse_pubkey() {
        let kp = EphemeralKeypair::generate();
        let parsed = parse_x25519_pubkey(&kp.public_key_hex()).unwrap();
        assert_eq!(parsed.as_bytes(), kp.public.as_bytes());
    }

    #[test]
    fn test_parse_pubkey_invalid() {
        assert!(matches!(parse_x25519_pubkey("aabb"), Err(CryptoError::InvalidPublicKeyLength(2))));
    }
}
