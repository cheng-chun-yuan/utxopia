/**
 * ZK Proof Generation for ZVault Frontend
 *
 * Re-exports SDK proof generation functions.
 * Uses circom circuits with Groth16 proofs via snarkjs.
 */

// Re-export SDK proof generation functions directly
export {
  generateClaimProof,
  generateSpendSplitProof,
  generateSpendPartialPublicProof,
  proofToBytes,
  type ClaimInputs,
  type SpendSplitInputs,
  type SpendPartialPublicInputs,
  type MerkleProofInput,
  type ProofData,
} from "@zvault/sdk";

/** Merkle proof for local tree */
export interface MerkleProof {
  siblings: bigint[];
  indices: number[];
}

// Re-export crypto utilities from SDK
export { bigintToBytes, bytesToBigint } from "@zvault/sdk";
