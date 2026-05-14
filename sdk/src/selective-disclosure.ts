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

/**
 * How the variant computes `attestation` from `(leafIndices, viewerNonce)`.
 *
 *   - "flat"    — `Poseidon(leafIndices ++ [viewerNonce])`. Cheap; requires
 *                 N+1 ≤ 16 because circomlib's Poseidon caps at arity 16.
 *   - "chunked" — `Poseidon(Poseidon(leafIndices[0..N/2]),
 *                           Poseidon(leafIndices[N/2..N]),
 *                           viewerNonce)`. Needed at N=16 where the flat
 *                 form would require Poseidon(17). Only one nesting level
 *                 ships today (N=16); deeper variants would extend the
 *                 same pattern.
 */
export type RangeSumAttestationStyle = "flat" | "chunked";

/**
 * Compiled range-sum variants and the cardinality each handles. Add new
 * entries here when you build a new sibling circuit. The `circuit` field
 * must match the directory name under `circuits/build/`.
 */
export const RANGE_SUM_VARIANTS = [
  { n: 4, circuit: "range_sum_4" as const, attestation: "flat" as const },
  { n: 8, circuit: "range_sum" as const, attestation: "flat" as const },
  { n: 16, circuit: "range_sum_16" as const, attestation: "chunked" as const },
] as const;

/** Number of notes accepted by each compiled variant. */
export const RANGE_SUM_SIZES = RANGE_SUM_VARIANTS.map((v) => v.n);

/**
 * @deprecated Prefer `RANGE_SUM_VARIANTS` / `pickRangeSumVariant`. Retained
 * for back-compat with older callers that assumed a single N.
 */
export const RANGE_SUM_N = 8;

/** Look up the compiled circuit name for a given note cardinality. */
export function pickRangeSumVariant(n: number): typeof RANGE_SUM_VARIANTS[number] {
  const v = RANGE_SUM_VARIANTS.find((x) => x.n === n);
  if (!v) {
    throw new Error(
      `range_sum has no compiled variant for N=${n}. Compiled variants: ` +
        RANGE_SUM_SIZES.join(", ") +
        ". Pad with zero-value notes or compile a new variant " +
        "(see circuits/scripts/build-aux.sh).",
    );
  }
  return v;
}

/**
 * Compute the range-sum attestation public input the way each compiled
 * circuit expects. SDK + CLI must agree on this exactly or the verifier
 * rejects the proof.
 *
 *   - flat:    Poseidon(leafIndices ++ [viewerNonce])
 *   - chunked: Poseidon(Poseidon(leafIndices[0..N/2]),
 *                       Poseidon(leafIndices[N/2..N]),
 *                       viewerNonce)
 *
 * `style` defaults to the cardinality's compiled variant; pass it
 * explicitly if you're computing the value without going through
 * `generateRangeSumProof` (e.g. inside a CLI that lays out witness data
 * up front).
 */
export async function computeRangeSumAttestation(
  leafIndices: ReadonlyArray<number | bigint>,
  viewerNonce: bigint,
  style?: RangeSumAttestationStyle,
): Promise<bigint> {
  // Only consult the variants registry when the caller didn't pick a style
  // explicitly. The explicit-style path is for tests / parity checks that
  // want to compute the hash without first compiling a variant.
  const resolvedStyle: RangeSumAttestationStyle =
    style ?? pickRangeSumVariant(leafIndices.length).attestation;

  // circomlibjs's Poseidon caps at the same arity (16) as the circom-side
  // hash. Importing the heavy circomlibjs module lazily keeps the SDK
  // bundle slim for callers that never compute an attestation.
  const { buildPoseidon } = await import("circomlibjs");
  // circomlibjs is untyped; cast to a minimal shape so downstream code
  // doesn't drown in `unknown`s. Field elements are opaque to TypeScript
  // (they're internally Uint8Arrays representing BN254 elements).
  type FieldElement = unknown;
  interface Poseidon {
    (inputs: FieldElement[]): FieldElement;
    F: { e: (x: bigint) => FieldElement; toObject: (x: FieldElement) => bigint };
  }
  const poseidon = (await buildPoseidon()) as Poseidon;
  const F = poseidon.F;
  const indicesAsField: FieldElement[] = leafIndices.map((i) => F.e(BigInt(i)));

  if (resolvedStyle === "flat") {
    return F.toObject(poseidon([...indicesAsField, F.e(viewerNonce)]));
  }
  // chunked: split in half, hash each half, then hash the two digests + nonce.
  const half = leafIndices.length / 2;
  if (!Number.isInteger(half)) {
    throw new Error(
      `chunked attestation requires an even cardinality; got N=${leafIndices.length}`,
    );
  }
  const chunk1: FieldElement = poseidon(indicesAsField.slice(0, half));
  const chunk2: FieldElement = poseidon(indicesAsField.slice(half));
  return F.toObject(poseidon([chunk1, chunk2, F.e(viewerNonce)]));
}

/**
 * Generate a range-sum ZK proof. The variant is picked automatically from
 * `inputs.notes.length` — compile + register new variants in
 * `RANGE_SUM_VARIANTS` to extend the supported cardinalities.
 *
 * Calls into the generic snarkjs prover with the matching circuit.
 * Requires the compiled wasm + zkey under
 * `<circuitBasePath>/<variant.circuit>/`.
 *
 * Public inputs: [leafIndices(N), merkleRoot, ceiling, token, attestation]
 */
export async function generateRangeSumProof(
  inputs: RangeSumProofInputs,
): Promise<ProofData> {
  const variant = pickRangeSumVariant(inputs.notes.length);
  const { generateGenericGroth16Proof } = await import("./prover/web");
  return generateGenericGroth16Proof(variant.circuit, {
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
