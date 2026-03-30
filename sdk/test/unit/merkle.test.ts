import { describe, it, expect } from "bun:test";
import {
  pathIndicesToLeafIndex,
  leafIndexToPathIndices,
  validateMerkleProofStructure,
  createEmptyMerkleProof,
  TREE_DEPTH,
} from "../../src/merkle";

describe("pathIndicesToLeafIndex / leafIndexToPathIndices", () => {
  const testCases = [0, 1, 7, 255, 65535];

  for (const index of testCases) {
    it(`roundtrips leaf index ${index}`, () => {
      const indices = leafIndexToPathIndices(index, TREE_DEPTH);
      expect(indices.length).toBe(TREE_DEPTH);
      expect(pathIndicesToLeafIndex(indices)).toBe(index);
    });
  }

  it("index 0 produces all-zero path indices", () => {
    const indices = leafIndexToPathIndices(0, TREE_DEPTH);
    expect(indices.every((i) => i === 0)).toBe(true);
  });

  it("index 1 has first bit set", () => {
    const indices = leafIndexToPathIndices(1, TREE_DEPTH);
    expect(indices[0]).toBe(1);
    expect(indices.slice(1).every((i) => i === 0)).toBe(true);
  });

  it("max index (65535) produces all-one path indices for depth 16", () => {
    const indices = leafIndexToPathIndices(65535, 16);
    expect(indices.every((i) => i === 1)).toBe(true);
  });

  it("works with custom depth", () => {
    const indices = leafIndexToPathIndices(5, 4); // 5 = 0101 in binary
    expect(indices).toEqual([1, 0, 1, 0]);
    expect(pathIndicesToLeafIndex(indices)).toBe(5);
  });
});

describe("validateMerkleProofStructure", () => {
  it("accepts a valid proof from createEmptyMerkleProof", () => {
    const proof = createEmptyMerkleProof();
    expect(validateMerkleProofStructure(proof)).toBe(true);
  });

  it("rejects proof with wrong number of path elements", () => {
    const proof = createEmptyMerkleProof();
    proof.pathElements = proof.pathElements.slice(0, 10);
    expect(validateMerkleProofStructure(proof)).toBe(false);
  });

  it("rejects proof with wrong number of path indices", () => {
    const proof = createEmptyMerkleProof();
    proof.pathIndices = proof.pathIndices.slice(0, 10);
    expect(validateMerkleProofStructure(proof)).toBe(false);
  });

  it("rejects proof with negative leaf index", () => {
    const proof = createEmptyMerkleProof();
    proof.leafIndex = -1;
    expect(validateMerkleProofStructure(proof)).toBe(false);
  });

  it("rejects proof with leaf index >= MAX_LEAVES", () => {
    const proof = createEmptyMerkleProof();
    proof.leafIndex = 65536;
    expect(validateMerkleProofStructure(proof)).toBe(false);
  });

  it("rejects proof with wrong root length", () => {
    const proof = createEmptyMerkleProof();
    proof.root = new Uint8Array(16);
    expect(validateMerkleProofStructure(proof)).toBe(false);
  });

  it("rejects proof with wrong path element length", () => {
    const proof = createEmptyMerkleProof();
    proof.pathElements[5] = new Uint8Array(16);
    expect(validateMerkleProofStructure(proof)).toBe(false);
  });

  it("rejects proof with invalid path index value", () => {
    const proof = createEmptyMerkleProof();
    proof.pathIndices[0] = 2;
    expect(validateMerkleProofStructure(proof)).toBe(false);
  });
});

describe("createEmptyMerkleProof", () => {
  it("creates proof with correct depth", () => {
    const proof = createEmptyMerkleProof();
    expect(proof.pathElements.length).toBe(TREE_DEPTH);
    expect(proof.pathIndices.length).toBe(TREE_DEPTH);
  });

  it("has leafIndex 0", () => {
    const proof = createEmptyMerkleProof();
    expect(proof.leafIndex).toBe(0);
  });

  it("has all path indices set to 0", () => {
    const proof = createEmptyMerkleProof();
    expect(proof.pathIndices.every((i) => i === 0)).toBe(true);
  });

  it("has 32-byte root", () => {
    const proof = createEmptyMerkleProof();
    expect(proof.root.length).toBe(32);
  });

  it("has 32-byte path elements", () => {
    const proof = createEmptyMerkleProof();
    for (const el of proof.pathElements) {
      expect(el.length).toBe(32);
    }
  });
});
