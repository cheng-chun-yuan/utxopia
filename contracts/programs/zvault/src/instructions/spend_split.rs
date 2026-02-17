//! Spend Split instruction (Groth16 - Client-Side ZK)
//!
//! Splits one unified commitment into two new commitments.
//! Input:  Commitment = Poseidon2(pub_key_x, amount)
//! Output: Commitment1 + Commitment2 (amount conservation enforced by ZK proof)
//!
//! ZK Proof: Groth16 (generated in browser via snarkjs, verified inline)

use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::{find_program_address, Pubkey},
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};

use crate::error::ZVaultError;
use crate::state::{
    CommitmentTree, NullifierOperationType, NullifierRecord, PoolState,
    StealthAnnouncement, NULLIFIER_RECORD_DISCRIMINATOR, STEALTH_ANNOUNCEMENT_DISCRIMINATOR,
};
use crate::utils::{
    create_pda_account, groth16::GROTH16_PROOF_SIZE, validate_account_writable,
    validate_program_owner, validate_system_program,
};


/// Split commitment instruction data (inline proof)
///
/// Layout:
/// - proof: [u8; 256] - Groth16 proof (inline)
/// - root: [u8; 32]
/// - nullifier_hash: [u8; 32]
/// - output_commitment_1: [u8; 32]
/// - output_commitment_2: [u8; 32]
/// - vk_hash: [u8; 32]
/// - output1_ephemeral_pub_x: [u8; 32]
/// - output1_encrypted_amount_with_sign: [u8; 32]
/// - output2_ephemeral_pub_x: [u8; 32]
/// - output2_encrypted_amount_with_sign: [u8; 32]
pub struct SpendSplitData<'a> {
    pub proof: &'a [u8],
    pub root: [u8; 32],
    pub nullifier_hash: [u8; 32],
    pub output_commitment_1: [u8; 32],
    pub output_commitment_2: [u8; 32],
    pub vk_hash: [u8; 32],
    pub output1_ephemeral_pub_x: [u8; 32],
    pub output1_encrypted_amount_with_sign: [u8; 32],
    pub output2_ephemeral_pub_x: [u8; 32],
    pub output2_encrypted_amount_with_sign: [u8; 32],
}

impl<'a> SpendSplitData<'a> {
    /// Size: proof(256) + root(32) + nullifier(32) + out1(32) + out2(32) + vk_hash(32) + eph1_x(32) + enc1(32) + eph2_x(32) + enc2(32) = 544 bytes
    pub const SIZE: usize = GROTH16_PROOF_SIZE + 32 + 32 + 32 + 32 + 32 + 32 + 32 + 32 + 32;

    pub fn from_bytes(data: &'a [u8]) -> Result<Self, ProgramError> {
        if data.len() < Self::SIZE {
            return Err(ProgramError::InvalidInstructionData);
        }

        let mut offset = 0;

        let proof = &data[offset..offset + GROTH16_PROOF_SIZE];
        offset += GROTH16_PROOF_SIZE;

        let mut root = [0u8; 32];
        root.copy_from_slice(&data[offset..offset + 32]);
        offset += 32;

        let mut nullifier_hash = [0u8; 32];
        nullifier_hash.copy_from_slice(&data[offset..offset + 32]);
        offset += 32;

        let mut output_commitment_1 = [0u8; 32];
        output_commitment_1.copy_from_slice(&data[offset..offset + 32]);
        offset += 32;

        let mut output_commitment_2 = [0u8; 32];
        output_commitment_2.copy_from_slice(&data[offset..offset + 32]);
        offset += 32;

        let mut vk_hash = [0u8; 32];
        vk_hash.copy_from_slice(&data[offset..offset + 32]);
        offset += 32;

        let mut output1_ephemeral_pub_x = [0u8; 32];
        output1_ephemeral_pub_x.copy_from_slice(&data[offset..offset + 32]);
        offset += 32;

        let mut output1_encrypted_amount_with_sign = [0u8; 32];
        output1_encrypted_amount_with_sign.copy_from_slice(&data[offset..offset + 32]);
        offset += 32;

        let mut output2_ephemeral_pub_x = [0u8; 32];
        output2_ephemeral_pub_x.copy_from_slice(&data[offset..offset + 32]);
        offset += 32;

        let mut output2_encrypted_amount_with_sign = [0u8; 32];
        output2_encrypted_amount_with_sign.copy_from_slice(&data[offset..offset + 32]);

        Ok(Self {
            proof,
            root,
            nullifier_hash,
            output_commitment_1,
            output_commitment_2,
            vk_hash,
            output1_ephemeral_pub_x,
            output1_encrypted_amount_with_sign,
            output2_ephemeral_pub_x,
            output2_encrypted_amount_with_sign,
        })
    }

    /// Extract encrypted amount from output1_encrypted_amount_with_sign (bits 0-63)
    pub fn get_output1_encrypted_amount(&self) -> [u8; 8] {
        let mut amount = [0u8; 8];
        amount.copy_from_slice(&self.output1_encrypted_amount_with_sign[0..8]);
        amount
    }

    /// Extract encrypted amount from output2_encrypted_amount_with_sign (bits 0-63)
    pub fn get_output2_encrypted_amount(&self) -> [u8; 8] {
        let mut amount = [0u8; 8];
        amount.copy_from_slice(&self.output2_encrypted_amount_with_sign[0..8]);
        amount
    }
}

/// Split commitment accounts (7 accounts)
///
/// 0. pool_state (writable)
/// 1. commitment_tree (writable)
/// 2. nullifier_record (writable)
/// 3. user (signer)
/// 4. system_program
/// 5. stealth_announcement_1 (writable) - StealthAnnouncement PDA for first output
/// 6. stealth_announcement_2 (writable) - StealthAnnouncement PDA for second output
pub struct SpendSplitAccounts<'a> {
    pub pool_state: &'a AccountInfo,
    pub commitment_tree: &'a AccountInfo,
    pub nullifier_record: &'a AccountInfo,
    pub user: &'a AccountInfo,
    pub system_program: &'a AccountInfo,
    pub stealth_announcement_1: &'a AccountInfo,
    pub stealth_announcement_2: &'a AccountInfo,
}

impl<'a> SpendSplitAccounts<'a> {
    pub const ACCOUNT_COUNT: usize = 7;

    pub fn from_accounts(accounts: &'a [AccountInfo]) -> Result<Self, ProgramError> {
        if accounts.len() < Self::ACCOUNT_COUNT {
            return Err(ProgramError::NotEnoughAccountKeys);
        }

        let pool_state = &accounts[0];
        let commitment_tree = &accounts[1];
        let nullifier_record = &accounts[2];
        let user = &accounts[3];
        let system_program = &accounts[4];
        let stealth_announcement_1 = &accounts[5];
        let stealth_announcement_2 = &accounts[6];

        // Validate user is signer
        if !user.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        Ok(Self {
            pool_state,
            commitment_tree,
            nullifier_record,
            user,
            system_program,
            stealth_announcement_1,
            stealth_announcement_2,
        })
    }
}

/// Process split commitment (1-in-2-out) with inline Groth16 proof verification
pub fn process_spend_split(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let accounts = SpendSplitAccounts::from_accounts(accounts)?;
    let ix_data = SpendSplitData::from_bytes(data)?;

    // SECURITY: Validate account owners BEFORE deserializing any data
    validate_program_owner(accounts.pool_state, program_id)?;
    validate_program_owner(accounts.commitment_tree, program_id)?;
    validate_system_program(accounts.system_program)?;

    // SECURITY: Validate writable accounts
    validate_account_writable(accounts.pool_state)?;
    validate_account_writable(accounts.commitment_tree)?;
    validate_account_writable(accounts.nullifier_record)?;
    validate_account_writable(accounts.stealth_announcement_1)?;
    validate_account_writable(accounts.stealth_announcement_2)?;

    // Verify stealth announcement PDA for first output
    // Ed25519 ephemeral pub is already 32 bytes, use directly as PDA seed
    let stealth_seeds_1: &[&[u8]] = &[StealthAnnouncement::SEED, &ix_data.output1_ephemeral_pub_x];
    let (expected_stealth_pda_1, stealth_bump_1) = find_program_address(stealth_seeds_1, program_id);
    if accounts.stealth_announcement_1.key() != &expected_stealth_pda_1 {
        crate::debug_msg!("Invalid stealth announcement PDA for first output");
        return Err(ProgramError::InvalidSeeds);
    }

    // Verify stealth announcement PDA for second output
    let stealth_seeds_2: &[&[u8]] = &[StealthAnnouncement::SEED, &ix_data.output2_ephemeral_pub_x];
    let (expected_stealth_pda_2, stealth_bump_2) = find_program_address(stealth_seeds_2, program_id);
    if accounts.stealth_announcement_2.key() != &expected_stealth_pda_2 {
        crate::debug_msg!("Invalid stealth announcement PDA for second output");
        return Err(ProgramError::InvalidSeeds);
    }

    // Verify root is valid in commitment tree
    {
        let tree_data = accounts.commitment_tree.try_borrow_data()?;
        let tree = CommitmentTree::from_bytes(&tree_data)?;

        if !tree.is_valid_root(&ix_data.root) {
            return Err(ZVaultError::InvalidRoot.into());
        }
    }

    // Verify nullifier PDA
    let nullifier_seeds: &[&[u8]] = &[NullifierRecord::SEED, &ix_data.nullifier_hash];
    let (expected_nullifier_pda, nullifier_bump) =
        find_program_address(nullifier_seeds, program_id);
    if accounts.nullifier_record.key() != &expected_nullifier_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // Get clock and rent for account creation
    let clock = Clock::get()?;
    let rent = Rent::get()?;

    // SECURITY: Create nullifier PDA FIRST to prevent race conditions
    {
        let nullifier_data_len = accounts.nullifier_record.data_len();
        if nullifier_data_len > 0 {
            let nullifier_data = accounts.nullifier_record.try_borrow_data()?;
            if !nullifier_data.is_empty() && nullifier_data[0] == NULLIFIER_RECORD_DISCRIMINATOR {
                return Err(ZVaultError::NullifierAlreadyUsed.into());
            }
        } else {
            let lamports = rent.minimum_balance(NullifierRecord::LEN);
            let bump_bytes = [nullifier_bump];
            let signer_seeds: &[&[u8]] = &[
                NullifierRecord::SEED,
                &ix_data.nullifier_hash,
                &bump_bytes,
            ];

            create_pda_account(
                accounts.user,
                accounts.nullifier_record,
                program_id,
                lamports,
                NullifierRecord::LEN as u64,
                signer_seeds,
            )?;
        }
    }

    // Verify Groth16 proof inline using BN254 pairing syscalls
    crate::debug_msg!("Verifying Groth16 split proof inline...");

    crate::utils::verify_groth16_split_proof(
        ix_data.proof,
        &ix_data.root,
        &ix_data.nullifier_hash,
        &ix_data.output_commitment_1,
        &ix_data.output_commitment_2,
    ).map_err(|_| {
        crate::debug_msg!("Groth16 split proof verification failed");
        ZVaultError::ZkVerificationFailed
    })?;

    crate::debug_msg!("Groth16 split proof verified");

    // Initialize nullifier record
    {
        let mut nullifier_data = accounts.nullifier_record.try_borrow_mut_data()?;
        let nullifier = NullifierRecord::init(&mut nullifier_data)?;

        nullifier
            .nullifier_hash
            .copy_from_slice(&ix_data.nullifier_hash);
        nullifier.set_spent_at(clock.unix_timestamp);
        nullifier
            .spent_by
            .copy_from_slice(accounts.user.key().as_ref());
        nullifier.set_operation_type(NullifierOperationType::Split);
    }

    // Update commitment tree with both new commitments and capture leaf indices
    let (leaf_index_1, leaf_index_2) = {
        let mut tree_data = accounts.commitment_tree.try_borrow_mut_data()?;
        let tree = CommitmentTree::from_bytes_mut(&mut tree_data)?;

        if tree.next_index() + 2 > (1u64 << 20) {
            return Err(ZVaultError::TreeFull.into());
        }

        let idx1 = tree.insert_leaf(&ix_data.output_commitment_1)?;
        let idx2 = tree.insert_leaf(&ix_data.output_commitment_2)?;
        (idx1, idx2)
    };

    // Create stealth announcement PDA for first output (if it doesn't exist)
    let stealth_account_1_data_len = accounts.stealth_announcement_1.data_len();
    if stealth_account_1_data_len > 0 {
        let ann_data = accounts.stealth_announcement_1.try_borrow_data()?;
        if ann_data[0] == STEALTH_ANNOUNCEMENT_DISCRIMINATOR {
            return Err(ProgramError::AccountAlreadyInitialized);
        }
    } else {
        let lamports = rent.minimum_balance(StealthAnnouncement::SIZE);

        let stealth_bump_1_bytes = [stealth_bump_1];
        let signer_seeds: &[&[u8]] = &[
            StealthAnnouncement::SEED,
            &ix_data.output1_ephemeral_pub_x,
            &stealth_bump_1_bytes,
        ];

        create_pda_account(
            accounts.user,
            accounts.stealth_announcement_1,
            program_id,
            lamports,
            StealthAnnouncement::SIZE as u64,
            signer_seeds,
        )?;
    }

    // Initialize stealth announcement for first output
    // Extract encrypted amount from the packed field (bits 0-63)
    let encrypted_amount_1 = ix_data.get_output1_encrypted_amount();
    {
        let mut ann_data = accounts.stealth_announcement_1.try_borrow_mut_data()?;
        let announcement = StealthAnnouncement::init(&mut ann_data)?;

        announcement.bump = stealth_bump_1;
        announcement.ephemeral_pub = ix_data.output1_ephemeral_pub_x;
        announcement.set_encrypted_amount(encrypted_amount_1);
        announcement.commitment.copy_from_slice(&ix_data.output_commitment_1);
        announcement.set_leaf_index(leaf_index_1);
        announcement.set_created_at(clock.unix_timestamp);
    }

    // Create stealth announcement PDA for second output (if it doesn't exist)
    let stealth_account_2_data_len = accounts.stealth_announcement_2.data_len();
    if stealth_account_2_data_len > 0 {
        let ann_data = accounts.stealth_announcement_2.try_borrow_data()?;
        if ann_data[0] == STEALTH_ANNOUNCEMENT_DISCRIMINATOR {
            return Err(ProgramError::AccountAlreadyInitialized);
        }
    } else {
        let lamports = rent.minimum_balance(StealthAnnouncement::SIZE);

        let stealth_bump_2_bytes = [stealth_bump_2];
        let signer_seeds: &[&[u8]] = &[
            StealthAnnouncement::SEED,
            &ix_data.output2_ephemeral_pub_x,
            &stealth_bump_2_bytes,
        ];

        create_pda_account(
            accounts.user,
            accounts.stealth_announcement_2,
            program_id,
            lamports,
            StealthAnnouncement::SIZE as u64,
            signer_seeds,
        )?;
    }

    // Initialize stealth announcement for second output
    let encrypted_amount_2 = ix_data.get_output2_encrypted_amount();
    {
        let mut ann_data = accounts.stealth_announcement_2.try_borrow_mut_data()?;
        let announcement = StealthAnnouncement::init(&mut ann_data)?;

        announcement.bump = stealth_bump_2;
        announcement.ephemeral_pub = ix_data.output2_ephemeral_pub_x;
        announcement.set_encrypted_amount(encrypted_amount_2);
        announcement.commitment.copy_from_slice(&ix_data.output_commitment_2);
        announcement.set_leaf_index(leaf_index_2);
        announcement.set_created_at(clock.unix_timestamp);
    }

    // Validate pool state and update statistics in a single mutable borrow
    {
        let mut pool_data = accounts.pool_state.try_borrow_mut_data()?;
        let pool = PoolState::from_bytes_mut(&mut pool_data)?;

        if pool.is_paused() {
            return Err(ZVaultError::PoolPaused.into());
        }

        let split_count = pool.split_count();
        pool.set_split_count(split_count.saturating_add(1));
        pool.set_last_update(clock.unix_timestamp);
    }

    crate::debug_msg!("Split completed (Groth16)");

    Ok(())
}
