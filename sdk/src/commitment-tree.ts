/**
 * Commitment Tree Client
 *
 * Implements an incremental Merkle tree matching the on-chain logic exactly.
 * Uses frontier array + pre-computed zero hashes (Tornado Cash/Semaphore pattern).
 *
 * The tree supports up to 2^20 (~1M) leaf commitments.
 * Standard Merkle path proofs compatible with ZK circuits.
 */

import { poseidonHashSync, initPoseidon } from "./poseidon";
import { debug, warn } from "./logger";

// Re-export initPoseidon for tree initialization
export { initPoseidon };

/**
 * Convert Uint8Array to bigint (little-endian)
 * Used for parsing on-chain u64 values
 */
function bytesToBigintLE(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result;
}

// Tree constants (must match on-chain — depth 16 = 65,536 leaves)
export const TREE_DEPTH = 16;
export const ROOT_HISTORY_SIZE = 100;
export const MAX_LEAVES = 1n << BigInt(TREE_DEPTH);

// Discriminator for CommitmentTree account
export const COMMITMENT_TREE_DISCRIMINATOR = 0x05;

/**
 * Pre-computed zero hashes for each level of the tree
 * ZERO[0] = 0 (empty leaf)
 * ZERO[i] = Poseidon(ZERO[i-1], ZERO[i-1])
 *
 * These values MUST match the contract's ZERO_HASHES exactly!
 * Using Circom-compatible Poseidon (matches Solana's sol_poseidon).
 */
export const ZERO_HASHES: bigint[] = [
  0x0000000000000000000000000000000000000000000000000000000000000000n, // Level 0
  0x2098f5fb9e239eab3ceac3f27b81e481dc3124d55ffed523a839ee8446b64864n, // Level 1
  0x1069673dcdb12263df301a6ff584a7ec261a44cb9dc68df067a4774460b1f1e1n, // Level 2
  0x18f43331537ee2af2e3d758d50f72106467c6eea50371dd528d57eb2b856d238n, // Level 3
  0x07f9d837cb17b0d36320ffe93ba52345f1b728571a568265caac97559dbc952an, // Level 4
  0x2b94cf5e8746b3f5c9631f4c5df32907a699c58c94b2ad4d7b5cec1639183f55n, // Level 5
  0x2dee93c5a666459646ea7d22cca9e1bcfed71e6951b953611d11dda32ea09d78n, // Level 6
  0x078295e5a22b84e982cf601eb639597b8b0515a88cb5ac7fa8a4aabe3c87349dn, // Level 7
  0x2fa5e5f18f6027a6501bec864564472a616b2e274a41211a444cbe3a99f3cc61n, // Level 8
  0x0e884376d0d8fd21ecb780389e941f66e45e7acce3e228ab3e2156a614fcd747n, // Level 9
  0x1b7201da72494f1e28717ad1a52eb469f95892f957713533de6175e5da190af2n, // Level 10
  0x1f8d8822725e36385200c0b201249819a6e6e1e4650808b5bebc6bface7d7636n, // Level 11
  0x2c5d82f66c914bafb9701589ba8cfcfb6162b0a12acf88a8d0879a0471b5f85an, // Level 12
  0x14c54148a0940bb820957f5adf3fa1134ef5c4aaa113f4646458f270e0bfbfd0n, // Level 13
  0x190d33b12f986f961e10c0ee44d8b9af11be25588cad89d416118e4bf4ebe80cn, // Level 14
  0x22f98aa9ce704152ac17354914ad73ed1167ae6596af510aa5b3649325e06c92n, // Level 15
  0x2a7c7c9b6ce5880b9f6f228d72bf6a575a526f29c66ecceef8b753d38bba7323n, // Level 16
  0x2e8186e558698ec1c67af9c14d463ffc470043c9c2988b954d75dd643f36b992n, // Level 17
  0x0f57c5571e9a4eab49e2c8cf050dae948aef6ead647392273546249d1c1ff10fn, // Level 18
  0x1830ee67b5fb554ad5f63d4388800e1cfe78e310697d46e43c9ce36134f72ccan, // Level 19
  0x2134e76ac5d21aab186c2be1dd8f84ee880a1e46eaf712f9d371b6df22191f3en, // Level 20: Empty tree root
];

/**
 * On-chain commitment tree state
 */
export interface CommitmentTreeState {
  discriminator: number;
  bump: number;
  currentRoot: Uint8Array;
  nextIndex: bigint;
  frontier: Uint8Array[]; // Rightmost filled nodes at each level
  rootHistory: Uint8Array[];
  rootHistoryIndex: number;
}

/**
 * Parse commitment tree account data
 *
 * On-chain layout:
 * - discriminator: 1 byte
 * - bump: 1 byte
 * - padding: 6 bytes
 * - current_root: 32 bytes
 * - next_index: 8 bytes
 * - frontier: 20 * 32 = 640 bytes
 * - root_history: 100 * 32 = 3200 bytes
 * - root_history_index: 4 bytes
 * - reserved: 60 bytes
 */
export function parseCommitmentTreeData(data: Uint8Array): CommitmentTreeState {
  const EXPECTED_MIN_SIZE = 8 + 32 + 8 + TREE_DEPTH * 32 + ROOT_HISTORY_SIZE * 32 + 4 + 60;
  if (data.length < EXPECTED_MIN_SIZE) {
    throw new Error(`Invalid commitment tree data length: ${data.length} < ${EXPECTED_MIN_SIZE}`);
  }

  if (data[0] !== COMMITMENT_TREE_DISCRIMINATOR) {
    throw new Error(`Invalid commitment tree discriminator: ${data[0]}`);
  }

  const discriminator = data[0];
  const bump = data[1];
  // Skip 6 bytes padding (indices 2-7)
  const currentRoot = data.slice(8, 40);
  // next_index is stored as little-endian u64
  const nextIndex = bytesToBigintLE(data.slice(40, 48));

  // Parse frontier (20 x 32 bytes)
  const frontier: Uint8Array[] = [];
  let offset = 48;
  for (let i = 0; i < TREE_DEPTH; i++) {
    frontier.push(data.slice(offset, offset + 32));
    offset += 32;
  }

  // Parse root history (100 x 32 bytes)
  const rootHistory: Uint8Array[] = [];
  for (let i = 0; i < ROOT_HISTORY_SIZE; i++) {
    rootHistory.push(data.slice(offset, offset + 32));
    offset += 32;
  }

  const rootHistoryIndex =
    data[offset] |
    (data[offset + 1] << 8) |
    (data[offset + 2] << 16) |
    (data[offset + 3] << 24);

  return {
    discriminator,
    bump,
    currentRoot,
    nextIndex,
    frontier,
    rootHistory,
    rootHistoryIndex,
  };
}

/**
 * Check if a root is valid (current or in history)
 */
export function isValidRoot(
  state: CommitmentTreeState,
  root: Uint8Array
): boolean {
  // Check current root
  if (arraysEqual(state.currentRoot, root)) {
    return true;
  }

  // Check historical roots
  for (const histRoot of state.rootHistory) {
    if (arraysEqual(histRoot, root)) {
      return true;
    }
  }

  return false;
}

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Convert bigint to 32-byte array (big-endian)
 */
function bigintToBytes32(n: bigint): Uint8Array {
  const hex = n.toString(16).padStart(64, "0");
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Convert 32-byte array (big-endian) to bigint
 */
function bytes32ToBigint(bytes: Uint8Array): bigint {
  let hex = "0x";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return BigInt(hex);
}

/**
 * Local Commitment Tree Index (Incremental Merkle Tree)
 *
 * Uses the same algorithm as the on-chain contract:
 * - Frontier array to track rightmost filled nodes at each level
 * - Pre-computed zero hashes for empty subtrees
 *
 * This produces the same root as the on-chain tree.
 */
export class CommitmentTreeIndex {
  private commitments: Map<string, { index: bigint; amount: bigint }> = new Map();
  private leaves: bigint[] = [];

  // Frontier: rightmost filled node at each level (like on-chain)
  private frontier: bigint[] = [];
  private currentRoot: bigint;
  private nextIndex: bigint = 0n;

  constructor() {
    // Initialize empty tree
    this.frontier = new Array(TREE_DEPTH).fill(0n);
    this.currentRoot = ZERO_HASHES[TREE_DEPTH]; // Empty tree root
  }

  /**
   * Add a commitment to the index
   * Uses the same algorithm as on-chain insert_leaf()
   */
  addCommitment(commitment: bigint, amount: bigint): bigint {
    const leafIndex = this.nextIndex;

    if (leafIndex >= MAX_LEAVES) {
      throw new Error("Tree is full");
    }

    // Store in map for lookup
    const commitmentHex = commitment.toString(16).padStart(64, "0");
    this.commitments.set(commitmentHex, { index: leafIndex, amount });

    // Add to leaves array
    this.leaves.push(commitment);

    // Update tree using incremental algorithm
    let currentHash = commitment;
    let currentIndex = Number(leafIndex);

    // Walk up the tree from leaf to root
    for (let level = 0; level < TREE_DEPTH; level++) {
      if (currentIndex % 2 === 0) {
        // This is a left child - save to frontier and pair with zero hash
        this.frontier[level] = currentHash;
        currentHash = poseidonHashSync([currentHash, ZERO_HASHES[level]]);
      } else {
        // This is a right child - pair with frontier (left sibling)
        currentHash = poseidonHashSync([this.frontier[level], currentHash]);
      }
      currentIndex = Math.floor(currentIndex / 2);
    }

    // Update root
    this.currentRoot = currentHash;
    this.nextIndex = leafIndex + 1n;

    return leafIndex;
  }

  /**
   * Get merkle proof for a commitment
   *
   * Returns siblings and path indices for ZK circuit verification.
   */
  getMerkleProof(commitment: bigint): {
    siblings: bigint[];
    indices: number[];
    leafIndex: bigint;
    root: bigint;
  } | null {
    const commitmentHex = commitment.toString(16).padStart(64, "0");
    const entry = this.commitments.get(commitmentHex);

    if (!entry) {
      return null;
    }

    const { index } = entry;
    const siblings: bigint[] = [];
    const indices: number[] = [];

    // We need to reconstruct the path from stored leaves
    // This requires recomputing sibling hashes
    const proof = this.computeMerkleProof(Number(index));

    return {
      siblings: proof.siblings,
      indices: proof.indices,
      leafIndex: index,
      root: this.currentRoot,
    };
  }

  /**
   * Compute merkle proof for a leaf at given index
   * Optimized: only computes nodes needed for the proof path
   */
  private computeMerkleProof(leafIndex: number): {
    siblings: bigint[];
    indices: number[];
  } {
    const siblings: bigint[] = [];
    const indices: number[] = [];
    const numLeaves = this.leaves.length;

    if (numLeaves === 0) {
      // Empty tree - all siblings are zero hashes
      for (let level = 0; level < TREE_DEPTH; level++) {
        siblings.push(ZERO_HASHES[level]);
        indices.push((leafIndex >> level) & 1);
      }
      return { siblings, indices };
    }

    // Build tree level by level, but only compute the nodes we actually need
    // For each level, we only need: the path node and its sibling
    let currentLevel = [...this.leaves];

    for (let level = 0; level < TREE_DEPTH; level++) {
      const idx = leafIndex >> level;
      const siblingIdx = idx ^ 1;

      // Get sibling value
      const sibling = siblingIdx < currentLevel.length
        ? currentLevel[siblingIdx]
        : ZERO_HASHES[level];

      siblings.push(sibling);
      indices.push(idx & 1);

      // Build next level - only need pairs that lead to our path
      // Compute minimal set of parent nodes needed
      const nextLevel: bigint[] = [];
      const numPairs = Math.ceil(currentLevel.length / 2);

      for (let i = 0; i < numPairs; i++) {
        const left = currentLevel[i * 2] ?? ZERO_HASHES[level];
        const right = currentLevel[i * 2 + 1] ?? ZERO_HASHES[level];
        nextLevel.push(poseidonHashSync([left, right]));
      }

      // If our path goes beyond the computed nodes, we need to add zero-hash parents
      const neededIdx = Math.floor(idx / 2);
      while (nextLevel.length <= neededIdx) {
        nextLevel.push(ZERO_HASHES[level + 1]);
      }

      currentLevel = nextLevel;
    }

    return { siblings, indices };
  }

  /**
   * Get commitment info by hex string
   */
  getCommitment(
    commitmentHex: string
  ): { index: bigint; amount: bigint } | null {
    return this.commitments.get(commitmentHex) ?? null;
  }

  /**
   * Get current merkle root
   */
  getRoot(): bigint {
    return this.currentRoot;
  }

  /**
   * Get root as bytes for comparison with on-chain
   */
  getRootBytes(): Uint8Array {
    return bigintToBytes32(this.currentRoot);
  }

  /**
   * Get number of commitments
   */
  size(): number {
    return this.leaves.length;
  }

  /**
   * Get next leaf index
   */
  getNextIndex(): bigint {
    return this.nextIndex;
  }

  /**
   * Get tree status (for API compatibility)
   */
  getStatus(): {
    root: string;
    nextIndex: number;
    size: number;
  } {
    return {
      root: this.currentRoot.toString(16).padStart(64, "0"),
      nextIndex: Number(this.nextIndex),
      size: this.leaves.length,
    };
  }

  /**
   * Get path (merkle proof) for a commitment by hex string
   * Convenience wrapper around getMerkleProof for API compatibility
   */
  getPath(commitmentHex: string): {
    siblings: string[];
    indices: number[];
    leafIndex: string;
    root: string;
  } | null {
    // Normalize hex
    const normalized = commitmentHex.startsWith("0x")
      ? commitmentHex.slice(2)
      : commitmentHex;
    const commitment = BigInt("0x" + normalized);

    const proof = this.getMerkleProof(commitment);
    if (!proof) return null;

    return {
      siblings: proof.siblings.map((s) => s.toString(16).padStart(64, "0")),
      indices: proof.indices,
      leafIndex: proof.leafIndex.toString(),
      root: proof.root.toString(16).padStart(64, "0"),
    };
  }

  /**
   * Export index for persistence
   */
  export(): { commitments: [string, { index: string; amount: string }][] } {
    return {
      commitments: Array.from(this.commitments.entries()).map(([k, v]) => [
        k,
        { index: v.index.toString(), amount: v.amount.toString() },
      ]),
    };
  }

  /**
   * Import index from persistence
   */
  import(data: {
    commitments: [string, { index: string; amount: string }][];
  }): void {
    // Reset state
    this.commitments.clear();
    this.leaves = [];
    this.frontier = new Array(TREE_DEPTH).fill(0n);
    this.currentRoot = ZERO_HASHES[TREE_DEPTH];
    this.nextIndex = 0n;

    // Sort by index and add in order
    const sorted = [...data.commitments].sort(
      (a, b) => Number(BigInt(a[1].index)) - Number(BigInt(b[1].index))
    );

    for (const [hexCommitment, entry] of sorted) {
      const commitment = BigInt("0x" + hexCommitment);
      const amount = BigInt(entry.amount);
      this.addCommitment(commitment, amount);
    }
  }

  /**
   * Import from on-chain state
   * Reconstructs tree state from on-chain frontier and root
   */
  importFromOnChainState(state: CommitmentTreeState): void {
    // Reset local state
    this.commitments.clear();
    this.leaves = [];
    this.nextIndex = state.nextIndex;

    // Copy frontier from on-chain state
    this.frontier = state.frontier.map(bytes32ToBigint);

    // Copy current root
    this.currentRoot = bytes32ToBigint(state.currentRoot);

    // Note: We don't have the actual leaf values from on-chain state
    // This is just for syncing root/frontier state
  }
}

/**
 * Fetch commitment tree state from Solana
 */
export async function fetchCommitmentTree(
  connection: { getAccountInfo: (pubkey: unknown) => Promise<{ data: Uint8Array } | null> },
  commitmentTreePDA: unknown
): Promise<CommitmentTreeState | null> {
  const accountInfo = await connection.getAccountInfo(commitmentTreePDA);

  if (!accountInfo) {
    return null;
  }

  return parseCommitmentTreeData(accountInfo.data);
}

// Global index instance (for frontend use)
let globalIndex: CommitmentTreeIndex | null = null;

/**
 * Get or create the global commitment index
 */
export function getCommitmentIndex(): CommitmentTreeIndex {
  if (!globalIndex) {
    globalIndex = new CommitmentTreeIndex();

    // Try to load from localStorage if available
    if (typeof window !== "undefined" && window.localStorage) {
      try {
        const stored = localStorage.getItem("utxopia_commitment_index");
        if (stored) {
          globalIndex.import(JSON.parse(stored));
          debug("tree", `Loaded ${globalIndex.size()} commitments from storage`);
        }
      } catch (e) {
        warn("tree", "Failed to load from storage:", e);
      }
    }
  }
  return globalIndex;
}

/**
 * Save the global commitment index to localStorage
 */
export function saveCommitmentIndex(): void {
  if (!globalIndex) return;

  if (typeof window !== "undefined" && window.localStorage) {
    try {
      const data = globalIndex.export();
      localStorage.setItem("utxopia_commitment_index", JSON.stringify(data));
      debug("tree", `Saved ${globalIndex.size()} commitments`);
    } catch (e) {
      warn("tree", "Failed to save to storage:", e);
    }
  }
}

// ============================================================================
// On-Chain Fetch Functions (Helius-compatible)
// ============================================================================

/**
 * RPC client interface for on-chain queries
 * Compatible with @solana/web3.js Connection and Helius enhanced RPC
 */
export interface RpcClient {
  getProgramAccounts(
    programId: string,
    config?: {
      filters?: Array<
        | { memcmp: { offset: number; bytes: string } }
        | { dataSize: number }
      >;
      encoding?: string;
    }
  ): Promise<
    Array<{
      pubkey: string;
      account: { data: Uint8Array | string };
    }>
  >;
}

/**
 * On-chain merkle proof format
 */
export interface OnChainMerkleProof {
  siblings: bigint[];
  indices: number[];
  leafIndex: number;
  root: bigint;
  commitment: bigint;
}

/**
 * Build commitment tree from indexed commitment data.
 *
 * Stealth announcements are now emitted as events, not stored as PDAs.
 * This function accepts a commitments map (leafIndex → commitment bigint)
 * from the event indexer and builds the local Merkle tree.
 *
 * @param _rpc - RPC client (unused, kept for API compatibility)
 * @param _programId - UTXOpia program ID (unused)
 * @param options - commitments map from indexer
 */
export async function buildCommitmentTreeFromChain(
  _rpc: RpcClient,
  _programId: string,
  options?: { maxLeafIndex?: number; commitments?: Map<number, bigint> }
): Promise<CommitmentTreeIndex> {
  const commitmentsByIndex = options?.commitments ?? new Map<number, bigint>();

  // Sort by leaf index
  const sorted = Array.from(commitmentsByIndex.entries()).sort((a, b) => a[0] - b[0]);

  if (options?.maxLeafIndex !== undefined) {
    const max = options.maxLeafIndex;
    while (sorted.length > 0 && sorted[sorted.length - 1][0] >= max) {
      sorted.pop();
    }
  }

  const tree = new CommitmentTreeIndex();

  for (const [leafIndex, commitment] of sorted) {
    // Fill gaps with zero commitments
    while (tree.getNextIndex() < BigInt(leafIndex)) {
      tree.addCommitment(0n, 0n);
    }
    tree.addCommitment(commitment, 0n);
  }

  debug("tree", `Built tree with ${tree.size()} leaves`);
  return tree;
}

/**
 * Get leaf index for a commitment.
 *
 * Commitments are emitted as sol_log_data events (not stored in PDAs).
 * Use scanUnifiedNotes() to get leafIndex for your notes, or query the indexer API.
 * This function builds the full tree from provided commitments to find the index.
 *
 * @param rpc - RPC client
 * @param programId - UTXOpia program ID
 * @param commitment - Commitment to find
 * @returns Leaf index or -1 if not found
 */
export async function getLeafIndexForCommitment(
  rpc: RpcClient,
  programId: string,
  commitment: bigint
): Promise<number> {
  try {
    const tree = await buildCommitmentTreeFromChain(rpc, programId);
    if (!tree) return -1;
    const proof = tree.getMerkleProof(commitment);
    return proof ? Number(proof.leafIndex) : -1;
  } catch (error) {
    console.error("[CommitmentTree] Error fetching leaf index:", error);
    return -1;
  }
}

/**
 * Fetch merkle proof for a commitment from on-chain data
 *
 * Builds tree from chain and computes merkle proof for the given commitment.
 * For better performance with multiple proofs, use buildCommitmentTreeFromChain
 * once and call getMerkleProof on the resulting tree.
 *
 * @param rpc - RPC client
 * @param programId - UTXOpia program ID
 * @param commitment - Commitment to get proof for
 * @returns Merkle proof or null if commitment not found
 *
 * @example
 * ```typescript
 * const proof = await fetchMerkleProofForCommitment(connection, programId, myCommitment);
 * if (proof) {
 *   // Use proof for ZK circuit
 *   const claimInputs = {
 *     merkleRoot: proof.root,
 *     merkleProof: { siblings: proof.siblings, indices: proof.indices },
 *     leafIndex: BigInt(proof.leafIndex),
 *     // ...
 *   };
 * }
 * ```
 */
export async function fetchMerkleProofForCommitment(
  rpc: RpcClient,
  programId: string,
  commitment: bigint
): Promise<OnChainMerkleProof | null> {
  // Build full tree from chain
  const tree = await buildCommitmentTreeFromChain(rpc, programId);

  // Get proof from local tree
  const proof = tree.getMerkleProof(commitment);

  if (!proof) {
    warn("tree", "Commitment not found in tree");
    return null;
  }

  return {
    siblings: proof.siblings,
    indices: proof.indices,
    leafIndex: Number(proof.leafIndex),
    root: proof.root,
    commitment,
  };
}

/**
 * Fetch merkle proof using cached tree (more efficient for multiple lookups)
 *
 * @param tree - Pre-built commitment tree from buildCommitmentTreeFromChain
 * @param commitment - Commitment to get proof for
 * @returns Merkle proof or null if not found
 */
export function getMerkleProofFromTree(
  tree: CommitmentTreeIndex,
  commitment: bigint
): OnChainMerkleProof | null {
  const proof = tree.getMerkleProof(commitment);

  if (!proof) {
    return null;
  }

  return {
    siblings: proof.siblings,
    indices: proof.indices,
    leafIndex: Number(proof.leafIndex),
    root: proof.root,
    commitment,
  };
}
