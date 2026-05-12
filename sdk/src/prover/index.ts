/**
 * Prover Subpath
 *
 * Auto-detects platform and exports the appropriate prover backend.
 * For explicit imports, use:
 * - @utxopia/sdk/prover/web for browser/Node.js snarkjs Groth16 prover
 * - @utxopia/sdk/prover/mobile for React Native Groth16 prover
 */

// Re-export everything from the web prover (default for browser/Node.js)
export * from "./web";

// Re-export types
export type {
  MerkleProofInput,
  ProofData,
  CircuitType,
  JoinSplitProofInputs,
} from "./web";
