//! Deposit record account (zero-copy)
//!
//! PRIVACY MODEL:
//! - Deposit amount IS stored (btc_txid links to public BTC tx anyway)
//! - Privacy comes from UNLINKING deposits to withdrawals:
//!   - Different commitment hash vs nullifier hash
//!   - Without knowing 'secret', can't link deposit → withdrawal

use pinocchio::program_error::ProgramError;

/// Discriminator for DepositRecord account
pub const DEPOSIT_RECORD_DISCRIMINATOR: u8 = 0x02;

/// Individual deposit record (zero-copy layout)
#[repr(C)]
pub struct DepositRecord {
    /// Account discriminator
    pub discriminator: u8,

    /// Has this deposit been minted to pool?
    pub minted: u8,

    /// Padding for alignment
    _padding: [u8; 6],

    /// The commitment hash: Poseidon(notePubKey, amount)
    pub commitment: [u8; 32],

    /// Amount in satoshis (stored for convenience, also visible via btc_txid)
    amount_sats: [u8; 8],

    /// Bitcoin transaction ID
    pub btc_txid: [u8; 32],

    /// Bitcoin block height where tx was confirmed
    block_height: [u8; 8],

    /// Leaf index in Merkle tree
    leaf_index: [u8; 8],

    /// Depositor's Solana address
    pub depositor: [u8; 32],

    /// Timestamp when deposit was verified
    timestamp: [u8; 8],

    /// Reserved for future use
    _reserved: [u8; 32],
}

impl DepositRecord {
    pub const LEN: usize = core::mem::size_of::<Self>();
    pub const SEED: &'static [u8] = b"deposit";

    /// Parse from account data
    pub fn from_bytes(data: &[u8]) -> Result<&Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[0] != DEPOSIT_RECORD_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(unsafe { &*(data.as_ptr() as *const Self) })
    }

    /// Parse as mutable from account data
    pub fn from_bytes_mut(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[0] != DEPOSIT_RECORD_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(unsafe { &mut *(data.as_mut_ptr() as *mut Self) })
    }

    /// Initialize a new deposit record in the given buffer
    pub fn init(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        data[..Self::LEN].fill(0);
        data[0] = DEPOSIT_RECORD_DISCRIMINATOR;
        Ok(unsafe { &mut *(data.as_mut_ptr() as *mut Self) })
    }

    // Getters
    pub fn is_minted(&self) -> bool {
        self.minted != 0
    }

    pub fn amount_sats(&self) -> u64 {
        u64::from_le_bytes(self.amount_sats)
    }

    pub fn block_height(&self) -> u64 {
        u64::from_le_bytes(self.block_height)
    }

    pub fn leaf_index(&self) -> u64 {
        u64::from_le_bytes(self.leaf_index)
    }

    pub fn timestamp(&self) -> i64 {
        i64::from_le_bytes(self.timestamp)
    }

    // Setters
    pub fn set_minted(&mut self, minted: bool) {
        self.minted = if minted { 1 } else { 0 };
    }

    pub fn set_amount_sats(&mut self, value: u64) {
        self.amount_sats = value.to_le_bytes();
    }

    pub fn set_block_height(&mut self, value: u64) {
        self.block_height = value.to_le_bytes();
    }

    pub fn set_leaf_index(&mut self, value: u64) {
        self.leaf_index = value.to_le_bytes();
    }

    pub fn set_timestamp(&mut self, value: i64) {
        self.timestamp = value.to_le_bytes();
    }
}
