//! Complete redemption instruction - marks redemption as complete after BTC send

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

/// Complete redemption instruction data
pub struct CompleteRedemptionData {
    pub btc_txid: [u8; 64], // Hex string
    pub btc_txid_len: u8,
}

impl CompleteRedemptionData {
    pub fn from_bytes(data: &[u8]) -> Result<Self, ProgramError> {
        if data.is_empty() {
            return Err(ProgramError::InvalidInstructionData);
        }

        let btc_txid_len = data[0];
        if btc_txid_len as usize > 64 {
            return Err(ProgramError::InvalidInstructionData);
        }

        let txid_end = 1 + btc_txid_len as usize;
        if data.len() < txid_end {
            return Err(ProgramError::InvalidInstructionData);
        }

        let mut btc_txid = [0u8; 64];
        btc_txid[..btc_txid_len as usize].copy_from_slice(&data[1..txid_end]);

        Ok(Self {
            btc_txid,
            btc_txid_len,
        })
    }
}

/// Complete redemption accounts
pub struct CompleteRedemptionAccounts<'a> {
    pub pool_state: &'a AccountInfo,
    pub redemption_request: &'a AccountInfo,
    pub authority: &'a AccountInfo,
}

impl<'a> CompleteRedemptionAccounts<'a> {
    pub fn from_accounts(accounts: &'a [AccountInfo]) -> Result<Self, ProgramError> {
        if accounts.len() < 3 {
            return Err(ProgramError::NotEnoughAccountKeys);
        }

        let pool_state = &accounts[0];
        let redemption_request = &accounts[1];
        let authority = &accounts[2];

        // Validate authority is signer
        if !authority.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        Ok(Self {
            pool_state,
            redemption_request,
            authority,
        })
    }
}

/// Process complete redemption
pub fn process_complete_redemption(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let accounts = CompleteRedemptionAccounts::from_accounts(accounts)?;
    let ix_data = CompleteRedemptionData::from_bytes(data)?;

    // SECURITY: Validate account owners BEFORE deserializing any data
    validate_program_owner(accounts.pool_state, program_id)?;
    validate_program_owner(accounts.redemption_request, program_id)?;

    // Load and validate pool state
    let (pool_authority, pending_redemptions) = {
        let pool_data = accounts.pool_state.try_borrow_data()?;
        let pool = PoolState::from_bytes(&pool_data)?;

        (pool.authority, pool.pending_redemptions())
    };

    // Validate authority
    if accounts.authority.key().as_ref() != pool_authority {
        return Err(ZVaultError::Unauthorized.into());
    }

    // Validate redemption request state
    {
        let redemption_data = accounts.redemption_request.try_borrow_data()?;
        let redemption = RedemptionRequest::from_bytes(&redemption_data)?;

        let status = redemption.get_status();
        if status == RedemptionStatus::Completed {
            return Err(ZVaultError::RedemptionAlreadyCompleted.into());
        }
        if status != RedemptionStatus::Pending && status != RedemptionStatus::Processing {
            return Err(ZVaultError::InvalidRedemptionState.into());
        }
    }

    // Get clock for timestamp
    let clock = Clock::get()?;

    // Update redemption request
    {
        let mut redemption_data = accounts.redemption_request.try_borrow_mut_data()?;
        let redemption = RedemptionRequest::from_bytes_mut(&mut redemption_data)?;

        redemption.set_btc_txid(&ix_data.btc_txid[..ix_data.btc_txid_len as usize])?;
        redemption.set_status(RedemptionStatus::Completed);
        redemption.set_completed_at(clock.unix_timestamp);
    }

    // Update pool state
    {
        let mut pool_data = accounts.pool_state.try_borrow_mut_data()?;
        let pool = PoolState::from_bytes_mut(&mut pool_data)?;

        pool.set_pending_redemptions(pending_redemptions.saturating_sub(1));
        pool.set_last_update(clock.unix_timestamp);
    }

    Ok(())
}
