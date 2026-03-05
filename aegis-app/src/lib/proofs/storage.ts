/**
 * Note Storage for AEGIS Frontend (circom-compatible)
 *
 * Manages storage of notes and provides Merkle tree functionality
 * for generating proofs in the browser.
 *
 * NOTE: This uses a simplified Merkle tree for frontend storage.
 * In production, the actual Merkle tree is maintained on-chain
 * and proofs are generated from the on-chain state.
 */

import { initPoseidon, bigintToBytes, bytesToBigint, type NoteData } from "@aegis/sdk";
import { sha256 } from "@noble/hashes/sha2.js";
import type { MerkleProof } from "./index";

const TREE_DEPTH = 20;

/**
 * Stored note with additional metadata
 */
export interface StoredNote extends NoteData {
  commitment?: bigint;
  leafIndex?: number;
  spent?: boolean;
}

/**
 * Serialized Merkle tree for storage
 */
export interface SerializedMerkleTree {
  leaves: string[];
  root: string;
}

/**
 * Simple hash function for Merkle tree (SHA256-based)
 *
 * NOTE: In circom mode, actual Poseidon hashing is done in the circuit.
 * This SHA256-based hash is just for frontend Merkle tree management.
 */
function merkleHash(left: bigint, right: bigint): bigint {
  const leftBytes = bigintToBytes(left);
  const rightBytes = bigintToBytes(right);
  const combined = new Uint8Array(64);
  combined.set(leftBytes, 0);
  combined.set(rightBytes, 32);
  const hash = sha256(combined);
  return bytesToBigint(hash);
}

/**
 * Simple Merkle Tree implementation for browser use
 *
 * Uses SHA256 for hashing (for frontend storage only).
 * circom circuits use Poseidon for actual proofs.
 */
export class MerkleTree {
  private leaves: bigint[] = [];
  private zeroHashes: bigint[] = [];
  public root: bigint = 0n;

  constructor() {
    this.initZeroHashes();
    this.root = this.zeroHashes[TREE_DEPTH];
  }

  private initZeroHashes(): void {
    // Start with hash of 0
    this.zeroHashes[0] = merkleHash(0n, 0n);
    for (let i = 1; i <= TREE_DEPTH; i++) {
      this.zeroHashes[i] = merkleHash(this.zeroHashes[i - 1], this.zeroHashes[i - 1]);
    }
  }

  insert(leaf: bigint): number {
    const index = this.leaves.length;
    this.leaves.push(leaf);
    this.updateRoot();
    return index;
  }

  private updateRoot(): void {
    if (this.leaves.length === 0) {
      this.root = this.zeroHashes[TREE_DEPTH];
      return;
    }

    let currentLevel = [...this.leaves];

    // Pad to power of 2
    const size = Math.pow(2, Math.ceil(Math.log2(currentLevel.length)));
    while (currentLevel.length < size) {
      currentLevel.push(this.zeroHashes[0]);
    }

    for (let level = 0; level < TREE_DEPTH && currentLevel.length > 1; level++) {
      const nextLevel: bigint[] = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        const right = i + 1 < currentLevel.length ? currentLevel[i + 1] : this.zeroHashes[level];
        nextLevel.push(merkleHash(left, right));
      }
      currentLevel = nextLevel;
    }

    this.root = currentLevel[0];
  }

  generateProof(leafIndex: number): MerkleProof {
    if (leafIndex >= this.leaves.length) {
      throw new Error("Leaf index out of bounds");
    }

    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];

    let currentLevel = [...this.leaves];

    // Pad to power of 2
    const size = Math.pow(2, Math.ceil(Math.log2(Math.max(currentLevel.length, 2))));
    while (currentLevel.length < size) {
      currentLevel.push(this.zeroHashes[0]);
    }

    let index = leafIndex;

    for (let level = 0; level < TREE_DEPTH && currentLevel.length > 1; level++) {
      const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
      const sibling = siblingIndex < currentLevel.length ? currentLevel[siblingIndex] : this.zeroHashes[level];

      pathElements.push(sibling);
      pathIndices.push(index % 2);

      // Move to next level
      const nextLevel: bigint[] = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        const right = i + 1 < currentLevel.length ? currentLevel[i + 1] : this.zeroHashes[level];
        nextLevel.push(merkleHash(left, right));
      }
      currentLevel = nextLevel;
      index = Math.floor(index / 2);
    }

    // Pad to full depth
    while (pathElements.length < TREE_DEPTH) {
      pathElements.push(this.zeroHashes[pathElements.length]);
      pathIndices.push(0);
    }

    return { siblings: pathElements, indices: pathIndices };
  }

  serialize(): SerializedMerkleTree {
    return {
      leaves: this.leaves.map(l => l.toString()),
      root: this.root.toString(),
    };
  }

  static deserialize(data: SerializedMerkleTree): MerkleTree {
    const tree = new MerkleTree();
    for (const leaf of data.leaves) {
      tree.insert(BigInt(leaf));
    }
    return tree;
  }
}

/**
 * Note Storage Manager (circom-compatible)
 */
export class NoteStorage {
  private notes: StoredNote[] = [];
  private tree: MerkleTree;
  private initialized = false;

  constructor() {
    this.tree = new MerkleTree();
  }

  async init(): Promise<void> {
    if (!this.initialized) {
      // Initialize Poseidon (no-op for circom, but kept for API compatibility)
      await initPoseidon();
      this.initialized = true;
      // Tree is already initialized in constructor
    }
  }

  addNote(note: StoredNote): void {
    if (note.commitment !== undefined) {
      const leafIndex = this.tree.insert(note.commitment);
      note.leafIndex = leafIndex;
    }
    this.notes.push(note);
  }

  getUnspentNotes(): StoredNote[] {
    return this.notes.filter((n) => !n.spent);
  }

  getAllNotes(): StoredNote[] {
    return [...this.notes];
  }

  getTotalBalance(): bigint {
    return this.getUnspentNotes().reduce((sum, note) => sum + note.amount, 0n);
  }

  getMerkleTree(): MerkleTree {
    return this.tree;
  }

  getMerkleRoot(): bigint {
    return this.tree.root;
  }

  getMerkleProof(note: StoredNote): MerkleProof {
    if (note.leafIndex === undefined) {
      throw new Error("Note not in tree");
    }
    return this.tree.generateProof(note.leafIndex);
  }

  markSpent(notes: StoredNote[]): void {
    const spentCommitments = new Set(notes.map((n) => n.commitment?.toString()));
    for (const note of this.notes) {
      if (spentCommitments.has(note.commitment?.toString())) {
        note.spent = true;
      }
    }
  }
}

export { TREE_DEPTH };
