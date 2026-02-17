//! Nullifier record account (zero-copy)

use pinocchio::program_error::ProgramError;

/// Discriminator for NullifierRecord account
pub const NULLIFIER_RECORD_DISCRIMINATOR: u8 = 0x03;

/// Type of operation that spent the nullifier
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum NullifierOperationType {
    /// Full withdrawal (redemption)
    FullWithdrawal = 0,
    /// Partial withdrawal with change
    PartialWithdrawal = 1,
    /// Private transfer (to another commitment)
    PrivateTransfer = 2,
    /// Commitment refresh (1-in-1-out transfer)
    Transfer = 3,
    /// Commitment split (1-in-2-out)
    Split = 4,
    /// Commitment join (2-in-1-out)
    Join = 5,
}

/// Nullifier record to prevent double-spend (zero-copy layout)
#[repr(C)]
pub struct NullifierRecord {
    /// Account discriminator
    pub discriminator: u8,

    /// Type of operation that spent this nullifier
    pub operation_type: u8,

    /// Padding for alignment
    _padding: [u8; 6],

    /// The nullifier hash
    pub nullifier_hash: [u8; 32],

    /// Timestamp when this nullifier was spent
    spent_at: [u8; 8],

    /// User who spent this nullifier
    pub spent_by: [u8; 32],

    /// Request ID that spent this nullifier
    spent_in_request: [u8; 8],

    /// Reserved for future use
    _reserved: [u8; 16],
}

impl NullifierRecord {
    pub const LEN: usize = core::mem::size_of::<Self>();
    pub const SEED: &'static [u8] = b"nullifier";

    /// Parse from account data
    pub fn from_bytes(data: &[u8]) -> Result<&Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[0] != NULLIFIER_RECORD_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(unsafe { &*(data.as_ptr() as *const Self) })
    }

    /// Parse as mutable from account data
    pub fn from_bytes_mut(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[0] != NULLIFIER_RECORD_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(unsafe { &mut *(data.as_mut_ptr() as *mut Self) })
    }

    /// Initialize a new nullifier record in the given buffer
    pub fn init(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        data[..Self::LEN].fill(0);
        data[0] = NULLIFIER_RECORD_DISCRIMINATOR;
        Ok(unsafe { &mut *(data.as_mut_ptr() as *mut Self) })
    }

    // Getters
    pub fn get_operation_type(&self) -> NullifierOperationType {
        match self.operation_type {
            0 => NullifierOperationType::FullWithdrawal,
            1 => NullifierOperationType::PartialWithdrawal,
            2 => NullifierOperationType::PrivateTransfer,
            3 => NullifierOperationType::Transfer,
            4 => NullifierOperationType::Split,
            5 => NullifierOperationType::Join,
            _ => NullifierOperationType::FullWithdrawal,
        }
    }

    pub fn spent_at(&self) -> i64 {
        i64::from_le_bytes(self.spent_at)
    }

    pub fn spent_in_request(&self) -> u64 {
        u64::from_le_bytes(self.spent_in_request)
    }

    // Setters
    pub fn set_operation_type(&mut self, op_type: NullifierOperationType) {
        self.operation_type = op_type as u8;
    }

    pub fn set_spent_at(&mut self, value: i64) {
        self.spent_at = value.to_le_bytes();
    }

    pub fn set_spent_in_request(&mut self, value: u64) {
        self.spent_in_request = value.to_le_bytes();
    }
}
