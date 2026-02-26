use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
    sysvars::{clock::Clock, Sysvar},
};

use crate::constants::REQUIRED_CONFIRMATIONS;
use crate::state::BitcoinLightClient;

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
pub fn process_reinitialize(
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
