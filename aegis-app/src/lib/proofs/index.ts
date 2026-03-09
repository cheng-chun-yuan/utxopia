/**
 * ZK Proof Generation for AEGIS Frontend
 *
 * Re-exports SDK JoinSplit proof generation.
 * All transfers (claim, split, send) use unified JoinSplit(N,M) proofs.
 */

export type {
  JoinSplitProofInputs,
  ProofData,
  MerkleProofInput,
} from "@aegis/sdk";

export {
  generateJoinSplitProof,
  proofToBytes,
  initProver,
  isProverAvailable,
} from "@aegis/sdk/prover/web";

export interface MerkleProof {
  siblings: bigint[];
  indices: number[];
}

export { bigintToBytes, bytesToBigint } from "@aegis/sdk";
