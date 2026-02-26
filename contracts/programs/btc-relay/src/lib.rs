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

/// Discriminator for VerifiedTransaction account
const VERIFIED_TX_DISCRIMINATOR: u8 = 0x08;

const LIGHT_CLIENT_SEED: &[u8] = b"btc_light_client";
const BLOCK_HEADER_SEED: &[u8] = b"block_header";
const VERIFIED_TX_SEED: &[u8] = b"verified_tx";

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
    expected_bits: [u8; 4],
    epoch_start_time: [u8; 4],
    _reserved: [u8; 56],
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

    fn from_bytes(data: &[u8]) -> Result<&Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[0] != BTC_LIGHT_CLIENT_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(unsafe { &*(data.as_ptr() as *const Self) })
    }

    fn tip_height(&self) -> u64 {
        u64::from_le_bytes(self.tip_height)
    }

    fn header_count(&self) -> u64 {
        u64::from_le_bytes(self.header_count)
    }

    fn expected_bits(&self) -> u32 {
        u32::from_le_bytes(self.expected_bits)
    }

    fn epoch_start_time(&self) -> u32 {
        u32::from_le_bytes(self.epoch_start_time)
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

    fn set_expected_bits(&mut self, value: u32) {
        self.expected_bits = value.to_le_bytes();
    }

    fn set_epoch_start_time(&mut self, value: u32) {
        self.epoch_start_time = value.to_le_bytes();
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

    fn height(&self) -> u64 {
        u64::from_le_bytes(self.height)
    }
}

/// Verified Transaction PDA — proves a Bitcoin tx exists in a confirmed block
/// PDA seeds: ["verified_tx", block_hash(32), txid(32)]
#[repr(C)]
struct VerifiedTransaction {
    discriminator: u8,
    bump: u8,
    _padding: [u8; 2],
    block_height: [u8; 4],
    block_hash: [u8; 32],
    txid: [u8; 32],
    verified_at: [u8; 8],
    tx_index: [u8; 4],
    _reserved: [u8; 4],
    _reserved2: [u8; 32],
}

impl VerifiedTransaction {
    const LEN: usize = core::mem::size_of::<Self>(); // 120 bytes
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

/// Calculate chainwork from difficulty bits: work = 2^256 / (target + 1)
/// Uses 4×u64 limb arithmetic for 256-bit division.
fn calculate_chainwork(bits: u32) -> [u8; 32] {
    let target = target_from_bits(bits);

    // target_plus_one = target + 1
    let mut target_plus_one = [0u8; 32];
    let mut carry: u16 = 1;
    for i in 0..32 {
        let sum = target[i] as u16 + carry;
        target_plus_one[i] = sum as u8;
        carry = sum >> 8;
    }

    // If target+1 is zero (overflow), return zero work
    if target_plus_one == [0u8; 32] {
        return [0u8; 32];
    }

    // Compute (~target) / (target + 1) to avoid 2^256 overflow
    // Since 2^256 / (target+1) = (~target / (target+1)) + 1 when target < 2^256 - 1
    let mut not_target = [0u8; 32];
    for i in 0..32 {
        not_target[i] = !target[i];
    }

    // 256-bit division: not_target / target_plus_one using 4×u64 limbs
    let dividend = u256_from_le_bytes(&not_target);
    let divisor = u256_from_le_bytes(&target_plus_one);
    let quotient = u256_div(dividend, divisor);

    // quotient + 1
    let result = u256_add(quotient, [1, 0, 0, 0]);
    u256_to_le_bytes(result)
}

// --- 256-bit arithmetic helpers (4×u64 limbs, little-endian) ---

fn u256_from_le_bytes(bytes: &[u8; 32]) -> [u64; 4] {
    [
        u64::from_le_bytes(bytes[0..8].try_into().unwrap()),
        u64::from_le_bytes(bytes[8..16].try_into().unwrap()),
        u64::from_le_bytes(bytes[16..24].try_into().unwrap()),
        u64::from_le_bytes(bytes[24..32].try_into().unwrap()),
    ]
}

fn u256_to_le_bytes(v: [u64; 4]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[0..8].copy_from_slice(&v[0].to_le_bytes());
    out[8..16].copy_from_slice(&v[1].to_le_bytes());
    out[16..24].copy_from_slice(&v[2].to_le_bytes());
    out[24..32].copy_from_slice(&v[3].to_le_bytes());
    out
}

fn u256_add(a: [u64; 4], b: [u64; 4]) -> [u64; 4] {
    let mut result = [0u64; 4];
    let mut carry = 0u64;
    for i in 0..4 {
        let (s1, c1) = a[i].overflowing_add(b[i]);
        let (s2, c2) = s1.overflowing_add(carry);
        result[i] = s2;
        carry = (c1 as u64) + (c2 as u64);
    }
    result
}

/// Compare a > b (strictly greater)
fn u256_gt_limbs(a: [u64; 4], b: [u64; 4]) -> bool {
    for i in (0..4).rev() {
        if a[i] > b[i] { return true; }
        if a[i] < b[i] { return false; }
    }
    false // equal
}

/// Compare a >= b
fn u256_gte(a: [u64; 4], b: [u64; 4]) -> bool {
    for i in (0..4).rev() {
        if a[i] > b[i] { return true; }
        if a[i] < b[i] { return false; }
    }
    true // equal
}

fn u256_sub(a: [u64; 4], b: [u64; 4]) -> [u64; 4] {
    let mut result = [0u64; 4];
    let mut borrow = 0u64;
    for i in 0..4 {
        let (s1, c1) = a[i].overflowing_sub(b[i]);
        let (s2, c2) = s1.overflowing_sub(borrow);
        result[i] = s2;
        borrow = (c1 as u64) + (c2 as u64);
    }
    result
}

fn u256_shl(v: [u64; 4], shift: u32) -> [u64; 4] {
    if shift >= 256 { return [0; 4]; }
    let limb_shift = (shift / 64) as usize;
    let bit_shift = shift % 64;
    let mut result = [0u64; 4];
    for i in limb_shift..4 {
        result[i] = v[i - limb_shift] << bit_shift;
        if bit_shift > 0 && i > limb_shift {
            result[i] |= v[i - limb_shift - 1] >> (64 - bit_shift);
        }
    }
    result
}

/// Count leading zeros of a 256-bit number
fn u256_clz(v: [u64; 4]) -> u32 {
    for i in (0..4).rev() {
        if v[i] != 0 {
            return (3 - i as u32) * 64 + v[i].leading_zeros();
        }
    }
    256
}

/// 256-bit division: a / b (returns quotient only)
fn u256_div(a: [u64; 4], b: [u64; 4]) -> [u64; 4] {
    if b == [0, 0, 0, 0] { return [0; 4]; }
    if !u256_gte(a, b) { return [0; 4]; }

    let a_clz = u256_clz(a);
    let b_clz = u256_clz(b);
    if b_clz < a_clz { return [0; 4]; }

    let shift_max = b_clz - a_clz;
    let mut remainder = a;
    let mut quotient = [0u64; 4];

    for s in (0..=shift_max).rev() {
        let shifted = u256_shl(b, s);
        if u256_gte(remainder, shifted) {
            remainder = u256_sub(remainder, shifted);
            // Set bit s in quotient
            let limb = (s / 64) as usize;
            let bit = s % 64;
            quotient[limb] |= 1u64 << bit;
        }
    }
    quotient
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
// Difficulty retarget constants (Bitcoin consensus)
// =============================================================================

/// Target timespan for difficulty adjustment (2 weeks in seconds)
const TARGET_TIMESPAN: u32 = 1_209_600;

/// Blocks per difficulty epoch
const BLOCKS_PER_EPOCH: u64 = 2016;

/// Maximum target (genesis difficulty) in compact bits format
const MAX_TARGET_BITS: u32 = 0x1d00ffff;

/// Calculate new difficulty bits after a retarget epoch.
/// Matches Bitcoin Core's GetNextWorkRequired algorithm.
fn calculate_new_bits(old_bits: u32, actual_timespan: u32) -> u32 {
    // Clamp timespan to [TARGET_TIMESPAN/4, TARGET_TIMESPAN*4]
    let clamped = if actual_timespan < TARGET_TIMESPAN / 4 {
        TARGET_TIMESPAN / 4
    } else if actual_timespan > TARGET_TIMESPAN * 4 {
        TARGET_TIMESPAN * 4
    } else {
        actual_timespan
    };

    // Expand old_bits to 256-bit target
    let old_target = target_from_bits(old_bits);
    let old_limbs = u256_from_le_bytes(&old_target);

    // new_target = old_target * clamped / TARGET_TIMESPAN
    // Multiply by clamped (fits in u32), then divide by TARGET_TIMESPAN
    let multiplied = u256_mul_u32(old_limbs, clamped);
    let new_target_limbs = u256_div_u32(multiplied, TARGET_TIMESPAN);
    let new_target = u256_to_le_bytes(new_target_limbs);

    // Cap at max target
    let max_target = target_from_bits(MAX_TARGET_BITS);
    let capped = if u256_gt_bytes(&new_target, &max_target) {
        max_target
    } else {
        new_target
    };

    // Re-encode to compact bits format
    bits_from_target(&capped)
}

/// Multiply 256-bit number by u32
fn u256_mul_u32(a: [u64; 4], b: u32) -> [u64; 4] {
    let b = b as u64;
    let mut result = [0u64; 4];
    let mut carry = 0u64;
    for i in 0..4 {
        let product = a[i] as u128 * b as u128 + carry as u128;
        result[i] = product as u64;
        carry = (product >> 64) as u64;
    }
    result
}

/// Divide 256-bit number by u32
fn u256_div_u32(a: [u64; 4], b: u32) -> [u64; 4] {
    let b = b as u64;
    let mut result = [0u64; 4];
    let mut remainder = 0u128;
    for i in (0..4).rev() {
        let dividend = (remainder << 64) | a[i] as u128;
        result[i] = (dividend / b as u128) as u64;
        remainder = dividend % b as u128;
    }
    result
}

/// Compare two 256-bit LE byte arrays: a > b
fn u256_gt_bytes(a: &[u8; 32], b: &[u8; 32]) -> bool {
    for i in (0..32).rev() {
        if a[i] > b[i] { return true; }
        if a[i] < b[i] { return false; }
    }
    false
}

/// Encode a 256-bit LE target back to compact bits format
fn bits_from_target(target: &[u8; 32]) -> u32 {
    // Find the highest non-zero byte
    let mut size = 32;
    while size > 0 && target[size - 1] == 0 {
        size -= 1;
    }
    if size == 0 {
        return 0;
    }

    let mut mantissa: u32;
    if size <= 3 {
        // Read up to 3 bytes from the beginning
        mantissa = 0;
        for i in (0..size).rev() {
            mantissa = (mantissa << 8) | target[i] as u32;
        }
        mantissa <<= 8 * (3 - size);
    } else {
        // Read the top 3 bytes
        mantissa = (target[size - 1] as u32) << 16
            | (target[size - 2] as u32) << 8
            | target[size - 3] as u32;
    }

    // If the sign bit (0x800000) is set, shift right and increase size
    if mantissa & 0x00800000 != 0 {
        mantissa >>= 8;
        size += 1;
    }

    (size as u32) << 24 | (mantissa & 0x007fffff)
}

// =============================================================================
// Required confirmations
// =============================================================================

const REQUIRED_CONFIRMATIONS: u64 = 6;

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
        3 => process_verify_transaction(program_id, accounts, &data[1..]),
        4 => process_reorg_header(program_id, accounts, &data[1..]),
        5 => process_close_block_header(program_id, accounts, &data[1..]),
        6 => process_reinitialize(program_id, accounts, &data[1..]),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

// =============================================================================
// INITIALIZE (disc=0)
// =============================================================================

/// Initialize the Bitcoin Light Client PDA.
///
/// Instruction data (after discriminator):
///   [0-7]   start_height       (u64 LE)
///   [8-39]  start_block_hash   ([u8; 32])
///   [40]    network            (u8: 0=mainnet, 1=testnet, 2=regtest)
///   [41-44] initial_bits       (u32 LE, optional — 0 to skip)
///   [45-48] epoch_start_time   (u32 LE, optional — 0 to skip)
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

    // Set initial difficulty params if provided
    if data.len() >= 49 {
        let initial_bits = u32::from_le_bytes(data[41..45].try_into().unwrap());
        let epoch_start = u32::from_le_bytes(data[45..49].try_into().unwrap());
        if initial_bits != 0 {
            lc.set_expected_bits(initial_bits);
        }
        if epoch_start != 0 {
            lc.set_epoch_start_time(epoch_start);
        }
    }

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
    let (expected_tip_hash, expected_height, network, lc_chainwork, lc_expected_bits, lc_epoch_start_time) = {
        let lc_data = light_client_info.try_borrow_data()?;
        let lc = BitcoinLightClient::from_bytes(&lc_data)?;
        let mut tip = [0u8; 32];
        tip.copy_from_slice(&lc.tip_hash);
        let mut cw = [0u8; 32];
        cw.copy_from_slice(&lc.total_chainwork);
        (tip, lc.tip_height(), lc.network, cw, lc.expected_bits(), lc.epoch_start_time())
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

        // Enforce expected difficulty (skip if not yet bootstrapped)
        if lc_expected_bits != 0 && bits != lc_expected_bits {
            return Err(ProgramError::InvalidArgument); // DifficultyMismatch
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

    // Check if block header PDA already exists (e.g., from a previous fork that was reorged)
    let account_exists = {
        let existing_data = block_header_info.try_borrow_data()?;
        !existing_data.is_empty()
            && existing_data.len() >= BlockHeader::LEN
            && existing_data[0] == BLOCK_HEADER_DISCRIMINATOR
    };

    if !account_exists {
        // Create block header account (normal path)
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
    }

    // Write block header data (same for both create and overwrite paths)
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

        // Difficulty retarget at epoch boundary (mainnet only)
        if network == 0 && block_height % BLOCKS_PER_EPOCH == 0 {
            let header_timestamp = u32::from_le_bytes(raw_header[68..72].try_into().unwrap());
            if lc_epoch_start_time != 0 && lc_expected_bits != 0 {
                let actual_timespan = header_timestamp.wrapping_sub(lc_epoch_start_time);
                let new_bits = calculate_new_bits(lc_expected_bits, actual_timespan);
                lc.set_expected_bits(new_bits);
            }
            lc.set_epoch_start_time(header_timestamp);
        }

        let clock = Clock::get()?;
        lc.set_last_update(clock.unix_timestamp);
    }

    Ok(())
}

// =============================================================================
// REORG_HEADER (disc=4) — overwrite block at height H if heavier fork
// =============================================================================

/// Overwrite an existing block header at height H with a new block from a heavier fork.
///
/// Instruction data (after discriminator):
///   [0-79]   raw_header    (80 bytes)
///   [80-87]  block_height  (u64 LE)
///
/// Accounts:
///   0. [writable]  BitcoinLightClient
///   1. [writable]  BlockHeader PDA at block_height (EXISTING — to overwrite)
///   2. []          BlockHeader PDA at block_height - 1 (parent — for chainwork)
///   3. [signer]    Submitter
fn process_reorg_header(
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
    let parent_header_info = &accounts[2];
    let submitter = &accounts[3];

    if !submitter.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    if light_client_info.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    if block_header_info.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    if parent_header_info.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }

    // Parse instruction data
    let raw_header: &[u8; 80] = data[0..80].try_into().unwrap();
    let block_height = u64::from_le_bytes(data[80..88].try_into().unwrap());
    let prev_block_hash: &[u8; 32] = data[4..36].try_into().unwrap();
    let bits = u32::from_le_bytes(data[72..76].try_into().unwrap());

    // Must not be height 0
    if block_height == 0 {
        return Err(ProgramError::InvalidArgument);
    }

    // Compute block hash
    let block_hash = double_sha256(raw_header);

    // Read network from light client
    let network = {
        let lc_data = light_client_info.try_borrow_data()?;
        let lc = BitcoinLightClient::from_bytes(&lc_data)?;
        lc.network
    };

    // Validate PoW (mainnet only)
    if network == 0 {
        let target = target_from_bits(bits);
        if !hash_meets_target(&block_hash, &target) {
            return Err(ProgramError::InvalidArgument);
        }
    }

    // Verify block header PDA at block_height
    let height_le = block_height.to_le_bytes();
    let (expected_header_pda, _) = pinocchio::pubkey::find_program_address(
        &[BLOCK_HEADER_SEED, &height_le],
        program_id,
    );
    if block_header_info.key() != &expected_header_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // Verify parent header PDA at block_height - 1
    let parent_height = block_height - 1;
    let parent_height_le = parent_height.to_le_bytes();
    let (expected_parent_pda, _) = pinocchio::pubkey::find_program_address(
        &[BLOCK_HEADER_SEED, &parent_height_le],
        program_id,
    );
    if parent_header_info.key() != &expected_parent_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // Read parent header: verify prev_block_hash links to parent, get parent chainwork
    let parent_chainwork = {
        let parent_data = parent_header_info.try_borrow_data()?;
        if parent_data.len() < BlockHeader::LEN || parent_data[0] != BLOCK_HEADER_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        let parent = unsafe { &*(parent_data.as_ptr() as *const BlockHeader) };
        if *prev_block_hash != parent.block_hash {
            return Err(ProgramError::InvalidArgument); // new block doesn't link to parent
        }
        let mut cw = [0u8; 32];
        cw.copy_from_slice(&parent.chainwork);
        cw
    };

    // Compute new chainwork
    let block_work = calculate_chainwork(bits);
    let new_chainwork = add_chainwork(&parent_chainwork, &block_work);

    // Read existing block's chainwork and verify new is strictly heavier
    {
        let existing_data = block_header_info.try_borrow_data()?;
        if existing_data.len() < BlockHeader::LEN || existing_data[0] != BLOCK_HEADER_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        let existing = unsafe { &*(existing_data.as_ptr() as *const BlockHeader) };
        let existing_cw = u256_from_le_bytes(&existing.chainwork);
        let new_cw = u256_from_le_bytes(&new_chainwork);
        // new_chainwork must be strictly greater
        if !u256_gt_limbs(new_cw, existing_cw) {
            return Err(ProgramError::InvalidArgument); // not heavier
        }
    }

    // Overwrite block header data in-place
    {
        let mut header_data = block_header_info.try_borrow_mut_data()?;
        let header = unsafe { &mut *(header_data.as_mut_ptr() as *mut BlockHeader) };
        header.version.copy_from_slice(&raw_header[0..4]);
        header.prev_block_hash.copy_from_slice(&raw_header[4..36]);
        header.merkle_root.copy_from_slice(&raw_header[36..68]);
        header.timestamp.copy_from_slice(&raw_header[68..72]);
        header.bits.copy_from_slice(&raw_header[72..76]);
        header.nonce.copy_from_slice(&raw_header[76..80]);
        header.block_hash = block_hash;
        header.height = block_height.to_le_bytes();
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
        lc.total_chainwork = new_chainwork;

        if block_height > REQUIRED_CONFIRMATIONS {
            lc.set_finalized_height(block_height - REQUIRED_CONFIRMATIONS);
        } else {
            lc.set_finalized_height(0);
        }

        let clock = Clock::get()?;
        lc.set_last_update(clock.unix_timestamp);
    }

    Ok(())
}

// =============================================================================
// RESET_TIP (disc=2) — authority-only tip override
// =============================================================================

/// Reset the light client's tip hash and height (rollback only).
/// The new tip must correspond to an existing BlockHeader PDA (passed as account).
/// New tip height must be ≤ current tip height (no forward jumps).
///
/// Instruction data (after discriminator):
///   [0-7]   new_tip_height      (u64 LE)
///   [8-39]  new_tip_hash        ([u8; 32])
///   [40-43] new_expected_bits    (u32 LE)
///   [44-47] new_epoch_start_time (u32 LE)
///
/// Accounts:
///   0. light_client   (writable, owned by program)
///   1. authority       (signer, must match state.authority)
///   2. block_header    (read-only, must be a valid BlockHeader PDA at new_tip_height)
fn process_reset_tip(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.len() < 48 {
        return Err(ProgramError::InvalidInstructionData);
    }
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let light_client_info = &accounts[0];
    let authority_info = &accounts[1];
    let block_header_info = &accounts[2];

    if !authority_info.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    if light_client_info.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }

    // Block header must also be owned by this program
    if block_header_info.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }

    let new_tip_height = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let mut new_tip_hash = [0u8; 32];
    new_tip_hash.copy_from_slice(&data[8..40]);
    let new_expected_bits = u32::from_le_bytes(data[40..44].try_into().unwrap());
    let new_epoch_start_time = u32::from_le_bytes(data[44..48].try_into().unwrap());

    // Reject all-zero hash
    if new_tip_hash == [0u8; 32] {
        return Err(ProgramError::InvalidArgument);
    }

    // Validate the block header PDA exists and matches
    {
        let height_le = new_tip_height.to_le_bytes();
        let (expected_header_pda, _) = pinocchio::pubkey::find_program_address(
            &[BLOCK_HEADER_SEED, &height_le],
            program_id,
        );
        if block_header_info.key() != &expected_header_pda {
            return Err(ProgramError::InvalidSeeds);
        }

        // Verify the block header data matches
        let header_data = block_header_info.try_borrow_data()?;
        if header_data.len() < BlockHeader::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if header_data[0] != BLOCK_HEADER_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        let header = unsafe { &*(header_data.as_ptr() as *const BlockHeader) };
        if header.block_hash != new_tip_hash {
            return Err(ProgramError::InvalidArgument);
        }
    }

    let mut lc_data = light_client_info.try_borrow_mut_data()?;
    let lc = BitcoinLightClient::from_bytes_mut(&mut lc_data)?;

    // Verify authority
    if lc.authority != *authority_info.key() {
        return Err(ProgramError::InvalidArgument);
    }

    // Rollback only — new tip must be ≤ current tip
    if new_tip_height > lc.tip_height() {
        return Err(ProgramError::InvalidArgument);
    }

    // Copy chainwork from the target block header
    {
        let header_data = block_header_info.try_borrow_data()?;
        let header = unsafe { &*(header_data.as_ptr() as *const BlockHeader) };
        lc.total_chainwork.copy_from_slice(&header.chainwork);
    }

    lc.tip_hash = new_tip_hash;
    lc.set_tip_height(new_tip_height);
    lc.set_expected_bits(new_expected_bits);
    lc.set_epoch_start_time(new_epoch_start_time);

    if new_tip_height > REQUIRED_CONFIRMATIONS {
        lc.set_finalized_height(new_tip_height - REQUIRED_CONFIRMATIONS);
    } else {
        lc.set_finalized_height(0);
    }

    let clock = Clock::get()?;
    lc.set_last_update(clock.unix_timestamp);

    Ok(())
}

// =============================================================================
// VERIFY_TRANSACTION (disc=3) — create VerifiedTransaction PDA
// =============================================================================

/// Double SHA256 pair for merkle proof verification
fn double_sha256_pair(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut combined = [0u8; 64];
    combined[0..32].copy_from_slice(left);
    combined[32..64].copy_from_slice(right);
    double_sha256(&combined)
}

/// Verify a Bitcoin transaction's inclusion in a confirmed block, creating a VerifiedTransaction PDA.
///
/// Instruction data (after discriminator):
///   [0-31]   txid         ([u8; 32])
///   [32-39]  block_height (u64 LE)
///   [40-43]  tx_size      (u32 LE)
///   [44+]    merkle_proof: [txid(32)][path_bits(4)][path_len(1)][tx_index(4)][siblings...]
///
/// Accounts:
///   0. [writable, PDA] VerifiedTransaction (to create)
///   1. []              BitcoinLightClient
///   2. []              BlockHeader at block_height
///   3. []              ChadBuffer (raw tx)
///   4. [signer, writable] Payer
///   5. []              System program
fn process_verify_transaction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.len() < 44 {
        return Err(ProgramError::InvalidInstructionData);
    }
    if accounts.len() < 6 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let verified_tx_info = &accounts[0];
    let light_client_info = &accounts[1];
    let block_header_info = &accounts[2];
    let tx_buffer_info = &accounts[3];
    let payer = &accounts[4];
    let _system_program = &accounts[5];

    if !payer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Validate ownership
    if light_client_info.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    if block_header_info.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }

    // Parse instruction data
    let mut txid = [0u8; 32];
    txid.copy_from_slice(&data[0..32]);
    let block_height = u64::from_le_bytes(data[32..40].try_into().unwrap());
    let tx_size = u32::from_le_bytes(data[40..44].try_into().unwrap());

    // Parse merkle proof from remaining data
    let proof_data = &data[44..];
    if proof_data.len() < 41 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut proof_txid = [0u8; 32];
    proof_txid.copy_from_slice(&proof_data[0..32]);
    let path_bits = u32::from_le_bytes(proof_data[32..36].try_into().unwrap());
    let path_len = proof_data[36];
    let tx_index = u32::from_le_bytes(proof_data[37..41].try_into().unwrap());

    if path_len as usize > 20 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let siblings_start = 41;
    let expected_proof_len = siblings_start + path_len as usize * 32;
    if proof_data.len() < expected_proof_len {
        return Err(ProgramError::InvalidInstructionData);
    }

    // Verify block header matches block_height
    let block_merkle_root = {
        let header_data = block_header_info.try_borrow_data()?;
        if header_data.len() < BlockHeader::LEN || header_data[0] != BLOCK_HEADER_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        let header = unsafe { &*(header_data.as_ptr() as *const BlockHeader) };
        if header.height() != block_height {
            return Err(ProgramError::InvalidArgument);
        }

        // Also get block_hash for PDA derivation
        let mut merkle_root = [0u8; 32];
        merkle_root.copy_from_slice(&header.merkle_root);
        let mut block_hash = [0u8; 32];
        block_hash.copy_from_slice(&header.block_hash);
        (merkle_root, block_hash)
    };

    // Verify sufficient confirmations
    {
        let lc_data = light_client_info.try_borrow_data()?;
        let lc = BitcoinLightClient::from_bytes(&lc_data)?;
        let tip = lc.tip_height();
        let confirmations = if block_height > tip { 0 } else { tip - block_height + 1 };
        if confirmations < REQUIRED_CONFIRMATIONS {
            return Err(ProgramError::InvalidArgument);
        }
    }

    // Read raw tx from ChadBuffer and verify hash
    {
        let buffer_data = tx_buffer_info.try_borrow_data()
            .map_err(|_| ProgramError::InvalidAccountData)?;
        // ChadBuffer format: 32-byte authority pubkey header, then data
        if buffer_data.len() < 32 + tx_size as usize {
            return Err(ProgramError::InvalidAccountData);
        }
        let raw_tx = &buffer_data[32..32 + tx_size as usize];
        let computed_hash = double_sha256(raw_tx);
        if computed_hash != txid {
            return Err(ProgramError::InvalidArgument);
        }
    }

    // Verify merkle proof
    if proof_txid != txid {
        return Err(ProgramError::InvalidArgument);
    }
    {
        let mut current = txid;
        for i in 0..path_len as usize {
            let sibling_offset = siblings_start + i * 32;
            let mut sibling = [0u8; 32];
            sibling.copy_from_slice(&proof_data[sibling_offset..sibling_offset + 32]);
            let is_right = (path_bits >> i) & 1 == 1;
            current = if is_right {
                double_sha256_pair(&sibling, &current)
            } else {
                double_sha256_pair(&current, &sibling)
            };
        }
        if current != block_merkle_root.0 {
            return Err(ProgramError::InvalidArgument);
        }
    }

    // Derive VerifiedTransaction PDA
    let (expected_pda, bump) = pinocchio::pubkey::find_program_address(
        &[VERIFIED_TX_SEED, &block_merkle_root.1, &txid],
        program_id,
    );
    if verified_tx_info.key() != &expected_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // Idempotent: if already exists, return Ok
    {
        let existing_data = verified_tx_info.try_borrow_data()?;
        if !existing_data.is_empty() && existing_data[0] == VERIFIED_TX_DISCRIMINATOR {
            return Ok(());
        }
    }

    // Create the VerifiedTransaction account
    let bump_bytes = [bump];
    let signer_seeds: [Seed; 4] = [
        Seed::from(VERIFIED_TX_SEED),
        Seed::from(block_merkle_root.1.as_slice()),
        Seed::from(txid.as_slice()),
        Seed::from(&bump_bytes),
    ];
    let signer = [Signer::from(&signer_seeds)];

    let rent = pinocchio::sysvars::rent::Rent::get()?;
    let lamports = rent.minimum_balance(VerifiedTransaction::LEN);

    CreateAccount {
        from: payer,
        to: verified_tx_info,
        lamports,
        space: VerifiedTransaction::LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&signer)?;

    // Initialize
    {
        let mut vt_data = verified_tx_info.try_borrow_mut_data()?;
        vt_data[..VerifiedTransaction::LEN].fill(0);
        vt_data[0] = VERIFIED_TX_DISCRIMINATOR;

        let vt = unsafe { &mut *(vt_data.as_mut_ptr() as *mut VerifiedTransaction) };
        vt.bump = bump;
        vt.block_height = (block_height as u32).to_le_bytes();
        vt.block_hash = block_merkle_root.1;
        vt.txid = txid;
        vt.tx_index = tx_index.to_le_bytes();

        let clock = Clock::get()?;
        vt.verified_at = clock.unix_timestamp.to_le_bytes();
    }

    Ok(())
}

// =============================================================================
// CLOSE_BLOCK_HEADER (disc=5) — reclaim rent from orphaned headers
// =============================================================================

/// Close a block header PDA above the current tip to reclaim rent.
/// Only the authority can close headers, and only those above tip_height.
///
/// Instruction data (after discriminator):
///   [0-7]  height  (u64 LE)
///
/// Accounts:
///   0. []          BitcoinLightClient (read-only)
///   1. [writable]  BlockHeader PDA to close
///   2. [signer]    Authority (must match light client authority)
///   3. [writable]  Rent receiver
fn process_close_block_header(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    if accounts.len() < 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let light_client_info = &accounts[0];
    let block_header_info = &accounts[1];
    let authority_info = &accounts[2];
    let rent_receiver = &accounts[3];

    if !authority_info.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    if light_client_info.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    if block_header_info.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }

    let height = u64::from_le_bytes(data[0..8].try_into().unwrap());

    // Verify authority and tip height
    let tip_height = {
        let lc_data = light_client_info.try_borrow_data()?;
        let lc = BitcoinLightClient::from_bytes(&lc_data)?;
        if lc.authority != *authority_info.key() {
            return Err(ProgramError::InvalidArgument);
        }
        lc.tip_height()
    };

    // Can only close headers ABOVE current tip (orphaned blocks)
    if height <= tip_height {
        return Err(ProgramError::InvalidArgument);
    }

    // Verify BlockHeader PDA matches expected derivation
    let height_le = height.to_le_bytes();
    let (expected_pda, _) = pinocchio::pubkey::find_program_address(
        &[BLOCK_HEADER_SEED, &height_le],
        program_id,
    );
    if block_header_info.key() != &expected_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // Close the account: transfer lamports to receiver
    let account_lamports = block_header_info.lamports();
    unsafe {
        *block_header_info.borrow_mut_lamports_unchecked() = 0;
        *rent_receiver.borrow_mut_lamports_unchecked() = rent_receiver
            .lamports()
            .wrapping_add(account_lamports);
    }

    // Zero account data
    {
        let mut header_data = block_header_info.try_borrow_mut_data()?;
        header_data.fill(0);
    }

    // Assign to system program (all-zero pubkey)
    unsafe { block_header_info.assign(&[0u8; 32]) };

    Ok(())
}

// =============================================================================
// REINITIALIZE (disc=6) — authority-only reset to a new chain
// =============================================================================

/// Reinitialize the light client to track a different chain/height.
/// Authority-only. Resets all state fields without closing/recreating the PDA.
///
/// Instruction data (after discriminator):
///   [0-7]   start_height       (u64 LE)
///   [8-39]  start_block_hash   ([u8; 32])
///   [40]    network            (u8: 0=mainnet, 1=testnet, 2=regtest)
///   [41-44] initial_bits       (u32 LE, optional — 0 to skip)
///   [45-48] epoch_start_time   (u32 LE, optional — 0 to skip)
///
/// Accounts:
///   0. [writable]  BitcoinLightClient
///   1. [signer]    Authority (must match current authority)
fn process_reinitialize(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.len() < 41 {
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

    // Verify caller is the current authority
    {
        let lc_data = light_client_info.try_borrow_data()?;
        let lc = BitcoinLightClient::from_bytes(&lc_data)?;
        if lc.authority != *authority_info.key() {
            return Err(ProgramError::InvalidArgument);
        }
    }

    let start_height = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let mut start_block_hash = [0u8; 32];
    start_block_hash.copy_from_slice(&data[8..40]);
    let network = data[40];

    // Reset all fields
    let mut lc_data = light_client_info.try_borrow_mut_data()?;
    let lc = BitcoinLightClient::from_bytes_mut(&mut lc_data)?;

    lc.network = network;
    lc.paused = 0;
    lc.genesis_hash = start_block_hash;
    lc.tip_hash = start_block_hash;
    lc.total_chainwork = [0u8; 32];
    lc.set_tip_height(start_height);
    lc.set_finalized_height(if start_height > REQUIRED_CONFIRMATIONS {
        start_height - REQUIRED_CONFIRMATIONS
    } else {
        0
    });
    lc.set_header_count(0);
    lc.set_expected_bits(0);
    lc.set_epoch_start_time(0);

    // Set initial difficulty params if provided
    if data.len() >= 49 {
        let initial_bits = u32::from_le_bytes(data[41..45].try_into().unwrap());
        let epoch_start = u32::from_le_bytes(data[45..49].try_into().unwrap());
        if initial_bits != 0 {
            lc.set_expected_bits(initial_bits);
        }
        if epoch_start != 0 {
            lc.set_epoch_start_time(epoch_start);
        }
    }

    let clock = Clock::get()?;
    lc.set_last_update(clock.unix_timestamp);

    Ok(())
}

