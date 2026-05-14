/**
 * Phase 3 (PoI) instruction builders.
 *
 *   - `buildUpdateAssociationRootInstructionData`: admin-only. Sets the
 *     AssociationSet PDA's `current_root` from an off-chain-curated set.
 *
 *   - `buildAttestPoIInstructionData`: user-facing. Verifies a Groth16 PoI
 *     proof against the current association root and emits an on-chain
 *     attestation event tagging a commitment as "innocent."
 */

const INSTRUCTION_UPDATE_ASSOCIATION_ROOT = 21;
const INSTRUCTION_ATTEST_POI = 22;
const INSTRUCTION_ATTEST_POI_HIDDEN = 23;
const GROTH16_PROOF_BYTES = 256;

/** PDA seed for the association-set account. Must match `ASSOCIATION_SET_SEED` in Rust. */
export const ASSOCIATION_SET_SEED = new TextEncoder().encode("poi_association_set");

/**
 * Build instruction data for `update_association_root` (disc 21).
 *
 * Layout: disc(1) + new_root(32) + status(1) = 34 bytes
 */
export function buildUpdateAssociationRootInstructionData(options: {
  newRoot: Uint8Array;
  status: number;
}): Uint8Array {
  if (options.newRoot.length !== 32) {
    throw new Error(`newRoot must be 32 bytes; got ${options.newRoot.length}`);
  }
  if (options.status < 0 || options.status > 255) {
    throw new Error(`status must fit in a u8; got ${options.status}`);
  }
  const out = new Uint8Array(1 + 32 + 1);
  out[0] = INSTRUCTION_UPDATE_ASSOCIATION_ROOT;
  out.set(options.newRoot, 1);
  out[33] = options.status;
  return out;
}

/**
 * Build instruction data for `attest_poi` (disc 22).
 *
 * Layout: disc(1) + commitment(32) + proof_bytes(256) = 289 bytes
 */
export function buildAttestPoIInstructionData(options: {
  commitment: Uint8Array;
  proofBytes: Uint8Array;
}): Uint8Array {
  if (options.commitment.length !== 32) {
    throw new Error(`commitment must be 32 bytes; got ${options.commitment.length}`);
  }
  if (options.proofBytes.length !== GROTH16_PROOF_BYTES) {
    throw new Error(
      `proofBytes must be ${GROTH16_PROOF_BYTES} bytes; got ${options.proofBytes.length}`,
    );
  }
  const out = new Uint8Array(1 + 32 + GROTH16_PROOF_BYTES);
  out[0] = INSTRUCTION_ATTEST_POI;
  out.set(options.commitment, 1);
  out.set(options.proofBytes, 1 + 32);
  return out;
}

/**
 * Build instruction data for `attest_poi_hidden` (disc 23).
 *
 * Same shape as the clear `attest_poi` builder, but the 32-byte public
 * input is the blinded ID = `Poseidon(commitment, nonce)` rather than the
 * commitment itself. Pair with {@link computeBlindedId} to derive the ID
 * the proof should commit to.
 *
 * Layout: disc(1) + blinded_id(32) + proof_bytes(256) = 289 bytes
 */
export function buildAttestPoIHiddenInstructionData(options: {
  blindedId: Uint8Array;
  proofBytes: Uint8Array;
}): Uint8Array {
  if (options.blindedId.length !== 32) {
    throw new Error(`blindedId must be 32 bytes; got ${options.blindedId.length}`);
  }
  if (options.proofBytes.length !== GROTH16_PROOF_BYTES) {
    throw new Error(
      `proofBytes must be ${GROTH16_PROOF_BYTES} bytes; got ${options.proofBytes.length}`,
    );
  }
  const out = new Uint8Array(1 + 32 + GROTH16_PROOF_BYTES);
  out[0] = INSTRUCTION_ATTEST_POI_HIDDEN;
  out.set(options.blindedId, 1);
  out.set(options.proofBytes, 1 + 32);
  return out;
}
