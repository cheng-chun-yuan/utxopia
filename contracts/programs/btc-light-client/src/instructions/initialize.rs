use pinocchio::{
    account_info::AccountInfo,
    instruction::{Seed, Signer},
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
    sysvars::{clock::Clock, Sysvar},
};
use pinocchio_system::instructions::CreateAccount;

use crate::constants::{
    BTC_LIGHT_CLIENT_DISCRIMINATOR, LIGHT_CLIENT_SEED, REQUIRED_CONFIRMATIONS,
};
use crate::state::BitcoinLightClient;

/// Initialize the Bitcoin Light Client PDA.
///
/// Instruction data (after discriminator):
///   [0-7]   start_height       (u64 LE)
///   [8-39]  start_block_hash   ([u8; 32])
///   [40]    network            (u8: 0=mainnet, 1=testnet, 2=regtest)
///   [41-44] initial_bits       (u32 LE, optional — 0 to skip)
///   [45-48] epoch_start_time   (u32 LE, optional — 0 to skip)
pub fn process_initialize(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.len() < 41 {
        return Err(ProgramError::InvalidInstructionData);
    }
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let light_client_info = &accounts[0];
    let payer = &accounts[1];
    let _system_program = &accounts[2];

    if !payer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Parse instruction data
    let start_height = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let mut start_block_hash = [0u8; 32];
    start_block_hash.copy_from_slice(&data[8..40]);
    let network = data[40];

    // Derive PDA and verify
    let (expected_pda, bump) = pinocchio::pubkey::find_program_address(
        &[LIGHT_CLIENT_SEED],
        program_id,
    );

    if light_client_info.key() != &expected_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // Create the account
    let bump_bytes = [bump];
    let signer_seeds: [Seed; 2] = [
        Seed::from(LIGHT_CLIENT_SEED),
        Seed::from(&bump_bytes),
    ];
    let signer = [Signer::from(&signer_seeds)];

    let rent = pinocchio::sysvars::rent::Rent::get()?;
    let lamports = rent.minimum_balance(BitcoinLightClient::LEN);

    CreateAccount {
        from: payer,
        to: light_client_info,
        lamports,
        space: BitcoinLightClient::LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&signer)?;

    // Initialize fields
    let mut lc_data = light_client_info.try_borrow_mut_data()?;
    lc_data[..BitcoinLightClient::LEN].fill(0);
    lc_data[0] = BTC_LIGHT_CLIENT_DISCRIMINATOR;

    let lc = unsafe { &mut *(lc_data.as_mut_ptr() as *mut BitcoinLightClient) };
    lc.bump = bump;
    lc.network = network;
    lc.authority.copy_from_slice(payer.key());
    lc.genesis_hash = start_block_hash;
    lc.tip_hash = start_block_hash;
    lc.set_tip_height(start_height);
    lc.set_finalized_height(if start_height > REQUIRED_CONFIRMATIONS {
        start_height - REQUIRED_CONFIRMATIONS
    } else {
        0
    });
    lc.set_header_count(0);

    let clock = Clock::get()?;
    lc.set_last_update(clock.unix_timestamp);

    // Calculate initial chainwork from a default bits value
    lc.total_chainwork = [0u8; 32];

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

    Ok(())
}
