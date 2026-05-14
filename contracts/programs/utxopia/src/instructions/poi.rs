//! Proof of Innocence (PoI) instructions (Phase 3c)
//!
//! Two instructions:
//!
//!   - `update_association_root` (disc 21): admin-only. Sets / refreshes the
//!     `AssociationSet` PDA's `current_root` from an off-chain-curated set
//!     of clean commitments. Initializes the PDA on first call.
//!
//!   - `attest_poi` (disc 22): user-facing. Verifies one Groth16 PoI proof
//!     against the current association root and emits an event tagging a
//!     given commitment as "innocent." Honor-system lineage: the user claims
//!     a commitment X is in the clean set; the chain verifies a fresh
//!     Groth16 proof; downstream consumers (CEXes, regulators) can rely on
//!     the on-chain attestation event without trusting the user.
//!
//! ## Privacy note
//!
//! The PoI proof's public input includes the claimed commitment in clear.
//! This trades a small amount of privacy ("yes I am claiming X is mine and
//! clean") for an honor-system attestation that's verifiable on chain. Full
//! lineage-through-JoinSplit without revealing the commitment requires a
//! merged JoinSplit+PoI circuit, which is a separate Phase 3d follow-up.

use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::{find_program_address, Pubkey},
    sysvars::{rent::Rent, Sysvar},
    ProgramResult,
};

use crate::error::UTXOpiaError;
use crate::state::{
    AssociationSet, PoolState, ASSOCIATION_SET_SEED,
};
use crate::utils::groth16::{
    verify_groth16_poi_hidden_proof, verify_groth16_poi_proof, GROTH16_PROOF_SIZE,
};
use crate::utils::{
    create_pda_account, validate_account_writable, validate_program_owner,
    validate_system_program,
};

/// Admin: set the association-set root.
///
/// Instruction data layout:
///   - new_root        :: [u8; 32]
///   - status          ::    u8 (0 = active, 1 = paused)
///
/// Accounts:
///   0. pool_state      (read; provides authority)
///   1. association_set (writable PDA)
///   2. authority       (signer)
///   3. system_program  (read)
pub fn process_update_association_root(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.len() < 33 {
        return Err(ProgramError::InvalidInstructionData);
    }
    if accounts.len() < 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let pool_state_info = &accounts[0];
    let association_info = &accounts[1];
    let authority = &accounts[2];
    let system_program = &accounts[3];

    validate_program_owner(pool_state_info, program_id)?;
    validate_system_program(system_program)?;
    validate_account_writable(association_info)?;
    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Authority check: must match the configured pool authority.
    {
        let pool_data = pool_state_info.try_borrow_data()?;
        let pool = PoolState::from_bytes(&pool_data)?;
        if authority.key().as_ref() != pool.authority {
            return Err(UTXOpiaError::Unauthorized.into());
        }
    }

    let new_root: [u8; 32] = data[0..32].try_into().unwrap();
    let new_status = data[32];

    // Derive expected PDA + bump.
    let (expected_pda, bump) = find_program_address(&[ASSOCIATION_SET_SEED], program_id);
    if association_info.key() != &expected_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    let current_slot = pinocchio::sysvars::clock::Clock::get()?.slot;

    // Lazily create the PDA on first call.
    let needs_init = {
        let data_ref = association_info.try_borrow_data()?;
        data_ref.is_empty() || !AssociationSet::is_initialized(&data_ref)
    };
    if needs_init {
        let rent = Rent::get()?;
        let bump_bytes = [bump];
        let signer_seeds: &[&[u8]] = &[ASSOCIATION_SET_SEED, &bump_bytes];
        create_pda_account(
            authority,
            association_info,
            program_id,
            rent.minimum_balance(AssociationSet::LEN),
            AssociationSet::LEN as u64,
            signer_seeds,
        )?;
        let mut data_mut = association_info.try_borrow_mut_data()?;
        AssociationSet::init(&mut data_mut, bump)?;
    }

    let mut data_mut = association_info.try_borrow_mut_data()?;
    let set = AssociationSet::from_bytes_mut(&mut data_mut)?;
    set.current_root = new_root;
    set.status = new_status;
    set.last_updated_slot = current_slot;
    set.version = set.version.wrapping_add(1);

    crate::utils::events::emit_association_root_updated(&new_root, new_status, set.version);
    Ok(())
}

/// User-facing PoI attestation.
///
/// Instruction data layout:
///   - commitment      :: [u8; 32]    (claimed-innocent commitment)
///   - proof_bytes     :: [u8; 256]   (Groth16 PoI proof)
///
/// The contract reads the current association_root from the AssociationSet
/// PDA, runs `verify_groth16_poi_proof(proof, association_root, commitment)`,
/// and emits an `EVENT_POI_ATTESTED` log on success.
///
/// Accounts:
///   0. association_set (read PDA)
///   1. payer           (signer)
pub fn process_attest_poi(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.len() < 32 + GROTH16_PROOF_SIZE {
        return Err(ProgramError::InvalidInstructionData);
    }
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let association_info = &accounts[0];
    let payer = &accounts[1];

    validate_program_owner(association_info, program_id)?;
    if !payer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let commitment: &[u8; 32] = data[0..32].try_into().unwrap();
    let proof_bytes = &data[32..32 + GROTH16_PROOF_SIZE];

    let association_data = association_info.try_borrow_data()?;
    let set = AssociationSet::from_bytes(&association_data)?;
    if set.status != 0 {
        return Err(UTXOpiaError::PoolPaused.into());
    }
    let association_root = set.current_root;

    verify_groth16_poi_proof(proof_bytes, &association_root, commitment)?;

    crate::utils::events::emit_poi_attested(&association_root, commitment, set.version);
    Ok(())
}

/// User-facing PoI attestation with a blinded commitment (Phase 3d-lite).
///
/// Identical to `process_attest_poi` except the public input is
/// `blinded_id = Poseidon(commitment, nonce)` instead of the commitment in
/// clear. Chain watchers see only the blinded ID; the auditor receiving
/// the attestation must obtain `nonce` out-of-band to verify the binding.
///
/// Instruction data layout:
///   - blinded_id      :: [u8; 32]    (Poseidon(commitment, nonce))
///   - proof_bytes     :: [u8; 256]   (Groth16 hidden-PoI proof)
///
/// Accounts:
///   0. association_set (read PDA)
///   1. payer           (signer)
pub fn process_attest_poi_hidden(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.len() < 32 + GROTH16_PROOF_SIZE {
        return Err(ProgramError::InvalidInstructionData);
    }
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let association_info = &accounts[0];
    let payer = &accounts[1];

    validate_program_owner(association_info, program_id)?;
    if !payer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let blinded_id: &[u8; 32] = data[0..32].try_into().unwrap();
    let proof_bytes = &data[32..32 + GROTH16_PROOF_SIZE];

    let association_data = association_info.try_borrow_data()?;
    let set = AssociationSet::from_bytes(&association_data)?;
    if set.status != 0 {
        return Err(UTXOpiaError::PoolPaused.into());
    }
    let association_root = set.current_root;

    verify_groth16_poi_hidden_proof(proof_bytes, &association_root, blinded_id)?;

    crate::utils::events::emit_poi_hidden_attested(&association_root, blinded_id, set.version);
    Ok(())
}
