//! Spend Partial Public instruction (Groth16 - Client-Side ZK)
//!
//! Claims part of a commitment to a public wallet, with change returned as a new commitment.
//!
//! Input:  Unified Commitment = Poseidon2(pub_key_x, amount)
//! Output: Public transfer + Change Commitment = Poseidon2(change_pub_key_x, change_amount)
//!
//! ZK Proof: Groth16 (generated in browser via snarkjs or mobile via snarkjs)
//! Proof is verified inline using BN254 pairing syscalls.

use pinocchio::{
    account_info::AccountInfo,
    instruction::{Seed, Signer},
    program_error::ProgramError,
    pubkey::{find_program_address, Pubkey},
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;

use crate::error::ZVaultError;
use crate::state::{
    CommitmentTree, NullifierOperationType, NullifierRecord, PoolState,
    StealthAnnouncement, NULLIFIER_RECORD_DISCRIMINATOR, STEALTH_ANNOUNCEMENT_DISCRIMINATOR,
};
use crate::utils::{
    create_pda_account, transfer_zbtc,
    validate_account_writable, validate_program_owner, validate_system_program,
    validate_token_2022_owner, validate_token_program_key,
    verify_groth16_spend_partial_public_proof, GROTH16_PROOF_SIZE,
};


/// Spend partial public instruction data (inline Groth16 proof)
///
/// Layout:
/// - proof: [u8; 256] - Groth16 proof
/// - root: [u8; 32]
/// - nullifier_hash: [u8; 32]
/// - public_amount: u64
/// - change_commitment: [u8; 32]
/// - recipient: [u8; 32]
/// - vk_hash: [u8; 32]
/// - change_ephemeral_pub_x: [u8; 32] - x-coordinate of ephemeral pubkey
/// - change_encrypted_amount_with_sign: [u8; 32] - bits 0-63: encrypted amount, bit 64: y_sign
pub struct SpendPartialPublicData<'a> {
    pub proof: &'a [u8],
    pub root: &'a [u8; 32],
    pub nullifier_hash: &'a [u8; 32],
    pub public_amount: u64,
    pub change_commitment: &'a [u8; 32],
    pub recipient: &'a [u8; 32],
    pub vk_hash: &'a [u8; 32],
    pub change_ephemeral_pub_x: [u8; 32],
    pub change_encrypted_amount_with_sign: [u8; 32],
}

impl<'a> SpendPartialPublicData<'a> {
    /// Size: proof(256) + root(32) + nullifier(32) + amount(8) + change(32) + recipient(32) + vk_hash(32) + eph_x(32) + enc_amount(32) = 488 bytes
    pub const SIZE: usize = GROTH16_PROOF_SIZE + 32 + 32 + 8 + 32 + 32 + 32 + 32 + 32;

    pub fn from_bytes(data: &'a [u8]) -> Result<Self, ProgramError> {
        if data.len() < Self::SIZE {
            return Err(ProgramError::InvalidInstructionData);
        }

        let proof = &data[0..GROTH16_PROOF_SIZE];
        let mut offset = GROTH16_PROOF_SIZE;

        let root: &[u8; 32] = data[offset..offset + 32].try_into().unwrap();
        offset += 32;

        let nullifier_hash: &[u8; 32] = data[offset..offset + 32].try_into().unwrap();
        offset += 32;

        let public_amount = u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap());
        offset += 8;

        let change_commitment: &[u8; 32] = data[offset..offset + 32].try_into().unwrap();
        offset += 32;

        let recipient: &[u8; 32] = data[offset..offset + 32].try_into().unwrap();
        offset += 32;

        let vk_hash: &[u8; 32] = data[offset..offset + 32].try_into().unwrap();
        offset += 32;

        let mut change_ephemeral_pub_x = [0u8; 32];
        change_ephemeral_pub_x.copy_from_slice(&data[offset..offset + 32]);
        offset += 32;

        let mut change_encrypted_amount_with_sign = [0u8; 32];
        change_encrypted_amount_with_sign.copy_from_slice(&data[offset..offset + 32]);

        Ok(Self {
            proof,
            root,
            nullifier_hash,
            public_amount,
            change_commitment,
            recipient,
            vk_hash,
            change_ephemeral_pub_x,
            change_encrypted_amount_with_sign,
        })
    }

    /// Extract encrypted amount from change_encrypted_amount_with_sign (bits 0-63)
    pub fn get_change_encrypted_amount(&self) -> [u8; 8] {
        let mut amount = [0u8; 8];
        amount.copy_from_slice(&self.change_encrypted_amount_with_sign[0..8]);
        amount
    }
}

/// Spend partial public accounts (inline Groth16 - 10 accounts)
///
/// 0. pool_state (writable)
/// 1. commitment_tree (writable)
/// 2. nullifier_record (writable)
/// 3. zbtc_mint (readonly)
/// 4. pool_vault (writable)
/// 5. recipient_ata (writable)
/// 6. user (signer)
/// 7. token_program
/// 8. system_program
/// 9. stealth_announcement_change (writable) - StealthAnnouncement PDA for change output
pub struct SpendPartialPublicAccounts<'a> {
    pub pool_state: &'a AccountInfo,
    pub commitment_tree: &'a AccountInfo,
    pub nullifier_record: &'a AccountInfo,
    pub zbtc_mint: &'a AccountInfo,
    pub pool_vault: &'a AccountInfo,
    pub recipient_ata: &'a AccountInfo,
    pub user: &'a AccountInfo,
    pub token_program: &'a AccountInfo,
    pub system_program: &'a AccountInfo,
    pub stealth_announcement_change: &'a AccountInfo,
}

impl<'a> SpendPartialPublicAccounts<'a> {
    pub const ACCOUNT_COUNT: usize = 10;

    pub fn from_accounts(accounts: &'a [AccountInfo]) -> Result<Self, ProgramError> {
        if accounts.len() < Self::ACCOUNT_COUNT {
            return Err(ProgramError::NotEnoughAccountKeys);
        }

        let user = &accounts[6];
        if !user.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        Ok(Self {
            pool_state: &accounts[0],
            commitment_tree: &accounts[1],
            nullifier_record: &accounts[2],
            zbtc_mint: &accounts[3],
            pool_vault: &accounts[4],
            recipient_ata: &accounts[5],
            user,
            token_program: &accounts[7],
            system_program: &accounts[8],
            stealth_announcement_change: &accounts[9],
        })
    }
}

/// Process spend partial public instruction (Groth16 proof with SkipVerification)
///
/// Claims part of a commitment to a public wallet, with change returned as a new commitment.
/// Amount conservation: input_amount == public_amount + change_amount (enforced by ZK proof)
///
/// Uses SkipVerification pattern: verifier must be called in earlier instruction of same TX.
pub fn process_spend_partial_public(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let accounts = SpendPartialPublicAccounts::from_accounts(accounts)?;
    let ix_data = SpendPartialPublicData::from_bytes(data)?;

    // SECURITY: Validate account owners BEFORE deserializing any data
    validate_program_owner(accounts.pool_state, program_id)?;
    validate_program_owner(accounts.commitment_tree, program_id)?;
    validate_token_2022_owner(accounts.zbtc_mint)?;
    validate_token_2022_owner(accounts.pool_vault)?;
    validate_token_2022_owner(accounts.recipient_ata)?;
    validate_token_program_key(accounts.token_program)?;
    validate_system_program(accounts.system_program)?;

    // SECURITY: Validate writable accounts
    validate_account_writable(accounts.pool_state)?;
    validate_account_writable(accounts.commitment_tree)?;
    validate_account_writable(accounts.nullifier_record)?;
    validate_account_writable(accounts.pool_vault)?;
    validate_account_writable(accounts.recipient_ata)?;
    validate_account_writable(accounts.stealth_announcement_change)?;

    // Verify stealth announcement PDA for change output
    // Ed25519 ephemeral pub is already 32 bytes, use directly as PDA seed
    let stealth_seeds: &[&[u8]] = &[StealthAnnouncement::SEED, &ix_data.change_ephemeral_pub_x];
    let (expected_stealth_pda, stealth_bump) = find_program_address(stealth_seeds, program_id);
    if accounts.stealth_announcement_change.key() != &expected_stealth_pda {
        crate::debug_msg!("Invalid stealth announcement PDA for change output");
        return Err(ProgramError::InvalidSeeds);
    }

    // Validate public amount
    if ix_data.public_amount == 0 {
        return Err(ZVaultError::ZeroAmount.into());
    }

    // Verify root is valid in commitment tree
    {
        let tree_data = accounts.commitment_tree.try_borrow_data()?;
        let tree = CommitmentTree::from_bytes(&tree_data)?;

        if !tree.is_valid_root(ix_data.root) {
            return Err(ZVaultError::InvalidRoot.into());
        }
    }

    // Verify nullifier PDA
    let nullifier_seeds: &[&[u8]] = &[NullifierRecord::SEED, ix_data.nullifier_hash];
    let (expected_nullifier_pda, nullifier_bump) = find_program_address(nullifier_seeds, program_id);
    if accounts.nullifier_record.key() != &expected_nullifier_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // Check if nullifier already spent
    {
        let nullifier_data = accounts.nullifier_record.try_borrow_data()?;
        if !nullifier_data.is_empty() && nullifier_data[0] == NULLIFIER_RECORD_DISCRIMINATOR {
            return Err(ZVaultError::NullifierAlreadyUsed.into());
        }
    }

    // Get clock for timestamp
    let clock = Clock::get()?;

    // SECURITY: Create nullifier record FIRST to prevent race conditions
    let nullifier_bump_bytes = [nullifier_bump];
    let nullifier_signer_seeds: [Seed; 3] = [
        Seed::from(NullifierRecord::SEED),
        Seed::from(ix_data.nullifier_hash.as_slice()),
        Seed::from(&nullifier_bump_bytes),
    ];
    let nullifier_signer = [Signer::from(&nullifier_signer_seeds)];

    CreateAccount {
        from: accounts.user,
        to: accounts.nullifier_record,
        lamports: Rent::get()?.minimum_balance(NullifierRecord::LEN),
        space: NullifierRecord::LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&nullifier_signer)?;

    // Verify Groth16 proof inline
    crate::debug_msg!("Verifying Groth16 spend_partial_public proof...");

    verify_groth16_spend_partial_public_proof(
        ix_data.proof,
        ix_data.root,
        ix_data.nullifier_hash,
        ix_data.public_amount,
        ix_data.change_commitment,
        ix_data.recipient,
    )
    .map_err(|_| {
        crate::debug_msg!("Groth16 proof verification failed");
        ZVaultError::ZkVerificationFailed
    })?;

    crate::debug_msg!("Groth16 proof verified successfully");

    // Initialize nullifier record
    {
        let mut nullifier_data = accounts.nullifier_record.try_borrow_mut_data()?;
        let nullifier = NullifierRecord::init(&mut nullifier_data)?;

        nullifier.nullifier_hash.copy_from_slice(ix_data.nullifier_hash);
        nullifier.set_spent_at(clock.unix_timestamp);
        nullifier.spent_by.copy_from_slice(ix_data.recipient);
        nullifier.set_operation_type(NullifierOperationType::Transfer);
    }

    // Add change commitment to tree and capture leaf index
    let change_leaf_index = {
        let mut tree_data = accounts.commitment_tree.try_borrow_mut_data()?;
        let tree = CommitmentTree::from_bytes_mut(&mut tree_data)?;

        if tree.next_index() >= (1u64 << 20) {
            return Err(ZVaultError::TreeFull.into());
        }

        tree.insert_leaf(ix_data.change_commitment)?
    };

    // Create stealth announcement PDA for change output (if it doesn't exist)
    let stealth_account_data_len = accounts.stealth_announcement_change.data_len();
    if stealth_account_data_len > 0 {
        let ann_data = accounts.stealth_announcement_change.try_borrow_data()?;
        if ann_data[0] == STEALTH_ANNOUNCEMENT_DISCRIMINATOR {
            return Err(ProgramError::AccountAlreadyInitialized);
        }
    } else {
        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(StealthAnnouncement::SIZE);

        let stealth_bump_bytes = [stealth_bump];
        let signer_seeds: &[&[u8]] = &[
            StealthAnnouncement::SEED,
            &ix_data.change_ephemeral_pub_x,
            &stealth_bump_bytes,
        ];

        create_pda_account(
            accounts.user,
            accounts.stealth_announcement_change,
            program_id,
            lamports,
            StealthAnnouncement::SIZE as u64,
            signer_seeds,
        )?;
    }

    // Initialize stealth announcement for change output
    // Extract encrypted amount from the packed field (bits 0-63)
    let encrypted_amount_change = ix_data.get_change_encrypted_amount();
    {
        let mut ann_data = accounts.stealth_announcement_change.try_borrow_mut_data()?;
        let announcement = StealthAnnouncement::init(&mut ann_data)?;

        announcement.bump = stealth_bump;
        announcement.ephemeral_pub = ix_data.change_ephemeral_pub_x;
        announcement.set_encrypted_amount(encrypted_amount_change);
        announcement.commitment.copy_from_slice(ix_data.change_commitment);
        announcement.set_leaf_index(change_leaf_index);
        announcement.set_created_at(clock.unix_timestamp);
    }

    // Validate pool state and update in a single mutable borrow
    let pool_bump = {
        let mut pool_data = accounts.pool_state.try_borrow_mut_data()?;
        let pool = PoolState::from_bytes_mut(&mut pool_data)?;

        if pool.is_paused() {
            return Err(ZVaultError::PoolPaused.into());
        }

        // Validate public amount bounds (minimum 1000 sats)
        if ix_data.public_amount < 1000 {
            return Err(ZVaultError::AmountTooSmall.into());
        }
        if ix_data.public_amount > pool.total_shielded() {
            return Err(ZVaultError::InsufficientFunds.into());
        }

        let bump = pool.bump;
        pool.sub_shielded(ix_data.public_amount)?;
        pool.set_last_update(clock.unix_timestamp);
        bump
    };

    // Transfer public amount from pool vault to recipient's ATA
    let bump_bytes = [pool_bump];
    let pool_signer_seeds: &[&[u8]] = &[PoolState::SEED, &bump_bytes];

    transfer_zbtc(
        accounts.token_program,
        accounts.pool_vault,
        accounts.recipient_ata,
        accounts.pool_state,
        ix_data.public_amount,
        pool_signer_seeds,
    )?;

    crate::debug_msg!("Spent partial to public with change (Groth16)");

    Ok(())
}
