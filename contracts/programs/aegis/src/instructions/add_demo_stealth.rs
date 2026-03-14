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
//! 5. Stealth announcement emitted as sol_log_data event (type=0, plaintext amount)
//! 6. User scans announcements with viewing key to detect deposits

use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

use crate::error::AegisError;
use crate::state::{CommitmentTree, PoolState};
use crate::utils::events::ANNOUNCEMENT_TYPE_DEPOSIT;
use crate::utils::{mint_zkbtc, validate_program_owner, validate_system_program, validate_token_2022_owner, validate_token_program_key, compute_deposit_commitment};

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
/// Also mints zkBTC to pool vault so users can claim.
///
/// Accounts:
/// 0. pool_state - Pool state PDA (writable)
/// 1. commitment_tree - Commitment tree PDA (writable)
/// 2. authority - Pool authority (signer, pays for announcement)
/// 3. system_program - System program
/// 4. zkbtc_mint - zkBTC Token-2022 mint (writable)
/// 5. pool_vault - Pool vault token account (writable)
/// 6. token_program - Token-2022 program
pub fn process_add_demo_stealth(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 7 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let pool_state = &accounts[0];
    let commitment_tree = &accounts[1];
    let authority = &accounts[2];
    let system_program = &accounts[3];
    let zkbtc_mint = &accounts[4];
    let pool_vault = &accounts[5];
    let token_program = &accounts[6];

    let ix_data = AddDemoStealthData::from_bytes(data)?;

    // Validate authority is signer
    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Validate amount is positive
    if ix_data.amount_sats == 0 {
        return Err(ProgramError::InvalidInstructionData);
    }

    // Compute commitment on-chain: Poseidon(npk, ZKBTC_TOKEN_ID, amount_sats)
    let commitment = compute_deposit_commitment(&ix_data.npk, ix_data.amount_sats)?;

    // Validate account owners
    validate_program_owner(pool_state, program_id)?;
    validate_program_owner(commitment_tree, program_id)?;
    validate_token_2022_owner(zkbtc_mint)?;
    validate_token_2022_owner(pool_vault)?;
    validate_token_program_key(token_program)?;
    validate_system_program(system_program)?;

    // Validate authority matches pool and get bump
    let pool_bump = {
        let pool_data = pool_state.try_borrow_data()?;
        let pool = PoolState::from_bytes(&pool_data)?;

        if authority.key().as_ref() != pool.authority {
            return Err(AegisError::Unauthorized.into());
        }
        pool.bump
    };

    let clock = Clock::get()?;

    // Insert commitment into Merkle tree
    let leaf_index = {
        let mut tree_data = commitment_tree.try_borrow_mut_data()?;
        let tree = CommitmentTree::from_bytes_mut(&mut tree_data)?;

        if !tree.has_capacity() {
            return Err(AegisError::TreeFull.into());
        }

        tree.insert_leaf(&commitment)?
    };

    // Emit stealth announcement as log event (LeafInserted merged into announcement)
    let amount_bytes = ix_data.amount_sats.to_le_bytes();
    crate::utils::events::emit_stealth_announcement(
        ANNOUNCEMENT_TYPE_DEPOSIT,
        &ix_data.ephemeral_pub,
        &amount_bytes,
        &commitment,
        leaf_index as u32,
    );

    // Mint zkBTC to pool vault so users can claim
    let bump_bytes = [pool_bump];
    let pool_signer_seeds: &[&[u8]] = &[PoolState::SEED, &bump_bytes];

    mint_zkbtc(
        token_program,
        zkbtc_mint,
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

    pinocchio::msg!("Aegis: demo deposit added");

    Ok(())
}
