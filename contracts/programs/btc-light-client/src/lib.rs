//! Bitcoin Light Client - Simple, Transparent, Permissionless (Pinocchio)
//!
//! A standalone Bitcoin header relay for Solana. Anyone can submit headers.
//! No fees, no permissions, just trustless Bitcoin state on Solana.

use pinocchio::{
    account_info::AccountInfo,
    entrypoint,
    instruction::{Seed, Signer},
    program_error::ProgramError,
    pubkey::{find_program_address, Pubkey},
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};

/// Program ID: 8GCjjPpzRP1DhWa9PLcRhSV7aLFkE8x7vf5royAQzUfG
pub const ID: Pubkey = [
    0x6b, 0x8a, 0x3f, 0x2d, 0x1c, 0x4e, 0x5b, 0x7a,
    0x9d, 0x0f, 0x8c, 0x6e, 0x3b, 0x2a, 0x1d, 0x4c,
    0x5e, 0x7f, 0x9a, 0x0b, 0x8d, 0x6c, 0x3e, 0x2f,
    0x1a, 0x4d, 0x5c, 0x7b, 0x9e, 0x0a, 0x8f, 0x6d,
];

/// Required confirmations for finality (6 blocks)
pub const REQUIRED_CONFIRMATIONS: u64 = 6;

// Instruction discriminators
pub const INITIALIZE: u8 = 0;
pub const SUBMIT_HEADER: u8 = 1;

entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }

    match data[0] {
        INITIALIZE => process_initialize(program_id, accounts, &data[1..]),
        SUBMIT_HEADER => process_submit_header(program_id, accounts, &data[1..]),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

// ============================================================================
// State Structures
// ============================================================================

/// Light client state discriminator
pub const LIGHT_CLIENT_DISCRIMINATOR: u8 = 0x01;

/// Block header discriminator
pub const BLOCK_HEADER_DISCRIMINATOR: u8 = 0x02;

/// Light client state - tracks Bitcoin chain tip
/// All multi-byte integers stored as little-endian byte arrays for alignment safety
#[repr(C)]
pub struct LightClientState {
    pub discriminator: u8,
    pub bump: u8,
    /// Padding for alignment
    _padding: [u8; 6],
    tip_height: [u8; 8],
    pub tip_hash: [u8; 32],
    start_height: [u8; 8],
    pub start_hash: [u8; 32],
    finalized_height: [u8; 8],
    header_count: [u8; 8],
    last_update: [u8; 8],
    pub network: u8,
    /// Padding to maintain consistent size
    _padding2: [u8; 7],
}

impl LightClientState {
    pub const SIZE: usize = core::mem::size_of::<Self>();
    pub const SEED: &'static [u8] = b"light_client";

    pub fn from_bytes(data: &[u8]) -> Result<&Self, ProgramError> {
        if data.len() < Self::SIZE {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[0] != LIGHT_CLIENT_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(unsafe { &*(data.as_ptr() as *const Self) })
    }

    pub fn from_bytes_mut(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        if data.len() < Self::SIZE {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(unsafe { &mut *(data.as_mut_ptr() as *mut Self) })
    }

    pub fn init(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        if data.len() < Self::SIZE {
            return Err(ProgramError::InvalidAccountData);
        }
        data[..Self::SIZE].fill(0);
        data[0] = LIGHT_CLIENT_DISCRIMINATOR;
        Ok(unsafe { &mut *(data.as_mut_ptr() as *mut Self) })
    }

    // Getters
    pub fn tip_height(&self) -> u64 {
        u64::from_le_bytes(self.tip_height)
    }

    pub fn start_height(&self) -> u64 {
        u64::from_le_bytes(self.start_height)
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

    // Setters
    pub fn set_tip_height(&mut self, value: u64) {
        self.tip_height = value.to_le_bytes();
    }

    pub fn set_start_height(&mut self, value: u64) {
        self.start_height = value.to_le_bytes();
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
}

/// Individual block header
/// All multi-byte integers stored as little-endian byte arrays for alignment safety
#[repr(C)]
pub struct BlockHeader {
    pub discriminator: u8,
    pub bump: u8,
    /// Padding for alignment
    _padding: [u8; 6],
    height: [u8; 8],
    pub block_hash: [u8; 32],
    pub prev_block_hash: [u8; 32],
    pub merkle_root: [u8; 32],
    timestamp: [u8; 4],
    bits: [u8; 4],
    nonce: [u8; 4],
    /// Padding for alignment
    _padding2: [u8; 4],
    pub submitted_by: [u8; 32],
    submitted_at: [u8; 8],
}

impl BlockHeader {
    pub const SIZE: usize = core::mem::size_of::<Self>();
    pub const SEED: &'static [u8] = b"block";

    pub fn from_bytes_mut(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        if data.len() < Self::SIZE {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(unsafe { &mut *(data.as_mut_ptr() as *mut Self) })
    }

    pub fn init(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        if data.len() < Self::SIZE {
            return Err(ProgramError::InvalidAccountData);
        }
        data[..Self::SIZE].fill(0);
        data[0] = BLOCK_HEADER_DISCRIMINATOR;
        Ok(unsafe { &mut *(data.as_mut_ptr() as *mut Self) })
    }

    // Getters
    pub fn height(&self) -> u64 {
        u64::from_le_bytes(self.height)
    }

    pub fn timestamp(&self) -> u32 {
        u32::from_le_bytes(self.timestamp)
    }

    pub fn bits(&self) -> u32 {
        u32::from_le_bytes(self.bits)
    }

    pub fn nonce(&self) -> u32 {
        u32::from_le_bytes(self.nonce)
    }

    pub fn submitted_at(&self) -> i64 {
        i64::from_le_bytes(self.submitted_at)
    }

    // Setters
    pub fn set_height(&mut self, value: u64) {
        self.height = value.to_le_bytes();
    }

    pub fn set_timestamp(&mut self, value: u32) {
        self.timestamp = value.to_le_bytes();
    }

    pub fn set_bits(&mut self, value: u32) {
        self.bits = value.to_le_bytes();
    }

    pub fn set_nonce(&mut self, value: u32) {
        self.nonce = value.to_le_bytes();
    }

    pub fn set_submitted_at(&mut self, value: i64) {
        self.submitted_at = value.to_le_bytes();
    }
}

// ============================================================================
// Errors
// ============================================================================

#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(u32)]
pub enum LightClientError {
    InvalidHeight = 0,
    InvalidPrevHash = 1,
    InsufficientPoW = 2,
    AlreadyInitialized = 3,
}

impl From<LightClientError> for ProgramError {
    fn from(e: LightClientError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

// ============================================================================
// Instructions
// ============================================================================

/// Initialize instruction data
/// - start_height: u64
/// - start_block_hash: [u8; 32]
/// - network: u8
fn process_initialize(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < 41 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let light_client = &accounts[0];
    let payer = &accounts[1];
    let _system_program = &accounts[2];

    // Parse instruction data
    let start_height = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let mut start_block_hash = [0u8; 32];
    start_block_hash.copy_from_slice(&data[8..40]);
    let network = data[40];

    // Validate payer is signer
    if !payer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Verify PDA
    let seeds: &[&[u8]] = &[LightClientState::SEED];
    let (expected_pda, bump) = find_program_address(seeds, program_id);
    if light_client.key() != &expected_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // Check not already initialized
    if light_client.data_len() > 0 {
        let existing_data = light_client.try_borrow_data()?;
        if existing_data[0] == LIGHT_CLIENT_DISCRIMINATOR {
            return Err(LightClientError::AlreadyInitialized.into());
        }
    }

    // Create account
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(LightClientState::SIZE);

    let bump_bytes = [bump];
    let signer_seeds: &[&[u8]] = &[LightClientState::SEED, &bump_bytes];
    let seeds_vec: Vec<Seed> = signer_seeds.iter().map(|s| Seed::from(*s)).collect();
    let signer = Signer::from(&seeds_vec[..]);

    let create_account = pinocchio_system::instructions::CreateAccount {
        from: payer,
        to: light_client,
        lamports,
        space: LightClientState::SIZE as u64,
        owner: program_id,
    };
    create_account.invoke_signed(&[signer])?;

    // Initialize state
    let clock = Clock::get()?;
    {
        let mut state_data = light_client.try_borrow_mut_data()?;
        let state = LightClientState::init(&mut state_data)?;

        state.bump = bump;
        state.set_tip_height(start_height);
        state.tip_hash = start_block_hash;
        state.set_start_height(start_height);
        state.start_hash = start_block_hash;
        state.set_finalized_height(start_height.saturating_sub(REQUIRED_CONFIRMATIONS));
        state.set_header_count(1);
        state.set_last_update(clock.unix_timestamp);
        state.network = network;
    }

    pinocchio::msg!("Bitcoin Light Client initialized");
    Ok(())
}

/// Submit header instruction data
/// - raw_header: [u8; 80]
/// - height: u64
fn process_submit_header(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < 88 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let light_client = &accounts[0];
    let block_header_acc = &accounts[1];
    let submitter = &accounts[2];
    let _system_program = &accounts[3];

    // Parse instruction data
    let mut raw_header = [0u8; 80];
    raw_header.copy_from_slice(&data[0..80]);
    let height = u64::from_le_bytes(data[80..88].try_into().unwrap());

    // Validate submitter is signer
    if !submitter.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Validate light client owner
    if light_client.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }

    // Parse header
    let parsed = ParsedHeader::from_raw(&raw_header);
    let block_hash = double_sha256(&raw_header);

    // Verify chain rules
    {
        let state_data = light_client.try_borrow_data()?;
        let state = LightClientState::from_bytes(&state_data)?;

        // Height must be tip + 1
        if height != state.tip_height() + 1 {
            return Err(LightClientError::InvalidHeight.into());
        }

        // Prev hash must match tip
        if parsed.prev_block_hash != state.tip_hash {
            return Err(LightClientError::InvalidPrevHash.into());
        }
    }

    // Verify proof of work
    let target = bits_to_target(parsed.bits);
    if !hash_meets_target(&block_hash, &target) {
        return Err(LightClientError::InsufficientPoW.into());
    }

    // Verify block header PDA
    let height_bytes = height.to_le_bytes();
    let seeds: &[&[u8]] = &[BlockHeader::SEED, &height_bytes];
    let (expected_pda, bump) = find_program_address(seeds, program_id);
    if block_header_acc.key() != &expected_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // Create block header account
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(BlockHeader::SIZE);

    let bump_bytes = [bump];
    let signer_seeds: &[&[u8]] = &[BlockHeader::SEED, &height_bytes, &bump_bytes];
    let seeds_vec: Vec<Seed> = signer_seeds.iter().map(|s| Seed::from(*s)).collect();
    let signer = Signer::from(&seeds_vec[..]);

    let create_account = pinocchio_system::instructions::CreateAccount {
        from: submitter,
        to: block_header_acc,
        lamports,
        space: BlockHeader::SIZE as u64,
        owner: program_id,
    };
    create_account.invoke_signed(&[signer])?;

    let clock = Clock::get()?;

    // Store block header
    {
        let mut header_data = block_header_acc.try_borrow_mut_data()?;
        let header = BlockHeader::init(&mut header_data)?;

        header.bump = bump;
        header.set_height(height);
        header.block_hash = block_hash;
        header.prev_block_hash = parsed.prev_block_hash;
        header.merkle_root = parsed.merkle_root;
        header.set_timestamp(parsed.timestamp);
        header.set_bits(parsed.bits);
        header.set_nonce(parsed.nonce);
        header.submitted_by.copy_from_slice(submitter.key().as_ref());
        header.set_submitted_at(clock.unix_timestamp);
    }

    // Update light client state
    {
        let mut state_data = light_client.try_borrow_mut_data()?;
        let state = LightClientState::from_bytes_mut(&mut state_data)?;

        state.set_tip_height(height);
        state.tip_hash = block_hash;
        let new_count = state.header_count()
            .checked_add(1)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        state.set_header_count(new_count);
        state.set_last_update(clock.unix_timestamp);

        if height >= REQUIRED_CONFIRMATIONS {
            state.set_finalized_height(height - REQUIRED_CONFIRMATIONS);
        }
    }

    pinocchio::msg!("Block submitted");
    Ok(())
}

// ============================================================================
// Helper Functions
// ============================================================================

struct ParsedHeader {
    prev_block_hash: [u8; 32],
    merkle_root: [u8; 32],
    timestamp: u32,
    bits: u32,
    nonce: u32,
}

impl ParsedHeader {
    fn from_raw(raw: &[u8; 80]) -> Self {
        let mut prev_block_hash = [0u8; 32];
        let mut merkle_root = [0u8; 32];
        prev_block_hash.copy_from_slice(&raw[4..36]);
        merkle_root.copy_from_slice(&raw[36..68]);

        Self {
            prev_block_hash,
            merkle_root,
            timestamp: u32::from_le_bytes(raw[68..72].try_into().unwrap()),
            bits: u32::from_le_bytes(raw[72..76].try_into().unwrap()),
            nonce: u32::from_le_bytes(raw[76..80].try_into().unwrap()),
        }
    }
}

/// Double SHA256 hash (Bitcoin standard)
fn double_sha256(data: &[u8]) -> [u8; 32] {
    let first = sha256(data);
    sha256(&first)
}

/// SHA256 hash using Solana syscall
fn sha256(data: &[u8]) -> [u8; 32] {
    let mut result = [0u8; 32];
    unsafe {
        pinocchio::syscalls::sol_sha256(
            data.as_ptr(),
            data.len() as u64,
            result.as_mut_ptr(),
        );
    }
    result
}

/// Convert compact bits to full target
fn bits_to_target(bits: u32) -> [u8; 32] {
    let mut target = [0u8; 32];
    let exponent = ((bits >> 24) & 0xff) as usize;
    let mantissa = bits & 0x007fffff;

    if exponent <= 3 {
        let shift = 8 * (3 - exponent);
        let value = mantissa >> shift;
        target[0..4].copy_from_slice(&value.to_le_bytes());
    } else if exponent <= 34 {
        let byte_offset = exponent - 3;
        if byte_offset < 30 {
            target[byte_offset] = (mantissa & 0xff) as u8;
            target[byte_offset + 1] = ((mantissa >> 8) & 0xff) as u8;
            target[byte_offset + 2] = ((mantissa >> 16) & 0xff) as u8;
        }
    }

    target
}

/// Check if hash meets difficulty target
fn hash_meets_target(hash: &[u8; 32], target: &[u8; 32]) -> bool {
    for i in (0..32).rev() {
        if hash[i] > target[i] {
            return false;
        }
        if hash[i] < target[i] {
            return true;
        }
    }
    true
}
