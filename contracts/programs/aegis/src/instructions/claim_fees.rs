//! Claim accumulated protocol fees from the pool vault.
//!
//! Authority-only instruction that transfers fee_pool tokens from the
//! pool vault to a specified recipient token account, then resets fee_pool to 0.
//!
//! # Accounts
//! 0. `[writable]` Pool state PDA
//! 1. `[signer]`   Authority (must match pool.authority)
//! 2. `[writable]` Pool vault (source token account, owned by pool PDA)
//! 3. `[writable]` Recipient token account (destination for fees)
//! 4. `[]`         Token-2022 program

use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    ProgramResult,
};

use crate::error::AegisError;
use crate::state::PoolState;
use crate::utils::{
    transfer_zkbtc,
    validate_account_writable, validate_program_owner,
    validate_token_2022_owner, validate_token_program_key,
};

/// Process claim_fees instruction
///
/// Transfers all accumulated fee_pool tokens from vault to recipient,
/// then zeros out the fee_pool counter.
pub fn process_claim_fees(
    program_id: &pinocchio::pubkey::Pubkey,
    accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    if accounts.len() < 5 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let pool_state_info = &accounts[0];
    let authority = &accounts[1];
    let pool_vault = &accounts[2];
    let recipient = &accounts[3];
    let token_program = &accounts[4];

    // Validate signer
    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Validate account owners
    validate_program_owner(pool_state_info, program_id)?;
    validate_token_2022_owner(pool_vault)?;
    validate_token_2022_owner(recipient)?;
    validate_token_program_key(token_program)?;
    validate_account_writable(pool_state_info)?;
    validate_account_writable(pool_vault)?;
    validate_account_writable(recipient)?;

    // Read pool state, validate authority, get fee amount and bump
    let (fee_amount, pool_bump) = {
        let pool_data = pool_state_info.try_borrow_data()?;
        let pool = PoolState::from_bytes(&pool_data)?;

        if authority.key().as_ref() != pool.authority {
            return Err(AegisError::Unauthorized.into());
        }

        let fee = pool.fee_pool();
        if fee == 0 {
            pinocchio::msg!("Aegis: no fees to claim");
            return Ok(());
        }

        (fee, pool.bump)
    };

    // Transfer fee tokens from vault to recipient (signed by pool PDA)
    let bump_bytes = [pool_bump];
    let pool_signer_seeds: &[&[u8]] = &[PoolState::SEED, &bump_bytes];

    transfer_zkbtc(
        token_program,
        pool_vault,
        recipient,
        pool_state_info,
        fee_amount,
        pool_signer_seeds,
    )?;

    // Reset fee_pool to 0
    {
        let mut pool_data = pool_state_info.try_borrow_mut_data()?;
        let pool = PoolState::from_bytes_mut(&mut pool_data)?;
        pool.set_fee_pool(0);
    }

    pinocchio::msg!("Aegis: claimed fees");
    Ok(())
}
