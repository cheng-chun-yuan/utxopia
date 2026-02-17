//! Initialize VK Registry instruction (Groth16)
//!
//! Creates and initializes a verification key hash registry for a specific circuit type.
//! The VK hash is used for CPI to the groth16 verifier program.
//!
//! # Security
//! - Only the pool authority can initialize VK registries
//! - Each circuit type has its own VK registry PDA
//! - VK hashes can be updated by authority (for circuit upgrades)

use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::{find_program_address, Pubkey},
    sysvars::{rent::Rent, Sysvar},
    ProgramResult,
};

use crate::error::ZVaultError;
use crate::state::{CircuitType, PoolState, VkRegistry, VK_REGISTRY_DISCRIMINATOR};
use crate::utils::{create_pda_account, validate_program_owner, validate_system_program};

/// Initialize VK Registry instruction data (Groth16)
///
/// Layout:
/// - circuit_type: u8 (which circuit this VK hash is for)
/// - vk_hash: [u8; 32] (Groth16 verification key hash)
pub struct InitVkRegistryData {
    pub circuit_type: u8,
    pub vk_hash: [u8; 32],
}

impl InitVkRegistryData {
    pub const SIZE: usize = 1 + 32; // 33 bytes

    pub fn from_bytes(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < Self::SIZE {
            return Err(ProgramError::InvalidInstructionData);
        }

        let circuit_type = data[0];

        // Validate circuit type
        if CircuitType::from_u8(circuit_type).is_none() {
            return Err(ProgramError::InvalidArgument);
        }

        let mut vk_hash = [0u8; 32];
        vk_hash.copy_from_slice(&data[1..33]);

        Ok(Self {
            circuit_type,
            vk_hash,
        })
    }
}

/// Initialize a VK registry account
///
/// Accounts:
/// 0. pool_state - Pool state PDA (to verify authority)
/// 1. vk_registry - VK registry PDA to create (writable)
/// 2. authority - Pool authority (signer, payer)
/// 3. system_program - System program
pub fn process_init_vk_registry(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let pool_state = &accounts[0];
    let vk_registry = &accounts[1];
    let authority = &accounts[2];
    let system_program = &accounts[3];

    let ix_data = InitVkRegistryData::from_bytes(data)?;

    // Validate authority is signer
    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Validate system program
    validate_system_program(system_program)?;

    // Validate pool state
    validate_program_owner(pool_state, program_id)?;

    // Verify authority matches pool
    {
        let pool_data = pool_state.try_borrow_data()?;
        let pool = PoolState::from_bytes(&pool_data)?;

        if authority.key().as_ref() != pool.authority {
            return Err(ZVaultError::Unauthorized.into());
        }
    }

    // Derive expected VK registry PDA
    let circuit_type_bytes = [ix_data.circuit_type];
    let seeds: &[&[u8]] = &[VkRegistry::SEED, &circuit_type_bytes];
    let (expected_pda, bump) = find_program_address(seeds, program_id);

    if vk_registry.key() != &expected_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // Check if already initialized
    let account_data_len = vk_registry.data_len();
    if account_data_len > 0 {
        let vk_data = vk_registry.try_borrow_data()?;
        if vk_data[0] == VK_REGISTRY_DISCRIMINATOR {
            return Err(ProgramError::AccountAlreadyInitialized);
        }
    } else {
        // Create the PDA account
        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(VkRegistry::SIZE);

        let bump_bytes = [bump];
        let signer_seeds: &[&[u8]] = &[VkRegistry::SEED, &circuit_type_bytes, &bump_bytes];

        create_pda_account(
            authority,
            vk_registry,
            program_id,
            lamports,
            VkRegistry::SIZE as u64,
            signer_seeds,
        )?;
    }

    // Initialize VK registry
    {
        let mut vk_data = vk_registry.try_borrow_mut_data()?;
        let registry = VkRegistry::init(&mut vk_data)?;

        registry.circuit_type = ix_data.circuit_type;
        registry.set_version(1);
        registry.authority.copy_from_slice(authority.key().as_ref());
        registry.vk_hash.copy_from_slice(&ix_data.vk_hash);
    }

    crate::debug_msg!("VK registry initialized (Groth16)");

    Ok(())
}

/// Update an existing VK registry (for circuit upgrades)
///
/// Accounts:
/// 0. vk_registry - VK registry PDA (writable)
/// 1. authority - Current authority (signer)
pub fn process_update_vk_registry(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let vk_registry = &accounts[0];
    let authority = &accounts[1];

    let ix_data = InitVkRegistryData::from_bytes(data)?;

    // Validate authority is signer
    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Validate VK registry
    validate_program_owner(vk_registry, program_id)?;

    // Update VK registry
    {
        let mut vk_data = vk_registry.try_borrow_mut_data()?;
        let registry = VkRegistry::from_bytes_mut(&mut vk_data)?;

        // Verify caller is authority
        if !registry.is_authority(authority.key().as_ref().try_into().unwrap()) {
            return Err(ZVaultError::Unauthorized.into());
        }

        // Verify circuit type matches
        if registry.circuit_type != ix_data.circuit_type {
            return Err(ProgramError::InvalidArgument);
        }

        // Update VK hash
        let new_version = registry.version().saturating_add(1);
        registry.set_version(new_version);
        registry.vk_hash.copy_from_slice(&ix_data.vk_hash);
    }

    crate::debug_msg!("VK registry updated (Groth16)");

    Ok(())
}
