//! Reverse Registry account state (zero-copy)
//!
//! Enables reverse lookup: spending_pubkey → name
//! Following SNS pattern for efficient name resolution.
//!
//! PDA: [b"reverse", spending_pubkey]

use pinocchio::program_error::ProgramError;

/// Account discriminator for ReverseRegistry
pub const REVERSE_REGISTRY_DISCRIMINATOR: u8 = 0x0A;

/// Maximum name length for reverse registry (same as name_registry)
pub const REVERSE_MAX_NAME_LENGTH: usize = 32;

/// Reverse registry account size
pub const REVERSE_REGISTRY_SIZE: usize = 1 +   // discriminator
    1 +   // bump
    32 +  // spending_pubkey (Baby Jubjub compressed)
    1 +   // name_len
    32 +  // name (padded to 32 bytes)
    32;   // _reserved = 100 bytes

/// Reverse registry for name lookup by spending pubkey
///
/// Allows looking up a .zkey name from a spending public key.
/// Created alongside NameRegistry during registration.
///
/// PDA: [b"reverse", spending_pubkey]
#[repr(C)]
pub struct ReverseRegistry {
    /// Discriminator (0x0A)
    pub discriminator: u8,

    /// Bump seed
    pub bump: u8,

    /// Baby Jubjub spending public key (32 bytes compressed)
    pub spending_pubkey: [u8; 32],

    /// Length of the name
    pub name_len: u8,

    /// The actual name (padded to 32 bytes)
    pub name: [u8; 32],

    /// Reserved for future expansion
    _reserved: [u8; 32],
}

impl ReverseRegistry {
    pub const SEED: &'static [u8] = b"reverse";
    pub const SIZE: usize = REVERSE_REGISTRY_SIZE;

    /// Initialize from mutable bytes
    pub fn init(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        if data.len() < Self::SIZE {
            return Err(ProgramError::AccountDataTooSmall);
        }

        // Zero initialize
        data[..Self::SIZE].fill(0);
        data[0] = REVERSE_REGISTRY_DISCRIMINATOR;

        let ptr = data.as_mut_ptr() as *mut Self;
        Ok(unsafe { &mut *ptr })
    }

    /// Parse from bytes (read-only)
    pub fn from_bytes(data: &[u8]) -> Result<&Self, ProgramError> {
        if data.len() < Self::SIZE {
            return Err(ProgramError::AccountDataTooSmall);
        }
        if data[0] != REVERSE_REGISTRY_DISCRIMINATOR {
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
        if data[0] != REVERSE_REGISTRY_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }

        let ptr = data.as_mut_ptr() as *mut Self;
        Ok(unsafe { &mut *ptr })
    }

    /// Get the name as a slice
    pub fn get_name(&self) -> &[u8] {
        &self.name[..self.name_len as usize]
    }

    /// Set the name
    pub fn set_name(&mut self, name: &[u8]) -> Result<(), ProgramError> {
        if name.len() > REVERSE_MAX_NAME_LENGTH {
            return Err(ProgramError::InvalidArgument);
        }
        self.name_len = name.len() as u8;
        self.name[..name.len()].copy_from_slice(name);
        Ok(())
    }
}
