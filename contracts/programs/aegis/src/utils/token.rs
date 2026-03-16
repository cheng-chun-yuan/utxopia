//! Token-2022 helper functions for Pinocchio

use pinocchio::{
    account_info::AccountInfo,
    cpi::{invoke, invoke_signed},
    instruction::{AccountMeta, Instruction, Signer, Seed},
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

use crate::constants::TOKEN_2022_PROGRAM_ID;

/// Token-2022 instruction discriminators
mod token_instruction {
    pub const MINT_TO: u8 = 7;
    pub const BURN: u8 = 8;
    pub const TRANSFER: u8 = 3;
}

/// Mint zkBTC tokens to a user account
///
/// # Arguments
/// * `mint` - The zkBTC mint account
/// * `destination` - The user's token account
/// * `authority` - The mint authority (pool PDA)
/// * `amount` - Amount to mint (in satoshis)
/// * `signer_seeds` - PDA signer seeds
pub fn mint_zkbtc(
    _token_program: &AccountInfo,
    mint: &AccountInfo,
    destination: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
    signer_seeds: &[&[u8]],
) -> ProgramResult {
    // Build instruction data: [discriminator, amount (8 bytes LE)]
    let mut data = [0u8; 9];
    data[0] = token_instruction::MINT_TO;
    data[1..9].copy_from_slice(&amount.to_le_bytes());

    let token_program_id = Pubkey::from(TOKEN_2022_PROGRAM_ID);

    let accounts = [
        AccountMeta::writable(mint.key()),
        AccountMeta::writable(destination.key()),
        AccountMeta::readonly_signer(authority.key()),
    ];

    let instruction = Instruction {
        program_id: &token_program_id,
        accounts: &accounts,
        data: &data,
    };

    // Create signer from seeds (fixed array, no heap allocation)
    let seeds: [Seed; 2] = [
        Seed::from(signer_seeds[0]),
        Seed::from(signer_seeds[1]),
    ];
    let signer = Signer::from(&seeds[..]);
    let signers = [signer];

    invoke_signed(&instruction, &[mint, destination, authority], &signers)
}

/// Burn zkBTC tokens from a user account
///
/// # Arguments
/// * `mint` - The zkBTC mint account
/// * `source` - The user's token account to burn from
/// * `authority` - The token account authority (user)
/// * `amount` - Amount to burn (in satoshis)
pub fn burn_zkbtc(
    _token_program: &AccountInfo,
    mint: &AccountInfo,
    source: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    let mut data = [0u8; 9];
    data[0] = token_instruction::BURN;
    data[1..9].copy_from_slice(&amount.to_le_bytes());

    let token_program_id = Pubkey::from(TOKEN_2022_PROGRAM_ID);

    let accounts = [
        AccountMeta::writable(source.key()),
        AccountMeta::writable(mint.key()),
        AccountMeta::readonly_signer(authority.key()),
    ];

    let instruction = Instruction {
        program_id: &token_program_id,
        accounts: &accounts,
        data: &data,
    };

    invoke(&instruction, &[source, mint, authority])
}

/// Burn zkBTC tokens from a PDA-controlled account (e.g., pool vault)
///
/// # Arguments
/// * `mint` - The zkBTC mint account
/// * `source` - The PDA-controlled token account to burn from
/// * `authority` - The PDA authority
/// * `amount` - Amount to burn (in satoshis)
/// * `signer_seeds` - PDA signer seeds
pub fn burn_zkbtc_signed(
    _token_program: &AccountInfo,
    mint: &AccountInfo,
    source: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
    signer_seeds: &[&[u8]],
) -> ProgramResult {
    let mut data = [0u8; 9];
    data[0] = token_instruction::BURN;
    data[1..9].copy_from_slice(&amount.to_le_bytes());

    let token_program_id = Pubkey::from(TOKEN_2022_PROGRAM_ID);

    let accounts = [
        AccountMeta::writable(source.key()),
        AccountMeta::writable(mint.key()),
        AccountMeta::readonly_signer(authority.key()),
    ];

    let instruction = Instruction {
        program_id: &token_program_id,
        accounts: &accounts,
        data: &data,
    };

    let seeds: [Seed; 2] = [
        Seed::from(signer_seeds[0]),
        Seed::from(signer_seeds[1]),
    ];
    let signer = Signer::from(&seeds[..]);
    let signers = [signer];

    invoke_signed(&instruction, &[source, mint, authority], &signers)
}

/// Transfer zkBTC tokens between accounts
///
/// # Arguments
/// * `source` - The source token account
/// * `destination` - The destination token account
/// * `authority` - The source account authority
/// * `amount` - Amount to transfer
/// * `signer_seeds` - Optional PDA signer seeds
pub fn transfer_zkbtc(
    _token_program: &AccountInfo,
    source: &AccountInfo,
    destination: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
    signer_seeds: &[&[u8]],
) -> ProgramResult {
    let mut data = [0u8; 9];
    data[0] = token_instruction::TRANSFER;
    data[1..9].copy_from_slice(&amount.to_le_bytes());

    let token_program_id = Pubkey::from(TOKEN_2022_PROGRAM_ID);

    let accounts = [
        AccountMeta::writable(source.key()),
        AccountMeta::writable(destination.key()),
        AccountMeta::readonly_signer(authority.key()),
    ];

    let instruction = Instruction {
        program_id: &token_program_id,
        accounts: &accounts,
        data: &data,
    };

    if signer_seeds.is_empty() {
        invoke(&instruction, &[source, destination, authority])
    } else {
        let seeds: [Seed; 2] = [
            Seed::from(signer_seeds[0]),
            Seed::from(signer_seeds[1]),
        ];
        let signer = Signer::from(&seeds[..]);
        let signers = [signer];
        invoke_signed(&instruction, &[source, destination, authority], &signers)
    }
}

/// Transfer tokens from a user-signed account (no PDA signing needed)
pub fn transfer_token_user(
    _token_program: &AccountInfo,
    source: &AccountInfo,
    destination: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    let mut data = [0u8; 9];
    data[0] = token_instruction::TRANSFER;
    data[1..9].copy_from_slice(&amount.to_le_bytes());

    let token_program_id = Pubkey::from(TOKEN_2022_PROGRAM_ID);

    let accounts = [
        AccountMeta::writable(source.key()),
        AccountMeta::writable(destination.key()),
        AccountMeta::readonly_signer(authority.key()),
    ];

    let instruction = Instruction {
        program_id: &token_program_id,
        accounts: &accounts,
        data: &data,
    };

    invoke(&instruction, &[source, destination, authority])
}

/// Validate that an account is owned by Token-2022 program
#[inline(always)]
pub fn is_token_2022_account(account: &AccountInfo) -> bool {
    account.owner() == &Pubkey::from(TOKEN_2022_PROGRAM_ID)
}

/// Validate token account basics
pub fn validate_token_account(
    account: &AccountInfo,
    expected_mint: &Pubkey,
    expected_owner: &Pubkey,
) -> Result<(), ProgramError> {
    // Check program owner
    if !is_token_2022_account(account) {
        return Err(ProgramError::InvalidAccountOwner);
    }

    // Token account data layout:
    // [0..32] mint
    // [32..64] owner
    // [64..72] amount
    // ...
    let data = account.try_borrow_data()?;
    if data.len() < 72 {
        return Err(ProgramError::InvalidAccountData);
    }

    // Check mint
    let mint = Pubkey::from(<[u8; 32]>::try_from(&data[0..32]).unwrap());
    if &mint != expected_mint {
        return Err(ProgramError::InvalidAccountData);
    }

    // Check owner
    let owner = Pubkey::from(<[u8; 32]>::try_from(&data[32..64]).unwrap());
    if &owner != expected_owner {
        return Err(ProgramError::InvalidAccountData);
    }

    Ok(())
}

/// Get token account balance
pub fn get_token_balance(account: &AccountInfo) -> Result<u64, ProgramError> {
    let data = account.try_borrow_data()?;
    if data.len() < 72 {
        return Err(ProgramError::InvalidAccountData);
    }

    Ok(u64::from_le_bytes(data[64..72].try_into().unwrap()))
}
