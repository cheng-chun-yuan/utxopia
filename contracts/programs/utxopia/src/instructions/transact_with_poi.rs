//! Transact-with-PoI co-attestation (Phase 3d-full prototype).
//!
//! ## Framing
//!
//! Rather than cloning the full ~400-line `transact` handler, this
//! instruction is a co-attestation: it verifies a JoinSplit-with-PoI Groth16
//! proof for the (1, 2) variant and emits a tagging event. The actual
//! state-change work (nullifier PDAs, leaf insertion, stealth announcements,
//! sender memos) still flows through the regular `transact` (disc 13) ix in
//! the same Solana transaction.
//!
//! Downstream consumers (CEXes, auditors) pair the two events on matching
//! `(merkle_root, bound_params_hash, nullifier, commitments_out)` tuples to
//! conclude "this transact was PoI-clean as of `association_root`."
//!
//! The verifier enforces:
//!   1. The Groth16 proof binds the public inputs.
//!   2. `merkle_root` is an active root in the commitment tree (so attackers
//!      can't fabricate against an old or forked root).
//!   3. `association_root` matches the current `AssociationSet` PDA root.
//!
//! Combined, this means: any pair of (transact + transact_with_poi) events
//! with matching nullifier + commitments is a public, on-chain assertion
//! that the spent note's commitment was in the curated clean set.
//!
//! ## Instruction Data Layout (only 1x2 variant — Phase 3d-full prototype)
//!   - [0]      n_inputs         (u8, MUST be 1)
//!   - [1]      n_outputs        (u8, MUST be 2)
//!   - [2..258] proof            ([u8; 256] inline only — no buffer mode)
//!   - [258..290]  merkle_root        ([u8; 32])
//!   - [290..322]  bound_params_hash  ([u8; 32])
//!   - [322..354]  nullifier          ([u8; 32])
//!   - [354..386]  commitment_out_0   ([u8; 32])
//!   - [386..418]  commitment_out_1   ([u8; 32])
//! Total: 418 bytes.
//!
//! ## Accounts
//!   0. association_set    (read, PDA — pinned with current_root)
//!   1. commitment_tree    (read, validates merkle_root is active)
//!   2. payer              (signer, pays the rent if any)
//!
//! ## Scaling out
//! Other (N, M) variants need: their own compiled circuit + zkey, their own
//! VK constants in `utils/groth16.rs`, and a parameterized version of this
//! handler that picks the right `verify_groth16_transact_NxM_with_poi_proof`
//! function. See TODOS.md → "Phase 3d-full scale-out".

use pinocchio::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey, ProgramResult};

use crate::error::UTXOpiaError;
use crate::state::{AssociationSet, CommitmentTree};
use crate::utils::groth16::GROTH16_PROOF_SIZE;
use crate::utils::validate_program_owner;

/// Total instruction data size for the 1x2 prototype.
/// header(2) + proof(256) + roots(32+32) + nullifier(32) + commitments(32*2) = 418
const IX_DATA_SIZE: usize = 2 + GROTH16_PROOF_SIZE + 32 + 32 + 32 + 32 + 32;

pub fn process_transact_with_poi(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.len() < IX_DATA_SIZE {
        return Err(ProgramError::InvalidInstructionData);
    }
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    // ── Parse instruction data ────────────────────────────────────────
    let n_inputs = data[0];
    let n_outputs = data[1];

    // 1x2 prototype: hard-fail any other variant. Future scale-out will
    // dispatch on (n_inputs, n_outputs) to the right VK + verifier.
    if n_inputs != 1 || n_outputs != 2 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let mut off = 2;
    let proof_bytes = &data[off..off + GROTH16_PROOF_SIZE];
    off += GROTH16_PROOF_SIZE;
    let merkle_root: &[u8; 32] = data[off..off + 32].try_into().unwrap();
    off += 32;
    let bound_params_hash: &[u8; 32] = data[off..off + 32].try_into().unwrap();
    off += 32;
    let nullifier: &[u8; 32] = data[off..off + 32].try_into().unwrap();
    off += 32;
    let commitment_out_0: &[u8; 32] = data[off..off + 32].try_into().unwrap();
    off += 32;
    let commitment_out_1: &[u8; 32] = data[off..off + 32].try_into().unwrap();

    // ── Validate accounts ─────────────────────────────────────────────
    let association_info = &accounts[0];
    let commitment_tree_info = &accounts[1];
    let payer = &accounts[2];

    validate_program_owner(association_info, program_id)?;
    validate_program_owner(commitment_tree_info, program_id)?;
    if !payer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // ── Pin the association root + check it's not paused ─────────────
    let association_data = association_info.try_borrow_data()?;
    let set = AssociationSet::from_bytes(&association_data)?;
    if set.status != 0 {
        return Err(UTXOpiaError::PoolPaused.into());
    }
    let association_root = set.current_root;

    // ── Validate the JoinSplit merkle_root is a known/active tree root.
    //    This is the same check transact does — prevents an attacker from
    //    forging a proof against an old or rotated-out root.
    {
        let tree_data = commitment_tree_info.try_borrow_data()?;
        let tree = CommitmentTree::from_bytes(&tree_data)?;
        if !tree.is_valid_root(merkle_root) {
            return Err(UTXOpiaError::InvalidMerkleProof.into());
        }
    }

    // ── Verify the Groth16-with-PoI proof ─────────────────────────────
    crate::utils::groth16::verify_groth16_transact_1x2_with_poi_proof(
        proof_bytes,
        merkle_root,
        bound_params_hash,
        nullifier,
        commitment_out_0,
        commitment_out_1,
        &association_root,
    )?;

    // ── Emit the co-attestation event ─────────────────────────────────
    // Downstream consumers pair this with a transact event on the matching
    // (nullifier, commitments_out) to conclude "that transact was clean."
    crate::utils::events::emit_transact_with_poi(
        &association_root,
        nullifier,
        commitment_out_0,
        commitment_out_1,
        set.version,
    );

    Ok(())
}
