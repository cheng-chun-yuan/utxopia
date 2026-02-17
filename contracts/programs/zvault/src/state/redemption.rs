//! Redemption request account (zero-copy)

use pinocchio::program_error::ProgramError;

use crate::constants::{MAX_BTC_ADDRESS_LEN, MAX_BTC_TXID_LEN};

/// Discriminator for RedemptionRequest account
pub const REDEMPTION_REQUEST_DISCRIMINATOR: u8 = 0x04;

/// Redemption status enum
#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RedemptionStatus {
    /// Request created, waiting for processing
    Pending = 0,
    /// Being processed by relayer
    Processing = 1,
    /// BTC transaction broadcast, waiting confirmation
    Broadcasting = 2,
    /// Successfully completed
    Completed = 3,
    /// Failed
    Failed = 4,
}

/// Redemption request - pending BTC withdrawal (zero-copy layout)
#[repr(C)]
pub struct RedemptionRequest {
    /// Account discriminator
    pub discriminator: u8,

    /// Current status
    pub status: u8,

    /// BTC address length
    pub btc_address_len: u8,

    /// BTC txid length
    pub btc_txid_len: u8,

    /// Padding for alignment
    _padding: [u8; 4],

    /// Unique request ID (incrementing)
    request_id: [u8; 8],

    /// User who requested the redemption
    pub requester: [u8; 32],

    /// Amount to withdraw (satoshis)
    amount_sats: [u8; 8],

    /// Timestamp when request was created
    created_at: [u8; 8],

    /// Timestamp when request was completed
    completed_at: [u8; 8],

    /// Bitcoin address for withdrawal (fixed buffer)
    pub btc_address: [u8; MAX_BTC_ADDRESS_LEN],

    /// Bitcoin transaction ID (fixed buffer)
    pub btc_txid: [u8; MAX_BTC_TXID_LEN],

    /// Reserved for future use
    _reserved: [u8; 32],
}

impl RedemptionRequest {
    pub const LEN: usize = core::mem::size_of::<Self>();
    pub const SEED: &'static [u8] = b"redemption";

    /// Parse from account data
    pub fn from_bytes(data: &[u8]) -> Result<&Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[0] != REDEMPTION_REQUEST_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(unsafe { &*(data.as_ptr() as *const Self) })
    }

    /// Parse as mutable from account data
    pub fn from_bytes_mut(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[0] != REDEMPTION_REQUEST_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(unsafe { &mut *(data.as_mut_ptr() as *mut Self) })
    }

    /// Initialize a new redemption request in the given buffer
    pub fn init(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        data[..Self::LEN].fill(0);
        data[0] = REDEMPTION_REQUEST_DISCRIMINATOR;
        Ok(unsafe { &mut *(data.as_mut_ptr() as *mut Self) })
    }

    // Getters
    pub fn get_status(&self) -> RedemptionStatus {
        match self.status {
            0 => RedemptionStatus::Pending,
            1 => RedemptionStatus::Processing,
            2 => RedemptionStatus::Broadcasting,
            3 => RedemptionStatus::Completed,
            4 => RedemptionStatus::Failed,
            _ => RedemptionStatus::Pending,
        }
    }

    pub fn request_id(&self) -> u64 {
        u64::from_le_bytes(self.request_id)
    }

    pub fn amount_sats(&self) -> u64 {
        u64::from_le_bytes(self.amount_sats)
    }

    pub fn created_at(&self) -> i64 {
        i64::from_le_bytes(self.created_at)
    }

    pub fn completed_at(&self) -> i64 {
        i64::from_le_bytes(self.completed_at)
    }

    pub fn get_btc_address(&self) -> &[u8] {
        &self.btc_address[..self.btc_address_len as usize]
    }

    pub fn get_btc_txid(&self) -> &[u8] {
        &self.btc_txid[..self.btc_txid_len as usize]
    }

    // Setters
    pub fn set_status(&mut self, status: RedemptionStatus) {
        self.status = status as u8;
    }

    pub fn set_request_id(&mut self, value: u64) {
        self.request_id = value.to_le_bytes();
    }

    pub fn set_amount_sats(&mut self, value: u64) {
        self.amount_sats = value.to_le_bytes();
    }

    pub fn set_created_at(&mut self, value: i64) {
        self.created_at = value.to_le_bytes();
    }

    pub fn set_completed_at(&mut self, value: i64) {
        self.completed_at = value.to_le_bytes();
    }

    pub fn set_btc_address(&mut self, address: &[u8]) -> Result<(), ProgramError> {
        if address.len() > MAX_BTC_ADDRESS_LEN {
            return Err(ProgramError::InvalidArgument);
        }
        self.btc_address[..address.len()].copy_from_slice(address);
        self.btc_address_len = address.len() as u8;
        Ok(())
    }

    pub fn set_btc_txid(&mut self, txid: &[u8]) -> Result<(), ProgramError> {
        if txid.len() > MAX_BTC_TXID_LEN {
            return Err(ProgramError::InvalidArgument);
        }
        self.btc_txid[..txid.len()].copy_from_slice(txid);
        self.btc_txid_len = txid.len() as u8;
        Ok(())
    }
}
