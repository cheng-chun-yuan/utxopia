/**
 * Poseidon Hash - BN254 compatible with circom circuits and Solana's sol_poseidon
 *
 * Uses poseidon-lite: pure JavaScript, zero dependencies, works in
 * Browser, Node.js, and React Native (no WASM required).
 *
 * UNIFIED MODEL:
 * - Commitment = Poseidon(pub_key_x, amount)
 * - Nullifier = Poseidon(priv_key, leaf_index)
 * - Nullifier Hash = Poseidon(nullifier)
 */

import { poseidon1 } from "poseidon-lite/poseidon1";
import { poseidon2 } from "poseidon-lite/poseidon2";
import { poseidon3 } from "poseidon-lite/poseidon3";
import { poseidon4 } from "poseidon-lite/poseidon4";
import { poseidon5 } from "poseidon-lite/poseidon5";
import { poseidon6 } from "poseidon-lite/poseidon6";

// Lookup table for poseidon hash by input count (1-6 covers all SDK usage)
const poseidonFns = [
  undefined,   // 0 — unused
  poseidon1,   // 1 input
  poseidon2,   // 2 inputs
  poseidon3,   // 3 inputs
  poseidon4,   // 4 inputs
  poseidon5,   // 5 inputs
  poseidon6,   // 6 inputs
] as const;

/**
 * Initialize poseidon (no-op — poseidon-lite needs no initialization)
 * Kept for backward API compatibility.
 */
export async function initPoseidon(): Promise<void> {
  // poseidon-lite is synchronous and ready immediately
}

/**
 * Hash inputs using Circom-compatible Poseidon (async)
 * Returns bigint result
 */
export async function poseidonHash(inputs: bigint[]): Promise<bigint> {
  return poseidonHashSync(inputs);
}

/**
 * Synchronous Poseidon hash (no initialization required with poseidon-lite)
 */
export function poseidonHashSync(inputs: bigint[]): bigint {
  const n = inputs.length;
  if (n < 1 || n > 6) {
    throw new Error(`Poseidon: unsupported input count ${n} (expected 1-6)`);
  }
  return poseidonFns[n]!(inputs as any);
}

// BN254 scalar field prime
export const BN254_SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// ============================================================================
// Unified Model Functions (Primary API) - Async versions
// ============================================================================

/**
 * Compute unified commitment from public key x-coordinate and amount
 * commitment = Poseidon(pub_key_x, amount)
 */
export async function computeUnifiedCommitment(pubKeyX: bigint, amount: bigint): Promise<bigint> {
  return poseidonHash([pubKeyX, amount]);
}

/**
 * Compute nullifier from private key and leaf index
 * nullifier = Poseidon(priv_key, leaf_index)
 */
export async function computeNullifier(privKey: bigint, leafIndex: bigint): Promise<bigint> {
  return poseidonHash([privKey, leafIndex]);
}

/**
 * Hash nullifier for double-spend prevention
 * nullifier_hash = Poseidon(nullifier)
 */
export async function hashNullifier(nullifier: bigint): Promise<bigint> {
  return poseidonHash([nullifier]);
}

// ============================================================================
// Synchronous versions (internal use only - require prior initPoseidon call)
// These are used by prover.ts which needs sync computation for circuit inputs
// ============================================================================

export function computeUnifiedCommitmentSync(pubKeyX: bigint, amount: bigint): bigint {
  return poseidonHashSync([pubKeyX, amount]);
}

export function computeNullifierSync(privKey: bigint, leafIndex: bigint): bigint {
  return poseidonHashSync([privKey, leafIndex]);
}

export function hashNullifierSync(nullifier: bigint): bigint {
  return poseidonHashSync([nullifier]);
}

// ============================================================================
// JoinSplit Primitives (Railgun-aligned 3-key model)
// ============================================================================

/**
 * Compute Master Public Key: MPK = Poseidon(pkX, pkY, nullifyingKey)
 */
export async function computeMPK(pkX: bigint, pkY: bigint, nullifyingKey: bigint): Promise<bigint> {
  return poseidonHash([pkX, pkY, nullifyingKey]);
}

export function computeMPKSync(pkX: bigint, pkY: bigint, nullifyingKey: bigint): bigint {
  return poseidonHashSync([pkX, pkY, nullifyingKey]);
}

/**
 * Compute Note Public Key: NPK = Poseidon(MPK, random)
 */
export async function computeNPK(mpk: bigint, random: bigint): Promise<bigint> {
  return poseidonHash([mpk, random]);
}

export function computeNPKSync(mpk: bigint, random: bigint): bigint {
  return poseidonHashSync([mpk, random]);
}

/**
 * Compute JoinSplit commitment: Poseidon(npk, token, amount)
 */
export async function computeJoinSplitCommitment(npk: bigint, token: bigint, amount: bigint): Promise<bigint> {
  return poseidonHash([npk, token, amount]);
}

export function computeJoinSplitCommitmentSync(npk: bigint, token: bigint, amount: bigint): bigint {
  return poseidonHashSync([npk, token, amount]);
}

/**
 * Compute JoinSplit nullifier: Poseidon(nullifyingKey, leafIndex)
 * (Same hash as computeNullifier but semantically distinct in the 3-key model)
 */
export async function computeJoinSplitNullifier(nullifyingKey: bigint, leafIndex: bigint): Promise<bigint> {
  return poseidonHash([nullifyingKey, leafIndex]);
}

export function computeJoinSplitNullifierSync(nullifyingKey: bigint, leafIndex: bigint): bigint {
  return poseidonHashSync([nullifyingKey, leafIndex]);
}

