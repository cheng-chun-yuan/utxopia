/**
 * Poseidon Hash - BN254 compatible with circom circuits and Solana's sol_poseidon
 *
 * Uses circomlibjs which matches:
 * - circomlib's poseidon.circom
 * - Solana's sol_poseidon syscall (light-poseidon)
 *
 * UNIFIED MODEL:
 * - Commitment = Poseidon(pub_key_x, amount)
 * - Nullifier = Poseidon(priv_key, leaf_index)
 * - Nullifier Hash = Poseidon(nullifier)
 * - Pool Commitment = Poseidon(pub_key_x, principal, deposit_epoch)
 */

import { buildPoseidon, type Poseidon } from "circomlibjs";

// Singleton poseidon instance
let poseidonInstance: Poseidon | null = null;

/**
 * Initialize poseidon (must be called before using hash functions)
 */
export async function initPoseidon(): Promise<void> {
  if (!poseidonInstance) {
    poseidonInstance = await buildPoseidon();
  }
}

/**
 * Get the poseidon instance (lazy initialization)
 */
async function getPoseidon(): Promise<Poseidon> {
  if (!poseidonInstance) {
    await initPoseidon();
  }
  return poseidonInstance!;
}

/**
 * Hash inputs using Circom-compatible Poseidon (async)
 * Returns bigint result
 */
export async function poseidonHash(inputs: bigint[]): Promise<bigint> {
  const poseidon = await getPoseidon();
  const hash = poseidon(inputs);
  return poseidon.F.toObject(hash) as bigint;
}

/**
 * Synchronous hash (requires prior initialization via initPoseidon)
 * Throws if not initialized
 */
export function poseidonHashSync(inputs: bigint[]): bigint {
  if (!poseidonInstance) {
    throw new Error("Poseidon not initialized. Call initPoseidon() first.");
  }
  const hash = poseidonInstance(inputs);
  return poseidonInstance.F.toObject(hash) as bigint;
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

