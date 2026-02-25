//! BTC Relay Program
//!
//! Manages Bitcoin light client state and block headers for SPV verification.
//! Uses the same account layouts as zvault so it can read these accounts directly.

use pinocchio::{
    account_info::AccountInfo,
    entrypoint,
    instruction::{Seed, Signer},
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
    sysvars::{clock::Clock, Sysvar},
};
use pinocchio_system::instructions::CreateAccount;

// =============================================================================
// State Layouts (must match zvault exactly)
// =============================================================================

/// Discriminator for BitcoinLightClient account
const BTC_LIGHT_CLIENT_DISCRIMINATOR: u8 = 0x06;

/// Discriminator for BlockHeader account
const BLOCK_HEADER_DISCRIMINATOR: u8 = 0x07;

const LIGHT_CLIENT_SEED: &[u8] = b"btc_light_client";
const BLOCK_HEADER_SEED: &[u8] = b"block_header";

/// Bitcoin Light Client state (zero-copy layout)
/// Must match zvault's BitcoinLightClient exactly.
#[repr(C)]
struct BitcoinLightClient {
    discriminator: u8,
    bump: u8,
    paused: u8,
    network: u8,
    _padding: [u8; 4],
    authority: [u8; 32],
    genesis_hash: [u8; 32],
    tip_hash: [u8; 32],
    total_chainwork: [u8; 32],
    tip_height: [u8; 8],
    finalized_height: [u8; 8],
    header_count: [u8; 8],
    last_update: [u8; 8],
    _reserved: [u8; 64],
}

impl BitcoinLightClient {
    const LEN: usize = core::mem::size_of::<Self>();

    fn from_bytes_mut(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[0] != BTC_LIGHT_CLIENT_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(unsafe { &mut *(data.as_mut_ptr() as *mut Self) })
    }

    fn tip_height(&self) -> u64 {
        u64::from_le_bytes(self.tip_height)
    }

    fn header_count(&self) -> u64 {
        u64::from_le_bytes(self.header_count)
    }

    fn set_tip_height(&mut self, value: u64) {
        self.tip_height = value.to_le_bytes();
    }

    fn set_finalized_height(&mut self, value: u64) {
        self.finalized_height = value.to_le_bytes();
    }

    fn set_header_count(&mut self, value: u64) {
        self.header_count = value.to_le_bytes();
    }

    fn set_last_update(&mut self, value: i64) {
        self.last_update = value.to_le_bytes();
    }
}

/// Bitcoin block header account (zero-copy layout)
/// Must match zvault's BlockHeader exactly.
#[repr(C)]
struct BlockHeader {
    discriminator: u8,
    _padding: [u8; 3],
    version: [u8; 4],
    prev_block_hash: [u8; 32],
    merkle_root: [u8; 32],
    timestamp: [u8; 4],
    bits: [u8; 4],
    nonce: [u8; 4],
    block_hash: [u8; 32],
    chainwork: [u8; 32],
    height: [u8; 8],
    submitted_at: [u8; 8],
    _reserved: [u8; 32],
}

impl BlockHeader {
    const LEN: usize = core::mem::size_of::<Self>();
}

// =============================================================================
// SHA256 (Solana syscall)
// =============================================================================

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut result = [0u8; 32];

    #[cfg(target_os = "solana")]
    {
        unsafe {
            extern "C" {
                fn sol_sha256(vals: *const u8, val_len: u64, hash_result: *mut u8) -> u64;
            }
            let slice_desc = [data.as_ptr(), data.len() as *const u8];
            sol_sha256(slice_desc.as_ptr() as *const u8, 1, result.as_mut_ptr());
        }
    }

    #[cfg(not(target_os = "solana"))]
    {
        // Simple fallback for off-chain testing
        for (i, byte) in data.iter().enumerate() {
            result[i % 32] ^= byte;
            result[(i + 1) % 32] = result[(i + 1) % 32].wrapping_add(*byte);
        }
    }

    result
}

fn double_sha256(data: &[u8]) -> [u8; 32] {
    let first = sha256(data);
    sha256(&first)
}

// =============================================================================
// PoW Validation
// =============================================================================

/// Check if a hash meets the difficulty target (LE comparison)
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

/// Get difficulty target from compact bits format
fn target_from_bits(bits: u32) -> [u8; 32] {
    let mut target = [0u8; 32];
    let exponent = ((bits >> 24) & 0xff) as usize;
    let mantissa = bits & 0x007fffff;

    if exponent <= 3 {
        let shift = 8 * (3 - exponent);
        let value = mantissa >> shift;
        target[0..4].copy_from_slice(&value.to_le_bytes());
    } else {
        let byte_offset = exponent - 3;
        if byte_offset < 29 {
            target[byte_offset..byte_offset + 3].copy_from_slice(&mantissa.to_le_bytes()[0..3]);
        }
    }

    target
}

/// Calculate chainwork from difficulty bits
fn calculate_chainwork(bits: u32) -> [u8; 32] {
    let mut work = [0u8; 32];
    let exponent = ((bits >> 24) & 0xff) as usize;
    let mantissa = bits & 0x007fffff;

    if exponent > 0 && exponent < 32 {
        let pos = 32 - exponent;
        if pos < 32 {
            work[pos] = (mantissa >> 16) as u8;
            if pos + 1 < 32 {
                work[pos + 1] = (mantissa >> 8) as u8;
            }
            if pos + 2 < 32 {
                work[pos + 2] = mantissa as u8;
            }
        }
    }

    work
}

/// Add two 256-bit chainwork values
fn add_chainwork(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut result = [0u8; 32];
    let mut carry: u16 = 0;

    for i in 0..32 {
        let sum = a[i] as u16 + b[i] as u16 + carry;
        result[i] = sum as u8;
        carry = sum >> 8;
    }

    result
}

// =============================================================================
// Required confirmations
// =============================================================================

const REQUIRED_CONFIRMATIONS: u64 = 1;

// =============================================================================
// Entrypoint
// =============================================================================

entrypoint!(process_instruction);

fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }

    match data[0] {
        0 => process_initialize(program_id, accounts, &data[1..]),
        1 => process_submit_header(program_id, accounts, &data[1..]),
        2 => process_reset_tip(program_id, accounts, &data[1..]),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

// =============================================================================
// INITIALIZE (disc=0)
// =============================================================================

/// Initialize the Bitcoin Light Client PDA.
///
/// Instruction data (after discriminator):
///   [0-7]   start_height   (u64 LE)
///   [8-39]  start_block_hash ([u8; 32])
///   [40]    network        (u8: 0=mainnet, 1=testnet, 2=regtest)
fn process_initialize(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.len() < 41 {
        return Err(ProgramError::InvalidInstructionData);
    }
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let light_client_info = &accounts[0];
    let payer = &accounts[1];
    let _system_program = &accounts[2];

    if !payer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Parse instruction data
    let start_height = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let mut start_block_hash = [0u8; 32];
    start_block_hash.copy_from_slice(&data[8..40]);
    let network = data[40];

    // Derive PDA and verify
    let (expected_pda, bump) = pinocchio::pubkey::find_program_address(
        &[LIGHT_CLIENT_SEED],
        program_id,
    );

    if light_client_info.key() != &expected_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // Create the account
    let bump_bytes = [bump];
    let signer_seeds: [Seed; 2] = [
        Seed::from(LIGHT_CLIENT_SEED),
        Seed::from(&bump_bytes),
    ];
    let signer = [Signer::from(&signer_seeds)];

    let rent = pinocchio::sysvars::rent::Rent::get()?;
    let lamports = rent.minimum_balance(BitcoinLightClient::LEN);

    CreateAccount {
        from: payer,
        to: light_client_info,
        lamports,
        space: BitcoinLightClient::LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&signer)?;

    // Initialize fields
    let mut lc_data = light_client_info.try_borrow_mut_data()?;
    lc_data[..BitcoinLightClient::LEN].fill(0);
    lc_data[0] = BTC_LIGHT_CLIENT_DISCRIMINATOR;

    let lc = unsafe { &mut *(lc_data.as_mut_ptr() as *mut BitcoinLightClient) };
    lc.bump = bump;
    lc.network = network;
    lc.authority.copy_from_slice(payer.key());
    lc.genesis_hash = start_block_hash;
    lc.tip_hash = start_block_hash;
    lc.set_tip_height(start_height);
    lc.set_finalized_height(if start_height > REQUIRED_CONFIRMATIONS {
        start_height - REQUIRED_CONFIRMATIONS
    } else {
        0
    });
    lc.set_header_count(0);

    let clock = Clock::get()?;
    lc.set_last_update(clock.unix_timestamp);

    // Calculate initial chainwork from a default bits value
    lc.total_chainwork = [0u8; 32];

    Ok(())
}

// =============================================================================
// SUBMIT_HEADER (disc=1)
// =============================================================================

/// Submit a new Bitcoin block header.
///
/// Instruction data (after discriminator):
///   [0-79]  raw_header     (80 bytes, raw Bitcoin block header)
///   [80-87] block_height   (u64 LE)
fn process_submit_header(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.len() < 88 {
        return Err(ProgramError::InvalidInstructionData);
    }
    if accounts.len() < 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let light_client_info = &accounts[0];
    let block_header_info = &accounts[1];
    let submitter = &accounts[2];
    let _system_program = &accounts[3];

    if !submitter.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Validate light client is owned by this program
    if light_client_info.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }

    // Parse instruction data
    let raw_header: &[u8; 80] = data[0..80].try_into().unwrap();
    let block_height = u64::from_le_bytes(data[80..88].try_into().unwrap());

    // Parse raw header fields
    let prev_block_hash: &[u8; 32] = data[4..36].try_into().unwrap();
    let bits = u32::from_le_bytes(data[72..76].try_into().unwrap());

    // Compute block hash = double_sha256(raw_header)
    let block_hash = double_sha256(raw_header);

    // Read light client state for validation
    let (expected_tip_hash, expected_height, network, lc_chainwork) = {
        let lc_data = light_client_info.try_borrow_data()?;
        if lc_data.len() < BitcoinLightClient::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if lc_data[0] != BTC_LIGHT_CLIENT_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        let lc = unsafe { &*(lc_data.as_ptr() as *const BitcoinLightClient) };
        let mut tip = [0u8; 32];
        tip.copy_from_slice(&lc.tip_hash);
        let mut cw = [0u8; 32];
        cw.copy_from_slice(&lc.total_chainwork);
        (tip, lc.tip_height(), lc.network, cw)
    };

    // Validate: prev_block_hash must equal current tip
    if *prev_block_hash != expected_tip_hash {
        return Err(ProgramError::InvalidArgument);
    }

    // Validate: height must be tip + 1
    if block_height != expected_height + 1 {
        return Err(ProgramError::InvalidArgument);
    }

    // Validate PoW (skip for testnet network=1 and regtest network=2)
    if network == 0 {
        let target = target_from_bits(bits);
        if !hash_meets_target(&block_hash, &target) {
            return Err(ProgramError::InvalidArgument);
        }
    }

    // Derive block header PDA
    let height_le = block_height.to_le_bytes();
    let (expected_header_pda, header_bump) = pinocchio::pubkey::find_program_address(
        &[BLOCK_HEADER_SEED, &height_le],
        program_id,
    );

    if block_header_info.key() != &expected_header_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // Create block header account
    let header_bump_bytes = [header_bump];
    let header_signer_seeds: [Seed; 3] = [
        Seed::from(BLOCK_HEADER_SEED),
        Seed::from(height_le.as_slice()),
        Seed::from(&header_bump_bytes),
    ];
    let header_signer = [Signer::from(&header_signer_seeds)];

    let rent = pinocchio::sysvars::rent::Rent::get()?;
    let lamports = rent.minimum_balance(BlockHeader::LEN);

    CreateAccount {
        from: submitter,
        to: block_header_info,
        lamports,
        space: BlockHeader::LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&header_signer)?;

    // Initialize block header
    {
        let mut header_data = block_header_info.try_borrow_mut_data()?;
        header_data[..BlockHeader::LEN].fill(0);
        header_data[0] = BLOCK_HEADER_DISCRIMINATOR;

        let header = unsafe { &mut *(header_data.as_mut_ptr() as *mut BlockHeader) };
        header.version.copy_from_slice(&raw_header[0..4]);
        header.prev_block_hash.copy_from_slice(&raw_header[4..36]);
        header.merkle_root.copy_from_slice(&raw_header[36..68]);
        header.timestamp.copy_from_slice(&raw_header[68..72]);
        header.bits.copy_from_slice(&raw_header[72..76]);
        header.nonce.copy_from_slice(&raw_header[76..80]);
        header.block_hash = block_hash;
        header.height = block_height.to_le_bytes();

        // Calculate and set chainwork
        let block_work = calculate_chainwork(bits);
        let new_chainwork = add_chainwork(&lc_chainwork, &block_work);
        header.chainwork = new_chainwork;

        let clock = Clock::get()?;
        header.submitted_at = clock.unix_timestamp.to_le_bytes();
    }

    // Update light client
    {
        let mut lc_data = light_client_info.try_borrow_mut_data()?;
        let lc = BitcoinLightClient::from_bytes_mut(&mut lc_data)?;

        lc.tip_hash = block_hash;
        lc.set_tip_height(block_height);
        lc.set_header_count(lc.header_count() + 1);

        // Update finalized height
        if block_height > REQUIRED_CONFIRMATIONS {
            lc.set_finalized_height(block_height - REQUIRED_CONFIRMATIONS);
        }

        // Update chainwork
        let block_work = calculate_chainwork(bits);
        lc.total_chainwork = add_chainwork(&lc_chainwork, &block_work);

        let clock = Clock::get()?;
        lc.set_last_update(clock.unix_timestamp);
    }

    Ok(())
}

// =============================================================================
// RESET_TIP (disc=2) — authority-only tip override
// =============================================================================

/// Reset the light client's tip hash and height.
/// Used to correct a bad genesis or jump to a new checkpoint.
///
/// Instruction data (after discriminator):
///   [0-7]   new_tip_height (u64 LE)
///   [8-39]  new_tip_hash   ([u8; 32])
///
/// Accounts:
///   0. light_client  (writable, owned by program)
///   1. authority      (signer, must match state.authority)
fn process_reset_tip(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.len() < 40 {
        return Err(ProgramError::InvalidInstructionData);
    }
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let light_client_info = &accounts[0];
    let authority_info = &accounts[1];

    if !authority_info.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    if light_client_info.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }

    let new_tip_height = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let mut new_tip_hash = [0u8; 32];
    new_tip_hash.copy_from_slice(&data[8..40]);

    // Reject all-zero hash
    if new_tip_hash == [0u8; 32] {
        return Err(ProgramError::InvalidArgument);
    }

    let mut lc_data = light_client_info.try_borrow_mut_data()?;
    let lc = BitcoinLightClient::from_bytes_mut(&mut lc_data)?;

    // Verify authority
    if lc.authority != *authority_info.key() {
        return Err(ProgramError::InvalidArgument);
    }

    lc.tip_hash = new_tip_hash;
    lc.set_tip_height(new_tip_height);

    if new_tip_height > REQUIRED_CONFIRMATIONS {
        lc.set_finalized_height(new_tip_height - REQUIRED_CONFIRMATIONS);
    } else {
        lc.set_finalized_height(0);
    }

    let clock = Clock::get()?;
    lc.set_last_update(clock.unix_timestamp);

    Ok(())
}
