//! Cryptographic utilities for zVault
//!
//! Provides Poseidon hashing for Merkle tree operations.
//! Uses Solana's native Poseidon syscall for efficiency.

use pinocchio::program_error::ProgramError;


/// BN254 scalar field modulus (Fr) — big-endian
/// = 21888242871839275222246405745257275088548364400416034343698204186575808495617
const BN254_FR_MODULUS: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29,
    0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91,
    0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

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
    // On-chain: always use Poseidon syscall (validator must be started with --clone-feature-set --url devnet)
    #[cfg(target_os = "solana")]
    {
        poseidon2_hash_syscall(left, right)
    }

    #[cfg(not(target_os = "solana"))]
    {
        poseidon2_hash_reference(left, right)
    }
}

/// Check if a big-endian 32-byte value is >= BN254 Fr modulus
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
#[cfg(target_os = "solana")]
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
#[cfg(target_os = "solana")]
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

/// Poseidon hash of three 32-byte inputs (for commitment computation)
///
/// Used to compute deposit commitments: Poseidon(npk, token_id, amount)
#[inline]
pub fn poseidon3_hash(a: &[u8; 32], b: &[u8; 32], c: &[u8; 32]) -> Result<[u8; 32], ProgramError> {
    // On-chain: always use Poseidon syscall (validator must be started with --clone-feature-set --url devnet)
    #[cfg(target_os = "solana")]
    {
        poseidon3_hash_syscall(a, b, c)
    }

    #[cfg(not(target_os = "solana"))]
    {
        poseidon3_hash_reference(a, b, c)
    }
}

/// SHA256 hash for localnet testing with 3 inputs
/// Poseidon3 hash using Solana syscall
#[cfg(target_os = "solana")]
fn poseidon3_hash_syscall(a: &[u8; 32], b: &[u8; 32], c: &[u8; 32]) -> Result<[u8; 32], ProgramError> {
    use solana_poseidon::{hashv, Parameters, Endianness};

    let a_reduced = reduce_to_field(a);
    let b_reduced = reduce_to_field(b);
    let c_reduced = reduce_to_field(c);

    hashv(Parameters::Bn254X5, Endianness::BigEndian, &[&a_reduced, &b_reduced, &c_reduced])
        .map(|hash| hash.to_bytes())
        .map_err(|_| ProgramError::InvalidArgument)
}

/// Reference implementation for testing with 3 inputs
#[cfg(not(target_os = "solana"))]
fn poseidon3_hash_reference(a: &[u8; 32], b: &[u8; 32], c: &[u8; 32]) -> Result<[u8; 32], ProgramError> {
    let mut hasher_input = [0u8; 97];
    hasher_input[0] = 0x03; // Domain separator for 3-input Poseidon
    hasher_input[1..33].copy_from_slice(a);
    hasher_input[33..65].copy_from_slice(b);
    hasher_input[65..97].copy_from_slice(c);

    let mut result = [0u8; 32];
    for (i, chunk) in hasher_input.chunks(3).enumerate() {
        if i < 32 {
            result[i] = chunk.iter().fold(0u8, |acc, &x| acc.wrapping_add(x));
        }
    }
    for i in 0..32 {
        result[i] = result[i].wrapping_add(result[(i + 11) % 32]);
    }

    Ok(result)
}

/// Subtract BN254 Fr modulus from a big-endian 32-byte value.
/// Assumes val >= modulus.
#[inline]
fn subtract_modulus(val: &[u8; 32]) -> [u8; 32] {
    let mut result = [0u8; 32];
    let mut borrow: u16 = 0;
    for i in (0..32).rev() {
        let diff = (val[i] as u16)
            .wrapping_sub(BN254_FR_MODULUS[i] as u16)
            .wrapping_sub(borrow);
        result[i] = diff as u8;
        borrow = if diff > 0xFF { 1 } else { 0 };
    }
    result
}

/// Reduce a big-endian SHA256 hash modulo BN254 Fr.
/// Matches SDK's `bytesToBigint(hash) % BN254_FIELD_PRIME`.
///
/// SHA256 output is 256 bits, modulus is ~254 bits, so the quotient
/// can be up to 5. We loop subtracting the modulus until the value
/// is in range (at most 5 iterations).
#[inline]
fn reduce_to_field_exact(val: &[u8; 32]) -> [u8; 32] {
    let mut result = *val;
    while is_ge_modulus(&result) {
        result = subtract_modulus(&result);
    }
    result
}

/// Compute bound params hash for private transfer verification.
/// Must match SDK's `computeBoundParamsHash()` exactly.
///
/// Layout (45 bytes LE):
///   treeNumber(4) + hasUnshield(1) + unshieldAddress(32) + chainId(8)
///   → SHA256 → mod BN254_SCALAR_FIELD
///
/// For private transfers: treeNumber=0, hasUnshield=0, address=zeros
pub fn compute_bound_params_hash_private_transfer(chain_id: u64) -> [u8; 32] {
    use super::sha256;

    let mut buf = [0u8; 45];
    // treeNumber = 0 (first 4 bytes already zero)
    // hasUnshield = 0 (byte 4 already zero)
    // unshieldAddress = zeros (bytes 5-36 already zero)
    // chainId (bytes 37-44, LE)
    buf[37..45].copy_from_slice(&chain_id.to_le_bytes());

    let hash: [u8; 32] = sha256(&buf);
    reduce_to_field_exact(&hash)
}

/// Compute bound params hash for public unshield verification.
/// Must match SDK's `computeBoundParamsHash(createUnshieldBoundParams(...))`.
///
/// Layout (45 bytes LE):
///   treeNumber(4) + hasUnshield(1) + unshieldAddress(32) + chainId(8)
///   → SHA256 → mod BN254_SCALAR_FIELD
///
/// For unshield: treeNumber=0, hasUnshield=1, address=recipient pubkey
pub fn compute_bound_params_hash_unshield(chain_id: u64, unshield_address: &[u8; 32]) -> [u8; 32] {
    use super::sha256;

    let mut buf = [0u8; 45];
    // treeNumber = 0 (first 4 bytes already zero)
    buf[4] = 1; // hasUnshield = 1
    buf[5..37].copy_from_slice(unshield_address);
    // chainId (bytes 37-44, LE)
    buf[37..45].copy_from_slice(&chain_id.to_le_bytes());

    let hash: [u8; 32] = sha256(&buf);
    reduce_to_field_exact(&hash)
}

/// ZBTC token identifier: "zbtc" as u32 = 0x7a627463
pub const ZBTC_TOKEN_ID: u32 = 0x7a627463;

/// Compute deposit commitment on-chain: Poseidon(npk, ZBTC_TOKEN_ID, amount_sats)
pub fn compute_deposit_commitment(npk: &[u8; 32], amount_sats: u64) -> Result<[u8; 32], ProgramError> {
    let mut token_id = [0u8; 32];
    token_id[28..32].copy_from_slice(&ZBTC_TOKEN_ID.to_be_bytes());

    let mut amount = [0u8; 32];
    amount[24..32].copy_from_slice(&amount_sats.to_be_bytes());

    poseidon3_hash(npk, &token_id, &amount)
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
    fn test_poseidon3_hash_deterministic() {
        let a = [1u8; 32];
        let b = [2u8; 32];
        let c = [3u8; 32];

        let hash1 = poseidon3_hash(&a, &b, &c).unwrap();
        let hash2 = poseidon3_hash(&a, &b, &c).unwrap();

        assert_eq!(hash1, hash2, "Poseidon3 hash should be deterministic");
    }

    #[test]
    fn test_poseidon3_hash_different_inputs() {
        let a = [1u8; 32];
        let b = [2u8; 32];
        let c = [3u8; 32];
        let d = [4u8; 32];

        let hash_abc = poseidon3_hash(&a, &b, &c).unwrap();
        let hash_abd = poseidon3_hash(&a, &b, &d).unwrap();

        assert_ne!(hash_abc, hash_abd, "Different inputs should produce different hashes");
    }

    #[test]
    fn test_compute_deposit_commitment() {
        let npk = [0x42u8; 32];
        let amount_sats = 100_000u64;

        let commitment1 = compute_deposit_commitment(&npk, amount_sats).unwrap();
        let commitment2 = compute_deposit_commitment(&npk, amount_sats).unwrap();

        assert_eq!(commitment1, commitment2, "Commitment should be deterministic");

        // Different amount should give different commitment
        let commitment3 = compute_deposit_commitment(&npk, 200_000).unwrap();
        assert_ne!(commitment1, commitment3, "Different amounts should give different commitments");

        // Different npk should give different commitment
        let npk2 = [0x43u8; 32];
        let commitment4 = compute_deposit_commitment(&npk2, amount_sats).unwrap();
        assert_ne!(commitment1, commitment4, "Different npks should give different commitments");
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

    #[test]
    fn test_reduce_to_field_exact_below_modulus() {
        // Value below modulus should be unchanged
        let val = [0x10u8; 32];
        assert_eq!(reduce_to_field_exact(&val), val);
    }

    #[test]
    fn test_reduce_to_field_exact_equal_to_modulus() {
        // Value equal to modulus should reduce to zero
        let result = reduce_to_field_exact(&BN254_FR_MODULUS);
        assert_eq!(result, [0u8; 32]);
    }

    #[test]
    fn test_reduce_to_field_exact_above_modulus() {
        // Value above modulus should reduce correctly
        let mut val = BN254_FR_MODULUS;
        val[31] = val[31].wrapping_add(1); // modulus + 1
        let result = reduce_to_field_exact(&val);
        let mut expected = [0u8; 32];
        expected[31] = 1;
        assert_eq!(result, expected);
    }

    #[test]
    fn test_reduce_to_field_exact_max_value() {
        // 0xFF...FF should reduce to a value < modulus
        let val = [0xFFu8; 32];
        let result = reduce_to_field_exact(&val);
        assert!(!is_ge_modulus(&result), "Result must be < modulus");
    }

    #[test]
    fn test_bound_params_hash_deterministic() {
        let hash1 = compute_bound_params_hash_private_transfer(103);
        let hash2 = compute_bound_params_hash_private_transfer(103);
        // Debug: println!("bound_params_hash(103) = {:02x?}", hash1);
        assert_eq!(hash1, hash2);
    }

    #[test]
    fn test_bound_params_hash_different_chain_ids() {
        let devnet = compute_bound_params_hash_private_transfer(103);
        let mainnet = compute_bound_params_hash_private_transfer(101);
        assert_ne!(devnet, mainnet, "Different chain IDs must produce different hashes");
    }

    #[test]
    fn test_bound_params_hash_is_valid_field_element() {
        let hash = compute_bound_params_hash_private_transfer(103);
        assert!(!is_ge_modulus(&hash), "Hash must be a valid BN254 field element");
    }
}
