/**
 * Type declarations for circomlibjs
 *
 * Circomlibjs provides Circom-compatible cryptographic primitives
 * including Poseidon hash function.
 */

declare module 'circomlibjs' {
  /** Finite field element type */
  export interface F {
    toObject(element: unknown): bigint;
  }

  /** Poseidon hash function instance */
  export interface Poseidon {
    (inputs: bigint[]): unknown;
    F: F;
  }

  /**
   * Build a Poseidon hash function instance
   * Uses BN254 parameters compatible with Solana's sol_poseidon syscall
   */
  export function buildPoseidon(): Promise<Poseidon>;
}
