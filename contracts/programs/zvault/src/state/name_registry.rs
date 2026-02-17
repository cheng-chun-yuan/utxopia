//! Name Registry account state (zero-copy)
//!
//! Optional on-chain registry for human-readable stealth addresses.
//! Users can register names like "albert.zkey" to make receiving payments easier.
//!
//! Privacy Note:
//! - Registering a name reveals you USE zVault (existence)
//! - But does NOT allow tracking your transactions (ECDH protects this)
//! - Use off-chain sharing if you want maximum privacy

use pinocchio::program_error::ProgramError;

/// Account discriminator for NameRegistry
pub const NAME_REGISTRY_DISCRIMINATOR: u8 = 0x09;

/// Maximum name length (excluding .zkey suffix)
pub const MAX_NAME_LENGTH: usize = 32;

/// Name registry account size
pub const NAME_REGISTRY_SIZE: usize = 1 +  // discriminator
    1 +   // bump
    32 +  // name_hash (SHA256 of lowercase name)
    32 +  // owner (Solana pubkey that can update)
    32 +  // spending_pubkey (Baby Jubjub compressed, 32 bytes)
    32 +  // viewing_pubkey (Ed25519, 32 bytes)
    8 +   // created_at
    8 +   // updated_at
    32;   // _reserved = 178 bytes

/// Name registry for human-readable stealth addresses
///
/// Allows users to register "alice.zkey" so others can send to them easily.
/// The owner can update the keys at any time.
///
/// PDA: [b"zkey", name_hash]
#[repr(C)]
pub struct NameRegistry {
    /// Discriminator (0x09)
    pub discriminator: u8,

    /// Bump seed
    pub bump: u8,

    /// SHA256 hash of the lowercase name (without .zkey suffix)
    /// e.g., SHA256("albert") for "albert.zkey"
    pub name_hash: [u8; 32],

    /// Owner's Solana pubkey (can update the registry)
    pub owner: [u8; 32],

    /// Baby Jubjub spending public key (32 bytes compressed)
    pub spending_pubkey: [u8; 32],

    /// Ed25519 viewing public key (32 bytes)
    pub viewing_pubkey: [u8; 32],

    /// Registration timestamp (stored as bytes for alignment)
    created_at_bytes: [u8; 8],

    /// Last update timestamp
    updated_at_bytes: [u8; 8],

    /// Reserved for future expansion
    _reserved: [u8; 32],
}

impl NameRegistry {
    pub const SEED: &'static [u8] = b"zkey";
    pub const SIZE: usize = NAME_REGISTRY_SIZE;

    /// Get created_at as i64
    pub fn created_at(&self) -> i64 {
        i64::from_le_bytes(self.created_at_bytes)
    }

    /// Set created_at
    pub fn set_created_at(&mut self, value: i64) {
        self.created_at_bytes = value.to_le_bytes();
    }

    /// Get updated_at as i64
    pub fn updated_at(&self) -> i64 {
        i64::from_le_bytes(self.updated_at_bytes)
    }

    /// Set updated_at
    pub fn set_updated_at(&mut self, value: i64) {
        self.updated_at_bytes = value.to_le_bytes();
    }

    /// Initialize from mutable bytes
    pub fn init(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        if data.len() < Self::SIZE {
            return Err(ProgramError::AccountDataTooSmall);
        }

        // Zero initialize
        data[..Self::SIZE].fill(0);
        data[0] = NAME_REGISTRY_DISCRIMINATOR;

        let ptr = data.as_mut_ptr() as *mut Self;
        Ok(unsafe { &mut *ptr })
    }

    /// Parse from bytes (read-only)
    pub fn from_bytes(data: &[u8]) -> Result<&Self, ProgramError> {
        if data.len() < Self::SIZE {
            return Err(ProgramError::AccountDataTooSmall);
        }
        if data[0] != NAME_REGISTRY_DISCRIMINATOR {
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
        if data[0] != NAME_REGISTRY_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }

        let ptr = data.as_mut_ptr() as *mut Self;
        Ok(unsafe { &mut *ptr })
    }

    /// Check if caller is the owner
    pub fn is_owner(&self, pubkey: &[u8; 32]) -> bool {
        self.owner == *pubkey
    }
}

/// Validate a name (lowercase alphanumeric, 1-32 chars)
pub fn validate_name(name: &[u8]) -> Result<(), ProgramError> {
    if name.is_empty() || name.len() > MAX_NAME_LENGTH {
        return Err(ProgramError::InvalidArgument);
    }

    for &c in name {
        // Allow lowercase letters, numbers, and underscores
        let valid = c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_';

        if !valid {
            return Err(ProgramError::InvalidArgument);
        }
    }

    Ok(())
}
