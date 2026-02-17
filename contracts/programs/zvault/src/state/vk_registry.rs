//! Verification Key Registry state account
//!
//! Stores Groth16 verification key hashes on-chain for different circuit types.
//! Actual verification happens via CPI to the groth16 verifier program.

use pinocchio::program_error::ProgramError;

/// Discriminator for VK Registry account
pub const VK_REGISTRY_DISCRIMINATOR: u8 = 0x14;

/// Circuit types that require verification keys
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CircuitType {
    /// Claim to public (4 public inputs)
    Claim = 0,
    /// Split commitment (4 public inputs)
    Split = 1,
    /// Spend partial public (5 public inputs)
    SpendPartialPublic = 2,
    /// Pool deposit (4 public inputs)
    PoolDeposit = 3,
    /// Pool withdraw (5 public inputs)
    PoolWithdraw = 4,
    /// Pool compound yield (5 public inputs)
    PoolCompound = 5,
    /// Pool claim yield (6 public inputs)
    PoolClaimYield = 6,
}

impl CircuitType {
    /// Number of public inputs for this circuit type
    pub fn num_public_inputs(&self) -> usize {
        match self {
            CircuitType::Claim => 4,
            CircuitType::Split => 4,
            CircuitType::SpendPartialPublic => 5,
            CircuitType::PoolDeposit => 4,
            CircuitType::PoolWithdraw => 5,
            CircuitType::PoolCompound => 5,
            CircuitType::PoolClaimYield => 6,
        }
    }

    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(CircuitType::Claim),
            1 => Some(CircuitType::Split),
            2 => Some(CircuitType::SpendPartialPublic),
            3 => Some(CircuitType::PoolDeposit),
            4 => Some(CircuitType::PoolWithdraw),
            5 => Some(CircuitType::PoolCompound),
            6 => Some(CircuitType::PoolClaimYield),
            _ => None,
        }
    }
}

/// On-chain verification key hash storage (Groth16)
///
/// For Groth16, we store the VK hash which is used to lookup
/// the full VK in the groth16 verifier program.
///
/// Layout (256 bytes total):
/// - discriminator: 1 byte
/// - circuit_type: 1 byte
/// - version: 2 bytes (for upgrades)
/// - authority: 32 bytes (who can update)
/// - vk_hash: 32 bytes (hash of the Groth16 verification key)
/// - reserved: 188 bytes
#[repr(C)]
pub struct VkRegistry {
    /// Account discriminator
    pub discriminator: u8,
    /// Circuit type this VK hash is for
    pub circuit_type: u8,
    /// Version number for VK upgrades
    version: [u8; 2],
    /// Authority that can update this VK hash
    pub authority: [u8; 32],
    /// Groth16 verification key hash
    pub vk_hash: [u8; 32],
    /// Reserved for future use
    _reserved: [u8; 188],
}

impl VkRegistry {
    pub const SIZE: usize = 256;
    pub const SEED: &'static [u8] = b"vk_registry";

    /// Parse from account data
    pub fn from_bytes(data: &[u8]) -> Result<&Self, ProgramError> {
        if data.len() < Self::SIZE {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[0] != VK_REGISTRY_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(unsafe { &*(data.as_ptr() as *const Self) })
    }

    /// Parse as mutable
    pub fn from_bytes_mut(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        if data.len() < Self::SIZE {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[0] != VK_REGISTRY_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(unsafe { &mut *(data.as_mut_ptr() as *mut Self) })
    }

    /// Initialize a new VK registry
    pub fn init(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        if data.len() < Self::SIZE {
            return Err(ProgramError::InvalidAccountData);
        }
        data[..Self::SIZE].fill(0);
        data[0] = VK_REGISTRY_DISCRIMINATOR;
        Ok(unsafe { &mut *(data.as_mut_ptr() as *mut Self) })
    }

    /// Get version number
    pub fn version(&self) -> u16 {
        u16::from_le_bytes(self.version)
    }

    /// Set version number
    pub fn set_version(&mut self, value: u16) {
        self.version = value.to_le_bytes();
    }

    /// Check if authority matches
    pub fn is_authority(&self, pubkey: &[u8; 32]) -> bool {
        self.authority == *pubkey
    }

    /// Get circuit type
    pub fn get_circuit_type(&self) -> Option<CircuitType> {
        CircuitType::from_u8(self.circuit_type)
    }

    /// Get VK hash for CPI to groth16 verifier
    pub fn get_vk_hash(&self) -> &[u8; 32] {
        &self.vk_hash
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_circuit_type_public_inputs() {
        assert_eq!(CircuitType::Split.num_public_inputs(), 4);
        assert_eq!(CircuitType::Claim.num_public_inputs(), 4);
        assert_eq!(CircuitType::PoolClaimYield.num_public_inputs(), 6);
    }

    #[test]
    fn test_vk_registry_size() {
        assert_eq!(VkRegistry::SIZE, 256);
    }
}
