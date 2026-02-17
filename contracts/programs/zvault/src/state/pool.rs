//! Pool state account (zero-copy)

use pinocchio::program_error::ProgramError;

/// Discriminator for PoolState account
pub const POOL_STATE_DISCRIMINATOR: u8 = 0x01;

/// Main pool state account (zero-copy layout)
/// All multi-byte integers stored as little-endian byte arrays for alignment safety
#[repr(C)]
pub struct PoolState {
    /// Account discriminator (1 byte)
    pub discriminator: u8,

    /// Bump seed for PDA derivation
    pub bump: u8,

    /// Flags: bit 0 = paused
    pub flags: u8,

    /// Padding for alignment
    _padding: u8,

    /// Authority that can update state (FROST relayer)
    pub authority: [u8; 32],

    /// zBTC Token-2022 mint address
    pub zbtc_mint: [u8; 32],

    /// Pool vault that holds zBTC (PDA-controlled)
    pub pool_vault: [u8; 32],

    /// FROST vault that holds zBTC pending Privacy Cash deposit
    pub frost_vault: [u8; 32],

    /// Total number of deposits recorded (u64 as bytes)
    deposit_count: [u8; 8],

    /// Total zBTC minted (in satoshis)
    total_minted: [u8; 8],

    /// Total zBTC burned (in satoshis)
    total_burned: [u8; 8],

    /// Number of pending redemption requests
    pending_redemptions: [u8; 8],

    /// Number of direct claims
    direct_claims: [u8; 8],

    /// Number of split operations
    split_count: [u8; 8],

    /// Timestamp of last update
    last_update: [u8; 8],

    /// Minimum deposit amount (satoshis)
    min_deposit: [u8; 8],

    /// Maximum deposit amount (satoshis)
    max_deposit: [u8; 8],

    /// Total zBTC in shielded pool (users hold commitments, not public tokens)
    total_shielded: [u8; 8],

    /// Reserved for future use
    _reserved: [u8; 56],
}

impl PoolState {
    pub const LEN: usize = core::mem::size_of::<Self>();
    pub const SEED: &'static [u8] = b"pool_state";

    const FLAG_PAUSED: u8 = 1 << 0;

    /// Parse from account data
    pub fn from_bytes(data: &[u8]) -> Result<&Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[0] != POOL_STATE_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        // Safe: PoolState is repr(C) with all byte-aligned fields
        Ok(unsafe { &*(data.as_ptr() as *const Self) })
    }

    /// Parse as mutable from account data
    pub fn from_bytes_mut(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[0] != POOL_STATE_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(unsafe { &mut *(data.as_mut_ptr() as *mut Self) })
    }

    /// Initialize a new pool state in the given buffer
    pub fn init(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        // Zero initialize
        data[..Self::LEN].fill(0);
        data[0] = POOL_STATE_DISCRIMINATOR;
        Ok(unsafe { &mut *(data.as_mut_ptr() as *mut Self) })
    }

    // Getters
    pub fn is_paused(&self) -> bool {
        self.flags & Self::FLAG_PAUSED != 0
    }

    pub fn deposit_count(&self) -> u64 {
        u64::from_le_bytes(self.deposit_count)
    }

    pub fn total_minted(&self) -> u64 {
        u64::from_le_bytes(self.total_minted)
    }

    pub fn total_burned(&self) -> u64 {
        u64::from_le_bytes(self.total_burned)
    }

    pub fn pending_redemptions(&self) -> u64 {
        u64::from_le_bytes(self.pending_redemptions)
    }

    pub fn direct_claims(&self) -> u64 {
        u64::from_le_bytes(self.direct_claims)
    }

    pub fn split_count(&self) -> u64 {
        u64::from_le_bytes(self.split_count)
    }

    pub fn last_update(&self) -> i64 {
        i64::from_le_bytes(self.last_update)
    }

    pub fn min_deposit(&self) -> u64 {
        u64::from_le_bytes(self.min_deposit)
    }

    pub fn max_deposit(&self) -> u64 {
        u64::from_le_bytes(self.max_deposit)
    }

    pub fn total_shielded(&self) -> u64 {
        u64::from_le_bytes(self.total_shielded)
    }

    // Setters
    pub fn set_paused(&mut self, paused: bool) {
        if paused {
            self.flags |= Self::FLAG_PAUSED;
        } else {
            self.flags &= !Self::FLAG_PAUSED;
        }
    }

    pub fn set_deposit_count(&mut self, value: u64) {
        self.deposit_count = value.to_le_bytes();
    }

    pub fn set_total_minted(&mut self, value: u64) {
        self.total_minted = value.to_le_bytes();
    }

    pub fn set_total_burned(&mut self, value: u64) {
        self.total_burned = value.to_le_bytes();
    }

    pub fn set_pending_redemptions(&mut self, value: u64) {
        self.pending_redemptions = value.to_le_bytes();
    }

    pub fn set_direct_claims(&mut self, value: u64) {
        self.direct_claims = value.to_le_bytes();
    }

    pub fn set_split_count(&mut self, value: u64) {
        self.split_count = value.to_le_bytes();
    }

    pub fn set_last_update(&mut self, value: i64) {
        self.last_update = value.to_le_bytes();
    }

    pub fn set_min_deposit(&mut self, value: u64) {
        self.min_deposit = value.to_le_bytes();
    }

    pub fn set_max_deposit(&mut self, value: u64) {
        self.max_deposit = value.to_le_bytes();
    }

    pub fn set_total_shielded(&mut self, value: u64) {
        self.total_shielded = value.to_le_bytes();
    }

    // Increment helpers with overflow check
    pub fn increment_deposit_count(&mut self) -> Result<(), ProgramError> {
        let count = self.deposit_count();
        self.set_deposit_count(count.checked_add(1).ok_or(ProgramError::ArithmeticOverflow)?);
        Ok(())
    }

    pub fn increment_direct_claims(&mut self) -> Result<(), ProgramError> {
        let count = self.direct_claims();
        self.set_direct_claims(count.checked_add(1).ok_or(ProgramError::ArithmeticOverflow)?);
        Ok(())
    }

    pub fn add_minted(&mut self, amount: u64) -> Result<(), ProgramError> {
        let total = self.total_minted();
        self.set_total_minted(total.checked_add(amount).ok_or(ProgramError::ArithmeticOverflow)?);
        Ok(())
    }

    pub fn add_burned(&mut self, amount: u64) -> Result<(), ProgramError> {
        let total = self.total_burned();
        self.set_total_burned(total.checked_add(amount).ok_or(ProgramError::ArithmeticOverflow)?);
        Ok(())
    }

    pub fn add_shielded(&mut self, amount: u64) -> Result<(), ProgramError> {
        let total = self.total_shielded();
        self.set_total_shielded(total.checked_add(amount).ok_or(ProgramError::ArithmeticOverflow)?);
        Ok(())
    }

    pub fn sub_shielded(&mut self, amount: u64) -> Result<(), ProgramError> {
        let total = self.total_shielded();
        self.set_total_shielded(total.checked_sub(amount).ok_or(ProgramError::ArithmeticOverflow)?);
        Ok(())
    }
}
