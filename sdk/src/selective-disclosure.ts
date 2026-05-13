/**
 * Selective ZK Disclosure (Phase 4 skeleton)
 *
 * Targeted ZK proofs that reveal a single fact about the prover's notes
 * without handing over a viewing key. Two flavors:
 *
 *   1. Ownership proof — "I own commitment X, amount ≥ Y."
 *      Useful for: proof-of-funds to a regulator, dispute resolution,
 *      challenge-response with a counterparty.
 *
 *   2. Range-sum proof — "Σ amount_i over a slot range ≤ Z" across a
 *      caller-provided set of leaf indices, with a check that I have
 *      *committed* to the full set via a Merkle commitment over the set.
 *
 * Status (2026-05-13): types frozen, no live prover. Circuits for both
 * (`ownership.circom`, `range_sum.circom`) need design + trusted setup before
 * runtime can do real work. Until then both generator functions throw.
 *
 * Design notes:
 *
 *   Ownership proof. Algorithm sketch:
 *     - Inputs (private): spendingPrivScalar, randomIn, valueIn, merkleProof
 *     - Inputs (public): commitment, merkleRoot, threshold (Y), token
 *     - Constraints:
 *         (a) commitment == Poseidon(NPK, token, valueIn) where
 *             NPK = Poseidon(MPK, randomIn) and MPK = Poseidon(spendingPub, nk)
 *         (b) commitment ∈ tree(merkleRoot)
 *         (c) valueIn >= threshold (range check)
 *     - The proof produces a *non-spending* witness: no nullifier is emitted,
 *       so generating the proof doesn't burn the note.
 *
 *   Range-sum proof. Algorithm sketch:
 *     - Inputs (private): for each note i: randomIn[i], valueIn[i], merkleProof[i]
 *     - Inputs (public): leafIndices[i], merkleRoot, ceiling (Z), token,
 *         attestation = Poseidon(leafIndices, viewerNonce) — a binding so the
 *         verifier knows the prover committed to *this exact* set of leaves
 *     - Constraints:
 *         (a) each commitment ∈ tree(merkleRoot)
 *         (b) each commitment == Poseidon(NPK_i, token, valueIn[i])
 *         (c) Σ valueIn[i] <= ceiling
 *         (d) attestation matches
 *     - Coverage check (the hard part: proving the prover didn't *omit* notes
 *       in the slot range) is enforced by having the verifier independently
 *       compute attestation = Poseidon(everyKnownLeaf, viewerNonce) and
 *       compare. The verifier learns the leaf set from the public viewing key
 *       handed over for that purpose.
 *
 * The viewing-key-coverage dependency means range-sum is most useful when
 * paired with the auditor flow from Phase 1 — a one-shot disclosure that
 * proves a property over the set the auditor already verified.
 */

import type { ProofData } from "./prover/web";

// ---------------------------------------------------------------------------
// Ownership proof
// ---------------------------------------------------------------------------

export interface OwnershipProofInputs {
  /** Witness data for the note. */
  spendingPrivScalar: bigint;
  nullifyingKey: bigint;
  randomIn: bigint;
  valueIn: bigint;
  pathElements: bigint[];
  pathIndices: number[];

  /** Public commitments the prover is claiming. */
  commitment: bigint;
  merkleRoot: bigint;
  /** Minimum amount the prover asserts the note holds. */
  threshold: bigint;
  tokenId: bigint;
}

export interface OwnershipPublicInputs {
  commitment: bigint;
  merkleRoot: bigint;
  threshold: bigint;
  tokenId: bigint;
}

/**
 * Generate an ownership ZK proof.
 *
 * Calls into the generic snarkjs prover with the `ownership` circuit.
 * Requires the compiled wasm + zkey under `<circuitBasePath>/ownership/`.
 *
 * Public inputs: [commitment, merkleRoot, threshold, tokenId]
 */
export async function generateOwnershipProof(
  inputs: OwnershipProofInputs,
): Promise<ProofData> {
  const { generateGenericGroth16Proof } = await import("./prover/web");
  return generateGenericGroth16Proof("ownership", {
    commitment: inputs.commitment.toString(),
    merkleRoot: inputs.merkleRoot.toString(),
    threshold: inputs.threshold.toString(),
    token: inputs.tokenId.toString(),
    spendingPrivScalar: inputs.spendingPrivScalar.toString(),
    randomIn: inputs.randomIn.toString(),
    valueIn: inputs.valueIn.toString(),
    pathElements: inputs.pathElements.map((e) => e.toString()),
    pathIndices: inputs.pathIndices,
    nullifyingKey: inputs.nullifyingKey.toString(),
  });
}

// ---------------------------------------------------------------------------
// Range-sum proof
// ---------------------------------------------------------------------------

export interface RangeSumProofInputs {
  /** One entry per note in the prover's claimed set. */
  notes: ReadonlyArray<{
    randomIn: bigint;
    valueIn: bigint;
    pathElements: bigint[];
    pathIndices: number[];
    commitment: bigint;
    leafIndex: number;
  }>;

  /** Common shared data. */
  spendingPrivScalar: bigint;
  nullifyingKey: bigint;
  merkleRoot: bigint;
  /** Upper bound on the sum the prover asserts. */
  ceiling: bigint;
  tokenId: bigint;
  /** Salt the verifier supplied, binding the proof to this verification round. */
  viewerNonce: bigint;
  /** Poseidon(leafIndices ++ [viewerNonce]) — must match the public input. */
  attestation: bigint;
}

export interface RangeSumPublicInputs {
  leafIndices: number[];
  merkleRoot: bigint;
  ceiling: bigint;
  tokenId: bigint;
  /** Poseidon(leafIndices ++ [viewerNonce]) committed to by the prover. */
  attestation: bigint;
}

/** Number of notes the v1 range-sum circuit accepts. Fixed at compile time. */
export const RANGE_SUM_N = 8;

/**
 * Generate a range-sum ZK proof (current variant: N=8).
 *
 * Calls into the generic snarkjs prover with the `range_sum` circuit.
 * Requires the compiled wasm + zkey under `<circuitBasePath>/range_sum/`.
 *
 * Public inputs: [leafIndices(N), merkleRoot, ceiling, token, attestation]
 */
export async function generateRangeSumProof(
  inputs: RangeSumProofInputs,
): Promise<ProofData> {
  if (inputs.notes.length !== RANGE_SUM_N) {
    throw new Error(
      `range_sum v1 expects exactly ${RANGE_SUM_N} notes; got ${inputs.notes.length}. ` +
        "Pad with zero-value notes or recompile a different variant.",
    );
  }
  const { generateGenericGroth16Proof } = await import("./prover/web");
  return generateGenericGroth16Proof("range_sum", {
    leafIndices: inputs.notes.map((n) => n.leafIndex),
    merkleRoot: inputs.merkleRoot.toString(),
    ceiling: inputs.ceiling.toString(),
    token: inputs.tokenId.toString(),
    attestation: inputs.attestation.toString(),
    spendingPrivScalar: inputs.spendingPrivScalar.toString(),
    nullifyingKey: inputs.nullifyingKey.toString(),
    randomIn: inputs.notes.map((n) => n.randomIn.toString()),
    valueIn: inputs.notes.map((n) => n.valueIn.toString()),
    pathElements: inputs.notes.map((n) => n.pathElements.map((e) => e.toString())),
    pathIndices: inputs.notes.map((n) => n.pathIndices),
    viewerNonce: inputs.viewerNonce.toString(),
    commitmentsIn: inputs.notes.map((n) => n.commitment.toString()),
  });
}
