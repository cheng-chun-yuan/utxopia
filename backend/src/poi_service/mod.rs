//! Off-chain Proof of Innocence (PoI) association service (Phase 3c)
//!
//! Maintains a depth-20 Poseidon Merkle tree of "clean" commitments —
//! commitments associated with SPV-verified BTC deposits that pass AML
//! screening. Serves inclusion proofs at `/api/poi/inclusion` so a client
//! can build a Groth16 PoI proof matching the on-chain `verify_groth16_poi_proof`
//! verifier.
//!
//! Phase 3c v1 scope:
//!   - In-memory store, populated via `add_commitment` (admin call). A future
//!     v2 will ingest from the existing `event_indexer` SQLite deposit table.
//!   - Tree built fresh on each query (O(N · depth) per request). With a
//!     handful of deposits this is microseconds; for production scale we'd
//!     cache and incrementally update.
//!
//! The Poseidon hash matches `solana-poseidon` / `circomlib` (BN254, t=3,
//! Circom-compatible), guaranteeing the off-chain root equals what the
//! on-chain PoI proof's public input expects.

use light_poseidon::{Poseidon, PoseidonBytesHasher, PoseidonError};
use rusqlite::{params, Connection};
use std::sync::{Arc, Mutex, RwLock};

/// PoI association tree depth. Must match `circuits/circom/proof_of_innocence.circom`.
pub const POI_TREE_DEPTH: usize = 20;

#[derive(Clone)]
pub struct PoIService {
    inner: Arc<RwLock<PoIState>>,
    /// Optional SQLite persistence handle. When present, every successful
    /// `add_commitment` is write-through to the DB. When None, the service is
    /// purely in-memory (used by tests and the legacy `new()` constructor).
    db: Option<Arc<Mutex<Connection>>>,
}

struct PoIState {
    leaves: Vec<[u8; 32]>,
}

#[derive(Debug, serde::Serialize)]
pub struct InclusionProof {
    pub found: bool,
    /// 32-byte association root, hex.
    pub association_root: String,
    /// `POI_TREE_DEPTH` hex strings, each 32 bytes.
    pub path_elements: Vec<String>,
    /// `POI_TREE_DEPTH` zero/one direction bits.
    pub path_indices: Vec<u8>,
}

#[derive(Debug, serde::Serialize)]
pub struct PoIStatus {
    pub leaves: usize,
    pub association_root: String,
}

#[derive(Debug, thiserror::Error)]
pub enum PoIError {
    #[error("poseidon error: {0}")]
    Poseidon(#[from] PoseidonError),
    #[error("commitment not in association set")]
    NotFound,
    #[error("malformed commitment: expected 32 bytes, got {0}")]
    BadCommitmentLength(usize),
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

impl PoIService {
    /// In-memory only constructor — leaves do not survive process restart.
    /// Useful for tests and embedded usage where persistence is not needed.
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(PoIState { leaves: Vec::new() })),
            db: None,
        }
    }

    /// Open (or create) a SQLite database at `path` and load all previously
    /// added commitments into the in-memory tree in original insertion order.
    ///
    /// Each subsequent `add_commitment` will be write-through to the DB.
    pub fn new_with_db(path: &str) -> Result<Self, PoIError> {
        let conn = Connection::open(path)?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS poi_leaves (\n                 commitment_hex TEXT PRIMARY KEY,\n                 added_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))\n             )",
            [],
        )?;

        // Load existing leaves in insertion order.
        let mut leaves: Vec<[u8; 32]> = Vec::new();
        {
            let mut stmt = conn.prepare(
                "SELECT commitment_hex FROM poi_leaves ORDER BY added_at ASC, rowid ASC",
            )?;
            let rows = stmt.query_map([], |row| {
                let hex_str: String = row.get(0)?;
                Ok(hex_str)
            })?;
            for row in rows {
                let hex_str = row?;
                if let Some(commitment) = decode_hex32(&hex_str) {
                    leaves.push(commitment);
                }
            }
        }

        Ok(Self {
            inner: Arc::new(RwLock::new(PoIState { leaves })),
            db: Some(Arc::new(Mutex::new(conn))),
        })
    }

    pub fn len(&self) -> usize {
        self.inner.read().unwrap().leaves.len()
    }

    /// Admin: add a commitment to the curated clean set. Idempotent.
    ///
    /// If the service was constructed with a SQLite path (`new_with_db`), the
    /// commitment is also written through to the DB inside the same critical
    /// section — duplicate adds are no-ops in both stores.
    pub fn add_commitment(&self, commitment: [u8; 32]) {
        // Write-through to SQLite first. Use INSERT OR IGNORE so duplicates
        // are silently dropped. If the row is new (changes() == 1) we then
        // append to the in-memory Vec.
        let inserted_into_db = if let Some(db) = &self.db {
            let hex_str = hex(&commitment);
            let conn = db.lock().unwrap();
            match conn.execute(
                "INSERT OR IGNORE INTO poi_leaves (commitment_hex) VALUES (?1)",
                params![hex_str],
            ) {
                Ok(rows) => Some(rows > 0),
                Err(e) => {
                    // Persistence failure shouldn't crash callers; log and
                    // fall back to in-memory-only state. The next restart
                    // will be inconsistent, which is acceptable for this
                    // admin/curator-driven flow.
                    eprintln!(
                        "[poi] sqlite write failed, falling back to in-memory: {}",
                        e
                    );
                    None
                }
            }
        } else {
            None
        };

        let mut state = self.inner.write().unwrap();
        let already_present = state.leaves.iter().any(|c| c == &commitment);
        match inserted_into_db {
            // DB says this was a new row → must add in-memory if not already.
            Some(true) if !already_present => state.leaves.push(commitment),
            // DB says it was a duplicate → in-memory must already have it
            // (we loaded all DB rows on construction); skip.
            Some(false) => {}
            // In-memory-only path or DB write failed: dedupe locally.
            _ => {
                if !already_present {
                    state.leaves.push(commitment);
                }
            }
        }
    }

    /// Current root of the depth-20 tree, padded with zeros for unused slots.
    pub fn association_root(&self) -> Result<[u8; 32], PoIError> {
        let state = self.inner.read().unwrap();
        Ok(compute_root(&state.leaves)?)
    }

    /// Inclusion proof for the given commitment. Returns `NotFound` if not in the set.
    pub fn inclusion_proof(&self, commitment: &[u8; 32]) -> Result<InclusionProof, PoIError> {
        let state = self.inner.read().unwrap();
        let leaf_index = state
            .leaves
            .iter()
            .position(|c| c == commitment)
            .ok_or(PoIError::NotFound)?;

        let (path_elements, path_indices) = compute_path(&state.leaves, leaf_index)?;
        let root = compute_root(&state.leaves)?;

        Ok(InclusionProof {
            found: true,
            association_root: hex(&root),
            path_elements: path_elements.iter().map(|e| hex(e)).collect(),
            path_indices,
        })
    }

    pub fn status(&self) -> Result<PoIStatus, PoIError> {
        let state = self.inner.read().unwrap();
        let root = compute_root(&state.leaves)?;
        Ok(PoIStatus {
            leaves: state.leaves.len(),
            association_root: hex(&root),
        })
    }
}

impl Default for PoIService {
    fn default() -> Self {
        Self::new()
    }
}

fn poseidon2(left: &[u8; 32], right: &[u8; 32]) -> Result<[u8; 32], PoseidonError> {
    let mut hasher = Poseidon::<ark_bn254::Fr>::new_circom(2)?;
    hasher.hash_bytes_be(&[left, right])
}

/// Compute the Merkle root of a depth-`POI_TREE_DEPTH` tree whose leaves are
/// `leaves`, with all unfilled slots set to zero.
fn compute_root(leaves: &[[u8; 32]]) -> Result<[u8; 32], PoseidonError> {
    let mut layer: Vec<[u8; 32]> = leaves.to_vec();
    let zero = [0u8; 32];
    let mut zeros_at_level: Vec<[u8; 32]> = vec![zero];
    for i in 0..POI_TREE_DEPTH {
        zeros_at_level.push(poseidon2(&zeros_at_level[i], &zeros_at_level[i])?);
    }

    for level in 0..POI_TREE_DEPTH {
        let z = zeros_at_level[level];
        let mut next = Vec::with_capacity((layer.len() + 1) / 2);
        let mut i = 0;
        while i < layer.len() {
            let left = layer[i];
            let right = if i + 1 < layer.len() { layer[i + 1] } else { z };
            next.push(poseidon2(&left, &right)?);
            i += 2;
        }
        if next.is_empty() {
            // empty tree at this level — all-zero subtree
            next.push(zeros_at_level[level + 1]);
        }
        layer = next;
    }
    Ok(layer[0])
}

/// Compute the Merkle path (siblings + direction bits) for the leaf at `leaf_index`.
fn compute_path(
    leaves: &[[u8; 32]],
    leaf_index: usize,
) -> Result<(Vec<[u8; 32]>, Vec<u8>), PoseidonError> {
    let zero = [0u8; 32];
    let mut zeros_at_level: Vec<[u8; 32]> = vec![zero];
    for i in 0..POI_TREE_DEPTH {
        zeros_at_level.push(poseidon2(&zeros_at_level[i], &zeros_at_level[i])?);
    }

    let mut layer: Vec<[u8; 32]> = leaves.to_vec();
    let mut idx = leaf_index;
    let mut path_elements = Vec::with_capacity(POI_TREE_DEPTH);
    let mut path_indices = Vec::with_capacity(POI_TREE_DEPTH);

    for level in 0..POI_TREE_DEPTH {
        let z = zeros_at_level[level];
        let sibling_idx = idx ^ 1;
        let sibling = if sibling_idx < layer.len() { layer[sibling_idx] } else { z };
        path_elements.push(sibling);
        path_indices.push((idx & 1) as u8);

        let mut next = Vec::with_capacity((layer.len() + 1) / 2);
        let mut i = 0;
        while i < layer.len() {
            let left = layer[i];
            let right = if i + 1 < layer.len() { layer[i + 1] } else { z };
            next.push(poseidon2(&left, &right)?);
            i += 2;
        }
        if next.is_empty() {
            next.push(zeros_at_level[level + 1]);
        }
        layer = next;
        idx /= 2;
    }
    Ok((path_elements, path_indices))
}

/// Parse a 64-char hex string into a 32-byte array. Returns None on any
/// malformed input. Used by the SQLite loader to be defensive about pre-existing
/// rows.
fn decode_hex32(s: &str) -> Option<[u8; 32]> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).ok()?;
    }
    Some(out)
}

fn hex(b: &[u8; 32]) -> String {
    let mut s = String::with_capacity(64);
    for byte in b {
        s.push(nibble(byte >> 4));
        s.push(nibble(byte & 0x0f));
    }
    s
}

fn nibble(n: u8) -> char {
    match n {
        0..=9 => (b'0' + n) as char,
        10..=15 => (b'a' + n - 10) as char,
        _ => unreachable!(),
    }
}

pub mod routes;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_tree_root_is_deterministic() {
        let svc = PoIService::new();
        let root1 = svc.association_root().unwrap();
        let root2 = svc.association_root().unwrap();
        assert_eq!(root1, root2);
    }

    #[test]
    fn adding_commitment_changes_root() {
        let svc = PoIService::new();
        let empty_root = svc.association_root().unwrap();
        svc.add_commitment([42u8; 32]);
        let new_root = svc.association_root().unwrap();
        assert_ne!(empty_root, new_root);
    }

    #[test]
    fn add_is_idempotent() {
        let svc = PoIService::new();
        svc.add_commitment([42u8; 32]);
        svc.add_commitment([42u8; 32]);
        assert_eq!(svc.len(), 1);
    }

    #[test]
    fn inclusion_proof_returns_root_for_known_leaf() {
        let svc = PoIService::new();
        svc.add_commitment([7u8; 32]);
        svc.add_commitment([8u8; 32]);

        let proof = svc.inclusion_proof(&[7u8; 32]).unwrap();
        assert_eq!(proof.path_elements.len(), POI_TREE_DEPTH);
        assert_eq!(proof.path_indices.len(), POI_TREE_DEPTH);
        let root_hex = hex(&svc.association_root().unwrap());
        assert_eq!(proof.association_root, root_hex);
    }

    #[test]
    fn inclusion_proof_returns_not_found_for_unknown() {
        let svc = PoIService::new();
        svc.add_commitment([7u8; 32]);
        assert!(matches!(
            svc.inclusion_proof(&[99u8; 32]),
            Err(PoIError::NotFound)
        ));
    }

    /// Cross-check with the circomlibjs Poseidon used by the on-chain PoI
    /// circuit. With a single leaf of value 42 (BE-encoded) at index 0 of a
    /// depth-20 sparse Merkle tree (empty subtree hashes at every other
    /// position), the root must equal
    /// `16663028580031846872497622655118393612917667584320291321890799087037447354634`,
    /// derived by running circomlibjs's Poseidon with the level-specific zero
    /// subtree hashes as path elements (the correct sparse-Merkle convention).
    /// If this assertion ever fails it means the off-chain Poseidon has
    /// drifted from the in-circuit Poseidon — on-chain PoI verification would
    /// reject every proof.
    #[test]
    fn root_matches_circomlibjs_for_single_leaf_42() {
        let svc = PoIService::new();
        let mut leaf = [0u8; 32];
        leaf[31] = 42;
        svc.add_commitment(leaf);
        let root = svc.association_root().unwrap();

        let expected = "16663028580031846872497622655118393612917667584320291321890799087037447354634";
        let actual = u256_to_decimal(&root);
        assert_eq!(
            actual, expected,
            "off-chain Poseidon root drifted from circomlibjs — on-chain verifier will reject",
        );
    }

    /// Task A persistence test: a service backed by SQLite must survive a
    /// "restart" (i.e. dropping and re-opening with the same DB path), and
    /// the rebuilt tree must produce the exact same root.
    #[test]
    fn sqlite_persistence_survives_restart() {
        // Use a unique temp path so parallel test invocations don't collide.
        let tmp_dir = std::env::temp_dir();
        let pid = std::process::id();
        let nonce: u32 = rand::random();
        let path = tmp_dir.join(format!("poi-test-{}-{}.sqlite", pid, nonce));
        let path_str = path.to_str().unwrap().to_string();

        // Ensure clean slate.
        let _ = std::fs::remove_file(&path);

        let commitment_a = [11u8; 32];
        let commitment_b = [22u8; 32];

        let root_before;
        {
            let svc = PoIService::new_with_db(&path_str).expect("open db");
            svc.add_commitment(commitment_a);
            svc.add_commitment(commitment_b);
            // Duplicate add — must not double-insert.
            svc.add_commitment(commitment_a);
            assert_eq!(svc.len(), 2);
            root_before = svc.association_root().unwrap();
        } // drop the service (simulates process restart)

        // Reopen with the same path. Both commitments must be there and the
        // root must match exactly.
        let svc2 = PoIService::new_with_db(&path_str).expect("reopen db");
        assert_eq!(svc2.len(), 2, "leaves did not survive restart");
        let root_after = svc2.association_root().unwrap();
        assert_eq!(
            root_after, root_before,
            "association root drifted after restart",
        );

        // Inclusion proof should still work after the restart.
        let proof = svc2.inclusion_proof(&commitment_a).unwrap();
        assert_eq!(proof.path_elements.len(), POI_TREE_DEPTH);

        // Cleanup
        let _ = std::fs::remove_file(&path);
    }

    fn u256_to_decimal(bytes: &[u8; 32]) -> String {
        let mut digits: Vec<u8> = Vec::new();
        let mut working = bytes.to_vec();
        loop {
            let mut all_zero = true;
            let mut carry: u32 = 0;
            for byte in working.iter_mut() {
                let cur = (carry << 8) | (*byte as u32);
                *byte = (cur / 10) as u8;
                carry = cur % 10;
                if *byte != 0 {
                    all_zero = false;
                }
            }
            digits.push(carry as u8);
            if all_zero {
                break;
            }
        }
        while digits.len() > 1 && *digits.last().unwrap() == 0 {
            digits.pop();
        }
        digits.iter().rev().map(|d| char::from(b'0' + d)).collect()
    }
}
