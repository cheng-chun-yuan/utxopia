//! Claim instruction (Groth16 - Client-Side ZK)
//!
//! Claims a unified commitment to a public Solana wallet.
//! Input:  Commitment = Poseidon2(pub_key_x, amount)
//! Output: zkBTC transferred to recipient's ATA (amount revealed)
//!
//! ZK Proof: Groth16 (generated in browser via snarkjs)
//!
//! Groth16 proofs are ~256 bytes, always fit inline (no buffer mode needed).
//!
//! Flow:
//! 1. User generates Groth16 proof client-side (no backend)
//! 2. Contract verifies proof via solana-bn254 pairing check
//! 3. Nullifier is recorded (prevents double-spend)
//! 4. zkBTC is transferred from pool vault to recipient's ATA

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
    NULLIFIER_RECORD_DISCRIMINATOR,
};
use crate::utils::{
    transfer_zbtc, validate_account_writable, validate_program_owner, validate_system_program,
    validate_token_2022_owner, validate_token_program_key, verify_groth16_claim_proof,
    GROTH16_PROOF_SIZE,
};

/// Claim instruction data (Groth16 proof - fixed size)
///
/// Layout:
/// - proof: [u8; 256] - Groth16 proof (2 G1 + 1 G2 point)
/// - root: [u8; 32] - Merkle tree root
/// - nullifier_hash: [u8; 32] - Nullifier to prevent double-spend
/// - amount_sats: u64 - Amount to claim (revealed)
/// - recipient: [u8; 32] - Recipient Solana wallet address
/// - vk_hash: [u8; 32] - Verification key hash
pub struct ClaimData<'a> {
    pub proof: &'a [u8],
    pub root: [u8; 32],
    pub nullifier_hash: [u8; 32],
    pub amount_sats: u64,
    pub recipient: [u8; 32],
    pub vk_hash: [u8; 32],
}

impl<'a> ClaimData<'a> {
    /// Data size: proof(256) + root(32) + nullifier(32) + amount(8) + recipient(32) + vk_hash(32) = 392 bytes
    pub const SIZE: usize = GROTH16_PROOF_SIZE + 32 + 32 + 8 + 32 + 32;

    pub fn from_bytes(data: &'a [u8]) -> Result<Self, ProgramError> {
        if data.len() < Self::SIZE {
            return Err(ProgramError::InvalidInstructionData);
        }

        let proof = &data[0..GROTH16_PROOF_SIZE];
        let mut offset = GROTH16_PROOF_SIZE;

        let mut root = [0u8; 32];
        root.copy_from_slice(&data[offset..offset + 32]);
        offset += 32;

        let mut nullifier_hash = [0u8; 32];
        nullifier_hash.copy_from_slice(&data[offset..offset + 32]);
        offset += 32;

        let amount_sats = u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap());
        offset += 8;

        let mut recipient = [0u8; 32];
        recipient.copy_from_slice(&data[offset..offset + 32]);
        offset += 32;

        let mut vk_hash = [0u8; 32];
        vk_hash.copy_from_slice(&data[offset..offset + 32]);

        Ok(Self {
            proof,
            root,
            nullifier_hash,
            amount_sats,
            recipient,
            vk_hash,
        })
    }
}

/// Claim accounts (9 accounts)
///
/// 0. pool_state (writable) - Pool state PDA
/// 1. commitment_tree (readonly) - Commitment tree for root validation
/// 2. nullifier_record (writable) - Nullifier PDA (created)
/// 3. zbtc_mint (writable) - zBTC Token-2022 mint
/// 4. pool_vault (writable) - Pool vault holding zBTC
/// 5. recipient_ata (writable) - Recipient's associated token account
/// 6. user (signer) - Transaction fee payer
/// 7. token_program - Token-2022 program
/// 8. system_program - System program
pub struct ClaimAccounts<'a> {
    pub pool_state: &'a AccountInfo,
    pub commitment_tree: &'a AccountInfo,
    pub nullifier_record: &'a AccountInfo,
    pub zbtc_mint: &'a AccountInfo,
    pub pool_vault: &'a AccountInfo,
    pub recipient_ata: &'a AccountInfo,
    pub user: &'a AccountInfo,
    pub token_program: &'a AccountInfo,
    pub system_program: &'a AccountInfo,
}

impl<'a> ClaimAccounts<'a> {
    pub fn from_accounts(
        accounts: &'a [AccountInfo],
    ) -> Result<Self, ProgramError> {
        if accounts.len() < 9 {
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
        })
    }
}

/// Process claim instruction (Groth16 proof)
///
/// Claims zkBTC directly to a Solana wallet, revealing the amount.
/// Proof is verified inline via solana-bn254 pairing check.
pub fn process_claim(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let accounts = ClaimAccounts::from_accounts(accounts)?;
    let ix_data = ClaimData::from_bytes(data)?;

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
    validate_account_writable(accounts.nullifier_record)?;
    validate_account_writable(accounts.pool_vault)?;
    validate_account_writable(accounts.recipient_ata)?;

    // Validate amount
    if ix_data.amount_sats == 0 {
        return Err(ZVaultError::ZeroAmount.into());
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

    // Check if nullifier already spent
    {
        let nullifier_data = accounts.nullifier_record.try_borrow_data()?;
        if !nullifier_data.is_empty() && nullifier_data[0] == NULLIFIER_RECORD_DISCRIMINATOR {
            return Err(ZVaultError::NullifierAlreadyUsed.into());
        }
    }

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
    crate::debug_msg!("Verifying Groth16 claim proof...");

    verify_groth16_claim_proof(
        ix_data.proof,
        &ix_data.root,
        &ix_data.nullifier_hash,
        ix_data.amount_sats,
        &ix_data.recipient,
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

        nullifier
            .nullifier_hash
            .copy_from_slice(&ix_data.nullifier_hash);
        nullifier.set_spent_at(clock.unix_timestamp);
        nullifier.spent_by.copy_from_slice(&ix_data.recipient);
        nullifier.set_operation_type(NullifierOperationType::Transfer);
    }

    // Validate pool state and update in a single mutable borrow
    let pool_bump = {
        let mut pool_data = accounts.pool_state.try_borrow_mut_data()?;
        let pool = PoolState::from_bytes_mut(&mut pool_data)?;

        if pool.is_paused() {
            return Err(ZVaultError::PoolPaused.into());
        }

        let min_deposit = pool.min_deposit();
        let total_shielded = pool.total_shielded();

        if ix_data.amount_sats < min_deposit {
            return Err(ZVaultError::AmountTooSmall.into());
        }
        if ix_data.amount_sats > total_shielded {
            return Err(ZVaultError::InsufficientFunds.into());
        }

        let bump = pool.bump;
        pool.sub_shielded(ix_data.amount_sats)?;
        pool.increment_direct_claims()?;
        pool.set_last_update(clock.unix_timestamp);
        bump
    };

    // Transfer zBTC from pool vault to recipient's ATA
    let bump_bytes = [pool_bump];
    let pool_signer_seeds: &[&[u8]] = &[PoolState::SEED, &bump_bytes];

    transfer_zbtc(
        accounts.token_program,
        accounts.pool_vault,
        accounts.recipient_ata,
        accounts.pool_state,
        ix_data.amount_sats,
        pool_signer_seeds,
    )?;

    crate::debug_msg!("Claimed sats to public wallet (Groth16)");

    Ok(())
}
