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

/// Announcement type: deposit (plaintext amount from BTC deposit verification)
pub const ANNOUNCEMENT_TYPE_DEPOSIT: u8 = 0;

/// Announcement type: transfer (XOR-encrypted amount from JoinSplit transact)
pub const ANNOUNCEMENT_TYPE_TRANSFER: u8 = 1;

/// Stealth announcement account size
///
/// Layout (82 bytes):
/// - discriminator (1 byte)
/// - announcement_type (1 byte): 0=deposit (plaintext amount), 1=transfer (encrypted amount)
/// - ephemeral_pub (32 bytes, Ed25519 compressed)
/// - amount_bytes (8 bytes, plaintext if type=0, XOR encrypted if type=1)
/// - commitment (32 bytes, Poseidon hash for Merkle tree — stored for self-sovereign recovery)
/// - leaf_index (8 bytes, position in Merkle tree)
///
/// Removed field (emitted as sol_log_data event):
/// - created_at (8 bytes) — available from slot time / event logs
pub const STEALTH_ANNOUNCEMENT_SIZE: usize = 1 + // discriminator
    1 + // announcement_type
    32 + // ephemeral_pub (Ed25519 key, 32 bytes)
    8 + // amount_bytes (plaintext if deposit, XOR encrypted if transfer)
    32 + // commitment (Poseidon hash, stored on-chain for self-sovereign recovery)
    8; // leaf_index (position in Merkle tree) = 82 bytes

/// Unified stealth announcement with type flag
///
/// Uses EIP-5564/DKSAP pattern with Ed25519 ephemeral key:
/// - sharedSecret = X25519(ephemeralPriv, viewingPubX25519) [sender]
/// - sharedSecret = X25519(viewingPriv, ephemeralPub) [recipient]
/// - stealthPub = spendingPub + hash(sharedSecret) * BASE8 (Baby Jubjub)
///
/// Unified for both deposits and transfers:
/// - type=0 (deposit): amount_bytes is plaintext u64 LE
/// - type=1 (transfer): amount_bytes is XOR-encrypted
///
/// PDA seeds:
/// - Deposits: [b"stealth", txid] — prevents double-verification of same txid
/// - Transfers: [b"stealth", ephemeral_pub] — prevents replay
#[repr(C)]
pub struct StealthAnnouncement {
    /// Discriminator (0x08)
    pub discriminator: u8,

    /// Announcement type: 0=deposit (plaintext amount), 1=transfer (encrypted amount)
    pub announcement_type: u8,

    /// Ed25519 ephemeral public key (32 bytes)
    /// Recipient: sharedSecret = X25519(viewingPriv, ephemeral_pub)
    /// Then: stealthPub = spendingPub + hash(sharedSecret) * BASE8
    pub ephemeral_pub: [u8; 32],

    /// Amount in satoshis (interpretation depends on announcement_type)
    /// type=0: plaintext u64 LE (deposit)
    /// type=1: XOR encrypted with SHA256(shared_secret || "amount")[0..8] (transfer)
    amount_bytes: [u8; 8],

    /// Commitment = Poseidon(npk, token, amount) — stored for self-sovereign recovery
    pub commitment: [u8; 32],

    /// Leaf index in Merkle tree
    leaf_index_bytes: [u8; 8],
}

impl StealthAnnouncement {
    pub const SEED: &'static [u8] = b"stealth";
    pub const SIZE: usize = STEALTH_ANNOUNCEMENT_SIZE;

    /// Get amount bytes (plaintext if type=0, encrypted if type=1)
    pub fn amount_bytes(&self) -> [u8; 8] {
        self.amount_bytes
    }

    /// Set amount bytes (raw — caller handles encryption for type=1)
    pub fn set_amount_bytes(&mut self, value: [u8; 8]) {
        self.amount_bytes = value;
    }

    /// Set amount as u64 plaintext (for type=0 deposits)
    pub fn set_amount_sats(&mut self, value: u64) {
        self.amount_bytes = value.to_le_bytes();
    }

    /// Get leaf_index as u64
    pub fn leaf_index(&self) -> u64 {
        u64::from_le_bytes(self.leaf_index_bytes)
    }

    /// Set leaf_index
    pub fn set_leaf_index(&mut self, value: u64) {
        self.leaf_index_bytes = value.to_le_bytes();
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
