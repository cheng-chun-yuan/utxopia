/**
 * Mobile Prover for React Native (JoinSplit Architecture)
 *
 * Uses mopro-ffi native Groth16 prover for iOS/Android.
 * Circuit .zkey files are resolved via an injected circuit resolver
 * (bundled for tier 1+2, on-demand from Cloudflare R2 for others).
 */

// Re-export types from web for API compatibility
export type {
  MerkleProofInput,
  ProofData,
  CircuitType,
  JoinSplitProofInputs,
} from "./web";

import type { ProofData, CircuitType, JoinSplitProofInputs } from "./web";
import {
  computeJoinSplitNullifierSync,
  computeJoinSplitCommitmentSync,
} from "../poseidon";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

type CircuitResolver = (
  circuitName: string,
  onProgress?: (progress: number) => void,
) => Promise<string>;

let moproModule: any = null;
let circuitResolver: CircuitResolver | null = null;
let proverReady = false;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Inject the circuit file resolver (called from the mobile app layer).
 * The resolver maps a circuit name like "joinsplit_2x2" to the local
 * file-system path of the corresponding .zkey file.
 */
export function setCircuitResolver(resolver: CircuitResolver): void {
  circuitResolver = resolver;
}

// Keep legacy API surface for backward compat
export function setCircuitPath(_path: string): void {
  // no-op — mobile uses resolver, not a base path
}

export function getCircuitPath(): string {
  return "";
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * Initialise the native mopro-ffi prover.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export async function initProver(): Promise<void> {
  if (proverReady) return;

  try {
    // Dynamic require so bundlers don't resolve this at compile time
    // when the native module isn't installed yet.
    moproModule = require("mopro-ffi");
  } catch {
    throw new Error(
      "mopro-ffi native module not found. " +
        "Run the ubrn build step first (see MoproBindings/package.json).",
    );
  }

  proverReady = true;
  console.log("[MobileProver] mopro-ffi native prover initialised");
}

/**
 * Check whether the native prover is available in the current runtime.
 */
export async function isProverAvailable(): Promise<boolean> {
  try {
    if (!moproModule) {
      moproModule = require("mopro-ffi");
    }
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Proof generation
// ---------------------------------------------------------------------------

/**
 * Generate a JoinSplit Groth16 proof using the native mopro-ffi prover.
 *
 * @param inputs    - JoinSplit proof inputs (typed) OR pre-formatted inputs object
 * @param circuitType - Override circuit variant (default: derived from inputs)
 * @param onProgress  - Optional progress callback (0..1)
 */
export async function generateJoinSplitProof(
  inputs: JoinSplitProofInputs | any,
  circuitType?: string,
  onProgress?: (progress: number) => void,
): Promise<ProofData> {
  if (!proverReady) await initProver();
  if (!circuitResolver) {
    throw new Error(
      "Circuit resolver not set. Call setCircuitResolver() before generating proofs.",
    );
  }

  // Determine circuit variant
  const nIn: number = inputs.nInputs ?? inputs.inputs?.length ?? 1;
  const nOut: number = inputs.nOutputs ?? inputs.outputs?.length ?? 2;
  const variant: CircuitType =
    (circuitType as CircuitType) ?? `joinsplit_${nIn}x${nOut}`;

  console.log(`[MobileProver] Generating ${variant} Groth16 proof...`);
  const startTime = Date.now();

  // Resolve the .zkey path (may trigger a download)
  onProgress?.(0);
  const zkeyPath = await circuitResolver(variant, onProgress);
  onProgress?.(0.1);

  // Format inputs for mopro's flat Record<string, string[]> format
  const flatInputs = formatCircuitInputs(inputs, nIn, nOut);

  // Call the native prover
  onProgress?.(0.2);
  const result = await moproModule.generateCircomProof(zkeyPath, flatInputs);
  onProgress?.(0.9);

  const elapsed = Date.now() - startTime;
  console.log(`[MobileProver] Proof generated in ${elapsed}ms`);

  // Convert mopro result to our ProofData format
  const proofData = convertMoproResult(result);
  onProgress?.(1);

  return proofData;
}

// ---------------------------------------------------------------------------
// Input formatting
// ---------------------------------------------------------------------------

/**
 * Convert JoinSplitProofInputs to mopro's flat Record<string, string[]>.
 *
 * mopro expects every value as a string array — scalars become single-element
 * arrays, vectors become multi-element arrays.
 */
function formatCircuitInputs(
  inputs: JoinSplitProofInputs | any,
  nIn: number,
  nOut: number,
): Record<string, string[]> {
  const flat: Record<string, string[]> = {};

  // If inputs are already in flat format, pass through
  if (!inputs.merkleRoot && !inputs.inputs) {
    const result: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(inputs)) {
      if (Array.isArray(value)) {
        result[key] = (value as any[]).map((v) => String(v));
      } else {
        result[key] = [String(value)];
      }
    }
    return result;
  }

  // Typed JoinSplitProofInputs — convert to circuit signal names
  const typed = inputs as JoinSplitProofInputs;

  flat["merkleRoot"] = [typed.merkleRoot.toString()];
  flat["boundParamsHash"] = [typed.boundParamsHash.toString()];
  flat["token"] = [typed.token.toString()];
  flat["publicKey"] = typed.publicKey.map((p) => p.toString());
  flat["signature"] = typed.signature.map((s) => s.toString());
  flat["nullifyingKey"] = [typed.nullifyingKey.toString()];

  // Input arrays
  flat["randomIn"] = typed.inputs.map((i) => i.random.toString());
  flat["valueIn"] = typed.inputs.map((i) => i.value.toString());
  flat["leavesIndices"] = typed.inputs.map((i) => i.leafIndex.toString());

  // Output arrays
  flat["npkOut"] = typed.outputs.map((o) => o.npk.toString());
  flat["valueOut"] = typed.outputs.map((o) => o.value.toString());

  // Compute nullifiers: Poseidon(nullifyingKey, leafIndex)
  const nullifiers: bigint[] = [];
  for (const inp of typed.inputs) {
    nullifiers.push(computeJoinSplitNullifierSync(typed.nullifyingKey, inp.leafIndex));
  }
  flat["nullifiers"] = nullifiers.map((n) => n.toString());

  // Compute output commitments: Poseidon(npk, token, value)
  const commitmentsOut: bigint[] = [];
  for (const out of typed.outputs) {
    commitmentsOut.push(computeJoinSplitCommitmentSync(out.npk, typed.token, out.value));
  }
  flat["commitmentsOut"] = commitmentsOut.map((c) => c.toString());

  // Merkle proof paths — flatten 2D arrays
  // pathElements[i][j] and pathIndices[i][j] where i = input index, j = tree level
  const pathElements: string[] = [];
  const pathIndices: string[] = [];
  for (const inp of typed.inputs) {
    for (const sibling of inp.merkleProof.siblings) {
      pathElements.push(sibling.toString());
    }
    for (const idx of inp.merkleProof.indices) {
      pathIndices.push(idx.toString());
    }
  }
  flat["pathElements"] = pathElements;
  flat["pathIndices"] = pathIndices;

  return flat;
}

// ---------------------------------------------------------------------------
// Result conversion
// ---------------------------------------------------------------------------

/**
 * Convert mopro's CircomProofResult to our ProofData format.
 *
 * mopro returns: { proof: { a: {x, y}, b: {x: [x0,x1], y: [y0,y1]}, c: {x, y} }, inputs: string[] }
 * We need: { proof: Uint8Array(256), publicInputs: string[] }
 */
function convertMoproResult(result: any): ProofData {
  const { proof, inputs: publicInputs } = result;

  const bytes = new Uint8Array(256);

  // G1 point A (64 bytes): x, y
  writeBigIntBE(bytes, 0, BigInt(proof.a.x), 32);
  writeBigIntBE(bytes, 32, BigInt(proof.a.y), 32);

  // G2 point B (128 bytes): [x_imag, x_real, y_imag, y_real]
  // mopro b.x = [x0, x1], b.y = [y0, y1]
  // On-chain layout: x_imag(x1), x_real(x0), y_imag(y1), y_real(y0)
  writeBigIntBE(bytes, 64, BigInt(proof.b.x[1]), 32);
  writeBigIntBE(bytes, 96, BigInt(proof.b.x[0]), 32);
  writeBigIntBE(bytes, 128, BigInt(proof.b.y[1]), 32);
  writeBigIntBE(bytes, 160, BigInt(proof.b.y[0]), 32);

  // G1 point C (64 bytes): x, y
  writeBigIntBE(bytes, 192, BigInt(proof.c.x), 32);
  writeBigIntBE(bytes, 224, BigInt(proof.c.y), 32);

  return {
    proof: bytes,
    publicInputs: publicInputs ?? [],
  };
}

function writeBigIntBE(
  buf: Uint8Array,
  offset: number,
  value: bigint,
  length: number,
): void {
  for (let i = length - 1; i >= 0; i--) {
    buf[offset + i] = Number(value & 0xffn);
    value >>= 8n;
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Convert a ProofData to raw 256-byte proof for on-chain submission.
 */
export function proofToBytes(proof: ProofData): Uint8Array {
  return proof.proof;
}

/**
 * Check if a circuit variant is available (resolver can find the .zkey).
 */
export async function circuitExists(
  circuitType?: CircuitType | string,
): Promise<boolean> {
  if (!circuitResolver) return false;
  const name = circuitType ?? "joinsplit_2x2";
  try {
    await circuitResolver(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reset module state (for testing or hot-reload scenarios).
 */
export async function cleanup(): Promise<void> {
  moproModule = null;
  circuitResolver = null;
  proverReady = false;
  console.log("[MobileProver] Cleaned up");
}
