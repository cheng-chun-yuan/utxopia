//! Bitcoin Light Client state account (zero-copy)

use pinocchio::program_error::ProgramError;

/// Discriminator for BitcoinLightClient account
pub const BTC_LIGHT_CLIENT_DISCRIMINATOR: u8 = 0x06;

/// Required confirmations for deposit finality
pub const REQUIRED_CONFIRMATIONS: u64 = 6;

/// Bitcoin Light Client state (zero-copy layout)
/// Tracks the Bitcoin blockchain for SPV proof verification
#[repr(C)]
pub struct BitcoinLightClient {
    /// Account discriminator
    pub discriminator: u8,

    /// Bump seed for PDA derivation
    pub bump: u8,

    /// Is the light client paused?
    pub paused: u8,

    /// Network (0 = mainnet, 1 = testnet, 2 = regtest)
    pub network: u8,

    /// Padding for alignment
    _padding: [u8; 4],

    /// Authority that can manage the light client
    pub authority: [u8; 32],

    /// Genesis block hash (network identifier)
    pub genesis_hash: [u8; 32],

    /// Current chain tip block hash
    pub tip_hash: [u8; 32],

    /// Total accumulated chainwork at tip
    pub total_chainwork: [u8; 32],

    /// Current chain tip height
    tip_height: [u8; 8],

    /// Finalized height (tip - REQUIRED_CONFIRMATIONS)
    finalized_height: [u8; 8],

    /// Number of headers stored
    header_count: [u8; 8],

    /// Timestamp of last header update
    last_update: [u8; 8],

    /// Reserved for future use
    _reserved: [u8; 64],
}

impl BitcoinLightClient {
    pub const LEN: usize = core::mem::size_of::<Self>();
    pub const SEED: &'static [u8] = b"btc_light_client";

    /// Parse from account data
    pub fn from_bytes(data: &[u8]) -> Result<&Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[0] != BTC_LIGHT_CLIENT_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(unsafe { &*(data.as_ptr() as *const Self) })
    }

    /// Parse as mutable from account data
    pub fn from_bytes_mut(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[0] != BTC_LIGHT_CLIENT_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(unsafe { &mut *(data.as_mut_ptr() as *mut Self) })
    }

    /// Initialize a new light client in the given buffer
    pub fn init(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        data[..Self::LEN].fill(0);
        data[0] = BTC_LIGHT_CLIENT_DISCRIMINATOR;
        Ok(unsafe { &mut *(data.as_mut_ptr() as *mut Self) })
    }

    // Getters
    pub fn is_paused(&self) -> bool {
        self.paused != 0
    }

    pub fn tip_height(&self) -> u64 {
        u64::from_le_bytes(self.tip_height)
    }

    pub fn finalized_height(&self) -> u64 {
        u64::from_le_bytes(self.finalized_height)
    }

    pub fn header_count(&self) -> u64 {
        u64::from_le_bytes(self.header_count)
    }

    pub fn last_update(&self) -> i64 {
        i64::from_le_bytes(self.last_update)
    }

    /// Check if a block height is finalized
    pub fn is_finalized(&self, block_height: u64) -> bool {
        block_height <= self.finalized_height()
    }

    /// Get the number of confirmations for a block
    pub fn confirmations(&self, block_height: u64) -> u64 {
        let tip = self.tip_height();
        if block_height > tip {
            0
        } else {
            tip - block_height + 1
        }
    }

    // Setters
    pub fn set_paused(&mut self, paused: bool) {
        self.paused = if paused { 1 } else { 0 };
    }

    pub fn set_tip_height(&mut self, value: u64) {
        self.tip_height = value.to_le_bytes();
    }

    pub fn set_finalized_height(&mut self, value: u64) {
        self.finalized_height = value.to_le_bytes();
    }

    pub fn set_header_count(&mut self, value: u64) {
        self.header_count = value.to_le_bytes();
    }

    pub fn set_last_update(&mut self, value: i64) {
        self.last_update = value.to_le_bytes();
    }

    pub fn increment_header_count(&mut self) -> Result<(), ProgramError> {
        let count = self.header_count();
        self.set_header_count(count.checked_add(1).ok_or(ProgramError::ArithmeticOverflow)?);
        Ok(())
    }
}
