use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

use crate::constants::BLOCK_HEADER_SEED;
use crate::state::BitcoinLightClient;

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
pub fn process_close_block_header(
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
