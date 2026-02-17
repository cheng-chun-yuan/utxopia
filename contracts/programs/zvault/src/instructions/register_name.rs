//! Register Name instruction
//!
//! Registers a human-readable .zkey name for a stealth address.
//! Example: "albert.zkey" → (spendingPubKey, viewingPubKey)
//!
//! Also creates a reverse lookup account (SNS pattern) to enable:
//! - Forward: hash(name) → NameRegistry → stealth address
//! - Reverse: spending_pubkey → ReverseRegistry → name
//!
//! This is OPTIONAL - users who want maximum privacy should share
//! their stealth meta-address off-chain instead.

use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::{find_program_address, Pubkey},
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};

use crate::utils::{create_pda_account, validate_system_program};

use crate::state::{
    NameRegistry, NAME_REGISTRY_DISCRIMINATOR, validate_name,
    ReverseRegistry, REVERSE_REGISTRY_DISCRIMINATOR,
};

/// Register name instruction data
/// Layout:
/// - name_len: u8 (length of name)
/// - name: [u8; name_len] (the name without .zkey suffix)
/// - spending_pubkey: [u8; 32] (Baby Jubjub compressed)
/// - viewing_pubkey: [u8; 32] (Ed25519)
pub struct RegisterNameData {
    pub name: Vec<u8>,
    pub name_hash: [u8; 32],
    pub spending_pubkey: [u8; 32],
    pub viewing_pubkey: [u8; 32],
}

impl RegisterNameData {
    pub fn from_bytes(data: &[u8]) -> Result<Self, ProgramError> {
        if data.is_empty() {
            return Err(ProgramError::InvalidInstructionData);
        }

        let name_len = data[0] as usize;
        if data.len() < 1 + name_len + 32 + 32 + 32 {
            return Err(ProgramError::InvalidInstructionData);
        }

        let name = data[1..1 + name_len].to_vec();

        // Validate name format
        validate_name(&name)?;

        let mut name_hash = [0u8; 32];
        name_hash.copy_from_slice(&data[1 + name_len..1 + name_len + 32]);

        let mut spending_pubkey = [0u8; 32];
        spending_pubkey.copy_from_slice(&data[1 + name_len + 32..1 + name_len + 32 + 32]);

        let mut viewing_pubkey = [0u8; 32];
        viewing_pubkey.copy_from_slice(&data[1 + name_len + 32 + 32..1 + name_len + 32 + 32 + 32]);

        Ok(Self {
            name,
            name_hash,
            spending_pubkey,
            viewing_pubkey,
        })
    }
}

/// Update name instruction data (only owner can update)
/// Layout:
/// - name_hash: [u8; 32] (to identify the registry)
/// - spending_pubkey: [u8; 32] (new Baby Jubjub key)
/// - viewing_pubkey: [u8; 32] (new Ed25519 key)
pub struct UpdateNameData {
    pub name_hash: [u8; 32],
    pub spending_pubkey: [u8; 32],
    pub viewing_pubkey: [u8; 32],
}

impl UpdateNameData {
    pub fn from_bytes(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < 32 + 32 + 32 {
            return Err(ProgramError::InvalidInstructionData);
        }

        let mut name_hash = [0u8; 32];
        name_hash.copy_from_slice(&data[0..32]);

        let mut spending_pubkey = [0u8; 32];
        spending_pubkey.copy_from_slice(&data[32..64]);

        let mut viewing_pubkey = [0u8; 32];
        viewing_pubkey.copy_from_slice(&data[64..96]);

        Ok(Self {
            name_hash,
            spending_pubkey,
            viewing_pubkey,
        })
    }
}

/// Register a .zkey name
///
/// Creates a PDA seeded by the name hash that stores the stealth address.
/// Also creates a reverse lookup PDA seeded by spending_pubkey for name resolution.
/// The registering wallet becomes the owner and can update the keys later.
///
/// Accounts:
/// 0. name_registry (PDA to create, seed: ["zkey", name_hash])
/// 1. reverse_registry (PDA to create, seed: ["reverse", spending_pubkey])
/// 2. owner (signer, pays rent, becomes owner)
/// 3. system_program
pub fn process_register_name(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let name_registry = &accounts[0];
    let reverse_registry = &accounts[1];
    let owner = &accounts[2];
    let system_program = &accounts[3];

    let ix_data = RegisterNameData::from_bytes(data)?;

    // Validate owner is signer
    if !owner.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Validate system program
    validate_system_program(system_program)?;

    // Verify name registry PDA (seeded by name_hash)
    let name_seeds: &[&[u8]] = &[NameRegistry::SEED, &ix_data.name_hash];
    let (expected_name_pda, name_bump) = find_program_address(name_seeds, program_id);
    if name_registry.key() != &expected_name_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // Verify reverse registry PDA (seeded by spending_pubkey)
    // Baby Jubjub compressed key is already 32 bytes
    let reverse_seeds: &[&[u8]] = &[ReverseRegistry::SEED, &ix_data.spending_pubkey];
    let (expected_reverse_pda, reverse_bump) = find_program_address(reverse_seeds, program_id);
    if reverse_registry.key() != &expected_reverse_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // Check if name already exists
    let name_account_len = name_registry.data_len();
    if name_account_len > 0 {
        let reg_data = name_registry.try_borrow_data()?;
        if reg_data[0] == NAME_REGISTRY_DISCRIMINATOR {
            return Err(ProgramError::AccountAlreadyInitialized);
        }
    }

    // Check if spending key already has a name (one name per key)
    let reverse_account_len = reverse_registry.data_len();
    if reverse_account_len > 0 {
        let rev_data = reverse_registry.try_borrow_data()?;
        if rev_data[0] == REVERSE_REGISTRY_DISCRIMINATOR {
            // This spending key already has a registered name
            return Err(ProgramError::AccountAlreadyInitialized);
        }
    }

    let rent = Rent::get()?;
    let clock = Clock::get()?;

    // Create name registry account
    if name_account_len == 0 {
        let lamports = rent.minimum_balance(NameRegistry::SIZE);
        let name_bump_bytes = [name_bump];
        let name_signer_seeds: &[&[u8]] = &[
            NameRegistry::SEED,
            &ix_data.name_hash,
            &name_bump_bytes,
        ];

        create_pda_account(
            owner,
            name_registry,
            program_id,
            lamports,
            NameRegistry::SIZE as u64,
            name_signer_seeds,
        )?;
    }

    // Create reverse registry account
    if reverse_account_len == 0 {
        let lamports = rent.minimum_balance(ReverseRegistry::SIZE);
        let reverse_bump_bytes = [reverse_bump];
        // Use the spending pubkey as PDA seed (already 32 bytes)
        let reverse_signer_seeds: &[&[u8]] = &[
            ReverseRegistry::SEED,
            &ix_data.spending_pubkey,
            &reverse_bump_bytes,
        ];

        create_pda_account(
            owner,
            reverse_registry,
            program_id,
            lamports,
            ReverseRegistry::SIZE as u64,
            reverse_signer_seeds,
        )?;
    }

    // Initialize name registry
    {
        let mut reg_data = name_registry.try_borrow_mut_data()?;
        let registry = NameRegistry::init(&mut reg_data)?;

        registry.bump = name_bump;
        registry.name_hash = ix_data.name_hash;
        registry.owner.copy_from_slice(owner.key().as_ref());
        registry.spending_pubkey = ix_data.spending_pubkey;
        registry.viewing_pubkey = ix_data.viewing_pubkey;
        registry.set_created_at(clock.unix_timestamp);
        registry.set_updated_at(clock.unix_timestamp);
    }

    // Initialize reverse registry (stores actual name for lookup)
    {
        let mut rev_data = reverse_registry.try_borrow_mut_data()?;
        let reverse = ReverseRegistry::init(&mut rev_data)?;

        reverse.bump = reverse_bump;
        reverse.spending_pubkey = ix_data.spending_pubkey;
        reverse.set_name(&ix_data.name)?;
    }

    Ok(())
}

/// Update a .zkey name's keys
///
/// Only the owner can update the keys. This allows key rotation
/// without losing the name.
///
/// Accounts:
/// 0. name_registry (PDA to update)
/// 1. owner (signer, must match registry owner)
pub fn process_update_name(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let name_registry = &accounts[0];
    let owner = &accounts[1];

    let ix_data = UpdateNameData::from_bytes(data)?;

    // Validate owner is signer
    if !owner.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Verify PDA
    let seeds: &[&[u8]] = &[NameRegistry::SEED, &ix_data.name_hash];
    let (expected_pda, _bump) = find_program_address(seeds, program_id);
    if name_registry.key() != &expected_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    let clock = Clock::get()?;

    // Update registry
    {
        let mut reg_data = name_registry.try_borrow_mut_data()?;
        let registry = NameRegistry::from_bytes_mut(&mut reg_data)?;

        // Verify caller is owner
        let mut owner_bytes = [0u8; 32];
        owner_bytes.copy_from_slice(owner.key().as_ref());
        if !registry.is_owner(&owner_bytes) {
            return Err(ProgramError::IllegalOwner);
        }

        // Update keys
        registry.spending_pubkey = ix_data.spending_pubkey;
        registry.viewing_pubkey = ix_data.viewing_pubkey;
        registry.set_updated_at(clock.unix_timestamp);
    }

    Ok(())
}

/// Transfer ownership of a .zkey name
///
/// Accounts:
/// 0. name_registry (PDA)
/// 1. current_owner (signer)
/// 2. new_owner (new owner pubkey)
pub fn process_transfer_name(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let name_registry = &accounts[0];
    let current_owner = &accounts[1];
    let new_owner = &accounts[2];

    // Validate current owner is signer
    if !current_owner.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Parse name_hash from data
    if data.len() < 32 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut name_hash = [0u8; 32];
    name_hash.copy_from_slice(&data[0..32]);

    // Verify PDA
    let seeds: &[&[u8]] = &[NameRegistry::SEED, &name_hash];
    let (expected_pda, _bump) = find_program_address(seeds, program_id);
    if name_registry.key() != &expected_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    let clock = Clock::get()?;

    // Transfer ownership
    {
        let mut reg_data = name_registry.try_borrow_mut_data()?;
        let registry = NameRegistry::from_bytes_mut(&mut reg_data)?;

        // Verify caller is current owner
        let mut owner_bytes = [0u8; 32];
        owner_bytes.copy_from_slice(current_owner.key().as_ref());
        if !registry.is_owner(&owner_bytes) {
            return Err(ProgramError::IllegalOwner);
        }

        // Transfer to new owner
        registry.owner.copy_from_slice(new_owner.key().as_ref());
        registry.set_updated_at(clock.unix_timestamp);
    }

    Ok(())
}
