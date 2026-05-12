/**
 * Merkle tree utilities for UTXOpia
 *
 * Provides structures and helpers for Merkle proofs.
 * Actual tree operations use Poseidon hashing which is computed
 * on-chain or via circom circuits.
 *
 * Note: This module does NOT compute Poseidon hashes in JavaScript.
 * The on-chain program maintains the Merkle tree. This SDK provides
 * proof structures for interaction with the program.
 */

import { bigintToBytes, bytesToBigint } from "./crypto";
import { toHex } from "./utils/encoding";

// Tree configuration - matches on-chain constants (depth 16 = 65,536 leaves)
export const TREE_DEPTH = 16;
export const ROOT_HISTORY_SIZE = 30;
export const MAX_LEAVES = 1 << TREE_DEPTH; // 65,536

// Zero value for empty nodes (matches on-chain)
export const ZERO_VALUE = bigintToBytes(
  0x2fe54c60d3ada40e0000000000000000000000000000000000000000n
);

/**
 * Merkle proof structure
 */
export interface MerkleProof {
  // Sibling nodes along the path (20 elements for depth 20)
  pathElements: Uint8Array[];
  // Path indices (0 = left, 1 = right)
  pathIndices: number[];
  // Leaf index
  leafIndex: number;
  // Merkle root
  root: Uint8Array;
}

/**
 * Create a Merkle proof from on-chain data
 *
 * @param pathElements - Sibling hashes as 32-byte arrays
 * @param pathIndices - Direction at each level (0=left, 1=right)
 * @param leafIndex - Index of the leaf in the tree
 * @param root - Current Merkle root
 */
export function createMerkleProof(
  pathElements: Uint8Array[],
  pathIndices: number[],
  leafIndex: number,
  root: Uint8Array
): MerkleProof {
  if (pathElements.length !== TREE_DEPTH) {
    throw new Error(`Expected ${TREE_DEPTH} path elements, got ${pathElements.length}`);
  }
  if (pathIndices.length !== TREE_DEPTH) {
    throw new Error(`Expected ${TREE_DEPTH} path indices, got ${pathIndices.length}`);
  }

  return {
    pathElements: pathElements.map((el) => new Uint8Array(el)),
    pathIndices: [...pathIndices],
    leafIndex,
    root: new Uint8Array(root),
  };
}

/**
 * Create a Merkle proof from bigint values
 */
export function createMerkleProofFromBigints(
  pathElements: bigint[],
  pathIndices: number[],
  leafIndex: number,
  root: bigint
): MerkleProof {
  return createMerkleProof(
    pathElements.map(bigintToBytes),
    pathIndices,
    leafIndex,
    bigintToBytes(root)
  );
}

/**
 * Convert Merkle proof to format expected by circom circuits
 */
export function proofToCircomFormat(proof: MerkleProof): {
  merkle_path: string[];
  path_indices: string[];
  merkle_root: string;
} {
  return {
    merkle_path: proof.pathElements.map(
      (el) => "0x" + toHex(el)
    ),
    path_indices: proof.pathIndices.map((i) => i.toString()),
    merkle_root: "0x" + toHex(proof.root),
  };
}

/**
 * Convert Merkle proof to format expected by on-chain program
 */
export function proofToOnChainFormat(proof: MerkleProof): {
  siblings: number[][];
  path: boolean[];
} {
  return {
    siblings: proof.pathElements.map((el) => Array.from(el)),
    path: proof.pathIndices.map((i) => i === 1),
  };
}

/**
 * Compute leaf index from path indices
 */
export function pathIndicesToLeafIndex(pathIndices: number[]): number {
  let index = 0;
  for (let i = 0; i < pathIndices.length; i++) {
    if (pathIndices[i] === 1) {
      index |= 1 << i;
    }
  }
  return index;
}

/**
 * Compute path indices from leaf index
 */
export function leafIndexToPathIndices(leafIndex: number, depth: number = TREE_DEPTH): number[] {
  const indices: number[] = [];
  let idx = leafIndex;
  for (let i = 0; i < depth; i++) {
    indices.push(idx & 1);
    idx >>= 1;
  }
  return indices;
}

/**
 * Create an empty/placeholder Merkle proof
 * Used when constructing proofs before on-chain data is available
 */
export function createEmptyMerkleProof(): MerkleProof {
  const pathElements: Uint8Array[] = [];
  const pathIndices: number[] = [];

  for (let i = 0; i < TREE_DEPTH; i++) {
    pathElements.push(new Uint8Array(ZERO_VALUE));
    pathIndices.push(0);
  }

  return {
    pathElements,
    pathIndices,
    leafIndex: 0,
    root: new Uint8Array(ZERO_VALUE),
  };
}

/**
 * Parse a merkle proof response (hex strings) into BigInt format for circuit input.
 * Accepts the response from /api/merkle/proof or /api/tree/proof.
 */
export function parseMerkleProofResponse(response: {
  root: string;
  siblings: string[];
  indices: number[];
}): { root: bigint; pathElements: bigint[]; pathIndices: number[] } {
  return {
    root: BigInt("0x" + response.root),
    pathElements: response.siblings.map((s) => BigInt("0x" + s)),
    pathIndices: response.indices,
  };
}

/**
 * Validate Merkle proof structure
 */
export function validateMerkleProofStructure(proof: MerkleProof): boolean {
  if (proof.pathElements.length !== TREE_DEPTH) return false;
  if (proof.pathIndices.length !== TREE_DEPTH) return false;
  if (proof.leafIndex < 0 || proof.leafIndex >= MAX_LEAVES) return false;
  if (proof.root.length !== 32) return false;

  for (const el of proof.pathElements) {
    if (el.length !== 32) return false;
  }

  for (const idx of proof.pathIndices) {
    if (idx !== 0 && idx !== 1) return false;
  }

  return true;
}
