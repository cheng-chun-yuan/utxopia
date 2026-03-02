/**
 * Type declarations for circomlibjs
 *
 * Circomlibjs provides Circom-compatible cryptographic primitives
 * including Poseidon hash function and EdDSA signing.
 */

declare module 'circomlibjs' {
  /** Finite field element type */
  export interface F {
    toObject(element: unknown): bigint;
    e(value: bigint | number | string): unknown;
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

  /** Baby Jubjub curve interface */
  export interface BabyJub {
    F: F;
  }

  /** EdDSA-Poseidon signature */
  export interface EdDSAPoseidonSignature {
    R8: [unknown, unknown];
    S: bigint;
  }

  /** EdDSA instance for Poseidon-based signing */
  export interface Eddsa {
    babyJub: BabyJub;
    pruneBuffer(buff: Buffer): Buffer;
    prv2pub(privKey: Buffer | Uint8Array): [unknown, unknown];
    signPoseidon(privKey: Buffer | Uint8Array, msg: unknown): EdDSAPoseidonSignature;
  }

  /**
   * Build an EdDSA instance for Poseidon-based signing
   * Compatible with circom's EdDSAPoseidonVerifier
   */
  export function buildEddsa(): Promise<Eddsa>;
}
