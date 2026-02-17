/**
 * WASM-based Groth16 Proof Generator for ZVault
 *
 * Universal prover that works in both Browser and Node.js environments.
 * Uses Groth16 proofs via snarkjs with lazy loading.
 *
 * UNIFIED MODEL:
 * - Commitment = Poseidon(pub_key_x, amount)
 * - Nullifier = Poseidon(priv_key, leaf_index)
 * - Nullifier Hash = Poseidon(nullifier)
 */

import {
  hashNullifierSync,
  computeUnifiedCommitmentSync,
  computeNullifierSync,
} from "../poseidon";
import { babyJubMul, BABYJUB_BASE8, BN254_FIELD_PRIME } from "../crypto";
import { getConfig } from "../config";
import type { Address } from "@solana/kit";

/** Maximum satoshis (total BTC supply) */
const MAX_SATOSHIS = 21_000_000n * 100_000_000n;

/**
 * Validate that proof inputs are within BN254 field bounds.
 * Prevents invalid proofs from being generated with out-of-range values.
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

export type CircuitType =
  | "claim"
  | "spend_split"
  | "spend_partial_public";

// Environment detection
const isBrowser = typeof window !== "undefined";
const isNode = typeof process !== "undefined" && process.versions?.node;

// Configurable circuit paths
let circuitBasePath = isBrowser ? "/circuits/groth16" : "./circuits";

/**
 * Set the base path for circuit artifacts
 *
 * @example Browser: setCircuitPath("/circuits/groth16")
 * @example Node.js: setCircuitPath("../circuits/build")
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

const CIRCUIT_NAMES: Record<CircuitType, string> = {
  claim: "claim",
  spend_split: "spend_split",
  spend_partial_public: "spend_partial_public",
};

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

  const name = CIRCUIT_NAMES[circuitType];
  const artifact: CircuitArtifact = {
    wasmPath: `${circuitBasePath}/${name}/${name}_js/${name}.wasm`,
    zkeyPath: `${circuitBasePath}/${name}/${name}.zkey`,
  };

  circuitCache.set(circuitType, artifact);
  return artifact;
}

type InputMap = Record<string, string | string[] | number[]>;

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
    // In bun: use Node.js subprocess to avoid WASM issues
    const result = await generateProofViaNodeSubprocess(artifacts, inputs);
    proof = result.proof;
    publicSignals = result.publicSignals;
  } else {
    // In browser or Node.js: use snarkjs directly
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

  // Serialize proof to bytes for on-chain submission
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
  const { execSync } = await import("child_process");
  const fs = await import("fs");
  const path = await import("path");

  // Resolve absolute paths for the artifacts
  const wasmPath = path.resolve(artifacts.wasmPath);
  const zkeyPath = path.resolve(artifacts.zkeyPath);

  // Write inputs to temp file
  const tmpDir = path.dirname(wasmPath);
  const tmpInput = path.join(tmpDir, `_prover_input_${Date.now()}.json`);
  const tmpProof = path.join(tmpDir, `_prover_proof_${Date.now()}.json`);
  const tmpPublic = path.join(tmpDir, `_prover_public_${Date.now()}.json`);

  fs.writeFileSync(tmpInput, JSON.stringify(inputs));

  try {
    execSync(
      `node -e "
        const snarkjs = require('snarkjs');
        const fs = require('fs');
        (async () => {
          const input = JSON.parse(fs.readFileSync('${tmpInput}', 'utf8'));
          const { proof, publicSignals } = await snarkjs.groth16.fullProve(
            input,
            '${wasmPath}',
            '${zkeyPath}'
          );
          fs.writeFileSync('${tmpProof}', JSON.stringify(proof));
          fs.writeFileSync('${tmpPublic}', JSON.stringify(publicSignals));
          process.exit(0);
        })().catch(e => { console.error(e); process.exit(1); });
      "`,
      { timeout: 120000 }
    );

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
  // snarkjs proof: { pi_a: [x, y, "1"], pi_b: [[x1, x2], [y1, y2], ["1","0"]], pi_c: [x, y, "1"] }
  // BN254 G1 = 64 bytes (32 x + 32 y), G2 = 128 bytes (64 x + 64 y)
  // Total: 64 + 128 + 64 = 256 bytes
  const bytes = new Uint8Array(256);

  // Serialize to Ethereum precompile / solana-bn254 big-endian format:
  //   G1 A: [x_BE(32), y_BE(32)]
  //   G2 B: [x_imag_BE(32), x_real_BE(32), y_imag_BE(32), y_real_BE(32)]
  //   G1 C: [x_BE(32), y_BE(32)]
  //
  // snarkjs pi_b format: [[x_c0(real), x_c1(imag)], [y_c0(real), y_c1(imag)], ...]
  const piA = proof.pi_a;
  const piB = proof.pi_b;
  const piC = proof.pi_c;

  // G1 point A (64 bytes)
  writeBigIntBE(bytes, 0, BigInt(piA[0]), 32);
  writeBigIntBE(bytes, 32, BigInt(piA[1]), 32);

  // G2 point B (128 bytes): [x_imag, x_real, y_imag, y_real]
  writeBigIntBE(bytes, 64, BigInt(piB[0][1]), 32);    // x_imag (c1)
  writeBigIntBE(bytes, 96, BigInt(piB[0][0]), 32);     // x_real (c0)
  writeBigIntBE(bytes, 128, BigInt(piB[1][1]), 32);    // y_imag (c1)
  writeBigIntBE(bytes, 160, BigInt(piB[1][0]), 32);    // y_real (c0)

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
// Public API - Proof Generation Functions
// ==========================================================================

/**
 * Initialize the prover (preloads snarkjs module)
 *
 * Call this early in your app to reduce latency on first proof generation.
 */
export async function initProver(): Promise<void> {
  await ensureSnarkjsLoaded();
  proverInitialized = true;
  console.log("[Prover] Groth16 prover initialized and ready");
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

// ==========================================================================
// Unified Model Proof Generation
// ==========================================================================

/**
 * Claim proof inputs (Unified Model)
 *
 * Claims commitment to a public Solana wallet.
 * Public key is derived in-circuit from priv_key via BabyPbk().
 */
export interface ClaimInputs {
  /** Spending private key (Baby Jubjub scalar) */
  privKey: bigint;
  /** Amount in satoshis */
  amount: bigint;
  /** Position in Merkle tree */
  leafIndex: bigint;
  /** Merkle tree root */
  merkleRoot: bigint;
  /** Merkle proof (20 levels) */
  merkleProof: MerkleProofInput;
  /** Recipient address (32 bytes as bigint) - bound to proof, cannot be changed */
  recipient: bigint;
}

/**
 * Generate a claim proof (Unified Model)
 *
 * Proves ownership of commitment (pub_key_x, amount) and reveals amount for public claim.
 */
export async function generateClaimProof(inputs: ClaimInputs): Promise<ProofData> {
  validateFieldInputs({
    merkleRoot: inputs.merkleRoot,
    privKey: inputs.privKey,
    recipient: inputs.recipient,
  });
  validateAmount(inputs.amount, "amount");

  const pathElements = inputs.merkleProof.siblings.map((s) => s.toString());
  const pathIndices = inputs.merkleProof.indices;

  // Compute nullifier and nullifier hash
  const nullifier = computeNullifierSync(inputs.privKey, inputs.leafIndex);
  const nullifierHash = hashNullifierSync(nullifier);

  const circuitInputs: InputMap = {
    priv_key: inputs.privKey.toString(),
    amount: inputs.amount.toString(),
    leaf_index: inputs.leafIndex.toString(),
    merkle_path: pathElements,
    path_indices: pathIndices,
    merkle_root: inputs.merkleRoot.toString(),
    nullifier_hash: nullifierHash.toString(),
    amount_pub: inputs.amount.toString(),
    recipient: inputs.recipient.toString(),
  };

  return generateProof("claim", circuitInputs);
}

/**
 * Spend split proof inputs (Unified Model)
 *
 * Splits one commitment into two commitments.
 * All public keys are derived in-circuit from private keys via BabyPbk().
 */
export interface SpendSplitInputs {
  /** Input: Spending private key (Baby Jubjub scalar) */
  privKey: bigint;
  /** Input: Amount in satoshis */
  amount: bigint;
  /** Input: Position in Merkle tree */
  leafIndex: bigint;
  /** Merkle tree root */
  merkleRoot: bigint;
  /** Merkle proof (20 levels) */
  merkleProof: MerkleProofInput;
  /** Output 1: Private key (Baby Jubjub scalar) */
  output1PrivKey: bigint;
  /** Output 1: Amount in satoshis */
  output1Amount: bigint;
  /** Output 2: Private key (Baby Jubjub scalar) */
  output2PrivKey: bigint;
  /** Output 2: Amount in satoshis */
  output2Amount: bigint;
}

/**
 * Generate a spend split proof (Unified Model)
 *
 * Commitment -> Commitment + Commitment
 * Amount conservation: input_amount == output1_amount + output2_amount
 */
export async function generateSpendSplitProof(inputs: SpendSplitInputs): Promise<ProofData> {
  validateFieldInputs({
    merkleRoot: inputs.merkleRoot,
    privKey: inputs.privKey,
    output1PrivKey: inputs.output1PrivKey,
    output2PrivKey: inputs.output2PrivKey,
  });
  validateAmount(inputs.amount, "amount");
  validateAmount(inputs.output1Amount, "output1Amount");
  validateAmount(inputs.output2Amount, "output2Amount");

  if (inputs.amount !== inputs.output1Amount + inputs.output2Amount) {
    throw new Error("Spend split must conserve amount (input == output1 + output2)");
  }

  if (inputs.merkleProof.siblings.length !== 20) {
    throw new Error(`Spend split circuit requires 20-level merkle tree, got ${inputs.merkleProof.siblings.length} siblings`);
  }

  const pathElements = inputs.merkleProof.siblings.map((s) => s.toString());
  const pathIndices = inputs.merkleProof.indices;

  // Compute nullifier hash
  const nullifier = computeNullifierSync(inputs.privKey, inputs.leafIndex);
  const nullifierHash = hashNullifierSync(nullifier);

  // Derive output public keys from private keys for commitment computation
  const output1PubKeyX = babyJubMul(inputs.output1PrivKey, BABYJUB_BASE8).x;
  const output2PubKeyX = babyJubMul(inputs.output2PrivKey, BABYJUB_BASE8).x;

  // Compute output commitments
  const outputCommitment1 = computeUnifiedCommitmentSync(output1PubKeyX, inputs.output1Amount);
  const outputCommitment2 = computeUnifiedCommitmentSync(output2PubKeyX, inputs.output2Amount);

  const circuitInputs: InputMap = {
    priv_key: inputs.privKey.toString(),
    amount: inputs.amount.toString(),
    leaf_index: inputs.leafIndex.toString(),
    merkle_path: pathElements,
    path_indices: pathIndices,
    output1_priv_key: inputs.output1PrivKey.toString(),
    output1_amount: inputs.output1Amount.toString(),
    output2_priv_key: inputs.output2PrivKey.toString(),
    output2_amount: inputs.output2Amount.toString(),
    merkle_root: inputs.merkleRoot.toString(),
    nullifier_hash: nullifierHash.toString(),
    output_commitment1: outputCommitment1.toString(),
    output_commitment2: outputCommitment2.toString(),
  };

  return generateProof("spend_split", circuitInputs);
}

/**
 * Spend partial public proof inputs (Unified Model)
 *
 * Performs partial public claim: Commitment -> Public Amount + Change Commitment
 * All public keys are derived in-circuit from private keys via BabyPbk().
 */
export interface SpendPartialPublicInputs {
  /** Input: Spending private key (Baby Jubjub scalar) */
  privKey: bigint;
  /** Input: Amount in satoshis */
  amount: bigint;
  /** Input: Position in Merkle tree */
  leafIndex: bigint;
  /** Merkle tree root */
  merkleRoot: bigint;
  /** Merkle proof (20 levels) */
  merkleProof: MerkleProofInput;
  /** Public amount to claim (revealed) */
  publicAmount: bigint;
  /** Change: Private key (Baby Jubjub scalar) */
  changePrivKey: bigint;
  /** Change: Amount in satoshis */
  changeAmount: bigint;
  /** Recipient Solana wallet (as bigint from 32 bytes) */
  recipient: bigint;
}

/**
 * Generate a spend partial public proof (Unified Model)
 *
 * Commitment -> Public Amount + Change Commitment
 * Amount conservation: input_amount == public_amount + change_amount
 */
export async function generateSpendPartialPublicProof(inputs: SpendPartialPublicInputs): Promise<ProofData> {
  validateFieldInputs({
    merkleRoot: inputs.merkleRoot,
    privKey: inputs.privKey,
    changePrivKey: inputs.changePrivKey,
    recipient: inputs.recipient,
  });
  validateAmount(inputs.amount, "amount");
  validateAmount(inputs.publicAmount, "publicAmount");
  validateAmount(inputs.changeAmount, "changeAmount");

  if (inputs.amount !== inputs.publicAmount + inputs.changeAmount) {
    throw new Error("Spend partial public must conserve amount (input == public + change)");
  }

  if (inputs.merkleProof.siblings.length !== 20) {
    throw new Error(`Spend partial public circuit requires 20-level merkle tree, got ${inputs.merkleProof.siblings.length} siblings`);
  }

  const pathElements = inputs.merkleProof.siblings.map((s) => s.toString());
  const pathIndices = inputs.merkleProof.indices;

  // Compute nullifier hash
  const nullifier = computeNullifierSync(inputs.privKey, inputs.leafIndex);
  const nullifierHash = hashNullifierSync(nullifier);

  // Derive change public key from private key for commitment computation
  const changePubKeyX = babyJubMul(inputs.changePrivKey, BABYJUB_BASE8).x;

  // Compute change commitment
  const changeCommitment = computeUnifiedCommitmentSync(changePubKeyX, inputs.changeAmount);

  const circuitInputs: InputMap = {
    priv_key: inputs.privKey.toString(),
    amount: inputs.amount.toString(),
    leaf_index: inputs.leafIndex.toString(),
    merkle_path: pathElements,
    path_indices: pathIndices,
    change_priv_key: inputs.changePrivKey.toString(),
    change_amount: inputs.changeAmount.toString(),
    merkle_root: inputs.merkleRoot.toString(),
    nullifier_hash: nullifierHash.toString(),
    public_amount: inputs.publicAmount.toString(),
    change_commitment: changeCommitment.toString(),
    recipient: inputs.recipient.toString(),
  };

  return generateProof("spend_partial_public", circuitInputs);
}

// ==========================================================================
// Circuit Availability & Verification
// ==========================================================================

/**
 * Check if circuit artifacts exist for a given circuit type
 */
export async function circuitExists(circuitType: CircuitType): Promise<boolean> {
  if (isBrowser) {
    // In browser, try to fetch the wasm file
    try {
      const artifacts = getCircuitArtifactPaths(circuitType);
      const response = await fetch(artifacts.wasmPath, { method: "HEAD" });
      return response.ok;
    } catch {
      return false;
    }
  } else {
    // In Node.js, check if files exist on disk
    try {
      const fs = await import("fs");
      const artifacts = getCircuitArtifactPaths(circuitType);
      return fs.existsSync(artifacts.wasmPath) && fs.existsSync(artifacts.zkeyPath);
    } catch {
      return false;
    }
  }
}

/**
 * Verify a proof using snarkjs (Node.js only, uses subprocess for bun compatibility)
 *
 * Note: This verifies that the proof bytes are well-formed (correct size, non-zero).
 * Full snarkjs verification requires the original proof JSON object - use snarkjs directly
 * in tests for cryptographic verification (see groth16-claim.test.ts).
 */
export async function verifyProof(_circuitType: CircuitType, proof: ProofData): Promise<boolean> {
  // Basic structural validation
  if (proof.proof.length !== 256) return false;
  if (proof.publicInputs.length === 0) return false;

  // Check proof is not all zeros
  const allZeros = proof.proof.every(b => b === 0);
  if (allZeros) return false;

  return true;
}

// ==========================================================================
// Utilities
// ==========================================================================

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
 *
 * Format:
 * - proof_bytes (256 bytes): Serialized Groth16 proof (2 G1 + 1 G2 point)
 * - public_inputs_count (4 bytes, LE)
 * - public_inputs (N x 32 bytes, big-endian)
 * - vk_hash (32 bytes)
 */
export function buildVerifyInstructionData(
  proof: Uint8Array,
  publicSignals: string[],
  vkHash: string
): Uint8Array {
  const piBytes = publicSignals.flatMap((pi) => {
    // Encode as 32-byte big-endian field element (matching BN254 format)
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

  const totalSize =
    proof.length + // proof bytes (~256)
    4 + // public_inputs_count
    piBytes.length +
    32; // vk_hash

  const data = new Uint8Array(totalSize);
  let offset = 0;

  // Proof bytes
  data.set(proof, offset);
  offset += proof.length;

  // Public inputs count (little-endian)
  const piCount = publicSignals.length;
  data[offset++] = piCount & 0xff;
  data[offset++] = (piCount >> 8) & 0xff;
  data[offset++] = (piCount >> 16) & 0xff;
  data[offset++] = (piCount >> 24) & 0xff;

  // Public inputs
  data.set(new Uint8Array(piBytes), offset);
  offset += piBytes.length;

  // VK hash
  data.set(vkHashBytes, offset);

  return data;
}
