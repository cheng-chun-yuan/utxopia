//! Redeem instruction (disc 16)
//!
//! JoinSplit N→M where the last output creates a RedemptionRequest PDA
//! for BTC withdrawal — atomic private transfer + BTC redemption in one tx.
//!
//! The last output commitment is verified in the ZK proof but NOT inserted
//! into the Merkle tree. Instead, a RedemptionRequest PDA is created for
//! the backend FROST signing pipeline to process.
//! Remaining M-1 outputs go into the tree as normal (change notes).
//!
//! Supports two modes:
//! - **Inline proof**: proof is in instruction data (legacy, small JoinSplits)
//! - **Buffer proof**: proof_source=1, proof omitted from ix data, read from
//!   proof_buffer account (ChadBuffer) appended after redemption_request.
//!   Saves 256 bytes of instruction data for large JoinSplits.
//!
//! Instruction Data Layout:
//! - [0]     n_inputs:           u8
//! - [1]     n_outputs:          u8  (includes redeem output as last)
//! - [2]     proof_source:       u8  (0=inline, 1=buffer account)
//! - If proof_source=0:
//!   - [3..259]  proof:          [u8; 256]  (Groth16 proof)
//! - If proof_source=1:
//!   - proof is read from the proof_buffer account (last account)
//! - [..]     merkle_root:       [u8; 32]
//! - [..]     bound_params_hash: [u8; 32]
//! - [..]     nullifiers:        [[u8; 32]; n_inputs]
//! - [..]     commitments_out:   [[u8; 32]; n_outputs]  (last = redeem)
//! - [..]     stealth_data:      [ephemeral_pub(32) + encrypted_amount(8)] × (n_outputs - 1)
//! - [..]     redeem_amount:     u64 (8 bytes LE)
//! - [..]     btc_script_len:    u8
//! - [..]     btc_script:        [u8; btc_script_len] (variable, max 62)
//! - [..]     request_nonce:     u64 (8 bytes LE)
//!
//! Accounts:
//! 0. pool_state           (writable)
//! 1. commitment_tree      (writable)
//! 2. vk_registry          (read)
//! 3. user                 (signer, payer)
//! 4. system_program       (read)
//! 5..5+N                  nullifier_records (writable PDA)
//! 5+N                     redemption_request (writable PDA)
//! [optional]              proof_buffer (read, only when proof_source=1, last account)

use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::{find_program_address, Pubkey},
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};

use crate::debug_msg;
use crate::error::AegisError;
use crate::state::{
    CommitmentTree, NullifierOperationType, NullifierRecord, PoolState,
    RedemptionRequest, RedemptionStatus, VkRegistry,
    NULLIFIER_RECORD_DISCRIMINATOR, REDEMPTION_REQUEST_DISCRIMINATOR,
};
use crate::utils::groth16::GROTH16_PROOF_SIZE;
use crate::utils::{
    create_pda_account, validate_account_writable, validate_program_owner,
    validate_system_program,
};

/// Maximum supported N + M
const MAX_JOINSPLIT_SIZE: usize = crate::constants::MAX_SAFE_JOINSPLIT_SIZE;

/// Stealth data per output: ephemeral_pub (32) + encrypted_amount (8)
const STEALTH_DATA_PER_OUTPUT: usize = 40;

/// Number of fixed accounts before nullifiers
const FIXED_ACCOUNTS: usize = 5;

/// Authority prefix size in ChadBuffer accounts
const CHADBUFFER_AUTHORITY_SIZE: usize = 32;

pub fn process_redeem(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    // Parse header
    if data.len() < 3 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let n_inputs = data[0] as usize;
    let n_outputs = data[1] as usize;
    let proof_source = data[2]; // 0 = inline, 1 = buffer account

    // n_outputs must be >= 1 (the redeem output itself)
    if n_inputs == 0 || n_outputs == 0 || n_inputs + n_outputs > MAX_JOINSPLIT_SIZE {
        debug_msg!("Invalid JoinSplit dimensions");
        return Err(ProgramError::InvalidInstructionData);
    }

    // Tree outputs = n_outputs - 1 (last output is redeem, not inserted)
    let n_tree_outputs = n_outputs - 1;

    // Calculate minimum data length based on proof source
    let proof_data_size = if proof_source == 0 { GROTH16_PROOF_SIZE } else { 0 };
    let header_size = 3 + proof_data_size + 32 + 32;
    let nullifiers_size = n_inputs * 32;
    let commitments_size = n_outputs * 32;
    let stealth_size = n_tree_outputs * STEALTH_DATA_PER_OUTPUT;
    let redeem_fixed_size = 8 + 1; // redeem_amount(8) + btc_script_len(1)
    let min_len = header_size + nullifiers_size + commitments_size + stealth_size + redeem_fixed_size;

    if data.len() < min_len {
        debug_msg!("Instruction data too short");
        return Err(ProgramError::InvalidInstructionData);
    }

    // Parse instruction data
    let mut offset = 3;

    // Read proof: inline or from buffer account
    let proof_buf: [u8; GROTH16_PROOF_SIZE];
    let proof_bytes: &[u8] = if proof_source == 0 {
        let p = &data[offset..offset + GROTH16_PROOF_SIZE];
        offset += GROTH16_PROOF_SIZE;
        p
    } else {
        // proof_source == 1: read from last account (proof_buffer)
        let buf_idx = accounts.len() - 1;
        let buf_info = &accounts[buf_idx];
        // Validate buffer is owned by ChadBuffer program
        crate::utils::chadbuffer::validate_chadbuffer_owner(buf_info)?;
        let buf_data = buf_info.try_borrow_data()?;
        // ChadBuffer layout: authority(32) + data(256)
        if buf_data.len() < CHADBUFFER_AUTHORITY_SIZE + GROTH16_PROOF_SIZE {
            debug_msg!("Proof buffer too small");
            return Err(ProgramError::InvalidAccountData);
        }
        let src = &buf_data[CHADBUFFER_AUTHORITY_SIZE..CHADBUFFER_AUTHORITY_SIZE + GROTH16_PROOF_SIZE];
        proof_buf = src.try_into().unwrap();
        &proof_buf
    };

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

    // Parse output commitments (all n_outputs, including redeem)
    let mut commitments_out: [&[u8; 32]; MAX_JOINSPLIT_SIZE] = [ZERO_REF; MAX_JOINSPLIT_SIZE];
    for i in 0..n_outputs {
        commitments_out[i] = data[offset..offset + 32].try_into().unwrap();
        offset += 32;
    }

    // Parse stealth data for tree outputs only (n_outputs - 1)
    let stealth_data_start = offset;
    offset += n_tree_outputs * STEALTH_DATA_PER_OUTPUT;

    // Parse redeem amount
    let redeem_amount = u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap());
    offset += 8;

    // Parse btc_script (variable length to save tx space)
    let btc_script_len = data[offset] as usize;
    offset += 1;

    if btc_script_len == 0 || btc_script_len > crate::constants::MAX_BTC_SCRIPT_LEN {
        debug_msg!("Invalid BTC script length");
        return Err(AegisError::InvalidBtcAddress.into());
    }

    if data.len() < offset + btc_script_len + 8 {
        debug_msg!("Instruction data too short for btc_script + nonce");
        return Err(ProgramError::InvalidInstructionData);
    }

    let btc_script = &data[offset..offset + btc_script_len];
    offset += btc_script_len;

    // Parse request nonce
    let request_nonce = u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap());

    // Verify bound params hash matches expected value for redeem
    {
        let expected = crate::utils::crypto::compute_bound_params_hash_redeem(
            crate::constants::CHAIN_ID,
        );
        if *bound_params_hash != expected {
            debug_msg!("Invalid bound params hash for redeem");
            return Err(AegisError::InvalidBoundParams.into());
        }
    }

    // Validate account count: fixed + nullifiers + 1 redemption_request
    let min_accounts = FIXED_ACCOUNTS + n_inputs + 1;
    if accounts.len() < min_accounts {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let pool_state_info = &accounts[0];
    let commitment_tree_info = &accounts[1];
    let vk_registry_info = &accounts[2];
    let user = &accounts[3];
    let system_program = &accounts[4];

    // Validate core accounts
    validate_program_owner(pool_state_info, program_id)?;
    validate_program_owner(commitment_tree_info, program_id)?;
    validate_program_owner(vk_registry_info, program_id)?;
    validate_system_program(system_program)?;
    validate_account_writable(pool_state_info)?;
    validate_account_writable(commitment_tree_info)?;

    if !user.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Validate pool is not paused
    let (pending_redemptions, total_shielded) = {
        let pool_data = pool_state_info.try_borrow_data()?;
        let pool = PoolState::from_bytes(&pool_data)?;
        if pool.is_paused() {
            return Err(AegisError::PoolPaused.into());
        }
        (pool.pending_redemptions(), pool.total_shielded())
    };

    // Validate redeem amount
    if redeem_amount == 0 {
        return Err(AegisError::ZeroAmount.into());
    }
    if redeem_amount > total_shielded {
        return Err(AegisError::InsufficientFunds.into());
    }

    // Validate VK registry for this (N, M) variant
    {
        let vk_data = vk_registry_info.try_borrow_data()?;
        let vk = VkRegistry::from_bytes(&vk_data)?;

        if vk.n_inputs != n_inputs as u8 || vk.n_outputs != n_outputs as u8 {
            debug_msg!("VK registry mismatch");
            return Err(AegisError::InvalidVkRegistry.into());
        }
    }

    // Validate Merkle root
    {
        let tree_data = commitment_tree_info.try_borrow_data()?;
        let tree = CommitmentTree::from_bytes(&tree_data)?;
        if !tree.is_valid_root(merkle_root) {
            debug_msg!("Invalid Merkle root");
            return Err(AegisError::InvalidMerkleProof.into());
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

    debug_msg!("Redeem JoinSplit proof verified");

    // Get clock and rent for PDA creation
    let clock = Clock::get()?;
    let rent = Rent::get()?;

    // Process nullifiers — same as unshield
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

        let null_hash: &[u8; 32] = nullifiers[i].try_into().unwrap();
        crate::utils::events::emit_nullifier_spent(
            null_hash,
            NullifierOperationType::FullWithdrawal as u8,
            clock.unix_timestamp,
            user.key().as_ref().try_into().unwrap(),
        );
    }

    // Insert tree outputs (all except the last redeem output) into Merkle tree
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
            let encrypted_amount: &[u8; 8] = data[stealth_offset + 32..stealth_offset + 40]
                .try_into()
                .unwrap();

            // Emit stealth announcement as log event (replaces PDA creation)
            crate::utils::events::emit_stealth_announcement(
                crate::utils::events::ANNOUNCEMENT_TYPE_TRANSFER,
                ephemeral_pub,
                encrypted_amount,
                commitments_out[i],
                leaf_index as u32,
            );

            crate::utils::events::emit_leaf_inserted(commitments_out[i], clock.unix_timestamp);
        }
    }

    // Create RedemptionRequest PDA — same pattern as request_redemption.rs
    {
        let redemption_info = &accounts[FIXED_ACCOUNTS + n_inputs];
        validate_account_writable(redemption_info)?;

        let nonce_bytes = request_nonce.to_le_bytes();
        let redemption_seeds: &[&[u8]] = &[
            RedemptionRequest::SEED,
            user.key().as_ref(),
            &nonce_bytes,
        ];
        let (expected_redemption_pda, redemption_bump) =
            find_program_address(redemption_seeds, program_id);
        if redemption_info.key() != &expected_redemption_pda {
            debug_msg!("Invalid redemption request PDA");
            return Err(ProgramError::InvalidSeeds);
        }

        {
            let redemption_data = redemption_info.try_borrow_data()?;
            if !redemption_data.is_empty()
                && redemption_data[0] == REDEMPTION_REQUEST_DISCRIMINATOR
            {
                return Err(AegisError::AlreadyInitialized.into());
            }
        }

        let redemption_bump_bytes = [redemption_bump];
        let redemption_signer_seeds: &[&[u8]] = &[
            RedemptionRequest::SEED,
            user.key().as_ref(),
            &nonce_bytes,
            &redemption_bump_bytes,
        ];

        create_pda_account(
            user,
            redemption_info,
            program_id,
            rent.minimum_balance(RedemptionRequest::LEN),
            RedemptionRequest::LEN as u64,
            redemption_signer_seeds,
        )?;

        {
            let mut redemption_data = redemption_info.try_borrow_mut_data()?;
            let redemption = RedemptionRequest::init(&mut redemption_data)?;
            redemption.set_request_id(request_nonce);
            redemption.requester.copy_from_slice(user.key().as_ref());
            redemption.set_amount_sats(redeem_amount);
            redemption.set_btc_script(btc_script)?;
            redemption.set_status(RedemptionStatus::Pending);
        }
    }

    // Update pool state: decrement total_shielded, increment pending_redemptions
    {
        let mut pool_data = pool_state_info.try_borrow_mut_data()?;
        let pool = PoolState::from_bytes_mut(&mut pool_data)?;
        pool.sub_shielded(redeem_amount)?;
        pool.set_pending_redemptions(pending_redemptions.saturating_add(1));
        pool.set_last_update(clock.unix_timestamp);
    }

    debug_msg!("Redeem completed");
    Ok(())
}
