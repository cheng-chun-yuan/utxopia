//! Add Demo Stealth instruction (Admin only)
//!
//! Creates a stealth deposit for demo purposes without requiring real BTC.
//! Works exactly like verify_stealth_deposit but skips SPV verification.
//!
//! npk-based flow (matches real deposits):
//! 1. SDK generates Ed25519 ephemeral keypair + derives npk
//! 2. Client sends ephemeralPub(32) + npk(32) + amount_sats(u64)
//! 3. This instruction computes commitment ON-CHAIN: Poseidon(npk, token, amount)
//! 4. Commitment is inserted into Merkle tree
//! 5. StealthAnnouncement created with type=DEPOSIT (plaintext amount)
//! 6. User scans announcements with viewing key to detect deposits

use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::{find_program_address, Pubkey},
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};

use crate::error::ZVaultError;
use crate::state::{CommitmentTree, PoolState, StealthAnnouncement, STEALTH_ANNOUNCEMENT_DISCRIMINATOR};
use crate::utils::{mint_zbtc, validate_program_owner, validate_system_program, validate_token_2022_owner, validate_token_program_key, create_pda_account, compute_deposit_commitment};

/// Add demo stealth instruction data (npk-based, matches real deposits)
///
/// Layout:
/// - ephemeral_pub: [u8; 32] (Ed25519)
/// - npk: [u8; 32] (note public key, big-endian BN254 field element)
/// - amount_sats: u64 (little-endian)
///
/// Total: 72 bytes
pub struct AddDemoStealthData {
    pub ephemeral_pub: [u8; 32],
    pub npk: [u8; 32],
    pub amount_sats: u64,
}

impl AddDemoStealthData {
    pub fn from_bytes(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < 72 {
            return Err(ProgramError::InvalidInstructionData);
        }

        let mut ephemeral_pub = [0u8; 32];
        ephemeral_pub.copy_from_slice(&data[0..32]);

        let mut npk = [0u8; 32];
        npk.copy_from_slice(&data[32..64]);

        let amount_sats = u64::from_le_bytes(
            data[64..72].try_into().map_err(|_| ProgramError::InvalidInstructionData)?
        );

        Ok(Self {
            ephemeral_pub,
            npk,
            amount_sats,
        })
    }
}

/// Add a demo stealth deposit (admin only)
///
/// Creates a private deposit that user can find with viewing key
/// and spend with spending key. No real BTC required.
/// Also mints zBTC to pool vault so users can claim.
///
/// Accounts:
/// 0. pool_state - Pool state PDA (writable)
/// 1. commitment_tree - Commitment tree PDA (writable)
/// 2. stealth_announcement - Stealth announcement PDA (to create, writable)
/// 3. authority - Pool authority (signer, pays for announcement)
/// 4. system_program - System program
/// 5. zbtc_mint - zBTC Token-2022 mint (writable)
/// 6. pool_vault - Pool vault token account (writable)
/// 7. token_program - Token-2022 program
pub fn process_add_demo_stealth(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 8 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let pool_state = &accounts[0];
    let commitment_tree = &accounts[1];
    let stealth_announcement = &accounts[2];
    let authority = &accounts[3];
    let system_program = &accounts[4];
    let zbtc_mint = &accounts[5];
    let pool_vault = &accounts[6];
    let token_program = &accounts[7];

    let ix_data = AddDemoStealthData::from_bytes(data)?;

    // Validate authority is signer
    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Validate amount is positive
    if ix_data.amount_sats == 0 {
        return Err(ProgramError::InvalidInstructionData);
    }

    // Compute commitment on-chain: Poseidon(npk, ZBTC_TOKEN_ID, amount_sats)
    let commitment = compute_deposit_commitment(&ix_data.npk, ix_data.amount_sats)?;

    // Validate account owners
    validate_program_owner(pool_state, program_id)?;
    validate_program_owner(commitment_tree, program_id)?;
    validate_token_2022_owner(zbtc_mint)?;
    validate_token_2022_owner(pool_vault)?;
    validate_token_program_key(token_program)?;
    validate_system_program(system_program)?;

    // Validate authority matches pool and get bump
    let pool_bump = {
        let pool_data = pool_state.try_borrow_data()?;
        let pool = PoolState::from_bytes(&pool_data)?;

        if authority.key().as_ref() != pool.authority {
            return Err(ZVaultError::Unauthorized.into());
        }
        pool.bump
    };

    // Verify stealth announcement PDA
    // Ed25519 ephemeral pub is already 32 bytes, use directly as PDA seed
    let seeds: &[&[u8]] = &[StealthAnnouncement::SEED, &ix_data.ephemeral_pub];
    let (expected_pda, bump) = find_program_address(seeds, program_id);
    if stealth_announcement.key() != &expected_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    let clock = Clock::get()?;

    // Insert commitment into Merkle tree
    let leaf_index = {
        let mut tree_data = commitment_tree.try_borrow_mut_data()?;
        let tree = CommitmentTree::from_bytes_mut(&mut tree_data)?;

        if !tree.has_capacity() {
            return Err(ZVaultError::TreeFull.into());
        }

        tree.insert_leaf(&commitment)?
    };

    // Create stealth announcement PDA if it doesn't exist
    let account_data_len = stealth_announcement.data_len();
    if account_data_len > 0 {
        let ann_data = stealth_announcement.try_borrow_data()?;
        if ann_data[0] == STEALTH_ANNOUNCEMENT_DISCRIMINATOR {
            return Err(ProgramError::AccountAlreadyInitialized);
        }
    } else {
        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(StealthAnnouncement::SIZE);

        let bump_bytes = [bump];
        let signer_seeds: &[&[u8]] = &[
            StealthAnnouncement::SEED,
            &ix_data.ephemeral_pub,
            &bump_bytes,
        ];

        create_pda_account(
            authority,
            stealth_announcement,
            program_id,
            lamports,
            StealthAnnouncement::SIZE as u64,
            signer_seeds,
        )?;
    }

    // Initialize stealth announcement
    {
        let mut ann_data = stealth_announcement.try_borrow_mut_data()?;
        let announcement = StealthAnnouncement::init(&mut ann_data)?;

        announcement.announcement_type = crate::state::ANNOUNCEMENT_TYPE_DEPOSIT;
        announcement.ephemeral_pub = ix_data.ephemeral_pub;
        // Store plaintext amount (type=0 deposit, not XOR-encrypted)
        announcement.set_amount_sats(ix_data.amount_sats);
        announcement.commitment = commitment;
        announcement.set_leaf_index(leaf_index);
        announcement.set_created_at(clock.unix_timestamp);
    }

    // Mint zBTC to pool vault so users can claim
    let bump_bytes = [pool_bump];
    let pool_signer_seeds: &[&[u8]] = &[PoolState::SEED, &bump_bytes];

    mint_zbtc(
        token_program,
        zbtc_mint,
        pool_vault,
        pool_state,
        ix_data.amount_sats,
        pool_signer_seeds,
    )?;

    // Update pool statistics
    {
        let mut pool_data = pool_state.try_borrow_mut_data()?;
        let pool = PoolState::from_bytes_mut(&mut pool_data)?;

        pool.increment_deposit_count()?;
        pool.add_minted(ix_data.amount_sats)?;
        pool.add_shielded(ix_data.amount_sats)?;
        pool.set_last_update(clock.unix_timestamp);
    }

    crate::debug_msg!("Demo stealth deposit added");

    Ok(())
}
