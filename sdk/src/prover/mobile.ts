/**
 * Mobile Prover for React Native
 *
 * Stub for Groth16 proof generation on iOS/Android.
 * Will use snarkjs or a native Groth16 prover when implemented.
 */

// Re-export types from web for API compatibility
export type {
  MerkleProofInput,
  ProofData,
  CircuitType,
  ClaimInputs,
  SpendSplitInputs,
  SpendPartialPublicInputs,
} from "./web";

// Note: This is a stub. Full implementation requires:
// 1. Install: bun add snarkjs
// 2. Add circuit WASM and zkey files to app assets
// 3. Configure snarkjs for React Native environment

/**
 * Initialize the mobile prover
 */
export async function initProver(): Promise<void> {
  throw new Error(
    "Mobile Groth16 prover not implemented. Configure snarkjs and add circuit artifacts."
  );
}

/**
 * Check if mobile prover is available
 */
export async function isProverAvailable(): Promise<boolean> {
  return false;
}

/**
 * Set the circuit path (mobile uses file paths)
 */
export function setCircuitPath(_path: string): void {
  // Mobile implementation would configure native module paths
}

/**
 * Get the current circuit path
 */
export function getCircuitPath(): string {
  return "";
}

// Stub implementations that throw until properly configured
export async function generateClaimProof(): Promise<never> {
  throw new Error("Mobile Groth16 prover not configured");
}

export async function generateSpendSplitProof(): Promise<never> {
  throw new Error("Mobile Groth16 prover not configured");
}

export async function generateSpendPartialPublicProof(): Promise<never> {
  throw new Error("Mobile Groth16 prover not configured");
}

export async function verifyProof(): Promise<boolean> {
  throw new Error("Mobile Groth16 prover not configured");
}

export async function circuitExists(): Promise<boolean> {
  return false;
}

export function proofToBytes(): Uint8Array {
  throw new Error("Mobile Groth16 prover not configured");
}

export async function cleanup(): Promise<void> {
  // No-op for uninitialized prover
}
