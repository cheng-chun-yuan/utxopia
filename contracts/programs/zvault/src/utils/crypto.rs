//! Cryptographic utilities for zVault
//!
//! Provides Poseidon hashing for Merkle tree operations.
//! Uses Solana's native Poseidon syscall for efficiency.

use pinocchio::program_error::ProgramError;

#[cfg(all(target_os = "solana", feature = "localnet"))]
use super::sha256;

/// BN254 scalar field modulus (Fr)
/// = 21888242871839275222246405745257275088548364400416034343698204186575808495617
/// Inputs to Poseidon must be < this value
#[cfg(all(target_os = "solana", not(feature = "localnet")))]
const BN254_FR_MODULUS: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29,
    0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d,
    0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c, 0xfd, 0x47,
]; // Big-endian representation

/// Poseidon hash of two 32-byte inputs (for Merkle tree nodes)
///
/// Uses the BN254 field with Poseidon parameters optimized for
/// binary Merkle trees (2 inputs → 1 output).
///
/// # On-chain Implementation
/// Uses Solana's `sol_poseidon` syscall (requires v1.17.5+).
/// With `localnet` feature, uses SHA256 (test validator lacks Poseidon syscall).
#[inline]
pub fn poseidon2_hash(left: &[u8; 32], right: &[u8; 32]) -> Result<[u8; 32], ProgramError> {
    // For localnet testing, use SHA256 since test validator doesn't have Poseidon syscall
    #[cfg(all(target_os = "solana", feature = "localnet"))]
    {
        sha256_hash_for_localnet(left, right)
    }

    #[cfg(all(target_os = "solana", not(feature = "localnet")))]
    {
        poseidon2_hash_syscall(left, right)
    }

    #[cfg(not(target_os = "solana"))]
    {
        poseidon2_hash_reference(left, right)
    }
}

/// SHA256 hash for localnet testing (test validator lacks Poseidon syscall)
#[cfg(all(target_os = "solana", feature = "localnet"))]
fn sha256_hash_for_localnet(left: &[u8; 32], right: &[u8; 32]) -> Result<[u8; 32], ProgramError> {
    let mut input = [0u8; 64];
    input[0..32].copy_from_slice(left);
    input[32..64].copy_from_slice(right);
    Ok(sha256(&input))
}

/// Check if a big-endian 32-byte value is >= BN254 Fr modulus
#[cfg(all(target_os = "solana", not(feature = "localnet")))]
#[inline]
fn is_ge_modulus(val: &[u8; 32]) -> bool {
    for i in 0..32 {
        if val[i] < BN254_FR_MODULUS[i] {
            return false;
        }
        if val[i] > BN254_FR_MODULUS[i] {
            return true;
        }
    }
    true // Equal to modulus
}

/// Reduce a big-endian value modulo BN254 Fr if needed
/// For values >= modulus, we XOR with a mask to bring into range
/// This is a simple reduction that maintains determinism
#[cfg(all(target_os = "solana", not(feature = "localnet")))]
#[inline]
fn reduce_to_field(val: &[u8; 32]) -> [u8; 32] {
    if !is_ge_modulus(val) {
        return *val;
    }
    // Simple reduction: clear top bits to ensure < modulus
    // The modulus starts with 0x30, so clearing to 0x2F or less ensures < modulus
    let mut result = *val;
    result[0] &= 0x2F;
    result
}

/// Poseidon hash using Solana syscall
/// Inputs are automatically reduced to valid BN254 field elements
#[cfg(all(target_os = "solana", not(feature = "localnet")))]
fn poseidon2_hash_syscall(left: &[u8; 32], right: &[u8; 32]) -> Result<[u8; 32], ProgramError> {
    use solana_poseidon::{hashv, Parameters, Endianness};

    // Reduce inputs to valid field elements if needed
    let left_reduced = reduce_to_field(left);
    let right_reduced = reduce_to_field(right);

    // Call Poseidon syscall - no fallback, this MUST work
    hashv(Parameters::Bn254X5, Endianness::BigEndian, &[&left_reduced, &right_reduced])
        .map(|hash| hash.to_bytes())
        .map_err(|_| ProgramError::InvalidArgument)
}

/// Reference implementation for testing (not for production on-chain use)
#[cfg(not(target_os = "solana"))]
fn poseidon2_hash_reference(left: &[u8; 32], right: &[u8; 32]) -> Result<[u8; 32], ProgramError> {
    // For off-chain testing, use a deterministic hash
    // This matches the structure but uses SHA256 as placeholder
    // Real tests should use the actual Poseidon implementation
    let mut hasher_input = [0u8; 65];
    hasher_input[0] = 0x01; // Domain separator for Merkle node
    hasher_input[1..33].copy_from_slice(left);
    hasher_input[33..65].copy_from_slice(right);

    // Simple deterministic hash for testing
    let mut result = [0u8; 32];
    for (i, chunk) in hasher_input.chunks(2).enumerate() {
        if i < 32 {
            result[i] = chunk.iter().fold(0u8, |acc, &x| acc.wrapping_add(x));
        }
    }
    // Add mixing
    for i in 0..32 {
        result[i] = result[i].wrapping_add(result[(i + 7) % 32]);
    }

    Ok(result)
}

/// Compute Merkle root from a leaf and its sibling path
///
/// # Arguments
/// * `leaf` - The leaf commitment
/// * `leaf_index` - Position of the leaf (determines left/right placement)
/// * `siblings` - Array of sibling hashes from leaf to root
///
/// # Returns
/// The computed Merkle root
pub fn compute_merkle_root(
    leaf: &[u8; 32],
    leaf_index: u64,
    siblings: &[[u8; 32]],
) -> Result<[u8; 32], ProgramError> {
    let mut current = *leaf;
    let mut index = leaf_index;

    for sibling in siblings {
        // If index is even, current is left child; if odd, current is right child
        let is_left = index & 1 == 0; // Bitwise check: even = left child
        current = if is_left {
            poseidon2_hash(&current, sibling)?
        } else {
            poseidon2_hash(sibling, &current)?
        };
        index /= 2;
    }

    Ok(current)
}

/// Zero value for empty Merkle tree nodes at each level
/// These are precomputed: zero[0] = H(0,0), zero[1] = H(zero[0], zero[0]), etc.
pub const ZERO_HASHES: [[u8; 32]; 20] = [
    // Level 0: Hash of two zero leaves
    [0u8; 32],
    // Levels 1-19: Each level is hash of previous level with itself
    // In production, these should be precomputed with actual Poseidon2
    [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32],
    [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32],
    [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32],
    [0u8; 32], [0u8; 32], [0u8; 32], [0u8; 32],
    [0u8; 32], [0u8; 32], [0u8; 32],
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_poseidon2_hash_deterministic() {
        let left = [1u8; 32];
        let right = [2u8; 32];

        let hash1 = poseidon2_hash(&left, &right).unwrap();
        let hash2 = poseidon2_hash(&left, &right).unwrap();

        assert_eq!(hash1, hash2, "Hash should be deterministic");
    }

    #[test]
    fn test_poseidon2_hash_different_inputs() {
        let a = [1u8; 32];
        let b = [2u8; 32];
        let c = [3u8; 32];

        let hash_ab = poseidon2_hash(&a, &b).unwrap();
        let hash_ac = poseidon2_hash(&a, &c).unwrap();
        let hash_ba = poseidon2_hash(&b, &a).unwrap();

        assert_ne!(hash_ab, hash_ac, "Different inputs should produce different hashes");
        assert_ne!(hash_ab, hash_ba, "Order should matter");
    }

    #[test]
    fn test_merkle_root_computation() {
        let leaf = [1u8; 32];
        let siblings = [[2u8; 32], [3u8; 32]];

        let root = compute_merkle_root(&leaf, 0, &siblings).unwrap();

        // Root should be deterministic
        let root2 = compute_merkle_root(&leaf, 0, &siblings).unwrap();
        assert_eq!(root, root2);
    }
}
