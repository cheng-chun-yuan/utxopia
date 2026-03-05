//! ChadBuffer utilities for reading large transaction data
//!
//! ChadBuffer is a Solana program that allows storing large data chunks
//! in separate accounts. This module provides utilities to read raw
//! Bitcoin transaction data from ChadBuffer accounts.
//!
//! Reference: https://github.com/deanmlittle/chadbuffer

use pinocchio::program_error::ProgramError;
use pinocchio::pubkey::Pubkey;

/// ChadBuffer program ID
pub const CHADBUFFER_PROGRAM_ID: Pubkey = [
    0x0a, 0x6a, 0x3c, 0x1e, 0x87, 0x32, 0x1a, 0x5c,
    0x7f, 0x4b, 0x2d, 0x9e, 0x8a, 0x6c, 0x3f, 0x1b,
    0x5d, 0x2a, 0x8e, 0x4c, 0x7b, 0x3a, 0x1f, 0x6d,
    0x9c, 0x5e, 0x2b, 0x8f, 0x4a, 0x7d, 0x3c, 0x1e,
];

/// Buffer header size (authority pubkey)
pub const BUFFER_HEADER_SIZE: usize = 32;

/// Read transaction data from a ChadBuffer account
///
/// # Arguments
/// * `buffer_data` - Raw account data from the buffer
/// * `transaction_size` - Expected size of the transaction
///
/// # Returns
/// Slice containing the raw transaction data (without header)
///
/// # Buffer Format
/// ```text
/// [authority (32 bytes)][raw_tx_data...]
/// ```
pub fn read_transaction_from_buffer(
    buffer_data: &[u8],
    transaction_size: usize,
) -> Result<&[u8], ProgramError> {
    // Minimum size: header + at least 1 byte of tx data
    if buffer_data.len() < BUFFER_HEADER_SIZE + 1 {
        return Err(ProgramError::InvalidAccountData);
    }

    // Check we have enough data
    let expected_size = BUFFER_HEADER_SIZE + transaction_size;
    if buffer_data.len() < expected_size {
        return Err(ProgramError::InvalidAccountData);
    }

    // Return slice after header
    Ok(&buffer_data[BUFFER_HEADER_SIZE..expected_size])
}

/// Validate that an account is a ChadBuffer account
///
/// Note: In production, you should verify the owner matches
/// the ChadBuffer program ID. This is a simplified check.
pub fn validate_buffer_account(
    account_data: &[u8],
    expected_authority: Option<&[u8; 32]>,
) -> Result<(), ProgramError> {
    if account_data.len() < BUFFER_HEADER_SIZE {
        return Err(ProgramError::InvalidAccountData);
    }

    // If authority is specified, verify it matches
    if let Some(authority) = expected_authority {
        if &account_data[0..32] != authority {
            return Err(ProgramError::InvalidAccountData);
        }
    }

    Ok(())
}

/// Extract the authority pubkey from a ChadBuffer account
pub fn get_buffer_authority(buffer_data: &[u8]) -> Result<[u8; 32], ProgramError> {
    if buffer_data.len() < BUFFER_HEADER_SIZE {
        return Err(ProgramError::InvalidAccountData);
    }

    let mut authority = [0u8; 32];
    authority.copy_from_slice(&buffer_data[0..32]);
    Ok(authority)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_read_transaction_from_buffer() {
        // Create mock buffer: 32-byte header + 10-byte tx
        let mut buffer = vec![0u8; 32]; // header (authority)
        buffer.extend_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); // tx data

        let tx = read_transaction_from_buffer(&buffer, 10).unwrap();
        assert_eq!(tx, &[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    }

    #[test]
    fn test_buffer_too_small() {
        let buffer = vec![0u8; 31]; // Less than header size
        assert!(read_transaction_from_buffer(&buffer, 10).is_err());
    }

    #[test]
    fn test_insufficient_tx_data() {
        let mut buffer = vec![0u8; 32]; // header only
        buffer.extend_from_slice(&[1, 2, 3]); // only 3 bytes of tx

        assert!(read_transaction_from_buffer(&buffer, 10).is_err());
    }
}
