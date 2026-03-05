//! Initialize instruction - sets up the Aegis pool

use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::{find_program_address, Pubkey},
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};

use crate::utils::{create_pda_account, validate_system_program, validate_token_2022_owner};

use crate::constants::{MAX_DEPOSIT_SATS, MIN_DEPOSIT_SATS};
use crate::error::AegisError;
use crate::state::{CommitmentTree, PoolState, POOL_STATE_DISCRIMINATOR};

/// Initialize instruction data
pub struct InitializeData {
    pub pool_bump: u8,
    pub tree_bump: u8,
}

impl InitializeData {
    pub fn from_bytes(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < 2 {
            return Err(ProgramError::InvalidInstructionData);
        }
        Ok(Self {
            pool_bump: data[0],
            tree_bump: data[1],
        })
    }
}

/// Initialize accounts
pub struct InitializeAccounts<'a> {
    pub pool_state: &'a AccountInfo,
    pub commitment_tree: &'a AccountInfo,
    pub zbtc_mint: &'a AccountInfo,
    pub pool_vault: &'a AccountInfo,
    pub frost_vault: &'a AccountInfo,
    pub authority: &'a AccountInfo,
    pub system_program: &'a AccountInfo,
}

impl<'a> InitializeAccounts<'a> {
    pub fn from_accounts(accounts: &'a [AccountInfo]) -> Result<Self, ProgramError> {
        if accounts.len() < 7 {
            return Err(ProgramError::NotEnoughAccountKeys);
        }

        let pool_state = &accounts[0];
        let commitment_tree = &accounts[1];
        let zbtc_mint = &accounts[2];
        let pool_vault = &accounts[3];
        let frost_vault = &accounts[4];
        let authority = &accounts[5];
        let system_program = &accounts[6];

        // Validate authority is signer
        if !authority.is_signer() {
            return Err(ProgramError::MissingRequiredSignature);
        }

        Ok(Self {
            pool_state,
            commitment_tree,
            zbtc_mint,
            pool_vault,
            frost_vault,
            authority,
            system_program,
        })
    }
}

/// Initialize the Aegis pool
pub fn process_initialize(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let accounts = InitializeAccounts::from_accounts(accounts)?;
    let _ix_data = InitializeData::from_bytes(data)?;

    // Validate zbtc_mint is owned by Token-2022
    validate_token_2022_owner(accounts.zbtc_mint)?;
    validate_system_program(accounts.system_program)?;

    // Verify pool_state PDA
    let pool_seeds: &[&[u8]] = &[PoolState::SEED];
    let (expected_pool_pda, pool_bump) = find_program_address(pool_seeds, program_id);
    if accounts.pool_state.key() != &expected_pool_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // Verify commitment_tree PDA
    let tree_seeds: &[&[u8]] = &[CommitmentTree::SEED];
    let (expected_tree_pda, tree_bump) = find_program_address(tree_seeds, program_id);
    if accounts.commitment_tree.key() != &expected_tree_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // Get rent for account sizes
    let rent = Rent::get()?;
    let pool_lamports = rent.minimum_balance(PoolState::LEN);
    let tree_lamports = rent.minimum_balance(CommitmentTree::LEN);

    // Check if pool_state already exists
    let pool_data_len = accounts.pool_state.data_len();

    if pool_data_len > 0 {
        // Account exists, check if initialized
        let pool_data = accounts.pool_state.try_borrow_data()?;
        if pool_data[0] == POOL_STATE_DISCRIMINATOR {
            return Err(AegisError::AlreadyInitialized.into());
        }
    } else {
        // Create pool_state PDA
        let pool_bump_bytes = [pool_bump];
        let pool_signer_seeds: &[&[u8]] = &[PoolState::SEED, &pool_bump_bytes];

        create_pda_account(
            accounts.authority,
            accounts.pool_state,
            program_id,
            pool_lamports,
            PoolState::LEN as u64,
            pool_signer_seeds,
        )?;
    }

    // Check if commitment_tree already exists
    let tree_data_len = accounts.commitment_tree.data_len();

    if tree_data_len == 0 {
        // Create commitment_tree PDA
        let tree_bump_bytes = [tree_bump];
        let tree_signer_seeds: &[&[u8]] = &[CommitmentTree::SEED, &tree_bump_bytes];

        create_pda_account(
            accounts.authority,
            accounts.commitment_tree,
            program_id,
            tree_lamports,
            CommitmentTree::LEN as u64,
            tree_signer_seeds,
        )?;
    }

    // Get clock for timestamp
    let clock = Clock::get()?;

    // Initialize pool state
    {
        let mut pool_data = accounts.pool_state.try_borrow_mut_data()?;
        let pool = PoolState::init(&mut pool_data)?;

        pool.bump = pool_bump;
        pool.authority.copy_from_slice(accounts.authority.key().as_ref());
        pool.zbtc_mint.copy_from_slice(accounts.zbtc_mint.key().as_ref());
        pool.pool_vault.copy_from_slice(accounts.pool_vault.key().as_ref());
        pool.frost_vault.copy_from_slice(accounts.frost_vault.key().as_ref());
        pool.set_min_deposit(MIN_DEPOSIT_SATS);
        pool.set_max_deposit(MAX_DEPOSIT_SATS);
        pool.set_last_update(clock.unix_timestamp);
        pool.set_paused(false);
    }

    // Initialize commitment tree
    {
        let mut tree_data = accounts.commitment_tree.try_borrow_mut_data()?;
        let tree = CommitmentTree::init(&mut tree_data)?;
        tree.bump = tree_bump;
    }

    Ok(())
}
