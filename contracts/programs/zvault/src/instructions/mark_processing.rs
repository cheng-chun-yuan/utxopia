//! Mark processing instruction — transitions a redemption from Pending to Processing
//!
//! Called by the pool authority before FROST signing begins.
//! Records the current slot for timeout tracking — if the redemption stays
//! in Processing longer than REDEMPTION_TIMEOUT_SLOTS, the user can cancel it.

use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvars::{clock::Clock, Sysvar},
    ProgramResult,
};

use crate::error::ZVaultError;
use crate::state::{PoolState, RedemptionRequest, RedemptionStatus};
use crate::utils::validate_program_owner;

/// Process mark_processing instruction
///
/// # Accounts
/// 0. `[writable]` Pool state
/// 1. `[writable]` Redemption request
/// 2. `[signer]`   Authority (pool authority)
pub fn process_mark_processing(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let pool_state_info = &accounts[0];
    let redemption_info = &accounts[1];
    let authority = &accounts[2];

    // Validate signers
    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Validate account owners
    validate_program_owner(pool_state_info, program_id)?;
    validate_program_owner(redemption_info, program_id)?;

    // Validate authority matches pool
    {
        let pool_data = pool_state_info.try_borrow_data()?;
        let pool = PoolState::from_bytes(&pool_data)?;

        if authority.key().as_ref() != pool.authority {
            return Err(ZVaultError::Unauthorized.into());
        }
    }

    // Validate status is Pending and transition to Processing
    {
        let mut redemption_data = redemption_info.try_borrow_mut_data()?;
        let redemption = RedemptionRequest::from_bytes_mut(&mut redemption_data)?;

        if redemption.get_status() != RedemptionStatus::Pending {
            return Err(ZVaultError::InvalidRedemptionState.into());
        }

        redemption.set_status(RedemptionStatus::Processing);

        // Record the slot for timeout tracking
        let clock = Clock::get()?;
        redemption.set_processing_slot(clock.slot as u32);
    }

    Ok(())
}
