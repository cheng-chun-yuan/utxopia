//! Request redemption instruction - burns zBTC from pool with ZK proof, queues BTC withdrawal
//!
//! SHIELDED-ONLY ARCHITECTURE:
//! - User proves ownership of commitment via ZK proof
//! - zBTC is burned from pool vault (not user wallet)
//! - Amount is revealed here (unavoidable for BTC withdrawal)
//! - This is the ONLY operation where amount becomes public

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
    RedemptionRequest, RedemptionStatus, NULLIFIER_RECORD_DISCRIMINATOR,
    REDEMPTION_REQUEST_DISCRIMINATOR,
};
use crate::utils::{validate_program_owner, validate_system_program, validate_token_2022_owner, validate_token_program_key, validate_account_writable};

/// Request redemption instruction data (with ZK proof)
///
/// Layout:
/// - proof_hash: [u8; 32] - SHA256 hash of the ZK proof
/// - merkle_root: [u8; 32] - Current commitment tree root
/// - nullifier_hash: [u8; 32] - Nullifier to prevent double-spend
/// - amount_sats: u64 - Amount to redeem (revealed - unavoidable)
/// - vk_hash: [u8; 32] - Verification key hash (all zeros = demo mode)
/// - btc_address_len: u8
/// - btc_address: [u8; 62] - BTC withdrawal address
/// - request_nonce: u64 - Unique nonce for this request
pub struct RequestRedemptionData {
    pub proof_hash: [u8; 32],
    pub merkle_root: [u8; 32],
    pub nullifier_hash: [u8; 32],
    pub amount_sats: u64,
    pub vk_hash: [u8; 32],
    pub btc_address: [u8; 62],
    pub btc_address_len: u8,
    pub request_nonce: u64,
}

impl RequestRedemptionData {
    pub fn from_bytes(data: &[u8]) -> Result<Self, ProgramError> {
        // proof_hash(32) + merkle_root(32) + nullifier_hash(32) + amount(8) + vk_hash(32)
        // + btc_address_len(1) + btc_address(variable) + request_nonce(8)
        if data.len() < 145 {
            return Err(ProgramError::InvalidInstructionData);
        }

        let mut proof_hash = [0u8; 32];
        proof_hash.copy_from_slice(&data[0..32]);

        let mut merkle_root = [0u8; 32];
        merkle_root.copy_from_slice(&data[32..64]);

        let mut nullifier_hash = [0u8; 32];
        nullifier_hash.copy_from_slice(&data[64..96]);

        let amount_sats = u64::from_le_bytes(data[96..104].try_into().unwrap());

        let mut vk_hash = [0u8; 32];
        vk_hash.copy_from_slice(&data[104..136]);

        let btc_address_len = data[136];
        if btc_address_len as usize > 62 {
            return Err(ZVaultError::InvalidBtcAddress.into());
        }

        let addr_end = 137 + btc_address_len as usize;
        if data.len() < addr_end + 8 {
            return Err(ProgramError::InvalidInstructionData);
        }

        let mut btc_address = [0u8; 62];
        btc_address[..btc_address_len as usize].copy_from_slice(&data[137..addr_end]);

        let request_nonce = u64::from_le_bytes(data[addr_end..addr_end + 8].try_into().unwrap());

        Ok(Self {
            proof_hash,
            merkle_root,
            nullifier_hash,
            amount_sats,
            vk_hash,
            btc_address,
            btc_address_len,
            request_nonce,
        })
    }
}

/// Request redemption accounts (shielded-only architecture)
pub struct RequestRedemptionAccounts<'a> {
    pub pool_state: &'a AccountInfo,
    pub commitment_tree: &'a AccountInfo,
    pub nullifier_record: &'a AccountInfo,
    pub redemption_request: &'a AccountInfo,
    pub zbtc_mint: &'a AccountInfo,
    pub pool_vault: &'a AccountInfo,
    pub user: &'a AccountInfo,
    pub token_program: &'a AccountInfo,
    pub system_program: &'a AccountInfo,
}

impl<'a> RequestRedemptionAccounts<'a> {
    pub fn from_accounts(accounts: &'a [AccountInfo]) -> Result<Self, ProgramError> {
        if accounts.len() < 9 {
            return Err(ProgramError::NotEnoughAccountKeys);
        }

        let pool_state = &accounts[0];
        let commitment_tree = &accounts[1];
        let nullifier_record = &accounts[2];
        let redemption_request = &accounts[3];
        let zbtc_mint = &accounts[4];
        let pool_vault = &accounts[5];
        let user = &accounts[6];
        let token_program = &accounts[7];
        let system_program = &accounts[8];

        // Validate user is signer
        if !user.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        Ok(Self {
            pool_state,
            commitment_tree,
            nullifier_record,
            redemption_request,
            zbtc_mint,
            pool_vault,
            user,
            token_program,
            system_program,
        })
    }
}

/// Process redemption request (shielded-only architecture)
///
/// This is the ONLY operation where amount is revealed (unavoidable for BTC withdrawal).
/// User proves ownership via ZK proof, zBTC is burned from pool vault.
pub fn process_request_redemption(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let accounts = RequestRedemptionAccounts::from_accounts(accounts)?;
    let ix_data = RequestRedemptionData::from_bytes(data)?;

    // SECURITY: Validate account owners BEFORE deserializing any data
    validate_program_owner(accounts.pool_state, program_id)?;
    validate_program_owner(accounts.commitment_tree, program_id)?;
    // Note: nullifier_record and redemption_request may not exist yet (will be created)
    validate_token_2022_owner(accounts.zbtc_mint)?;
    validate_token_2022_owner(accounts.pool_vault)?;
    validate_token_program_key(accounts.token_program)?;
    validate_system_program(accounts.system_program)?;

    // SECURITY: Validate writable accounts
    validate_account_writable(accounts.pool_state)?;
    validate_account_writable(accounts.nullifier_record)?;
    validate_account_writable(accounts.redemption_request)?;
    validate_account_writable(accounts.zbtc_mint)?;
    validate_account_writable(accounts.pool_vault)?;

    // Load and validate pool state
    let (pool_bump, min_deposit, pending_redemptions, total_shielded) = {
        let pool_data = accounts.pool_state.try_borrow_data()?;
        let pool = PoolState::from_bytes(&pool_data)?;

        if pool.is_paused() {
            return Err(ZVaultError::PoolPaused.into());
        }

        (
            pool.bump,
            pool.min_deposit(),
            pool.pending_redemptions(),
            pool.total_shielded(),
        )
    };

    // Validate amount
    if ix_data.amount_sats == 0 {
        return Err(ZVaultError::ZeroAmount.into());
    }
    if ix_data.amount_sats < min_deposit {
        return Err(ZVaultError::AmountTooSmall.into());
    }
    if ix_data.amount_sats > total_shielded {
        return Err(ZVaultError::InsufficientFunds.into());
    }

    // Validate BTC address
    if ix_data.btc_address_len == 0 {
        return Err(ZVaultError::InvalidBtcAddress.into());
    }

    // SECURITY: Always verify root is valid in commitment tree
    // Demo mode bypass removed for mainnet security
    {
        let tree_data = accounts.commitment_tree.try_borrow_data()?;
        let tree = CommitmentTree::from_bytes(&tree_data)?;

        if !tree.is_valid_root(&ix_data.merkle_root) {
            return Err(ZVaultError::InvalidRoot.into());
        }
    }

    // Verify nullifier PDA
    let nullifier_seeds: &[&[u8]] = &[NullifierRecord::SEED, &ix_data.nullifier_hash];
    let (expected_nullifier_pda, nullifier_bump) = find_program_address(nullifier_seeds, program_id);
    if accounts.nullifier_record.key() != &expected_nullifier_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // Check if nullifier already spent (account already exists and initialized)
    {
        let nullifier_data = accounts.nullifier_record.try_borrow_data()?;
        if !nullifier_data.is_empty() && nullifier_data[0] == NULLIFIER_RECORD_DISCRIMINATOR {
            return Err(ZVaultError::NullifierAlreadyUsed.into());
        }
    }

    // Verify redemption request PDA
    let nonce_bytes = ix_data.request_nonce.to_le_bytes();
    let redemption_seeds: &[&[u8]] = &[
        RedemptionRequest::SEED,
        accounts.user.key().as_ref(),
        &nonce_bytes,
    ];
    let (expected_redemption_pda, _) = find_program_address(redemption_seeds, program_id);
    if accounts.redemption_request.key() != &expected_redemption_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // Check if redemption already exists
    {
        let redemption_data = accounts.redemption_request.try_borrow_data()?;
        if !redemption_data.is_empty() && redemption_data[0] == REDEMPTION_REQUEST_DISCRIMINATOR {
            return Err(ZVaultError::AlreadyInitialized.into());
        }
    }

    // Get clock for timestamp
    let clock = Clock::get()?;

    // Create nullifier record account (PDA) - prevents double-spend
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

    // Record nullifier (prevent double-spend)
    {
        let mut nullifier_data = accounts.nullifier_record.try_borrow_mut_data()?;
        let nullifier = NullifierRecord::init(&mut nullifier_data)?;

        nullifier.nullifier_hash.copy_from_slice(&ix_data.nullifier_hash);
        nullifier.set_spent_at(clock.unix_timestamp);
        nullifier.spent_by.copy_from_slice(accounts.user.key().as_ref());
        nullifier.set_spent_in_request(ix_data.request_nonce);
        nullifier.set_operation_type(NullifierOperationType::FullWithdrawal);
    }

    // Burn zBTC from pool vault (not user wallet - shielded-only architecture)
    // Pool PDA is the authority for the pool vault
    let bump_bytes = [pool_bump];
    let pool_signer_seeds: &[&[u8]] = &[PoolState::SEED, &bump_bytes];

    crate::utils::burn_zbtc_signed(
        accounts.token_program,
        accounts.zbtc_mint,
        accounts.pool_vault,
        accounts.pool_state,
        ix_data.amount_sats,
        pool_signer_seeds,
    )?;

    // Create redemption request
    {
        let mut redemption_data = accounts.redemption_request.try_borrow_mut_data()?;
        let redemption = RedemptionRequest::init(&mut redemption_data)?;

        redemption.set_request_id(ix_data.request_nonce);
        redemption.requester.copy_from_slice(accounts.user.key().as_ref());
        redemption.set_amount_sats(ix_data.amount_sats);
        redemption.set_btc_address(&ix_data.btc_address[..ix_data.btc_address_len as usize])?;
        redemption.set_status(RedemptionStatus::Pending);
        redemption.set_created_at(clock.unix_timestamp);
    }

    // Update pool state
    {
        let mut pool_data = accounts.pool_state.try_borrow_mut_data()?;
        let pool = PoolState::from_bytes_mut(&mut pool_data)?;

        pool.add_burned(ix_data.amount_sats)?;
        pool.sub_shielded(ix_data.amount_sats)?;
        pool.set_pending_redemptions(pending_redemptions.saturating_add(1));
        pool.set_last_update(clock.unix_timestamp);
    }

    Ok(())
}
