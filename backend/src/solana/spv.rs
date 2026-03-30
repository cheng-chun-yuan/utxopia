//! Shared SPV Utilities
//!
//! Extracted from deposit_tracker/verifier.rs for reuse by both the deposit
//! verifier and the redemption service.

use solana_client::rpc_client::RpcClient;
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer as SolanaSigner},
    transaction::Transaction,
};
use solana_system_interface::instruction as system_instruction;
use solana_sdk::pubkey;
use thiserror::Error;

use crate::bitcoin::client::MerkleProofInfo;

// =============================================================================
// Constants
// =============================================================================

/// ChadBuffer program ID
pub const CHADBUFFER_PROGRAM_ID: Pubkey = pubkey!("C5RpjtTMFXKVZCtXSzKXD4CDNTaWBg3dVeMfYvjZYHDF");

/// ChadBuffer authority header size (32 bytes for payer pubkey)
pub const CHADBUFFER_AUTHORITY_SIZE: usize = 32;

/// Solana transaction size limit
const SOLANA_TX_SIZE_LIMIT: usize = 1232;

/// ChadBuffer write TX overhead (signature + header + accounts + instruction header + disc + offset)
const CHADBUFFER_WRITE_TX_OVERHEAD: usize = 176;

/// Maximum data bytes per ChadBuffer write transaction
pub const CHADBUFFER_MAX_DATA_PER_WRITE: usize = SOLANA_TX_SIZE_LIMIT - CHADBUFFER_WRITE_TX_OVERHEAD;

// =============================================================================
// Error Type
// =============================================================================

#[derive(Debug, Error)]
pub enum SpvError {
    #[error("RPC error: {0}")]
    RpcError(String),

    #[error("Hex decode error: {0}")]
    HexDecode(String),

    #[error("Data validation error: {0}")]
    DataValidation(String),
}

// =============================================================================
// Public Functions
// =============================================================================

/// Convert display-order hex txid to internal byte order (reversed).
pub fn txid_to_internal(txid_hex: &str) -> Result<[u8; 32], SpvError> {
    let bytes = hex::decode(txid_hex)
        .map_err(|e| SpvError::HexDecode(format!("invalid txid: {}", e)))?;
    if bytes.len() != 32 {
        return Err(SpvError::DataValidation(format!(
            "txid must be 32 bytes, got {}",
            bytes.len()
        )));
    }
    let mut internal = [0u8; 32];
    internal.copy_from_slice(&bytes);
    internal.reverse();
    Ok(internal)
}

// Re-export from shared module for backward compatibility
pub use crate::common::crypto::double_sha256;

/// Strip witness data from a segwit transaction to get the non-witness serialization.
///
/// Bitcoin txid = double_sha256(non-witness serialization), but the raw tx from
/// Esplora includes witness data. For segwit txs (marker=0x00, flag=0x01 after version),
/// we strip the marker, flag, and all witness items.
pub fn strip_witness_data(raw_tx: &[u8]) -> Result<Vec<u8>, SpvError> {
    if raw_tx.len() < 10 {
        return Err(SpvError::DataValidation("tx too short".to_string()));
    }

    // Check if this is a segwit transaction
    if raw_tx[4] != 0x00 || raw_tx[5] != 0x01 {
        return Ok(raw_tx.to_vec());
    }

    let mut result = Vec::with_capacity(raw_tx.len());
    // Copy version (4 bytes)
    result.extend_from_slice(&raw_tx[0..4]);

    // Skip marker (0x00) and flag (0x01) — start parsing from offset 6
    let mut pos = 6;

    // Read input count (varint)
    let (input_count, varint_len) = read_varint(&raw_tx[pos..])?;
    let input_start = pos;

    // Skip past all inputs
    pos += varint_len;
    for _ in 0..input_count {
        pos += 36; // txid(32) + vout(4)
        let (script_len, vl) = read_varint(&raw_tx[pos..])?;
        pos += vl + script_len as usize;
        pos += 4; // sequence
    }

    // Read output count (varint)
    let (output_count, vl) = read_varint(&raw_tx[pos..])?;
    pos += vl;

    // Skip past all outputs
    for _ in 0..output_count {
        pos += 8; // value
        let (script_len, vl) = read_varint(&raw_tx[pos..])?;
        pos += vl + script_len as usize;
    }

    // Copy inputs + outputs (from input_start to pos)
    result.extend_from_slice(&raw_tx[input_start..pos]);

    // Locktime is always the last 4 bytes
    if raw_tx.len() < 4 {
        return Err(SpvError::DataValidation("tx too short for locktime".to_string()));
    }
    result.extend_from_slice(&raw_tx[raw_tx.len() - 4..]);

    Ok(result)
}

/// Upload raw transaction data to a ChadBuffer account.
///
/// Creates a new account owned by the ChadBuffer program, initializes it
/// with the payer as authority, and writes raw tx data in chunks.
///
/// Returns (buffer_pubkey, buffer_keypair). Caller should close the buffer
/// after use via `close_chadbuffer`.
pub fn upload_to_chadbuffer(
    rpc: &RpcClient,
    payer: &Keypair,
    raw_tx: &[u8],
) -> Result<(Pubkey, Keypair), SpvError> {
    let buffer_keypair = Keypair::new();
    let space = CHADBUFFER_AUTHORITY_SIZE + raw_tx.len();

    let rent = rpc
        .get_minimum_balance_for_rent_exemption(space)
        .map_err(|e| SpvError::RpcError(format!("Failed to get rent: {}", e)))?;

    // TX 1: Create account owned by ChadBuffer program
    let create_ix = system_instruction::create_account(
        &payer.pubkey(),
        &buffer_keypair.pubkey(),
        rent,
        space as u64,
        &CHADBUFFER_PROGRAM_ID,
    );

    let blockhash = rpc
        .get_latest_blockhash()
        .map_err(|e| SpvError::RpcError(format!("Failed to get blockhash: {}", e)))?;

    let tx = Transaction::new_signed_with_payer(
        &[create_ix],
        Some(&payer.pubkey()),
        &[payer, &buffer_keypair],
        blockhash,
    );

    rpc.send_and_confirm_transaction(&tx)
        .map_err(|e| SpvError::RpcError(format!("Failed to create buffer account: {}", e)))?;

    // Split raw tx into chunks
    let chunks = split_into_chunks(raw_tx, CHADBUFFER_MAX_DATA_PER_WRITE);

    // TX 2: ChadBuffer Init (disc 0) with first chunk
    let mut init_data = Vec::with_capacity(1 + chunks[0].len());
    init_data.push(0u8); // ChadBuffer::Create discriminator
    init_data.extend_from_slice(chunks[0]);

    let init_ix = Instruction {
        program_id: CHADBUFFER_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(buffer_keypair.pubkey(), false),
        ],
        data: init_data,
    };

    let blockhash = rpc
        .get_latest_blockhash()
        .map_err(|e| SpvError::RpcError(format!("Failed to get blockhash: {}", e)))?;

    let tx = Transaction::new_signed_with_payer(
        &[init_ix],
        Some(&payer.pubkey()),
        &[payer],
        blockhash,
    );

    rpc.send_and_confirm_transaction(&tx)
        .map_err(|e| SpvError::RpcError(format!("Failed to init buffer: {}", e)))?;

    // TX 3+: Write remaining chunks
    let mut offset = chunks[0].len();
    for chunk in &chunks[1..] {
        let mut write_data = Vec::with_capacity(4 + chunk.len());
        write_data.push(2u8); // ChadBuffer::Write discriminator
        // u24 offset (little-endian)
        write_data.push((offset & 0xff) as u8);
        write_data.push(((offset >> 8) & 0xff) as u8);
        write_data.push(((offset >> 16) & 0xff) as u8);
        write_data.extend_from_slice(chunk);

        let write_ix = Instruction {
            program_id: CHADBUFFER_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new(buffer_keypair.pubkey(), false),
            ],
            data: write_data,
        };

        let blockhash = rpc
            .get_latest_blockhash()
            .map_err(|e| SpvError::RpcError(format!("Failed to get blockhash: {}", e)))?;

        let tx = Transaction::new_signed_with_payer(
            &[write_ix],
            Some(&payer.pubkey()),
            &[payer],
            blockhash,
        );

        rpc.send_and_confirm_transaction(&tx)
            .map_err(|e| SpvError::RpcError(format!("Failed to write buffer chunk: {}", e)))?;

        offset += chunk.len();
    }

    tracing::debug!(
        "ChadBuffer uploaded: {} ({} bytes, {} chunks)",
        buffer_keypair.pubkey(),
        raw_tx.len(),
        chunks.len()
    );

    Ok((buffer_keypair.pubkey(), buffer_keypair))
}

/// Close a ChadBuffer account and reclaim rent lamports.
pub fn close_chadbuffer(
    rpc: &RpcClient,
    payer: &Keypair,
    buffer_pubkey: &Pubkey,
) -> Result<(), SpvError> {
    let close_ix = Instruction {
        program_id: CHADBUFFER_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(*buffer_pubkey, false),
        ],
        data: vec![3u8], // ChadBuffer::Close discriminator
    };

    let blockhash = rpc
        .get_latest_blockhash()
        .map_err(|e| SpvError::RpcError(format!("Failed to get blockhash: {}", e)))?;

    let tx = Transaction::new_signed_with_payer(
        &[close_ix],
        Some(&payer.pubkey()),
        &[payer],
        blockhash,
    );

    rpc.send_and_confirm_transaction(&tx)
        .map_err(|e| SpvError::RpcError(format!("Failed to close buffer: {}", e)))?;

    Ok(())
}

/// Build btc-light-client verify_transaction instruction (disc 2).
///
/// Uses `MerkleProofInfo` from `bitcoin::client` (the Esplora response format).
#[allow(clippy::too_many_arguments)]
pub fn build_verify_transaction_ix(
    payer_pubkey: &Pubkey,
    txid: &[u8; 32],
    merkle_proof: &MerkleProofInfo,
    block_hash: &[u8; 32],
    tx_size: u32,
    light_client_program_id: &Pubkey,
    light_client: &Pubkey,
    block_header_pda: &Pubkey,
    verified_tx_pda: &Pubkey,
    tx_buffer: &Pubkey,
) -> Result<Instruction, SpvError> {
    let mut data = Vec::new();
    data.push(2u8); // discriminator

    // txid (32)
    data.extend_from_slice(txid);
    // block_hash (32)
    data.extend_from_slice(block_hash);
    // tx_size (4)
    data.extend_from_slice(&tx_size.to_le_bytes());

    // Merkle proof: [txid(32)][path_bits(4)][path_len(1)][tx_index(4)][siblings...]
    data.extend_from_slice(txid);
    data.extend_from_slice(&merkle_proof.pos.to_le_bytes());
    data.push(merkle_proof.merkle.len() as u8);
    data.extend_from_slice(&merkle_proof.pos.to_le_bytes());

    for sibling_hex in &merkle_proof.merkle {
        let sibling_bytes = hex::decode(sibling_hex)
            .map_err(|e| SpvError::HexDecode(format!("invalid merkle sibling: {}", e)))?;
        let mut sibling = [0u8; 32];
        sibling.copy_from_slice(&sibling_bytes);
        sibling.reverse();
        data.extend_from_slice(&sibling);
    }

    let accounts = vec![
        AccountMeta::new(*verified_tx_pda, false),
        AccountMeta::new_readonly(*light_client, false),
        AccountMeta::new_readonly(*block_header_pda, false),
        AccountMeta::new_readonly(*tx_buffer, false),
        AccountMeta::new(*payer_pubkey, true),
        AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
    ];

    Ok(Instruction {
        program_id: *light_client_program_id,
        accounts,
        data,
    })
}

/// Derive the light client PDA.
pub fn derive_light_client_pda(program_id: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"btc_light_client"], program_id).0
}

/// Derive a block header PDA from block hash.
pub fn derive_block_header_pda(block_hash: &[u8; 32], program_id: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"block", block_hash], program_id).0
}

/// Derive a verified transaction PDA from block hash and txid.
pub fn derive_verified_tx_pda(
    block_hash: &[u8; 32],
    txid: &[u8; 32],
    program_id: &Pubkey,
) -> Pubkey {
    Pubkey::find_program_address(&[b"verified_tx", block_hash, txid], program_id).0
}

// =============================================================================
// Private Helpers
// =============================================================================

/// Read a Bitcoin varint (CompactSize) from a byte slice.
/// Returns (value, bytes_consumed).
fn read_varint(data: &[u8]) -> Result<(u64, usize), SpvError> {
    if data.is_empty() {
        return Err(SpvError::DataValidation("unexpected end of tx data".to_string()));
    }
    match data[0] {
        0..=0xfc => Ok((data[0] as u64, 1)),
        0xfd => {
            if data.len() < 3 {
                return Err(SpvError::DataValidation("truncated varint".to_string()));
            }
            Ok((u16::from_le_bytes([data[1], data[2]]) as u64, 3))
        }
        0xfe => {
            if data.len() < 5 {
                return Err(SpvError::DataValidation("truncated varint".to_string()));
            }
            Ok((u32::from_le_bytes([data[1], data[2], data[3], data[4]]) as u64, 5))
        }
        0xff => {
            if data.len() < 9 {
                return Err(SpvError::DataValidation("truncated varint".to_string()));
            }
            Ok((u64::from_le_bytes(data[1..9].try_into().unwrap()), 9))
        }
    }
}

/// Split data into chunks of at most `chunk_size` bytes.
fn split_into_chunks(data: &[u8], chunk_size: usize) -> Vec<&[u8]> {
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < data.len() {
        let end = std::cmp::min(start + chunk_size, data.len());
        chunks.push(&data[start..end]);
        start = end;
    }
    if chunks.is_empty() {
        chunks.push(&data[..0]);
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_txid_to_internal() {
        let txid = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
        let internal = txid_to_internal(txid).unwrap();
        assert_eq!(internal[0], 0x89);
        assert_eq!(internal[31], 0xab);
    }

    #[test]
    fn test_split_into_chunks() {
        let data = vec![1u8; 2500];
        let chunks = split_into_chunks(&data, 1000);
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].len(), 1000);
        assert_eq!(chunks[1].len(), 1000);
        assert_eq!(chunks[2].len(), 500);
    }

    #[test]
    fn test_split_single_chunk() {
        let data = vec![1u8; 500];
        let chunks = split_into_chunks(&data, 1000);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].len(), 500);
    }

    #[test]
    fn test_double_sha256() {
        let data = b"hello";
        let hash = double_sha256(data);
        assert_eq!(hash.len(), 32);
        // Deterministic
        assert_eq!(hash, double_sha256(data));
    }
}
