//! Poseidon Merkle Tree for commitment tracking
//!
//! Mirrors the on-chain `CommitmentTree` and SDK `CommitmentTreeIndex`.
//! Uses `light-poseidon` for circom-compatible BN254 Poseidon hashing.
//!
//! - Depth: 16 (65,536 leaf capacity)
//! - Hash: Poseidon(left, right) on BN254 scalar field
//! - Provides merkle proof generation (path + indices) for any leaf
//! - Used by event_indexer tree_cache and API proof endpoints

use light_poseidon::{Poseidon, PoseidonBytesHasher, PoseidonError};
use serde::Serialize;

pub const TREE_DEPTH: usize = 16;
pub const MAX_LEAVES: u64 = 1 << TREE_DEPTH; // 65,536

/// Pre-computed zero hashes for each level (matches on-chain + SDK).
/// ZERO_HASHES[0] = H(0) = 0x00..00 (empty leaf)
/// ZERO_HASHES[i] = Poseidon(ZERO_HASHES[i-1], ZERO_HASHES[i-1])
pub const ZERO_HASHES: [[u8; 32]; TREE_DEPTH + 1] = [
    // Level 0: empty leaf
    hex_bytes("0000000000000000000000000000000000000000000000000000000000000000"),
    // Level 1
    hex_bytes("2098f5fb9e239eab3ceac3f27b81e481dc3124d55ffed523a839ee8446b64864"),
    // Level 2
    hex_bytes("1069673dcdb12263df301a6ff584a7ec261a44cb9dc68df067a4774460b1f1e1"),
    // Level 3
    hex_bytes("18f43331537ee2af2e3d758d50f72106467c6eea50371dd528d57eb2b856d238"),
    // Level 4
    hex_bytes("07f9d837cb17b0d36320ffe93ba52345f1b728571a568265caac97559dbc952a"),
    // Level 5
    hex_bytes("2b94cf5e8746b3f5c9631f4c5df32907a699c58c94b2ad4d7b5cec1639183f55"),
    // Level 6
    hex_bytes("2dee93c5a666459646ea7d22cca9e1bcfed71e6951b953611d11dda32ea09d78"),
    // Level 7
    hex_bytes("078295e5a22b84e982cf601eb639597b8b0515a88cb5ac7fa8a4aabe3c87349d"),
    // Level 8
    hex_bytes("2fa5e5f18f6027a6501bec864564472a616b2e274a41211a444cbe3a99f3cc61"),
    // Level 9
    hex_bytes("0e884376d0d8fd21ecb780389e941f66e45e7acce3e228ab3e2156a614fcd747"),
    // Level 10
    hex_bytes("1b7201da72494f1e28717ad1a52eb469f95892f957713533de6175e5da190af2"),
    // Level 11
    hex_bytes("1f8d8822725e36385200c0b201249819a6e6e1e4650808b5bebc6bface7d7636"),
    // Level 12
    hex_bytes("2c5d82f66c914bafb9701589ba8cfcfb6162b0a12acf88a8d0879a0471b5f85a"),
    // Level 13
    hex_bytes("14c54148a0940bb820957f5adf3fa1134ef5c4aaa113f4646458f270e0bfbfd0"),
    // Level 14
    hex_bytes("190d33b12f986f961e10c0ee44d8b9af11be25588cad89d416118e4bf4ebe80c"),
    // Level 15
    hex_bytes("22f98aa9ce704152ac17354914ad73ed1167ae6596af510aa5b3649325e06c92"),
    // Level 16: empty tree root
    hex_bytes("2a7c7c9b6ce5880b9f6f228d72bf6a575a526f29c66ecceef8b753d38bba7323"),
];

/// Compile-time hex string to [u8; 32] conversion
const fn hex_bytes(s: &str) -> [u8; 32] {
    let b = s.as_bytes();
    assert!(b.len() == 64, "hex string must be 64 chars");
    let mut out = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        out[i] = (hex_nibble(b[i * 2]) << 4) | hex_nibble(b[i * 2 + 1]);
        i += 1;
    }
    out
}

const fn hex_nibble(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        b'A'..=b'F' => c - b'A' + 10,
        _ => panic!("invalid hex char"),
    }
}

/// Poseidon hash of two 32-byte inputs (BN254, circom-compatible)
fn poseidon2_hash(left: &[u8; 32], right: &[u8; 32]) -> Result<[u8; 32], PoseidonError> {
    let mut hasher = Poseidon::<ark_bn254::Fr>::new_circom(2)?;
    let result = hasher.hash_bytes_be(&[left, right])?;
    Ok(result)
}

/// Merkle proof for a single commitment
#[derive(Debug, Clone, Serialize)]
pub struct MerkleProof {
    pub leaf_index: u64,
    pub commitment: String, // hex
    pub root: String,       // hex
    pub siblings: Vec<String>, // 16 hex strings
    pub indices: Vec<u8>,      // 16 values, each 0 or 1
}

/// Tree status summary
#[derive(Debug, Clone, Serialize)]
pub struct TreeStatus {
    pub root: String,
    pub next_index: u64,
    pub size: u64,
}

/// In-memory Poseidon Merkle tree (depth 16)
///
/// Stores all leaves for proof generation and uses a frontier
/// for incremental root updates (matching the on-chain algorithm).
pub struct MerkleTree {
    /// All inserted leaves in order
    leaves: Vec<[u8; 32]>,
    /// Frontier: rightmost filled left-sibling at each level
    frontier: [[u8; 32]; TREE_DEPTH],
    /// Current Merkle root
    current_root: [u8; 32],
    /// Next leaf index to insert at
    next_index: u64,
}

impl Default for MerkleTree {
    fn default() -> Self {
        Self::new()
    }
}

impl MerkleTree {
    /// Create an empty tree
    pub fn new() -> Self {
        Self {
            leaves: Vec::new(),
            frontier: [[0u8; 32]; TREE_DEPTH],
            current_root: ZERO_HASHES[TREE_DEPTH],
            next_index: 0,
        }
    }

    /// Build tree from an ordered list of leaf commitments
    pub fn build_from_leaves(leaves: &[[u8; 32]]) -> Result<Self, String> {
        let mut tree = Self::new();
        for leaf in leaves {
            tree.add_leaf(*leaf).map_err(|e| format!("{}", e))?;
        }
        Ok(tree)
    }

    /// Insert a leaf commitment. Returns the leaf index.
    /// Mirrors the on-chain `insert_leaf` algorithm exactly.
    pub fn add_leaf(&mut self, commitment: [u8; 32]) -> Result<u64, PoseidonError> {
        let leaf_index = self.next_index;
        if leaf_index >= MAX_LEAVES {
            return Err(PoseidonError::InvalidInputLength {
                len: MAX_LEAVES as usize,
                modulus_bytes_len: 32,
            });
        }

        let mut current_hash = commitment;
        let mut current_index = leaf_index as usize;

        for (level, zero_hash) in ZERO_HASHES.iter().enumerate().take(TREE_DEPTH) {
            if current_index.is_multiple_of(2) {
                // Left child: save to frontier, pair with zero hash
                self.frontier[level] = current_hash;
                current_hash = poseidon2_hash(&current_hash, zero_hash)?;
            } else {
                // Right child: pair with frontier (left sibling)
                current_hash = poseidon2_hash(&self.frontier[level], &current_hash)?;
            }
            current_index /= 2;
        }

        self.current_root = current_hash;
        self.leaves.push(commitment);
        self.next_index = leaf_index + 1;
        Ok(leaf_index)
    }

    /// Get Merkle proof for a commitment by its hex string
    pub fn get_proof(&self, commitment_hex: &str) -> Option<MerkleProof> {
        let commitment_bytes = hex::decode(commitment_hex).ok()?;
        if commitment_bytes.len() != 32 {
            return None;
        }
        let mut target = [0u8; 32];
        target.copy_from_slice(&commitment_bytes);

        // Find the leaf index
        let leaf_index = self.leaves.iter().position(|l| *l == target)?;
        self.get_proof_by_index(leaf_index as u64)
    }

    /// Get Merkle proof by leaf index
    pub fn get_proof_by_index(&self, index: u64) -> Option<MerkleProof> {
        if index >= self.next_index {
            return None;
        }

        let leaf_index = index as usize;
        let mut siblings = Vec::with_capacity(TREE_DEPTH);
        let mut indices = Vec::with_capacity(TREE_DEPTH);

        // Build tree level by level, extracting siblings along the path
        let mut current_level: Vec<[u8; 32]> = self.leaves.clone();

        for level in 0..TREE_DEPTH {
            let idx = leaf_index >> level;
            let sibling_idx = idx ^ 1;

            // Get sibling (or zero hash if beyond current tree size)
            let sibling = if sibling_idx < current_level.len() {
                current_level[sibling_idx]
            } else {
                ZERO_HASHES[level]
            };

            siblings.push(hex::encode(sibling));
            indices.push((idx & 1) as u8);

            // Build next level (parent nodes)
            let num_pairs = current_level.len().div_ceil(2);
            let mut next_level = Vec::with_capacity(num_pairs);
            for i in 0..num_pairs {
                let left = current_level.get(i * 2).copied().unwrap_or(ZERO_HASHES[level]);
                let right = current_level.get(i * 2 + 1).copied().unwrap_or(ZERO_HASHES[level]);
                match poseidon2_hash(&left, &right) {
                    Ok(h) => next_level.push(h),
                    Err(_) => return None,
                }
            }

            // Ensure we have enough nodes for the path
            let needed_idx = idx / 2;
            while next_level.len() <= needed_idx {
                next_level.push(ZERO_HASHES[level + 1]);
            }

            current_level = next_level;
        }

        Some(MerkleProof {
            leaf_index: index,
            commitment: hex::encode(self.leaves[leaf_index]),
            root: hex::encode(self.current_root),
            siblings,
            indices,
        })
    }

    /// Current Merkle root as hex
    pub fn root_hex(&self) -> String {
        hex::encode(self.current_root)
    }

    /// Current root as bytes
    pub fn root(&self) -> [u8; 32] {
        self.current_root
    }

    /// Number of leaves inserted
    pub fn size(&self) -> u64 {
        self.next_index
    }

    /// Tree status summary
    pub fn status(&self) -> TreeStatus {
        TreeStatus {
            root: self.root_hex(),
            next_index: self.next_index,
            size: self.next_index,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty_tree_root() {
        let tree = MerkleTree::new();
        assert_eq!(tree.root(), ZERO_HASHES[TREE_DEPTH]);
        assert_eq!(tree.size(), 0);
    }

    #[test]
    fn test_zero_hashes_consistency() {
        // Verify ZERO_HASHES[i] = Poseidon(ZERO_HASHES[i-1], ZERO_HASHES[i-1])
        for i in 1..=TREE_DEPTH {
            let computed = poseidon2_hash(&ZERO_HASHES[i - 1], &ZERO_HASHES[i - 1]).unwrap();
            assert_eq!(
                computed, ZERO_HASHES[i],
                "ZERO_HASHES[{}] mismatch: computed {} vs stored {}",
                i,
                hex::encode(computed),
                hex::encode(ZERO_HASHES[i])
            );
        }
    }

    /// Create a test commitment that fits within the BN254 field modulus.
    /// Sets the first byte to ensure the value is < modulus.
    fn test_commitment(fill: u8) -> [u8; 32] {
        let mut c = [fill; 32];
        c[0] = 0x01; // ensure < BN254 modulus (~0x30644...)
        c
    }

    #[test]
    fn test_single_leaf_insert() {
        let mut tree = MerkleTree::new();
        let commitment = test_commitment(0x42);
        let idx = tree.add_leaf(commitment).unwrap();
        assert_eq!(idx, 0);
        assert_eq!(tree.size(), 1);
        assert_ne!(tree.root(), ZERO_HASHES[TREE_DEPTH]); // root changed
    }

    #[test]
    fn test_proof_roundtrip() {
        let mut tree = MerkleTree::new();

        // Insert a few leaves
        let c1 = [0x01u8; 32];
        let c2 = [0x02u8; 32];
        let c3 = [0x03u8; 32];
        tree.add_leaf(c1).unwrap();
        tree.add_leaf(c2).unwrap();
        tree.add_leaf(c3).unwrap();

        // Get proof for c2
        let proof = tree.get_proof(&hex::encode(c2)).unwrap();
        assert_eq!(proof.leaf_index, 1);
        assert_eq!(proof.root, tree.root_hex());
        assert_eq!(proof.siblings.len(), TREE_DEPTH);
        assert_eq!(proof.indices.len(), TREE_DEPTH);
    }

    #[test]
    fn test_proof_by_index() {
        let mut tree = MerkleTree::new();
        let c_aa = test_commitment(0xAA);
        let c_bb = test_commitment(0xBB);
        tree.add_leaf(c_aa).unwrap();
        tree.add_leaf(c_bb).unwrap();

        let proof = tree.get_proof_by_index(0).unwrap();
        assert_eq!(proof.leaf_index, 0);
        assert_eq!(proof.commitment, hex::encode(c_aa));

        let proof = tree.get_proof_by_index(1).unwrap();
        assert_eq!(proof.leaf_index, 1);
        assert_eq!(proof.commitment, hex::encode(c_bb));

        // Out of bounds
        assert!(tree.get_proof_by_index(2).is_none());
    }

    #[test]
    fn test_build_from_leaves() {
        let leaves = vec![[0x01u8; 32], [0x02u8; 32], [0x03u8; 32]];
        let tree = MerkleTree::build_from_leaves(&leaves).unwrap();
        assert_eq!(tree.size(), 3);

        // Build incrementally for comparison
        let mut tree2 = MerkleTree::new();
        for l in &leaves {
            tree2.add_leaf(*l).unwrap();
        }
        assert_eq!(tree.root(), tree2.root());
    }

    #[test]
    fn test_commitment_not_found() {
        let mut tree = MerkleTree::new();
        tree.add_leaf([0x01u8; 32]).unwrap();
        assert!(tree.get_proof(&hex::encode([0xFF; 32])).is_none());
    }
}
