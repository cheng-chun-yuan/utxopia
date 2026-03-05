//! Account validation utilities for security checks
//!
//! CRITICAL: These functions must be called BEFORE deserializing any account data.
//! Without owner validation, attackers can pass fake accounts with crafted data.

use pinocchio::{
    account_info::AccountInfo,
    instruction::{Seed, Signer},
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

use crate::constants::TOKEN_2022_PROGRAM_ID;
use crate::error::AegisError;

// ============================================================================
// PDA CREATION HELPER (shared across all instructions)
// ============================================================================

/// Create a PDA account via CPI to system program
///
/// This is a shared helper to eliminate duplication across instruction files.
/// Previously duplicated in: announce_stealth, transfer_stealth, add_demo_stealth,
/// initialize (shared across instruction files, ~100 lines saved)
#[inline]
pub fn create_pda_account<'a>(
    payer: &'a AccountInfo,
    pda_account: &'a AccountInfo,
    program_id: &Pubkey,
    lamports: u64,
    space: u64,
    signer_seeds: &[&[u8]],
) -> ProgramResult {
    let create_account = pinocchio_system::instructions::CreateAccount {
        from: payer,
        to: pda_account,
        lamports,
        space,
        owner: program_id,
    };

    // Convert seeds to Pinocchio format
    let seeds: [Seed; 4] = [
        if !signer_seeds.is_empty() { Seed::from(signer_seeds[0]) } else { Seed::from(&[][..]) },
        if signer_seeds.len() > 1 { Seed::from(signer_seeds[1]) } else { Seed::from(&[][..]) },
        if signer_seeds.len() > 2 { Seed::from(signer_seeds[2]) } else { Seed::from(&[][..]) },
        if signer_seeds.len() > 3 { Seed::from(signer_seeds[3]) } else { Seed::from(&[][..]) },
    ];

    let signer = Signer::from(&seeds[..signer_seeds.len()]);
    create_account.invoke_signed(&[signer])
}

// ============================================================================
// BATCH VALIDATION HELPERS
// ============================================================================

/// Validate multiple accounts are owned by program and writable
///
/// Combines owner + writable validation for common patterns.
/// Reduces boilerplate in instruction handlers.
#[inline]
pub fn validate_program_accounts_writable(
    accounts: &[&AccountInfo],
    program_id: &Pubkey,
) -> Result<(), ProgramError> {
    for account in accounts {
        validate_program_owner(account, program_id)?;
        validate_account_writable(account)?;
    }
    Ok(())
}

/// Validate multiple accounts are owned by program (read-only)
#[inline]
pub fn validate_program_accounts(
    accounts: &[&AccountInfo],
    program_id: &Pubkey,
) -> Result<(), ProgramError> {
    for account in accounts {
        validate_program_owner(account, program_id)?;
    }
    Ok(())
}

// ============================================================================
// SINGLE ACCOUNT VALIDATION
// ============================================================================

/// Validate that an account is owned by the program
///
/// # Security
/// This MUST be called before deserializing any program-owned account (PoolState,
/// CommitmentTree, NullifierRecord, DepositRecord, RedemptionRequest, etc.)
///
/// Without this check, an attacker can:
/// 1. Create a fake account with crafted data matching expected discriminator
/// 2. Pass it to an instruction
/// 3. Have the program trust the fake data
#[inline(always)]
pub fn validate_program_owner(
    account: &AccountInfo,
    program_id: &Pubkey,
) -> Result<(), ProgramError> {
    let owner = account.owner();
    if owner != program_id {
        return Err(AegisError::InvalidAccountOwner.into());
    }
    Ok(())
}

/// Validate that an account is owned by Token-2022 program
#[inline(always)]
pub fn validate_token_2022_owner(account: &AccountInfo) -> Result<(), ProgramError> {
    if account.owner().as_ref() != &TOKEN_2022_PROGRAM_ID {
        return Err(ProgramError::InvalidAccountOwner);
    }
    Ok(())
}

/// Validate that an account key matches the Token-2022 program ID
#[inline(always)]
pub fn validate_token_program_key(account: &AccountInfo) -> Result<(), ProgramError> {
    if account.key().as_ref() != &TOKEN_2022_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    Ok(())
}

/// Validate that an account is the System Program
#[inline(always)]
pub fn validate_system_program(account: &AccountInfo) -> Result<(), ProgramError> {
    const SYSTEM_PROGRAM_ID: [u8; 32] = [0; 32];
    if account.key().as_ref() != &SYSTEM_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    Ok(())
}

/// Validate multiple program-owned accounts at once
///
/// # Arguments
/// * `accounts` - Slice of accounts to validate
/// * `program_id` - The program ID that should own these accounts
#[inline(always)]
pub fn validate_program_owners(
    accounts: &[&AccountInfo],
    program_id: &Pubkey,
) -> Result<(), ProgramError> {
    for account in accounts {
        validate_program_owner(account, program_id)?;
    }
    Ok(())
}

/// Validate that an account is writable
///
/// # Security
/// This MUST be called before any `try_borrow_mut_data()` operation.
/// Without this check, silent state corruption can occur if a read-only
/// account is passed where a writable one is expected.
#[inline(always)]
pub fn validate_account_writable(account: &AccountInfo) -> Result<(), ProgramError> {
    if !account.is_writable() {
        return Err(AegisError::AccountNotWritable.into());
    }
    Ok(())
}

/// Validate that a token account belongs to the expected mint
///
/// # Security
/// This prevents token account spoofing attacks where an attacker
/// passes a token account for a different mint.
///
/// # Token Account Layout (Token-2022)
/// - Bytes 0-32: mint pubkey
/// - Bytes 32-64: owner pubkey
/// - Bytes 64-72: amount (u64)
#[inline(always)]
pub fn validate_token_mint(
    token_account: &AccountInfo,
    expected_mint: &Pubkey,
) -> Result<(), ProgramError> {
    let data = token_account.try_borrow_data()?;
    if data.len() < 32 {
        return Err(AegisError::InvalidAccountData.into());
    }

    let mint_bytes: [u8; 32] = data[0..32]
        .try_into()
        .map_err(|_| AegisError::InvalidAccountData)?;

    if mint_bytes != expected_mint.as_ref() {
        return Err(AegisError::InvalidMint.into());
    }
    Ok(())
}

/// Validate that two accounts are different (prevent duplicate mutable account attacks)
///
/// # Security
/// Passing the same account for multiple parameters can cause the program
/// to overwrite its own changes, leading to unexpected behavior.
#[inline(always)]
pub fn validate_accounts_different(
    account1: &AccountInfo,
    account2: &AccountInfo,
) -> Result<(), ProgramError> {
    if account1.key() == account2.key() {
        return Err(ProgramError::InvalidArgument);
    }
    Ok(())
}

/// Validate that an account is initialized (has discriminator set)
///
/// # Security
/// Prevents use of uninitialized accounts that may contain garbage data.
#[inline(always)]
pub fn validate_initialized(
    account: &AccountInfo,
    expected_discriminator: u8,
) -> Result<(), ProgramError> {
    let data = account.try_borrow_data()?;
    if data.is_empty() || data[0] != expected_discriminator {
        return Err(AegisError::NotInitialized.into());
    }
    Ok(())
}

/// Validate that an account is NOT initialized (for safe initialization)
///
/// # Security
/// Prevents reinitialization attacks that could overwrite existing data.
#[inline(always)]
pub fn validate_not_initialized(
    account: &AccountInfo,
    discriminator: u8,
) -> Result<(), ProgramError> {
    let data = account.try_borrow_data()?;
    if !data.is_empty() && data[0] == discriminator {
        return Err(AegisError::AlreadyInitialized.into());
    }
    Ok(())
}

/// Securely close an account (prevents revival attacks)
///
/// # Security
/// 1. Marks account as closed with special discriminator
/// 2. Transfers all lamports to destination
/// 3. Zeroes remaining data to prevent data leakage
///
/// This prevents "revival attacks" where a closed account is
/// refunded within the same transaction.
pub fn close_account_securely(
    account: &AccountInfo,
    destination: &AccountInfo,
) -> Result<(), ProgramError> {
    // Mark as closed with special discriminator
    {
        let mut data = account.try_borrow_mut_data()?;
        if !data.is_empty() {
            data[0] = 0xFF; // Closed account marker
            // Zero remaining data for security
            for byte in data[1..].iter_mut() {
                *byte = 0;
            }
        }
    }

    // Transfer all lamports to destination
    let account_lamports = account.lamports();
    if account_lamports > 0 {
        // Subtract from source
        unsafe {
            *account.borrow_mut_lamports_unchecked() = 0;
        }
        // Add to destination
        unsafe {
            *destination.borrow_mut_lamports_unchecked() = destination
                .lamports()
                .checked_add(account_lamports)
                .ok_or(ProgramError::ArithmeticOverflow)?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    // Tests would go here with mock AccountInfo
}
