//! Multi-token Unshield instruction (disc 30)
//!
//! Unshield SPL tokens from the privacy pool. User provides JoinSplit ZK proof;
//! last output is a burn commitment Poseidon([0], token_id, amount).
//! Revealed amount minus fees is transferred from token vault to user.
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
//!
//! Accounts:
//! 0. pool_state           (read)
//! 1. commitment_tree      (writable)
//! 2. vk_registry          (read)
//! 3. user                 (signer, payer)
//! 4. system_program       (read)
//! 5. token_config         (writable)
//! 6. vault                (writable) — token-specific vault
//! 7. user_token_account   (writable)
//! 8. token_program        (read)
//! 9..9+n_inputs           nullifier_records (writable, PDA)

use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::{find_program_address, Pubkey},
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};

use crate::error::AegisError;
use crate::state::{
    CommitmentTree, NullifierOperationType, NullifierRecord, PoolState, TokenConfig,
    VkRegistry, NULLIFIER_RECORD_DISCRIMINATOR,
};
use crate::utils::groth16::GROTH16_PROOF_SIZE;
use crate::utils::{
    create_pda_account, validate_account_writable, validate_program_owner,
    validate_system_program, validate_token_2022_owner, validate_token_program_key,
};
use crate::utils::token::transfer_zkbtc;

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

    if n_inputs == 0 || n_outputs == 0 || n_inputs + n_outputs > MAX_JOINSPLIT_SIZE {
        return Err(ProgramError::InvalidInstructionData);
    }

    // Tree outputs = n_outputs - 1 (last output is unshield, not inserted)
    let n_tree_outputs = n_outputs - 1;

    // Calculate expected data length
    let header_size = 2 + GROTH16_PROOF_SIZE + 32 + 32;
    let nullifiers_size = n_inputs * 32;
    let commitments_size = n_outputs * 32;
    let stealth_size = n_tree_outputs * STEALTH_DATA_PER_OUTPUT;
    let unshield_data_size = 8; // unshield_amount only (no address — use zero-npk burn)
    let expected_len = header_size + nullifiers_size + commitments_size + stealth_size + unshield_data_size;

    if data.len() < expected_len {
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

    // Parse unshield amount
    let unshield_amount = u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap());

    // Validate account count
    let min_accounts = FIXED_ACCOUNTS + n_inputs;
    if accounts.len() < min_accounts {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let pool_state_info = &accounts[0];
    let commitment_tree_info = &accounts[1];
    let vk_registry_info = &accounts[2];
    let user = &accounts[3];
    let system_program = &accounts[4];
    let token_config_info = &accounts[5];
    let vault = &accounts[6];
    let user_token_account = &accounts[7];
    let token_program = &accounts[8];

    // Validate core accounts
    validate_program_owner(pool_state_info, program_id)?;
    validate_program_owner(commitment_tree_info, program_id)?;
    validate_program_owner(vk_registry_info, program_id)?;
    validate_program_owner(token_config_info, program_id)?;
    validate_system_program(system_program)?;
    validate_token_2022_owner(vault)?;
    validate_token_2022_owner(user_token_account)?;
    validate_token_program_key(token_program)?;
    validate_account_writable(commitment_tree_info)?;
    validate_account_writable(token_config_info)?;
    validate_account_writable(vault)?;
    validate_account_writable(user_token_account)?;

    if !user.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Read pool state — check paused, get withdrawal_fee_bps
    let withdrawal_fee_bps = {
        let pool_data = pool_state_info.try_borrow_data()?;
        let pool = PoolState::from_bytes(&pool_data)?;
        if pool.is_paused() {
            return Err(AegisError::PoolPaused.into());
        }
        pool.withdrawal_fee_bps()
    };

    // Read token config — get token_id, validate vault
    let token_id = {
        let tc_data = token_config_info.try_borrow_data()?;
        let tc = TokenConfig::from_bytes(&tc_data)?;

        if !tc.is_enabled() {
            return Err(AegisError::TokenDisabled.into());
        }

        // Validate vault matches
        if vault.key().as_ref() != tc.vault {
            return Err(AegisError::InvalidVault.into());
        }

        tc.token_id
    };

    // Derive pool PDA for signing vault transfer
    let pool_seeds: &[&[u8]] = &[PoolState::SEED];
    let (expected_pool_pda, pool_bump) = find_program_address(pool_seeds, program_id);
    if pool_state_info.key() != &expected_pool_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // Validate VK registry for this (N, M) variant
    {
        let vk_data = vk_registry_info.try_borrow_data()?;
        let vk = VkRegistry::from_bytes(&vk_data)?;

        if vk.n_inputs != n_inputs as u8 || vk.n_outputs != n_outputs as u8 {
            return Err(AegisError::InvalidVkRegistry.into());
        }
    }

    // Validate Merkle root
    {
        let tree_data = commitment_tree_info.try_borrow_data()?;
        let tree = CommitmentTree::from_bytes(&tree_data)?;
        if !tree.is_valid_root(merkle_root) {
            return Err(AegisError::InvalidMerkleProof.into());
        }
    }

    // Build public inputs
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

    // Verify burn commitment: last output = Poseidon([0u8; 32], token_id, amount)
    {
        let zero_npk = [0u8; 32];
        let expected_commitment = crate::utils::crypto::compute_commitment(
            &zero_npk, &token_id, unshield_amount,
        )?;
        if *commitments_out[n_outputs - 1] != expected_commitment {
            return Err(AegisError::InvalidCommitment.into());
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
            return Err(ProgramError::InvalidSeeds);
        }

        {
            let nullifier_data = nullifier_info.try_borrow_data()?;
            if !nullifier_data.is_empty() && nullifier_data[0] == NULLIFIER_RECORD_DISCRIMINATOR {
                return Err(AegisError::NullifierAlreadyUsed.into());
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
            NullifierRecord::init(&mut nullifier_data)?;
        }
    }

    // Emit nullifiers batch
    crate::utils::events::emit_nullifiers_batch(
        &nullifiers[..n_inputs],
        NullifierOperationType::FullWithdrawal as u8,
        30, // instruction::UNSHIELD
    );

    // Insert tree outputs (all except the last unshield output) into Merkle tree
    {
        let mut tree_data = commitment_tree_info.try_borrow_mut_data()?;
        let tree = CommitmentTree::from_bytes_mut(&mut tree_data)?;

        for i in 0..n_tree_outputs {
            let leaf_index = tree.insert_leaf(commitments_out[i])?;

            let stealth_offset = stealth_data_start + i * STEALTH_DATA_PER_OUTPUT;
            let ephemeral_pub: &[u8; 32] = data[stealth_offset..stealth_offset + 32]
                .try_into()
                .unwrap();
            let encrypted_amount: &[u8; 8] = data[stealth_offset + 32..stealth_offset + 40]
                .try_into()
                .unwrap();

            // Change outputs use zero token_id to avoid linking private notes to token type.
            // The recipient knows the token from context (they initiated the unshield).
            crate::utils::events::emit_stealth_announcement(
                crate::utils::events::ANNOUNCEMENT_TYPE_TRANSFER,
                ephemeral_pub,
                encrypted_amount,
                commitments_out[i],
                leaf_index as u32,
                &[0u8; 32],
            );
        }
    }

    // Compute fees
    let protocol_fee = (unshield_amount as u128 * withdrawal_fee_bps as u128 / 10_000) as u64;
    let payout = unshield_amount
        .checked_sub(protocol_fee)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    // Emit unshield metadata
    crate::utils::events::emit_unshield_meta(
        unshield_amount,
        user.key().as_ref().try_into().unwrap(),
    );

    // Transfer payout from vault to user's token account (signed by pool PDA)
    {
        let pool_bump_bytes = [pool_bump];
        let pool_signer_seeds: &[&[u8]] = &[PoolState::SEED, &pool_bump_bytes];

        transfer_zkbtc(
            token_program,
            vault,
            user_token_account,
            pool_state_info, // Pool PDA is the vault authority
            payout,
            pool_signer_seeds,
        )?;
    }

    // Update token config: decrement total_shielded, add fees
    {
        let mut tc_data = token_config_info.try_borrow_mut_data()?;
        let tc = TokenConfig::from_bytes_mut(&mut tc_data)?;
        tc.sub_shielded(unshield_amount)?;
        tc.add_fees(protocol_fee)?;
    }

    let _ = clock; // suppress unused warning

    pinocchio::msg!("Aegis: unshield");
    Ok(())
}
