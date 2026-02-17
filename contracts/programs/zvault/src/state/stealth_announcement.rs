//! Stealth announcement account state (zero-copy)
//!
//! EIP-5564/DKSAP Single Ephemeral Key Pattern:
//! - Single Ed25519 ephemeral key for X25519 ECDH stealth derivation
//! - Recipient uses viewing key to detect, spending key to claim
//!
//! Privacy Properties:
//! - No recipient hint (prevents linking deposits to same recipient)
//! - Single ephemeral pubkey: Ed25519 for stealth address derivation
//! - Viewing key can detect but CANNOT derive stealth private key
//! - Amount is ENCRYPTED with shared secret (only recipient can decrypt)
//!
//! Stealth Address Flow:
//! - Sender: sharedSecret = X25519(ephemeralPriv, viewingPubX25519)
//!           stealthPub = spendingPub + hash(sharedSecret) * BASE8 (Baby Jubjub)
//! - Recipient: sharedSecret = X25519(viewingPriv, ephemeralPub)
//!             stealthPriv = spendingPriv + hash(sharedSecret)
//!
//! Amount Encryption:
//! - encryption_key = SHA256(shared_secret || "amount")[0..8]
//! - encrypted_amount = amount_sats XOR encryption_key
//! - Only recipient with viewing key can derive shared_secret and decrypt

use pinocchio::program_error::ProgramError;

/// Account discriminator for StealthAnnouncement
pub const STEALTH_ANNOUNCEMENT_DISCRIMINATOR: u8 = 0x08;

/// Stealth announcement account size (single ephemeral key)
///
/// Layout (90 bytes):
/// - discriminator (1 byte)
/// - bump (1 byte)
/// - ephemeral_pub (32 bytes, Ed25519 compressed)
/// - encrypted_amount (8 bytes, XOR encrypted with shared secret)
/// - commitment (32 bytes)
/// - leaf_index (8 bytes, position in Merkle tree)
/// - created_at (8 bytes)
pub const STEALTH_ANNOUNCEMENT_SIZE: usize = 1 + // discriminator
    1 + // bump
    32 + // ephemeral_pub (Ed25519 key, 32 bytes)
    8 + // encrypted_amount (XOR with SHA256(shared_secret || "amount")[0..8])
    32 + // commitment
    8 + // leaf_index (position in Merkle tree)
    8; // created_at = 90 bytes

/// Stealth address announcement with single ephemeral key
///
/// Uses EIP-5564/DKSAP pattern with Ed25519 ephemeral key:
/// - sharedSecret = X25519(ephemeralPriv, viewingPubX25519) [sender]
/// - sharedSecret = X25519(viewingPriv, ephemeralPub) [recipient]
/// - stealthPub = spendingPub + hash(sharedSecret) * BASE8 (Baby Jubjub)
///
/// Key Separation:
/// - Viewing key can detect deposits but CANNOT derive stealthPriv
/// - Spending key required for stealthPriv and nullifier derivation
///
/// Security Properties:
/// - Amount is ENCRYPTED (only recipient can decrypt with viewing key)
/// - Commitment = Poseidon2(stealthPub.x, amount) binds the actual amount
/// - ZK proof guarantees amount conservation without revealing value
///
/// PDA: [b"stealth", ephemeral_pub]
#[repr(C)]
pub struct StealthAnnouncement {
    /// Discriminator (0x08)
    pub discriminator: u8,

    /// Bump seed
    pub bump: u8,

    /// Ed25519 ephemeral public key (32 bytes)
    /// Recipient: sharedSecret = X25519(viewingPriv, ephemeral_pub)
    /// Then: stealthPub = spendingPub + hash(sharedSecret) * BASE8
    pub ephemeral_pub: [u8; 32],

    /// Encrypted amount in satoshis
    /// encryption_key = SHA256(shared_secret || "amount")[0..8]
    /// encrypted_amount = amount_sats XOR encryption_key
    /// Only recipient with viewing key can decrypt
    encrypted_amount_bytes: [u8; 8],

    /// Commitment for Merkle tree verification
    /// commitment = Poseidon2(stealthPub.x, amount)
    pub commitment: [u8; 32],

    /// Leaf index in Merkle tree (0 if not from direct deposit)
    /// Set by verify_stealth_deposit instruction
    leaf_index_bytes: [u8; 8],

    /// Timestamp (stored as bytes for alignment)
    created_at_bytes: [u8; 8],
}

impl StealthAnnouncement {
    pub const SEED: &'static [u8] = b"stealth";
    pub const SIZE: usize = STEALTH_ANNOUNCEMENT_SIZE;

    /// Get encrypted_amount bytes (caller must decrypt with shared secret)
    pub fn encrypted_amount(&self) -> [u8; 8] {
        self.encrypted_amount_bytes
    }

    /// Set encrypted_amount bytes (caller must encrypt with shared secret first)
    pub fn set_encrypted_amount(&mut self, value: [u8; 8]) {
        self.encrypted_amount_bytes = value;
    }

    /// Set amount as u64 (converts to le_bytes)
    /// Note: For privacy, prefer set_encrypted_amount with pre-encrypted bytes
    pub fn set_amount_sats(&mut self, value: u64) {
        self.encrypted_amount_bytes = value.to_le_bytes();
    }

    /// Get leaf_index as u64
    pub fn leaf_index(&self) -> u64 {
        u64::from_le_bytes(self.leaf_index_bytes)
    }

    /// Set leaf_index
    pub fn set_leaf_index(&mut self, value: u64) {
        self.leaf_index_bytes = value.to_le_bytes();
    }

    /// Get created_at as i64
    pub fn created_at(&self) -> i64 {
        i64::from_le_bytes(self.created_at_bytes)
    }

    /// Set created_at
    pub fn set_created_at(&mut self, value: i64) {
        self.created_at_bytes = value.to_le_bytes();
    }

    /// Initialize from mutable bytes
    pub fn init(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        if data.len() < Self::SIZE {
            return Err(ProgramError::AccountDataTooSmall);
        }

        // Zero initialize
        data[..Self::SIZE].fill(0);
        data[0] = STEALTH_ANNOUNCEMENT_DISCRIMINATOR;

        let ptr = data.as_mut_ptr() as *mut Self;
        Ok(unsafe { &mut *ptr })
    }

    /// Parse from bytes (read-only)
    pub fn from_bytes(data: &[u8]) -> Result<&Self, ProgramError> {
        if data.len() < Self::SIZE {
            return Err(ProgramError::AccountDataTooSmall);
        }
        if data[0] != STEALTH_ANNOUNCEMENT_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }

        let ptr = data.as_ptr() as *const Self;
        Ok(unsafe { &*ptr })
    }

    /// Parse from bytes (mutable)
    pub fn from_bytes_mut(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        if data.len() < Self::SIZE {
            return Err(ProgramError::AccountDataTooSmall);
        }
        if data[0] != STEALTH_ANNOUNCEMENT_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }

        let ptr = data.as_mut_ptr() as *mut Self;
        Ok(unsafe { &mut *ptr })
    }
}
