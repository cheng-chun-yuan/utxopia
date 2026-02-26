use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
    sysvars::{clock::Clock, Sysvar},
};

use crate::constants::{
    BLOCK_HEADER_DISCRIMINATOR, BLOCK_HEADER_SEED, REQUIRED_CONFIRMATIONS,
};
use crate::state::{BitcoinLightClient, BlockHeader};

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
pub fn process_reset_tip(
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
