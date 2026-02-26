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
    BLOCK_HEADER_DISCRIMINATOR, BLOCK_HEADER_SEED, BLOCKS_PER_EPOCH, REQUIRED_CONFIRMATIONS,
};
use crate::state::{BitcoinLightClient, BlockHeader};
use crate::utils::{
    double_sha256, hash_meets_target, target_from_bits, calculate_chainwork, add_chainwork,
    calculate_new_bits,
};

/// Submit a new Bitcoin block header.
///
/// Instruction data (after discriminator):
///   [0-79]  raw_header     (80 bytes, raw Bitcoin block header)
///   [80-87] block_height   (u64 LE)
pub fn process_submit_header(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.len() < 88 {
        return Err(ProgramError::InvalidInstructionData);
    }
    if accounts.len() < 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let light_client_info = &accounts[0];
    let block_header_info = &accounts[1];
    let submitter = &accounts[2];
    let _system_program = &accounts[3];

    if !submitter.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Validate light client is owned by this program
    if light_client_info.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }

    // Parse instruction data
    let raw_header: &[u8; 80] = data[0..80].try_into().unwrap();
    let block_height = u64::from_le_bytes(data[80..88].try_into().unwrap());

    // Parse raw header fields
    let prev_block_hash: &[u8; 32] = data[4..36].try_into().unwrap();
    let bits = u32::from_le_bytes(data[72..76].try_into().unwrap());

    // Compute block hash = double_sha256(raw_header)
    let block_hash = double_sha256(raw_header);

    // Read light client state for validation
    let (expected_tip_hash, expected_height, network, lc_chainwork, lc_expected_bits, lc_epoch_start_time) = {
        let lc_data = light_client_info.try_borrow_data()?;
        let lc = BitcoinLightClient::from_bytes(&lc_data)?;
        let mut tip = [0u8; 32];
        tip.copy_from_slice(&lc.tip_hash);
        let mut cw = [0u8; 32];
        cw.copy_from_slice(&lc.total_chainwork);
        (tip, lc.tip_height(), lc.network, cw, lc.expected_bits(), lc.epoch_start_time())
    };

    // Validate: prev_block_hash must equal current tip
    if *prev_block_hash != expected_tip_hash {
        return Err(ProgramError::InvalidArgument);
    }

    // Validate: height must be tip + 1
    if block_height != expected_height + 1 {
        return Err(ProgramError::InvalidArgument);
    }

    // Validate PoW (skip for testnet network=1 and regtest network=2)
    if network == 0 {
        let target = target_from_bits(bits);
        if !hash_meets_target(&block_hash, &target) {
            return Err(ProgramError::InvalidArgument);
        }

        // Enforce expected difficulty (skip if not yet bootstrapped)
        if lc_expected_bits != 0 && bits != lc_expected_bits {
            return Err(ProgramError::InvalidArgument); // DifficultyMismatch
        }
    }

    // Derive block header PDA
    let height_le = block_height.to_le_bytes();
    let (expected_header_pda, header_bump) = pinocchio::pubkey::find_program_address(
        &[BLOCK_HEADER_SEED, &height_le],
        program_id,
    );

    if block_header_info.key() != &expected_header_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // Check if block header PDA already exists (e.g., from a previous fork that was reorged)
    let account_exists = {
        let existing_data = block_header_info.try_borrow_data()?;
        !existing_data.is_empty()
            && existing_data.len() >= BlockHeader::LEN
            && existing_data[0] == BLOCK_HEADER_DISCRIMINATOR
    };

    if !account_exists {
        // Create block header account (normal path)
        let header_bump_bytes = [header_bump];
        let header_signer_seeds: [Seed; 3] = [
            Seed::from(BLOCK_HEADER_SEED),
            Seed::from(height_le.as_slice()),
            Seed::from(&header_bump_bytes),
        ];
        let header_signer = [Signer::from(&header_signer_seeds)];

        let rent = pinocchio::sysvars::rent::Rent::get()?;
        let lamports = rent.minimum_balance(BlockHeader::LEN);

        CreateAccount {
            from: submitter,
            to: block_header_info,
            lamports,
            space: BlockHeader::LEN as u64,
            owner: program_id,
        }
        .invoke_signed(&header_signer)?;
    }

    // Write block header data (same for both create and overwrite paths)
    {
        let mut header_data = block_header_info.try_borrow_mut_data()?;
        header_data[..BlockHeader::LEN].fill(0);
        header_data[0] = BLOCK_HEADER_DISCRIMINATOR;

        let header = unsafe { &mut *(header_data.as_mut_ptr() as *mut BlockHeader) };
        header.version.copy_from_slice(&raw_header[0..4]);
        header.prev_block_hash.copy_from_slice(&raw_header[4..36]);
        header.merkle_root.copy_from_slice(&raw_header[36..68]);
        header.timestamp.copy_from_slice(&raw_header[68..72]);
        header.bits.copy_from_slice(&raw_header[72..76]);
        header.nonce.copy_from_slice(&raw_header[76..80]);
        header.block_hash = block_hash;
        header.height = block_height.to_le_bytes();

        // Calculate and set chainwork
        let block_work = calculate_chainwork(bits);
        let new_chainwork = add_chainwork(&lc_chainwork, &block_work);
        header.chainwork = new_chainwork;

        let clock = Clock::get()?;
        header.submitted_at = clock.unix_timestamp.to_le_bytes();
    }

    // Update light client
    {
        let mut lc_data = light_client_info.try_borrow_mut_data()?;
        let lc = BitcoinLightClient::from_bytes_mut(&mut lc_data)?;

        lc.tip_hash = block_hash;
        lc.set_tip_height(block_height);
        lc.set_header_count(lc.header_count() + 1);

        // Update finalized height
        if block_height > REQUIRED_CONFIRMATIONS {
            lc.set_finalized_height(block_height - REQUIRED_CONFIRMATIONS);
        }

        // Update chainwork
        let block_work = calculate_chainwork(bits);
        lc.total_chainwork = add_chainwork(&lc_chainwork, &block_work);

        // Difficulty retarget at epoch boundary (mainnet only)
        if network == 0 && block_height % BLOCKS_PER_EPOCH == 0 {
            let header_timestamp = u32::from_le_bytes(raw_header[68..72].try_into().unwrap());
            if lc_epoch_start_time != 0 && lc_expected_bits != 0 {
                let actual_timespan = header_timestamp.wrapping_sub(lc_epoch_start_time);
                let new_bits = calculate_new_bits(lc_expected_bits, actual_timespan);
                lc.set_expected_bits(new_bits);
            }
            lc.set_epoch_start_time(header_timestamp);
        }

        let clock = Clock::get()?;
        lc.set_last_update(clock.unix_timestamp);
    }

    Ok(())
}
