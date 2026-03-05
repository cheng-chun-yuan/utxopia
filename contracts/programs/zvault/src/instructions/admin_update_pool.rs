//! Admin Update Pool — Allows pool authority to update min/max deposit bounds.
//!
//! Instruction data: min_deposit(u64 LE) + max_deposit(u64 LE) = 16 bytes
//!
//! Accounts:
//!   0. [writable] Pool state
//!   1. [signer] Authority (must match pool.authority)

use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

use crate::error::AegisError;
use crate::state::PoolState;
use crate::utils::{validate_program_owner, validate_account_writable};

pub fn process_admin_update_pool(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < 16 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let pool_state_info = &accounts[0];
    let authority = &accounts[1];

    validate_program_owner(pool_state_info, program_id)?;
    validate_account_writable(pool_state_info)?;

    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let min_deposit = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let max_deposit = u64::from_le_bytes(data[8..16].try_into().unwrap());

    let mut pool_data = pool_state_info.try_borrow_mut_data()?;
    let pool = PoolState::from_bytes_mut(&mut pool_data)?;

    if authority.key().as_ref() != pool.authority {
        return Err(AegisError::Unauthorized.into());
    }

    pool.set_min_deposit(min_deposit);
    pool.set_max_deposit(max_deposit);

    Ok(())
}
