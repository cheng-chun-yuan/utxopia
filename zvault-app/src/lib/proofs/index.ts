/**
 * ZK Proof Generation for ZVault Frontend
 *
 * Re-exports SDK JoinSplit proof generation.
 * All transfers (claim, split, send) use unified JoinSplit(N,M) proofs.
 */

export {
  generateJoinSplitProof,
  proofToBytes,
  initProver,
  isProverAvailable,
  type JoinSplitProofInputs,
  type ProofData,
  type MerkleProofInput,
} from "@zvault/sdk";

export interface MerkleProof {
  siblings: bigint[];
  indices: number[];
}

export { bigintToBytes, bytesToBigint } from "@zvault/sdk";
