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
use crate::utils::{
    double_sha256, hash_meets_target, target_from_bits, calculate_chainwork, add_chainwork,
    u256_from_le_bytes, u256_gt_limbs,
};

/// Overwrite an existing block header at height H with a new block from a heavier fork.
///
/// Instruction data (after discriminator):
///   [0-79]   raw_header    (80 bytes)
///   [80-87]  block_height  (u64 LE)
///
/// Accounts:
///   0. [writable]  BitcoinLightClient
///   1. [writable]  BlockHeader PDA at block_height (EXISTING — to overwrite)
///   2. []          BlockHeader PDA at block_height - 1 (parent — for chainwork)
///   3. [signer]    Submitter
pub fn process_reorg_header(
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
    let parent_header_info = &accounts[2];
    let submitter = &accounts[3];

    if !submitter.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    if light_client_info.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    if block_header_info.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    if parent_header_info.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }

    // Parse instruction data
    let raw_header: &[u8; 80] = data[0..80].try_into().unwrap();
    let block_height = u64::from_le_bytes(data[80..88].try_into().unwrap());
    let prev_block_hash: &[u8; 32] = data[4..36].try_into().unwrap();
    let bits = u32::from_le_bytes(data[72..76].try_into().unwrap());

    // Must not be height 0
    if block_height == 0 {
        return Err(ProgramError::InvalidArgument);
    }

    // Compute block hash
    let block_hash = double_sha256(raw_header);

    // Read network from light client
    let network = {
        let lc_data = light_client_info.try_borrow_data()?;
        let lc = BitcoinLightClient::from_bytes(&lc_data)?;
        lc.network
    };

    // Validate PoW (mainnet only)
    if network == 0 {
        let target = target_from_bits(bits);
        if !hash_meets_target(&block_hash, &target) {
            return Err(ProgramError::InvalidArgument);
        }
    }

    // Verify block header PDA at block_height
    let height_le = block_height.to_le_bytes();
    let (expected_header_pda, _) = pinocchio::pubkey::find_program_address(
        &[BLOCK_HEADER_SEED, &height_le],
        program_id,
    );
    if block_header_info.key() != &expected_header_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // Verify parent header PDA at block_height - 1
    let parent_height = block_height - 1;
    let parent_height_le = parent_height.to_le_bytes();
    let (expected_parent_pda, _) = pinocchio::pubkey::find_program_address(
        &[BLOCK_HEADER_SEED, &parent_height_le],
        program_id,
    );
    if parent_header_info.key() != &expected_parent_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // Read parent header: verify prev_block_hash links to parent, get parent chainwork
    let parent_chainwork = {
        let parent_data = parent_header_info.try_borrow_data()?;
        if parent_data.len() < BlockHeader::LEN || parent_data[0] != BLOCK_HEADER_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        let parent = unsafe { &*(parent_data.as_ptr() as *const BlockHeader) };
        if *prev_block_hash != parent.block_hash {
            return Err(ProgramError::InvalidArgument); // new block doesn't link to parent
        }
        let mut cw = [0u8; 32];
        cw.copy_from_slice(&parent.chainwork);
        cw
    };

    // Compute new chainwork
    let block_work = calculate_chainwork(bits);
    let new_chainwork = add_chainwork(&parent_chainwork, &block_work);

    // Read existing block's chainwork and verify new is strictly heavier
    {
        let existing_data = block_header_info.try_borrow_data()?;
        if existing_data.len() < BlockHeader::LEN || existing_data[0] != BLOCK_HEADER_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        let existing = unsafe { &*(existing_data.as_ptr() as *const BlockHeader) };
        let existing_cw = u256_from_le_bytes(&existing.chainwork);
        let new_cw = u256_from_le_bytes(&new_chainwork);
        // new_chainwork must be strictly greater
        if !u256_gt_limbs(new_cw, existing_cw) {
            return Err(ProgramError::InvalidArgument); // not heavier
        }
    }

    // Overwrite block header data in-place
    {
        let mut header_data = block_header_info.try_borrow_mut_data()?;
        let header = unsafe { &mut *(header_data.as_mut_ptr() as *mut BlockHeader) };
        header.version.copy_from_slice(&raw_header[0..4]);
        header.prev_block_hash.copy_from_slice(&raw_header[4..36]);
        header.merkle_root.copy_from_slice(&raw_header[36..68]);
        header.timestamp.copy_from_slice(&raw_header[68..72]);
        header.bits.copy_from_slice(&raw_header[72..76]);
        header.nonce.copy_from_slice(&raw_header[76..80]);
        header.block_hash = block_hash;
        header.height = block_height.to_le_bytes();
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
        lc.total_chainwork = new_chainwork;

        if block_height > REQUIRED_CONFIRMATIONS {
            lc.set_finalized_height(block_height - REQUIRED_CONFIRMATIONS);
        } else {
            lc.set_finalized_height(0);
        }

        let clock = Clock::get()?;
        lc.set_last_update(clock.unix_timestamp);
    }

    Ok(())
}
