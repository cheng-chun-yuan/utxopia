/**
 * WASM-based Groth16 Proof Generator for UTXOPIA
 *
 * Universal prover that works in both Browser and Node.js environments.
 * Uses Groth16 proofs via snarkjs with lazy loading.
 *
 * JOINSPLIT MODEL:
 * - Commitment = Poseidon(npk, token, amount)
 * - Nullifier = Poseidon(nullifyingKey, leafIndex)
 * - Signature = EdDSA-Poseidon over (merkleRoot, boundParamsHash, nullifiers..., commitmentsOut...)
 */

import {
  poseidonHashSync,
  computeJoinSplitCommitmentSync,
  computeJoinSplitNullifierSync,
} from "../poseidon";
import { BN254_FIELD_PRIME } from "../crypto";
import { TREE_DEPTH } from "../merkle";
import { getConfig } from "../config";
import type { Address } from "@solana/kit";

/** Maximum satoshis (total BTC supply) */
const MAX_SATOSHIS = 21_000_000n * 100_000_000n;

/**
 * Validate that proof inputs are within BN254 field bounds.
 */
function validateFieldInputs(fields: Record<string, bigint>): void {
  for (const [name, value] of Object.entries(fields)) {
    if (value < 0n) {
      throw new Error(`Invalid proof input: ${name} is negative`);
    }
    if (value >= BN254_FIELD_PRIME) {
      throw new Error(`Invalid proof input: ${name} exceeds BN254 field prime`);
    }
  }
}

function validateAmount(amount: bigint, label: string): void {
  if (amount <= 0n) {
    throw new Error(`Invalid proof input: ${label} must be positive`);
  }
  if (amount > MAX_SATOSHIS) {
    throw new Error(`Invalid proof input: ${label} exceeds total BTC supply`);
  }
}

export interface MerkleProofInput {
  siblings: bigint[];
  indices: number[];
}

export interface ProofData {
  proof: Uint8Array;
  publicInputs: string[];
  verificationKey?: Uint8Array;
}

export type CircuitType = `joinsplit_${number}x${number}`;

/** Names of non-JoinSplit auxiliary circuits (selective disclosure). */
export type AuxCircuitName =
  | "ownership"
  | "range_sum"
  | "range_sum_4"
  | "range_sum_16";

// Environment detection
const isBrowser = typeof window !== "undefined";
const isNode = typeof process !== "undefined" && process.versions?.node;

// Configurable circuit paths
let circuitBasePath = isBrowser ? "/circuits/groth16" : "./circuits";

/**
 * Set the base path for circuit artifacts
 */
export function setCircuitPath(path: string): void {
  circuitBasePath = path;
}

/**
 * Get the current circuit base path
 */
export function getCircuitPath(): string {
  return circuitBasePath;
}

// Lazy-loaded snarkjs module
let snarkjs: any = null;

interface CircuitArtifact {
  wasmPath: string;
  zkeyPath: string;
}

const circuitCache = new Map<CircuitType, CircuitArtifact>();
let proverInitialized = false;

/**
 * Load snarkjs module
 */
async function ensureSnarkjsLoaded(): Promise<void> {
  if (snarkjs) return;

  console.log("[Prover] Loading snarkjs module...");
  snarkjs = await import("snarkjs").catch(() => null);

  if (!snarkjs) {
    throw new Error(
      "Groth16 prover requires the snarkjs package. " +
        "Install it with: bun add snarkjs"
    );
  }
}

/**
 * Resolve circuit artifact paths
 */
function getCircuitArtifactPaths(circuitType: CircuitType): CircuitArtifact {
  if (circuitCache.has(circuitType)) {
    return circuitCache.get(circuitType)!;
  }

  const name = circuitType; // "joinsplit_NxM"
  const artifact: CircuitArtifact = {
    wasmPath: `${circuitBasePath}/${name}/${name}_js/${name}.wasm`,
    zkeyPath: `${circuitBasePath}/${name}/${name}.zkey`,
  };

  circuitCache.set(circuitType, artifact);
  return artifact;
}

type InputMap = Record<string, string | string[] | number[] | string[][] | number[][]>;

// Detect bun runtime (snarkjs WASM hangs in bun)
const isBun = typeof process !== "undefined" && !!(process as any).versions?.bun;

/**
 * Generate a Groth16 proof for a circuit with given inputs.
 * Uses Node.js subprocess when running in bun (snarkjs WASM incompatibility).
 */
async function generateProof(
  circuitType: CircuitType,
  inputs: InputMap
): Promise<ProofData> {
  console.log(`[Prover] Generating ${circuitType} Groth16 proof...`);
  const startTime = typeof performance !== "undefined" ? performance.now() : Date.now();

  const artifacts = getCircuitArtifactPaths(circuitType);

  let proof: any;
  let publicSignals: string[];

  if (isBun && isNode) {
    const result = await generateProofViaNodeSubprocess(artifacts, inputs);
    proof = result.proof;
    publicSignals = result.publicSignals;
  } else {
    await ensureSnarkjsLoaded();
    const result = await snarkjs.groth16.fullProve(
      inputs,
      artifacts.wasmPath,
      artifacts.zkeyPath
    );
    proof = result.proof;
    publicSignals = result.publicSignals;
  }

  const elapsed = (typeof performance !== "undefined" ? performance.now() : Date.now()) - startTime;
  console.log(`[Prover] Groth16 proof generated in ${elapsed.toFixed(0)}ms`);

  const proofBytes = serializeProof(proof);
  console.log(`[Prover] Proof size: ${proofBytes.length} bytes`);

  return {
    proof: proofBytes,
    publicInputs: publicSignals,
  };
}

/**
 * Generate proof via Node.js subprocess (for bun compatibility)
 */
async function generateProofViaNodeSubprocess(
  artifacts: CircuitArtifact,
  inputs: InputMap
): Promise<{ proof: any; publicSignals: string[] }> {
  // Build a CommonJS-aware `require` that works in both CJS and ESM execution
  // contexts. In ESM, `require` isn't a global; `module.createRequire(url)`
  // creates one bound to a given module URL.
  // `import.meta.url` is only valid in ESM modules; in CJS bundles
  // (`type: "commonjs"`) we fall back to the inherited `require`. Both
  // bundlers (esbuild / tsc) preserve `import.meta.url` correctly.
  let _require: (m: string) => any;
  if (typeof (globalThis as any).require === "function") {
    _require = (globalThis as any).require;
  } else {
    // Hide the dynamic import from webpack so the browser bundle never tries
    // to resolve `node:module`. This whole code path only fires under Node/bun,
    // never in the browser.
    const dynamicImport = new Function(
      "specifier",
      "return import(specifier)",
    ) as (s: string) => Promise<any>;
    const { createRequire } = await dynamicImport("node:module");
    _require = createRequire(import.meta.url);
  }
  const { execFileSync } = _require("child_process");
  const fs = _require("fs");
  const path = _require("path");

  const wasmPath = path.resolve(artifacts.wasmPath);
  const zkeyPath = path.resolve(artifacts.zkeyPath);

  const tmpDir = path.dirname(wasmPath);
  const tmpInput = path.join(tmpDir, `_prover_input_${Date.now()}.json`);
  const tmpProof = path.join(tmpDir, `_prover_proof_${Date.now()}.json`);
  const tmpPublic = path.join(tmpDir, `_prover_public_${Date.now()}.json`);

  fs.writeFileSync(tmpInput, JSON.stringify(inputs));

  try {
    // Use execFileSync to avoid shell injection via file paths
    // Take the last 5 argv entries — Node 24's --eval TypeScript transform
    // can prepend extra paths, so positional destructuring [,, ...] breaks.
    const script = `
      const snarkjs = require('snarkjs');
      const fs = require('fs');
      const [inputPath, wasmP, zkeyP, proofPath, publicPath] = process.argv.slice(-5);
      (async () => {
        const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmP, zkeyP);
        fs.writeFileSync(proofPath, JSON.stringify(proof));
        fs.writeFileSync(publicPath, JSON.stringify(publicSignals));
        process.exit(0);
      })().catch(e => { console.error(e); process.exit(1); });
    `;
    execFileSync("node", ["-e", script, tmpInput, wasmPath, zkeyPath, tmpProof, tmpPublic], {
      timeout: 120000,
    });

    const proof = JSON.parse(fs.readFileSync(tmpProof, "utf8"));
    const publicSignals: string[] = JSON.parse(fs.readFileSync(tmpPublic, "utf8"));

    return { proof, publicSignals };
  } finally {
    try { fs.unlinkSync(tmpInput); } catch {}
    try { fs.unlinkSync(tmpProof); } catch {}
    try { fs.unlinkSync(tmpPublic); } catch {}
  }
}

/**
 * Serialize snarkjs Groth16 proof to 256 bytes (2 G1 + 1 G2 on BN254)
 */
function serializeProof(proof: any): Uint8Array {
  const bytes = new Uint8Array(256);

  const piA = proof.pi_a;
  const piB = proof.pi_b;
  const piC = proof.pi_c;

  // G1 point A (64 bytes)
  writeBigIntBE(bytes, 0, BigInt(piA[0]), 32);
  writeBigIntBE(bytes, 32, BigInt(piA[1]), 32);

  // G2 point B (128 bytes): [x_imag, x_real, y_imag, y_real]
  writeBigIntBE(bytes, 64, BigInt(piB[0][1]), 32);
  writeBigIntBE(bytes, 96, BigInt(piB[0][0]), 32);
  writeBigIntBE(bytes, 128, BigInt(piB[1][1]), 32);
  writeBigIntBE(bytes, 160, BigInt(piB[1][0]), 32);

  // G1 point C (64 bytes)
  writeBigIntBE(bytes, 192, BigInt(piC[0]), 32);
  writeBigIntBE(bytes, 224, BigInt(piC[1]), 32);

  return bytes;
}

function writeBigIntBE(buf: Uint8Array, offset: number, value: bigint, length: number): void {
  for (let i = length - 1; i >= 0; i--) {
    buf[offset + i] = Number(value & 0xFFn);
    value >>= 8n;
  }
}

// ==========================================================================
// Public API
// ==========================================================================

/**
 * Initialize the prover (preloads snarkjs module)
 */
export async function initProver(): Promise<void> {
  await ensureSnarkjsLoaded();
  proverInitialized = true;
  console.log("[Prover] Groth16 prover initialized and ready");
}

/**
 * Generate a Groth16 proof for any circuit by name. Useful for non-JoinSplit
 * circuits (ownership, range_sum) that follow the same artifact layout
 * `<circuitBasePath>/<name>/<name>_js/<name>.wasm` + `<circuitBasePath>/<name>/<name>.zkey`.
 *
 * Returns `{ proof: 256 bytes, publicInputs }` matching `ProofData`.
 */
export async function generateGenericGroth16Proof(
  circuitName: string,
  inputs: Record<string, string | string[] | number[] | string[][] | number[][]>,
): Promise<ProofData> {
  // Reuse the same artifact lookup pattern as JoinSplit variants.
  const artifacts: CircuitArtifact = {
    wasmPath: `${circuitBasePath}/${circuitName}/${circuitName}_js/${circuitName}.wasm`,
    zkeyPath: `${circuitBasePath}/${circuitName}/${circuitName}.zkey`,
  };

  let proof: any;
  let publicSignals: string[];

  if (isBun && isNode) {
    const result = await generateProofViaNodeSubprocess(artifacts, inputs);
    proof = result.proof;
    publicSignals = result.publicSignals;
  } else {
    await ensureSnarkjsLoaded();
    const result = await snarkjs.groth16.fullProve(
      inputs,
      artifacts.wasmPath,
      artifacts.zkeyPath,
    );
    proof = result.proof;
    publicSignals = result.publicSignals;
  }

  return {
    proof: serializeProof(proof),
    publicInputs: publicSignals,
  };
}

/**
 * Check if prover is available in current environment
 */
export async function isProverAvailable(): Promise<boolean> {
  try {
    await ensureSnarkjsLoaded();
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify a Groth16 proof against a verifying key + public signals.
 *
 * Accepts the snarkjs-native shapes:
 *   - `vkey`:           the JSON emitted by `snarkjs zkey export verificationkey`
 *   - `publicSignals`:  array of decimal strings
 *   - `proof`:          `{ pi_a, pi_b, pi_c, protocol, curve }` as produced by `snarkjs.groth16.fullProve`
 *
 * Lazy-loads snarkjs so calling code doesn't pay the bundle cost unless it
 * verifies. Returns true on a valid proof, false on an invalid one; throws
 * if snarkjs is missing or the inputs are structurally malformed.
 */
export async function verifyGroth16Proof(
  vkey: unknown,
  publicSignals: ReadonlyArray<string>,
  proof: unknown,
): Promise<boolean> {
  await ensureSnarkjsLoaded();
  return snarkjs.groth16.verify(vkey, publicSignals, proof);
}

// ==========================================================================
// JoinSplit Proof Generation (Railgun-aligned)
// ==========================================================================

/**
 * JoinSplit proof inputs
 */
export interface JoinSplitProofInputs {
  nInputs: number;
  nOutputs: number;
  merkleRoot: bigint;
  boundParamsHash: bigint;
  token: bigint;
  publicKey: [bigint, bigint];  // BJJ (x, y)
  signature: [bigint, bigint, bigint];  // EdDSA-Poseidon (R8x, R8y, S)
  nullifyingKey: bigint;
  inputs: Array<{
    random: bigint;
    value: bigint;
    leafIndex: bigint;
    merkleProof: { siblings: bigint[]; indices: number[] };
  }>;
  outputs: Array<{ npk: bigint; value: bigint }>;
}

/**
 * Generate a JoinSplit proof
 *
 * Unified prover for all JoinSplit variants.
 * Selects the joinsplit_NxM circuit based on nInputs/nOutputs.
 */
export async function generateJoinSplitProof(inputs: JoinSplitProofInputs): Promise<ProofData> {
  const { nInputs, nOutputs } = inputs;

  if (nInputs < 1 || nOutputs < 1 || nInputs + nOutputs > 14) {
    throw new Error(`Invalid JoinSplit dimensions: ${nInputs}x${nOutputs} (N+M must be 2..14)`);
  }

  // Validate array lengths match declared dimensions
  if (inputs.inputs.length !== nInputs) {
    throw new Error(`Expected ${nInputs} inputs, got ${inputs.inputs.length}`);
  }
  if (inputs.outputs.length !== nOutputs) {
    throw new Error(`Expected ${nOutputs} outputs, got ${inputs.outputs.length}`);
  }

  validateFieldInputs({
    merkleRoot: inputs.merkleRoot,
    boundParamsHash: inputs.boundParamsHash,
    token: inputs.token,
    publicKeyX: inputs.publicKey[0],
    publicKeyY: inputs.publicKey[1],
    nullifyingKey: inputs.nullifyingKey,
  });

  // Validate input amounts and Merkle proof depths
  let totalIn = 0n;
  for (let i = 0; i < inputs.inputs.length; i++) {
    const inp = inputs.inputs[i];
    validateAmount(inp.value, `input[${i}].value`);
    validateFieldInputs({ [`input[${i}].random`]: inp.random });
    if (inp.merkleProof.siblings.length !== TREE_DEPTH) {
      throw new Error(
        `input[${i}].merkleProof: expected ${TREE_DEPTH} siblings, got ${inp.merkleProof.siblings.length}`
      );
    }
    if (inp.merkleProof.indices.length !== TREE_DEPTH) {
      throw new Error(
        `input[${i}].merkleProof: expected ${TREE_DEPTH} indices, got ${inp.merkleProof.indices.length}`
      );
    }
    totalIn += inp.value;
  }

  // Validate output amounts
  let totalOut = 0n;
  for (let i = 0; i < inputs.outputs.length; i++) {
    const out = inputs.outputs[i];
    validateAmount(out.value, `output[${i}].value`);
    validateFieldInputs({ [`output[${i}].npk`]: out.npk });
    totalOut += out.value;
  }

  // Validate conservation of value (inputs must equal outputs)
  if (totalIn !== totalOut) {
    throw new Error(
      `Value mismatch: inputs sum to ${totalIn} sats but outputs sum to ${totalOut} sats`
    );
  }

  // Compute nullifiers
  const nullifiers: bigint[] = [];
  for (const inp of inputs.inputs) {
    const nullifier = computeJoinSplitNullifierSync(inputs.nullifyingKey, inp.leafIndex);
    nullifiers.push(nullifier);
  }

  // Compute output commitments
  const commitmentsOut: bigint[] = [];
  for (const out of inputs.outputs) {
    const commitment = computeJoinSplitCommitmentSync(out.npk, inputs.token, out.value);
    commitmentsOut.push(commitment);
  }

  // Compute message hash: Poseidon(merkleRoot, boundParamsHash, nullifiers..., commitmentsOut...)
  const hashInputs: bigint[] = [
    inputs.merkleRoot,
    inputs.boundParamsHash,
    ...nullifiers,
    ...commitmentsOut,
  ];
  const _msgHash = poseidonHashSync(hashInputs);

  // Build circuit inputs
  const circuitInputs: InputMap = {
    merkleRoot: inputs.merkleRoot.toString(),
    boundParamsHash: inputs.boundParamsHash.toString(),
    nullifiers: nullifiers.map(n => n.toString()),
    commitmentsOut: commitmentsOut.map(c => c.toString()),
    token: inputs.token.toString(),
    publicKey: inputs.publicKey.map(p => p.toString()),
    signature: inputs.signature.map(s => s.toString()),
    nullifyingKey: inputs.nullifyingKey.toString(),
    randomIn: inputs.inputs.map(i => i.random.toString()),
    valueIn: inputs.inputs.map(i => i.value.toString()),
    leavesIndices: inputs.inputs.map(i => i.leafIndex.toString()),
    npkOut: inputs.outputs.map(o => o.npk.toString()),
    valueOut: inputs.outputs.map(o => o.value.toString()),
  };

  // Build path arrays (2D arrays for circuit)
  const pathElements: string[][] = [];
  const pathIndices: number[][] = [];
  for (const inp of inputs.inputs) {
    pathElements.push(inp.merkleProof.siblings.map(s => s.toString()));
    pathIndices.push(inp.merkleProof.indices);
  }
  circuitInputs.pathElements = pathElements as any;
  circuitInputs.pathIndices = pathIndices as any;

  const variantName: CircuitType = `joinsplit_${nInputs}x${nOutputs}`;
  return generateProof(variantName, circuitInputs);
}

// ==========================================================================
// Circuit Availability & Verification
// ==========================================================================

/**
 * Check if circuit artifacts exist for a given circuit type
 */
export async function circuitExists(circuitType: CircuitType): Promise<boolean> {
  try {
    const artifacts = getCircuitArtifactPaths(circuitType);
    const isUrl = artifacts.wasmPath.startsWith("http://") || artifacts.wasmPath.startsWith("https://");

    if (isBrowser || isUrl) {
      // Browser or remote URL (S3, CDN) — use fetch
      const [wasmRes, zkeyRes] = await Promise.all([
        fetch(artifacts.wasmPath, { method: "HEAD" }),
        fetch(artifacts.zkeyPath, { method: "HEAD" }),
      ]);
      return wasmRes.ok && zkeyRes.ok;
    }
    // Node/Bun with local paths
    const _require = new Function("m", "return require(m)") as (m: string) => any;
    const { existsSync } = _require("fs");
    return existsSync(artifacts.wasmPath) && existsSync(artifacts.zkeyPath);
  } catch {
    return false;
  }
}

/**
 * Convert proof to raw bytes for on-chain submission
 */
export function proofToBytes(proof: ProofData): Uint8Array {
  return proof.proof;
}

/**
 * Cleanup all cached resources
 */
export async function cleanup(): Promise<void> {
  circuitCache.clear();
  console.log("[Prover] Cleaned up all cached resources");
}

// ==========================================================================
// Solana Instruction Building (for Groth16 on-chain verification)
// ==========================================================================

/**
 * Groth16 verifier program ID (from current config)
 */
export function getGroth16VerifierProgramId(): Address {
  const config = getConfig();
  return config.groth16VerifierProgramId;
}

/**
 * Build instruction data for Groth16 verification
 */
export function buildVerifyInstructionData(
  proof: Uint8Array,
  publicSignals: string[],
  vkHash: string
): Uint8Array {
  const piBytes = publicSignals.flatMap((pi) => {
    const bytes = new Array(32).fill(0);
    const bigint = BigInt(pi);
    for (let i = 31; i >= 0; i--) {
      bytes[i] = Number((bigint >> BigInt((31 - i) * 8)) & 0xFFn);
    }
    return bytes;
  });

  const cleanHex = vkHash.startsWith("0x") ? vkHash.slice(2) : vkHash;
  const vkHashBytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < vkHashBytes.length; i++) {
    vkHashBytes[i] = parseInt(cleanHex.substr(i * 2, 2), 16);
  }

  const totalSize = proof.length + 4 + piBytes.length + 32;
  const data = new Uint8Array(totalSize);
  let offset = 0;

  data.set(proof, offset);
  offset += proof.length;

  const piCount = publicSignals.length;
  data[offset++] = piCount & 0xff;
  data[offset++] = (piCount >> 8) & 0xff;
  data[offset++] = (piCount >> 16) & 0xff;
  data[offset++] = (piCount >> 24) & 0xff;

  data.set(new Uint8Array(piBytes), offset);
  offset += piBytes.length;

  data.set(vkHashBytes, offset);

  return data;
}
