/**
 * ZK Proof Generation Service (Groth16)
 *
 * Stub for mobile Groth16 proof generation via snarkjs.
 * Will download circuit WASM and zkey files from CDN.
 *
 * @module lib/proof
 */

import * as FileSystem from "expo-file-system/legacy";
import {
  proofToCircomFormat,
  type MerkleProof as SDKMerkleProof,
  type Note,
} from '@zvault/sdk';

// ============================================================================
// Types
// ============================================================================

export interface ProofInputs {
  [key: string]: string | string[];
}

export interface ProofResult {
  success: boolean;
  proof?: string;
  publicInputs?: string[];
  duration?: number;
  error?: string;
}

export interface MerkleProof {
  pathElements: string[];
  pathIndices: string[];
}

export interface ClaimProofInput {
  nullifier: string;
  secret: string;
  amount: string;
  merkleRoot: string;
  merkleProof: MerkleProof;
}

export interface SplitProofInput {
  inputNullifier: string;
  inputSecret: string;
  inputAmount: string;
  merkleRoot: string;
  merkleProof: MerkleProof;
  output1Nullifier: string;
  output1Secret: string;
  output1Amount: string;
  output2Nullifier: string;
  output2Secret: string;
  output2Amount: string;
}

export interface TransferProofInput {
  inputNullifier: string;
  inputSecret: string;
  inputAmount: string;
  merkleRoot: string;
  merkleProof: MerkleProof;
  outputNullifier: string;
  outputSecret: string;
  recipient: string;
}

export interface PartialWithdrawProofInput {
  inputNullifier: string;
  inputSecret: string;
  inputAmount: string;
  merkleRoot: string;
  merkleProof: MerkleProof;
  withdrawAmount: string;
  changeNullifier: string;
  changeSecret: string;
  changeAmount: string;
  recipient: string;
}

export interface StealthTransferProofInput {
  inputNullifier: string;
  inputSecret: string;
  inputAmount: string;
  merkleRoot: string;
  merkleProof: MerkleProof;
  outputNullifier: string;
  outputSecret: string;
  outputAmount: string;
  stealthPubkey: string;
  ephemeralPubkey: string;
}

export interface InitProgress {
  stage: 'checking' | 'downloading' | 'ready' | 'error';
  progress?: number;
  message: string;
}

// ============================================================================
// Constants
// ============================================================================

const CIRCUITS_BASE_URL = "https://circuits.amidoggy.xyz";

export const CIRCUITS = {
  CLAIM: "claim",
  SPLIT: "spend_split",
  TRANSFER: "spend_partial_public",
  PARTIAL_WITHDRAW: "spend_partial_public",
  STEALTH_TRANSFER: "spend_split",
} as const;

export type CircuitName = (typeof CIRCUITS)[keyof typeof CIRCUITS];

// ============================================================================
// File Paths
// ============================================================================

function getCircuitDir(): string {
  const docDir = FileSystem.documentDirectory;
  if (!docDir) {
    throw new Error("Document directory not available");
  }
  return docDir + "circuits/";
}

function getCircuitWasmPath(circuitName: string): string {
  return getCircuitDir() + `${circuitName}.wasm`;
}

function getCircuitZkeyPath(circuitName: string): string {
  return getCircuitDir() + `${circuitName}.zkey`;
}

// ============================================================================
// Initialization
// ============================================================================

let _isInitialized = false;

/**
 * Check if Groth16 prover is available
 */
export async function isGroth16Available(): Promise<boolean> {
  try {
    // snarkjs should be available
    await import("snarkjs");
    return true;
  } catch {
    return false;
  }
}

/**
 * Initialize the proof system
 * Downloads circuit WASM and zkey files from CDN
 */
export async function initializeProofSystem(
  onProgress?: (progress: InitProgress) => void
): Promise<boolean> {
  if (_isInitialized) {
    onProgress?.({ stage: 'ready', message: 'Proof system ready' });
    return true;
  }

  try {
    onProgress?.({ stage: 'checking', message: 'Checking proof system...' });

    const circuitDir = getCircuitDir();
    const dirInfo = await FileSystem.getInfoAsync(circuitDir);
    if (!dirInfo.exists) {
      await FileSystem.makeDirectoryAsync(circuitDir, { intermediates: true });
    }

    // TODO: Download circuit WASM and zkey files
    onProgress?.({ stage: 'downloading', progress: 0, message: 'Downloading circuits...' });

    // Verify snarkjs is available
    const available = await isGroth16Available();
    if (!available) {
      throw new Error("snarkjs not available in this environment");
    }

    _isInitialized = true;
    onProgress?.({ stage: 'ready', message: 'Proof system ready' });
    console.log("[Proof] Groth16 system initialized successfully");
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Initialization failed';
    onProgress?.({ stage: 'error', message });
    console.error("[Proof] Initialization failed:", error);
    return false;
  }
}

/**
 * Check if proof system is ready
 */
export async function isProofSystemReady(): Promise<boolean> {
  return _isInitialized;
}

// ============================================================================
// Core Proof Generation
// ============================================================================

async function generateProof(
  circuitName: CircuitName,
  inputs: ProofInputs
): Promise<ProofResult> {
  const startTime = Date.now();

  if (!_isInitialized) {
    const ready = await initializeProofSystem();
    if (!ready) {
      return { success: false, error: "Proof system not initialized" };
    }
  }

  try {
    const snarkjs = await import("snarkjs");
    const wasmPath = getCircuitWasmPath(circuitName);
    const zkeyPath = getCircuitZkeyPath(circuitName);

    console.log(`[Proof] Generating ${circuitName} Groth16 proof...`);

    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      inputs,
      wasmPath,
      zkeyPath
    );

    const duration = Date.now() - startTime;
    console.log(`[Proof] Generated in ${duration}ms`);

    return {
      success: true,
      proof: JSON.stringify(proof),
      publicInputs: publicSignals,
      duration,
    };
  } catch (error) {
    console.error("[Proof] Generation failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Proof generation failed",
      duration: Date.now() - startTime,
    };
  }
}

// ============================================================================
// Proof Generators
// ============================================================================

export async function generateClaimProof(input: ClaimProofInput): Promise<ProofResult> {
  return generateProof(CIRCUITS.CLAIM, {
    nullifier: input.nullifier,
    secret: input.secret,
    amount: input.amount,
    merkle_root: input.merkleRoot,
    merkle_path: input.merkleProof.pathElements,
    path_indices: input.merkleProof.pathIndices,
  });
}

export async function generateSplitProof(input: SplitProofInput): Promise<ProofResult> {
  return generateProof(CIRCUITS.SPLIT, {
    input_nullifier: input.inputNullifier,
    input_secret: input.inputSecret,
    input_amount: input.inputAmount,
    merkle_root: input.merkleRoot,
    merkle_path: input.merkleProof.pathElements,
    path_indices: input.merkleProof.pathIndices,
    output1_nullifier: input.output1Nullifier,
    output1_secret: input.output1Secret,
    output1_amount: input.output1Amount,
    output2_nullifier: input.output2Nullifier,
    output2_secret: input.output2Secret,
    output2_amount: input.output2Amount,
  });
}

export async function generateTransferProof(input: TransferProofInput): Promise<ProofResult> {
  return generateProof(CIRCUITS.TRANSFER, {
    input_nullifier: input.inputNullifier,
    input_secret: input.inputSecret,
    input_amount: input.inputAmount,
    merkle_root: input.merkleRoot,
    merkle_path: input.merkleProof.pathElements,
    path_indices: input.merkleProof.pathIndices,
    output_nullifier: input.outputNullifier,
    output_secret: input.outputSecret,
    recipient: input.recipient,
  });
}

export async function generatePartialWithdrawProof(input: PartialWithdrawProofInput): Promise<ProofResult> {
  return generateProof(CIRCUITS.PARTIAL_WITHDRAW, {
    input_nullifier: input.inputNullifier,
    input_secret: input.inputSecret,
    input_amount: input.inputAmount,
    merkle_root: input.merkleRoot,
    merkle_path: input.merkleProof.pathElements,
    path_indices: input.merkleProof.pathIndices,
    withdraw_amount: input.withdrawAmount,
    change_nullifier: input.changeNullifier,
    change_secret: input.changeSecret,
    change_amount: input.changeAmount,
    recipient: input.recipient,
  });
}

export async function generateStealthTransferProof(input: StealthTransferProofInput): Promise<ProofResult> {
  return generateProof(CIRCUITS.STEALTH_TRANSFER, {
    input_nullifier: input.inputNullifier,
    input_secret: input.inputSecret,
    input_amount: input.inputAmount,
    merkle_root: input.merkleRoot,
    merkle_path: input.merkleProof.pathElements,
    path_indices: input.merkleProof.pathIndices,
    output_nullifier: input.outputNullifier,
    output_secret: input.outputSecret,
    output_amount: input.outputAmount,
    stealth_pubkey: input.stealthPubkey,
    ephemeral_pubkey: input.ephemeralPubkey,
  });
}

// ============================================================================
// Proof Verifiers (stubs)
// ============================================================================

export async function verifyClaimProof(_proof: string): Promise<boolean> {
  console.warn("[Proof] Groth16 verification not yet implemented on mobile");
  return false;
}

export async function verifySplitProof(_proof: string): Promise<boolean> {
  console.warn("[Proof] Groth16 verification not yet implemented on mobile");
  return false;
}

export async function verifyTransferProof(_proof: string): Promise<boolean> {
  console.warn("[Proof] Groth16 verification not yet implemented on mobile");
  return false;
}

export async function verifyPartialWithdrawProof(_proof: string): Promise<boolean> {
  console.warn("[Proof] Groth16 verification not yet implemented on mobile");
  return false;
}

export async function verifyStealthTransferProof(_proof: string): Promise<boolean> {
  console.warn("[Proof] Groth16 verification not yet implemented on mobile");
  return false;
}

// ============================================================================
// Utility Functions
// ============================================================================

export function createEmptyMerkleProof(depth: number = 10): MerkleProof {
  return {
    pathElements: Array(depth).fill("0"),
    pathIndices: Array(depth).fill("0"),
  };
}

export function prepareClaimInputsFromNote(
  note: Note,
  merkleRoot: bigint,
  merkleProof: SDKMerkleProof
): ClaimProofInput {
  const circomProof = proofToCircomFormat(merkleProof);

  return {
    nullifier: note.nullifier.toString(),
    secret: note.secret.toString(),
    amount: note.amount.toString(),
    merkleRoot: merkleRoot.toString(),
    merkleProof: {
      pathElements: circomProof.merkle_path,
      pathIndices: circomProof.path_indices,
    },
  };
}

export function formatProofForOnChain(
  proof: string,
  publicInputs: string[]
): { proof: Uint8Array; publicInputs: bigint[] } {
  const proofBytes = hexToBytes(proof);
  const inputs = publicInputs.map((s) => BigInt(s));

  return {
    proof: proofBytes,
    publicInputs: inputs,
  };
}

function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = parseInt(cleanHex.substr(i, 2), 16);
  }
  return bytes;
}
