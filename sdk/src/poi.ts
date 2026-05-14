/**
 * Proof of Innocence (PoI) SDK — Phase 3 skeleton
 *
 * Public types and interfaces only. Implementation deferred — the circuit
 * (`circuits/circom/proof_of_innocence.circom`) needs trusted setup before
 * the prover wrappers can produce real proofs. Calling any of the runtime
 * helpers throws an explicit `not implemented` error so build-time consumers
 * fail loudly rather than silently misbehave.
 *
 * Status (2026-05-13): types frozen, wire format frozen, no live prover.
 * Next steps:
 *   1. Run `bash circuits/scripts/compile.sh poi` (after the script is updated
 *      to recognize the new circuit name)
 *   2. Trusted setup ceremony with a multi-party contribution sequence
 *   3. Run `node circuits/scripts/export-vk-rust.js poi` to emit the on-chain VK
 *   4. Wire `verifyPoIProof` to call into the snarkjs/mopro prover
 *   5. Wire `transact_with_poi` / `unshield_with_poi` instructions in the program
 */

import type { ProofData } from "./prover/web";

/** Tree depth used by the association-set Merkle tree. Keep in sync with circuit. */
export const POI_TREE_DEPTH = 20;

/** Inputs the user provides to generate a PoI proof. */
export interface PoIProofInputs {
  /** Association-set root the proof will be anchored to (as 32-byte BE bigint). */
  associationRoot: bigint;
  /** The deposit-origin commitment whose innocence we're proving. */
  commitment: bigint;
  /** Merkle path against the association tree. */
  pathElements: bigint[];
  /** Direction bits for the Merkle path. */
  pathIndices: number[];
}

/** Public inputs of a generated PoI proof. */
export interface PoIPublicInputs {
  associationRoot: bigint;
  commitment: bigint;
}

/** Backend response when fetching an inclusion proof for a commitment. */
export interface PoIInclusionResponse {
  found: boolean;
  associationRoot: bigint;
  pathElements: bigint[];
  pathIndices: number[];
}

/**
 * Compute the leaf hash for a commitment inside the association tree.
 *
 * For Phase 3 v1 we use the commitment itself as the leaf — it's already a
 * 32-byte Poseidon hash, so re-hashing buys nothing. Reserved as a function in
 * case a future version tags the entry with metadata (e.g. operator id, slot
 * of inclusion) by hashing extra fields.
 */
export function poiLeafHash(commitment: bigint): bigint {
  return commitment;
}

/**
 * Fetch the inclusion proof for a commitment from a curated PoI service.
 *
 * Returns `null` if the commitment is not in the current association set —
 * callers should treat this as "cannot prove innocence; the user should run
 * normal (non-PoI) transact instead."
 */
export async function fetchPoIInclusion(
  serviceUrl: string,
  commitment: bigint,
  signal?: AbortSignal,
): Promise<PoIInclusionResponse | null> {
  const url = `${serviceUrl}/api/poi/inclusion?commitment=${commitment.toString(16)}`;
  const resp = await fetch(url, { signal });
  if (resp.status === 404) return null;
  if (!resp.ok) {
    throw new Error(`fetchPoIInclusion: HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as {
    found: boolean;
    association_root: string;
    path_elements: string[];
    path_indices: number[];
  };
  if (!data.found) return null;
  return {
    found: true,
    associationRoot: BigInt("0x" + data.association_root),
    pathElements: data.path_elements.map((s) => BigInt("0x" + s)),
    pathIndices: data.path_indices,
  };
}

/**
 * Generate a Proof of Innocence Groth16 proof.
 *
 * Calls into the generic snarkjs prover with the `proof_of_innocence`
 * circuit. Requires the compiled wasm + zkey to be present under
 * `<circuitBasePath>/proof_of_innocence/`.
 */
export async function generatePoIProof(inputs: PoIProofInputs): Promise<ProofData> {
  // Import lazily so the snarkjs dependency is only pulled in when the
  // caller actually runs a proof. Keeps client bundles slim.
  const { generateGenericGroth16Proof } = await import("./prover/web");
  if (inputs.pathElements.length !== POI_TREE_DEPTH) {
    throw new Error(
      `PoI proof expects ${POI_TREE_DEPTH} path elements; got ${inputs.pathElements.length}`,
    );
  }
  if (inputs.pathIndices.length !== POI_TREE_DEPTH) {
    throw new Error(
      `PoI proof expects ${POI_TREE_DEPTH} path indices; got ${inputs.pathIndices.length}`,
    );
  }
  return generateGenericGroth16Proof("proof_of_innocence", {
    associationRoot: inputs.associationRoot.toString(),
    commitment: inputs.commitment.toString(),
    pathElements: inputs.pathElements.map((e) => e.toString()),
    pathIndices: inputs.pathIndices,
  });
}

// ---------------------------------------------------------------------------
// Hidden-commitment PoI (Phase 3d-lite)
// ---------------------------------------------------------------------------

/** Inputs to {@link generateHiddenPoIProof}. */
export interface HiddenPoIProofInputs extends PoIProofInputs {
  /**
   * Random 240-bit blinding factor. Anyone with this value can verify the
   * binding between the on-chain `blinded_id` and the underlying
   * commitment, so treat it as a "share-only-with-your-auditor" secret.
   */
  nonce: bigint;
}

/** Number of random bytes recommended for the nonce. 30 bytes ≈ 240 bits
 *  of entropy, comfortably above the security margin for blinding. */
export const HIDDEN_POI_NONCE_BYTES = 30;

/**
 * Compute the public blinded ID = `Poseidon(commitment, nonce)`.
 *
 * SDK + circuit + on-chain verifier must agree on this construction byte
 * for byte. Uses the same circomlibjs Poseidon-2 the circuit uses, so the
 * BN254 field element matches exactly.
 */
export async function computeBlindedId(commitment: bigint, nonce: bigint): Promise<bigint> {
  // Lazy-load circomlibjs to keep the bundle slim for callers that never
  // touch the hidden-PoI flow.
  const { buildPoseidon } = await import("circomlibjs");
  type FieldElement = unknown;
  interface Poseidon {
    (inputs: FieldElement[]): FieldElement;
    F: { e: (x: bigint) => FieldElement; toObject: (x: FieldElement) => bigint };
  }
  const poseidon = (await buildPoseidon()) as Poseidon;
  const F = poseidon.F;
  return F.toObject(poseidon([F.e(commitment), F.e(nonce)]));
}

/**
 * Generate a fresh random nonce suitable for blinding a commitment.
 * Returns an integer in `[0, 2^240)` — well below BN254's field size, so
 * never wraps modulo the prime.
 */
export function generateHiddenPoINonce(): bigint {
  const bytes = new Uint8Array(HIDDEN_POI_NONCE_BYTES);
  crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

/**
 * Generate a hidden-commitment Proof of Innocence Groth16 proof.
 *
 * Calls into the generic snarkjs prover with the `attest_poi_hidden`
 * circuit. The public output is `blinded_id = Poseidon(commitment, nonce)`
 * — pass it to `buildAttestPoIHiddenInstructionData` to construct the
 * on-chain attestation.
 */
export async function generateHiddenPoIProof(inputs: HiddenPoIProofInputs): Promise<ProofData> {
  const { generateGenericGroth16Proof } = await import("./prover/web");
  if (inputs.pathElements.length !== POI_TREE_DEPTH) {
    throw new Error(
      `Hidden PoI proof expects ${POI_TREE_DEPTH} path elements; got ${inputs.pathElements.length}`,
    );
  }
  if (inputs.pathIndices.length !== POI_TREE_DEPTH) {
    throw new Error(
      `Hidden PoI proof expects ${POI_TREE_DEPTH} path indices; got ${inputs.pathIndices.length}`,
    );
  }
  const blindedId = await computeBlindedId(inputs.commitment, inputs.nonce);
  return generateGenericGroth16Proof("attest_poi_hidden", {
    associationRoot: inputs.associationRoot.toString(),
    blindedId: blindedId.toString(),
    commitment: inputs.commitment.toString(),
    nonce: inputs.nonce.toString(),
    pathElements: inputs.pathElements.map((e) => e.toString()),
    pathIndices: inputs.pathIndices,
  });
}
