/**
 * On-Chain Commitment Tree Fetch Tests
 *
 * Tests for fetching commitment tree data from Solana RPC.
 * These tests use mock RPC responses to verify parsing and tree building.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import {
  buildCommitmentTreeFromChain,
  getLeafIndexForCommitment,
  fetchMerkleProofForCommitment,
  getMerkleProofFromTree,
  CommitmentTreeIndex,
  initPoseidon,
  type RpcClient,
} from "../src/commitment-tree";
import { bigintToBytes } from "../src/crypto";

// Initialize Poseidon before tests
beforeAll(async () => {
  await initPoseidon();
});

// Mock stealth announcement data builder
function buildMockAnnouncementData(commitment: bigint, leafIndex: number): Uint8Array {
  const data = new Uint8Array(91);

  // Discriminator (0x08 for StealthAnnouncement)
  data[0] = 0x08;
  // Bump
  data[1] = 0xff;

  // Ephemeral pub (33 bytes) - mock compressed pubkey
  data[2] = 0x02;
  for (let i = 3; i < 35; i++) data[i] = i;

  // Encrypted amount (8 bytes)
  const amountView = new DataView(data.buffer, 35, 8);
  amountView.setBigUint64(0, 100000n, true);

  // Commitment (32 bytes, big-endian)
  const commitmentBytes = bigintToBytes(commitment);
  data.set(commitmentBytes, 43);

  // Leaf index (8 bytes, little-endian)
  const indexView = new DataView(data.buffer, 75, 8);
  indexView.setBigUint64(0, BigInt(leafIndex), true);

  // Created at (8 bytes)
  const timeView = new DataView(data.buffer, 83, 8);
  timeView.setBigInt64(0, BigInt(Date.now()), true);

  return data;
}

// Create mock RPC client
function createMockRpc(
  announcements: Array<{ commitment: bigint; leafIndex: number }>
): RpcClient {
  return {
    getProgramAccounts: async (_programId, config) => {
      // Filter by discriminator if memcmp filter present
      const memcmpFilters = config?.filters?.filter(
        (f): f is { memcmp: { offset: number; bytes: string } } => "memcmp" in f
      );

      // Check for commitment filter (offset 43)
      const commitmentFilter = memcmpFilters?.find((f) => f.memcmp.offset === 43);

      if (commitmentFilter) {
        // Single commitment lookup
        const targetCommitment = announcements.find((a) => {
          const bytes = bigintToBytes(a.commitment);
          // Simple check - in real impl would decode base58
          return true; // Simplified for test
        });

        if (targetCommitment) {
          return [
            {
              pubkey: `mock-pubkey-${targetCommitment.leafIndex}`,
              account: {
                data: buildMockAnnouncementData(
                  targetCommitment.commitment,
                  targetCommitment.leafIndex
                ),
              },
            },
          ];
        }
        return [];
      }

      // Return all announcements
      return announcements.map((ann) => ({
        pubkey: `mock-pubkey-${ann.leafIndex}`,
        account: {
          data: buildMockAnnouncementData(ann.commitment, ann.leafIndex),
        },
      }));
    },
  };
}

describe("On-Chain Commitment Tree", () => {
  describe("buildCommitmentTreeFromChain", () => {
    test("builds tree from mock announcements", async () => {
      const mockRpc = createMockRpc([
        { commitment: 111n, leafIndex: 0 },
        { commitment: 222n, leafIndex: 1 },
        { commitment: 333n, leafIndex: 2 },
      ]);

      const tree = await buildCommitmentTreeFromChain(mockRpc, "mock-program-id");

      expect(tree.size()).toBe(3);
      expect(tree.getRoot()).toBeGreaterThan(0n);
      expect(tree.getNextIndex()).toBe(3n);
    });

    test("handles empty chain", async () => {
      const mockRpc = createMockRpc([]);

      const tree = await buildCommitmentTreeFromChain(mockRpc, "mock-program-id");

      expect(tree.size()).toBe(0);
      // Empty tree has known root (ZERO_HASHES[20])
      expect(tree.getRoot()).toBe(
        0x2134e76ac5d21aab186c2be1dd8f84ee880a1e46eaf712f9d371b6df22191f3en
      );
    });

    test("sorts by leaf index", async () => {
      // Provide out-of-order announcements
      const mockRpc = createMockRpc([
        { commitment: 333n, leafIndex: 2 },
        { commitment: 111n, leafIndex: 0 },
        { commitment: 222n, leafIndex: 1 },
      ]);

      const tree = await buildCommitmentTreeFromChain(mockRpc, "mock-program-id");

      // Tree should be built in correct order
      expect(tree.size()).toBe(3);

      // Verify commitments are in correct positions by checking proof
      const proof0 = tree.getMerkleProof(111n);
      const proof1 = tree.getMerkleProof(222n);
      const proof2 = tree.getMerkleProof(333n);

      expect(proof0?.leafIndex).toBe(0n);
      expect(proof1?.leafIndex).toBe(1n);
      expect(proof2?.leafIndex).toBe(2n);
    });
  });

  describe("getMerkleProofFromTree", () => {
    test("returns valid proof for existing commitment", async () => {
      const mockRpc = createMockRpc([
        { commitment: 111n, leafIndex: 0 },
        { commitment: 222n, leafIndex: 1 },
        { commitment: 333n, leafIndex: 2 },
      ]);

      const tree = await buildCommitmentTreeFromChain(mockRpc, "mock-program-id");
      const proof = getMerkleProofFromTree(tree, 222n);

      expect(proof).not.toBeNull();
      expect(proof!.leafIndex).toBe(1);
      expect(proof!.commitment).toBe(222n);
      expect(proof!.siblings.length).toBe(20); // TREE_DEPTH
      expect(proof!.indices.length).toBe(20);
      expect(proof!.root).toBe(tree.getRoot());
    });

    test("returns null for non-existent commitment", async () => {
      const mockRpc = createMockRpc([
        { commitment: 111n, leafIndex: 0 },
      ]);

      const tree = await buildCommitmentTreeFromChain(mockRpc, "mock-program-id");
      const proof = getMerkleProofFromTree(tree, 999n);

      expect(proof).toBeNull();
    });
  });

  describe("CommitmentTreeIndex local operations", () => {
    test("computes deterministic root", () => {
      const tree1 = new CommitmentTreeIndex();
      const tree2 = new CommitmentTreeIndex();

      tree1.addCommitment(111n, 100n);
      tree1.addCommitment(222n, 200n);

      tree2.addCommitment(111n, 100n);
      tree2.addCommitment(222n, 200n);

      expect(tree1.getRoot()).toBe(tree2.getRoot());
    });

    test("different commitments produce different roots", () => {
      const tree1 = new CommitmentTreeIndex();
      const tree2 = new CommitmentTreeIndex();

      tree1.addCommitment(111n, 100n);
      tree2.addCommitment(222n, 100n);

      expect(tree1.getRoot()).not.toBe(tree2.getRoot());
    });

    test("merkle proof verifies correctly", () => {
      const tree = new CommitmentTreeIndex();
      tree.addCommitment(111n, 100n);
      tree.addCommitment(222n, 200n);
      tree.addCommitment(333n, 300n);

      const proof = tree.getMerkleProof(222n);

      expect(proof).not.toBeNull();
      expect(proof!.leafIndex).toBe(1n);

      // Verify path indices are correct (0 = left, 1 = right)
      // Index 1 is right child at level 0
      expect(proof!.indices[0]).toBe(1);
    });
  });
});

describe("Integration: Full Flow Simulation", () => {
  test("deposit → fetch → proof → verify", async () => {
    // Simulate deposits
    const deposits = [
      { commitment: 12345n, leafIndex: 0 },
      { commitment: 67890n, leafIndex: 1 },
      { commitment: 11111n, leafIndex: 2 },
    ];

    // Create mock RPC
    const mockRpc = createMockRpc(deposits);

    // Fetch tree from "chain"
    const tree = await buildCommitmentTreeFromChain(mockRpc, "mock-program-id");
    expect(tree.size()).toBe(3);

    // Get proof for middle deposit
    const proof = getMerkleProofFromTree(tree, 67890n);
    expect(proof).not.toBeNull();
    expect(proof!.leafIndex).toBe(1);

    // Verify proof structure matches circuit expectations
    expect(proof!.siblings.length).toBe(20);
    expect(proof!.indices.length).toBe(20);
    expect(proof!.indices.every((i) => i === 0 || i === 1)).toBe(true);

    // Verify root is consistent
    expect(proof!.root).toBe(tree.getRoot());
  });
});
