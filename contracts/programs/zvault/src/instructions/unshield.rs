//! Public Unshield instruction (disc 15)
//!
//! Converts shielded zkBTC back to public SPL tokens on Solana.
//! User proves ownership via JoinSplit ZK proof, nullifiers are created,
//! and pool vault transfers public zBTC to the user's token account.
//!
//! The last output commitment is the "unshield output" — verified in ZK proof
//! but NOT inserted into the Merkle tree. Instead, the unshield amount is
//! transferred from pool vault → user's token account.
//! Remaining M-1 outputs go into tree as normal (change notes).
//!
//! Instruction Data Layout:
//! - [0]     n_inputs:           u8
//! - [1]     n_outputs:          u8  (includes unshield output as last)
//! - [2..258]  proof:            [u8; 256]  (Groth16 proof)
//! - [258..290] merkle_root:     [u8; 32]
//! - [290..322] bound_params_hash: [u8; 32]
//! - [322..]  nullifiers:        [[u8; 32]; n_inputs]
//! - [..]     commitments_out:   [[u8; 32]; n_outputs]  (last = unshield)
//! - [..]     stealth_data:      [ephemeral_pub(32) + encrypted_amount(8)] × (n_outputs - 1)
//! - [..]     unshield_amount:   u64 (8 bytes LE)
//! - [..]     unshield_address:  [u8; 32] (recipient Solana pubkey)
//!
//! Accounts:
//! 0. pool_state           (writable)
//! 1. commitment_tree      (writable)
//! 2. vk_registry          (read)
//! 3. user                 (signer, payer)
//! 4. system_program       (read)
//! 5. zbtc_mint            (writable)
//! 6. pool_vault           (writable)
//! 7. user_token_account   (writable)
//! 8. token_program        (read)
//! 9..9+n_inputs           nullifier_records (writable, PDA)
//! 9+n_inputs..            stealth_announcements (writable, PDA) — only for tree outputs

use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::{find_program_address, Pubkey},
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};

use crate::debug_msg;
use crate::error::ZVaultError;
use crate::state::{
    CommitmentTree, NullifierOperationType, NullifierRecord, PoolState,
    StealthAnnouncement, VkRegistry, NULLIFIER_RECORD_DISCRIMINATOR,
    STEALTH_ANNOUNCEMENT_DISCRIMINATOR,
};
use crate::utils::groth16::GROTH16_PROOF_SIZE;
use crate::utils::{
    create_pda_account, validate_account_writable, validate_program_owner,
    validate_system_program, validate_token_2022_owner, validate_token_program_key,
};
use crate::utils::token::{transfer_zbtc, validate_token_account};

/// Maximum supported N + M
const MAX_JOINSPLIT_SIZE: usize = crate::constants::MAX_SAFE_JOINSPLIT_SIZE;

/// Stealth data per output: ephemeral_pub (32) + encrypted_amount (8)
const STEALTH_DATA_PER_OUTPUT: usize = 40;

/// Number of fixed accounts before nullifiers
const FIXED_ACCOUNTS: usize = 9;

pub fn process_unshield(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    // Parse header
    if data.len() < 2 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let n_inputs = data[0] as usize;
    let n_outputs = data[1] as usize;

    // n_outputs must be >= 1 (the unshield output itself)
    if n_inputs == 0 || n_outputs == 0 || n_inputs + n_outputs > MAX_JOINSPLIT_SIZE {
        debug_msg!("Invalid JoinSplit dimensions");
        return Err(ProgramError::InvalidInstructionData);
    }

    // Tree outputs = n_outputs - 1 (last output is unshield, not inserted)
    let n_tree_outputs = n_outputs - 1;

    // Calculate expected data length
    let header_size = 2 + GROTH16_PROOF_SIZE + 32 + 32;
    let nullifiers_size = n_inputs * 32;
    let commitments_size = n_outputs * 32;
    let stealth_size = n_tree_outputs * STEALTH_DATA_PER_OUTPUT;
    let unshield_data_size = 8 + 32; // unshield_amount(8) + unshield_address(32)
    let expected_len = header_size + nullifiers_size + commitments_size + stealth_size + unshield_data_size;

    if data.len() < expected_len {
        debug_msg!("Instruction data too short");
        return Err(ProgramError::InvalidInstructionData);
    }

    // Parse instruction data
    let mut offset = 2;

    let proof_bytes = &data[offset..offset + GROTH16_PROOF_SIZE];
    offset += GROTH16_PROOF_SIZE;

    let merkle_root: &[u8; 32] = data[offset..offset + 32].try_into().unwrap();
    offset += 32;

    let bound_params_hash: &[u8; 32] = data[offset..offset + 32].try_into().unwrap();
    offset += 32;

    // Parse nullifiers
    const ZERO_REF: &[u8; 32] = &[0u8; 32];
    let mut nullifiers: [&[u8; 32]; MAX_JOINSPLIT_SIZE] = [ZERO_REF; MAX_JOINSPLIT_SIZE];
    for i in 0..n_inputs {
        nullifiers[i] = data[offset..offset + 32].try_into().unwrap();
        offset += 32;
    }

    // Parse output commitments (all n_outputs, including unshield)
    let mut commitments_out: [&[u8; 32]; MAX_JOINSPLIT_SIZE] = [ZERO_REF; MAX_JOINSPLIT_SIZE];
    for i in 0..n_outputs {
        commitments_out[i] = data[offset..offset + 32].try_into().unwrap();
        offset += 32;
    }

    // Parse stealth data for tree outputs only (n_outputs - 1)
    let stealth_data_start = offset;
    offset += n_tree_outputs * STEALTH_DATA_PER_OUTPUT;

    // Parse unshield amount and address
    let unshield_amount = u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap());
    offset += 8;

    let unshield_address: &[u8; 32] = data[offset..offset + 32].try_into().unwrap();

    // Verify bound params hash matches expected value for unshield
    {
        let expected = crate::utils::crypto::compute_bound_params_hash_unshield(
            crate::constants::CHAIN_ID,
            unshield_address,
        );
        if *bound_params_hash != expected {
            debug_msg!("Invalid bound params hash for unshield");
            return Err(ZVaultError::InvalidBoundParams.into());
        }
    }

    // Validate account count
    let min_accounts = FIXED_ACCOUNTS + n_inputs + n_tree_outputs;
    if accounts.len() < min_accounts {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let pool_state_info = &accounts[0];
    let commitment_tree_info = &accounts[1];
    let vk_registry_info = &accounts[2];
    let user = &accounts[3];
    let system_program = &accounts[4];
    let zbtc_mint = &accounts[5];
    let pool_vault = &accounts[6];
    let user_token_account = &accounts[7];
    let token_program = &accounts[8];

    // Validate core accounts
    validate_program_owner(pool_state_info, program_id)?;
    validate_program_owner(commitment_tree_info, program_id)?;
    validate_program_owner(vk_registry_info, program_id)?;
    validate_system_program(system_program)?;
    validate_token_2022_owner(zbtc_mint)?;
    validate_token_2022_owner(pool_vault)?;
    validate_token_program_key(token_program)?;
    validate_account_writable(pool_state_info)?;
    validate_account_writable(commitment_tree_info)?;
    validate_account_writable(zbtc_mint)?;
    validate_account_writable(pool_vault)?;
    validate_account_writable(user_token_account)?;

    if !user.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Validate pool is not paused and get pool vault + bump
    let pool_bump: u8;
    {
        let pool_data = pool_state_info.try_borrow_data()?;
        let pool = PoolState::from_bytes(&pool_data)?;
        if pool.is_paused() {
            return Err(ZVaultError::PoolPaused.into());
        }

        // Verify zbtc_mint matches pool
        if zbtc_mint.key().as_ref() != pool.zbtc_mint {
            debug_msg!("zBTC mint mismatch");
            return Err(ProgramError::InvalidAccountData);
        }

        // Verify pool vault matches pool
        if pool_vault.key().as_ref() != pool.pool_vault {
            debug_msg!("Pool vault mismatch");
            return Err(ProgramError::InvalidAccountData);
        }
    }

    // Derive pool PDA for signing transfer
    let pool_seeds: &[&[u8]] = &[PoolState::SEED];
    let (expected_pool_pda, bump) = find_program_address(pool_seeds, program_id);
    if pool_state_info.key() != &expected_pool_pda {
        debug_msg!("Invalid pool PDA");
        return Err(ProgramError::InvalidSeeds);
    }
    pool_bump = bump;

    // Validate user token account: owned by Token-2022, correct mint
    let unshield_recipient = Pubkey::from(*unshield_address);
    validate_token_account(user_token_account, zbtc_mint.key(), &unshield_recipient)?;

    // Validate VK registry for this (N, M) variant
    {
        let vk_data = vk_registry_info.try_borrow_data()?;
        let vk = VkRegistry::from_bytes(&vk_data)?;

        if vk.n_inputs != n_inputs as u8 || vk.n_outputs != n_outputs as u8 {
            debug_msg!("VK registry mismatch");
            return Err(ZVaultError::InvalidVkRegistry.into());
        }
    }

    // Validate Merkle root
    {
        let tree_data = commitment_tree_info.try_borrow_data()?;
        let tree = CommitmentTree::from_bytes(&tree_data)?;
        if !tree.is_valid_root(merkle_root) {
            debug_msg!("Invalid Merkle root");
            return Err(ZVaultError::InvalidMerkleProof.into());
        }
    }

    // Build public inputs array for verification
    const MAX_PUBLIC_INPUTS: usize = 2 + MAX_JOINSPLIT_SIZE;
    let mut public_inputs: [&[u8; 32]; MAX_PUBLIC_INPUTS] = [ZERO_REF; MAX_PUBLIC_INPUTS];
    let mut pi_len = 0;
    public_inputs[pi_len] = merkle_root; pi_len += 1;
    public_inputs[pi_len] = bound_params_hash; pi_len += 1;
    for i in 0..n_inputs {
        public_inputs[pi_len] = nullifiers[i]; pi_len += 1;
    }
    for i in 0..n_outputs {
        public_inputs[pi_len] = commitments_out[i]; pi_len += 1;
    }

    // Load VK and verify Groth16 proof
    let (delta_g2, ic) = crate::utils::groth16::load_joinsplit_vk(
        n_inputs as u8, n_outputs as u8,
    )?;

    crate::utils::groth16::verify_groth16_joinsplit_proof(
        proof_bytes, &public_inputs[..pi_len], delta_g2, ic,
    )?;

    debug_msg!("Unshield JoinSplit proof verified");

    // Verify unshield commitment: last output = Poseidon(unshield_address, ZBTC_TOKEN_ID, unshield_amount)
    {
        let expected_commitment = crate::utils::crypto::compute_deposit_commitment(
            unshield_address,
            unshield_amount,
        )?;
        if *commitments_out[n_outputs - 1] != expected_commitment {
            debug_msg!("Unshield commitment mismatch");
            return Err(ZVaultError::InvalidCommitment.into());
        }
    }

    // Get clock and rent for PDA creation
    let clock = Clock::get()?;
    let rent = Rent::get()?;

    // Process nullifiers
    for i in 0..n_inputs {
        let nullifier_info = &accounts[FIXED_ACCOUNTS + i];
        validate_account_writable(nullifier_info)?;

        let nullifier_seeds: &[&[u8]] = &[NullifierRecord::SEED, nullifiers[i].as_ref()];
        let (expected_pda, nbump) = find_program_address(nullifier_seeds, program_id);
        if nullifier_info.key() != &expected_pda {
            debug_msg!("Invalid nullifier PDA");
            return Err(ProgramError::InvalidSeeds);
        }

        {
            let nullifier_data = nullifier_info.try_borrow_data()?;
            if !nullifier_data.is_empty() && nullifier_data[0] == NULLIFIER_RECORD_DISCRIMINATOR {
                debug_msg!("Nullifier already spent");
                return Err(ZVaultError::NullifierAlreadyUsed.into());
            }
        }

        let bump_bytes = [nbump];
        let signer_seeds: &[&[u8]] = &[
            NullifierRecord::SEED,
            nullifiers[i].as_ref(),
            &bump_bytes,
        ];

        create_pda_account(
            user,
            nullifier_info,
            program_id,
            rent.minimum_balance(NullifierRecord::LEN),
            NullifierRecord::LEN as u64,
            signer_seeds,
        )?;

        {
            let mut nullifier_data = nullifier_info.try_borrow_mut_data()?;
            let record = NullifierRecord::init(&mut nullifier_data)?;
            record.nullifier_hash.copy_from_slice(nullifiers[i]);
            record.set_spent_at(clock.unix_timestamp);
            record.spent_by.copy_from_slice(user.key().as_ref());
            record.set_operation_type(NullifierOperationType::FullWithdrawal);
        }
    }

    // Insert tree outputs (all except the last unshield output) into Merkle tree
    {
        let mut tree_data = commitment_tree_info.try_borrow_mut_data()?;
        let tree = CommitmentTree::from_bytes_mut(&mut tree_data)?;

        for i in 0..n_tree_outputs {
            let leaf_index = tree.insert_leaf(commitments_out[i])?;

            debug_msg!("Inserted commitment into tree");

            let stealth_offset = stealth_data_start + i * STEALTH_DATA_PER_OUTPUT;
            let ephemeral_pub: &[u8; 32] = data[stealth_offset..stealth_offset + 32]
                .try_into()
                .unwrap();
            let encrypted_amount: [u8; 8] = data[stealth_offset + 32..stealth_offset + 40]
                .try_into()
                .unwrap();

            let announcement_info = &accounts[FIXED_ACCOUNTS + n_inputs + i];
            validate_account_writable(announcement_info)?;

            let ann_seeds: &[&[u8]] = &[StealthAnnouncement::SEED, ephemeral_pub.as_ref()];
            let (expected_ann_pda, ann_bump) = find_program_address(ann_seeds, program_id);
            if announcement_info.key() != &expected_ann_pda {
                debug_msg!("Invalid stealth announcement PDA");
                return Err(ProgramError::InvalidSeeds);
            }

            {
                let ann_data = announcement_info.try_borrow_data()?;
                if !ann_data.is_empty() && ann_data[0] == STEALTH_ANNOUNCEMENT_DISCRIMINATOR {
                    return Err(ProgramError::AccountAlreadyInitialized);
                }
            }

            let ann_bump_bytes = [ann_bump];
            let ann_signer_seeds: &[&[u8]] = &[
                StealthAnnouncement::SEED,
                ephemeral_pub.as_ref(),
                &ann_bump_bytes,
            ];

            create_pda_account(
                user,
                announcement_info,
                program_id,
                rent.minimum_balance(StealthAnnouncement::SIZE),
                StealthAnnouncement::SIZE as u64,
                ann_signer_seeds,
            )?;

            {
                let mut ann_data = announcement_info.try_borrow_mut_data()?;
                let announcement = StealthAnnouncement::init(&mut ann_data)?;
                announcement.announcement_type = crate::state::ANNOUNCEMENT_TYPE_TRANSFER;
                announcement.ephemeral_pub = *ephemeral_pub;
                announcement.set_amount_bytes(encrypted_amount);
                announcement.commitment = *commitments_out[i];
                announcement.set_leaf_index(leaf_index);
                announcement.set_created_at(clock.unix_timestamp);
            }
        }
    }

    // Transfer unshield amount from pool vault to user's token account
    {
        let pool_bump_bytes = [pool_bump];
        let pool_signer_seeds: &[&[u8]] = &[PoolState::SEED, &pool_bump_bytes];

        transfer_zbtc(
            token_program,
            pool_vault,
            user_token_account,
            pool_state_info, // Pool PDA is the vault authority
            unshield_amount,
            pool_signer_seeds,
        )?;
    }

    // Update pool state: decrement total_shielded
    {
        let mut pool_data = pool_state_info.try_borrow_mut_data()?;
        let pool = PoolState::from_bytes_mut(&mut pool_data)?;
        pool.sub_shielded(unshield_amount)?;
        pool.set_last_update(clock.unix_timestamp);
    }

    debug_msg!("Unshield completed");
    Ok(())
}
