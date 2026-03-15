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

use crate::error::AegisError;
use crate::state::{PoolState, RedemptionRequest, RedemptionStatus};
use crate::utils::{validate_program_owner, validate_account_writable};

/// Process mark_processing instruction
///
/// # Instruction Data
/// - total_input_sats: 8 bytes (u64 LE) — sum of BTC input UTXOs for the withdrawal tx.
///   Set by the backend after selecting UTXOs but before FROST signing.
///   Used by complete_redemption to trustlessly compute miner_fee = total_inputs - sum(outputs).
///   Pass 0 if unknown (backward compat — complete_redemption will fall back).
///
/// # Accounts
/// 0. `[writable]` Pool state
/// 1. `[writable]` Redemption request
/// 2. `[signer]`   Authority (pool authority)
pub fn process_mark_processing(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
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

    // Validate account owners and writable
    validate_program_owner(pool_state_info, program_id)?;
    validate_program_owner(redemption_info, program_id)?;
    validate_account_writable(redemption_info)?;

    // Validate authority matches pool
    {
        let pool_data = pool_state_info.try_borrow_data()?;
        let pool = PoolState::from_bytes(&pool_data)?;

        if authority.key().as_ref() != pool.authority {
            return Err(AegisError::Unauthorized.into());
        }
    }

    // Validate status is Pending and transition to Processing
    {
        let mut redemption_data = redemption_info.try_borrow_mut_data()?;
        let redemption = RedemptionRequest::from_bytes_mut(&mut redemption_data)?;

        if redemption.get_status() != RedemptionStatus::Pending {
            return Err(AegisError::InvalidRedemptionState.into());
        }

        redemption.set_status(RedemptionStatus::Processing);

        // Record the slot for timeout tracking
        let clock = Clock::get()?;
        let slot = clock.slot as u32;
        redemption.set_processing_slot(slot);

        // Store total_input_sats from instruction data (0 if not provided)
        let total_input_sats = if data.len() >= 8 {
            u64::from_le_bytes(data[0..8].try_into().unwrap())
        } else {
            0
        };
        redemption.set_total_input_sats(total_input_sats);

        // Emit processing event
        let requester: &[u8; 32] = &redemption.requester;
        crate::utils::events::emit_redemption_processing(
            requester,
            redemption.amount_sats(),
            redemption.request_id(),
            slot,
        );
    }

    pinocchio::msg!("Aegis: redemption processing");
    Ok(())
}
