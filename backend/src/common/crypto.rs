//! Shared cryptographic utilities
//!
//! Consolidates duplicated hash functions that were previously defined
//! independently in bitcoin/taproot.rs, bitcoin/spv.rs, solana/spv.rs,
//! solana/client.rs, and deposit_tracker/sweeper.rs.

use sha2::{Digest, Sha256};

/// Compute SHA-256 hash of arbitrary data
pub fn sha256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finalize().into()
}

/// Compute double SHA-256: SHA256(SHA256(data))
/// Used for Bitcoin block header hashing and transaction ID computation
pub fn double_sha256(data: &[u8]) -> [u8; 32] {
    let first = Sha256::digest(data);
    Sha256::digest(&first).into()
}

/// Compute double SHA-256 of a concatenated pair of 32-byte hashes
/// Used for Bitcoin Merkle tree interior nodes
pub fn double_sha256_pair(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut combined = [0u8; 64];
    combined[..32].copy_from_slice(left);
    combined[32..].copy_from_slice(right);
    double_sha256(&combined)
}
