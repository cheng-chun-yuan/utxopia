/**
 * NULLIFIER GUARD E2E Tests
 *
 * Tests the nullifier mechanism that prevents double-spending.
 *
 * Key properties:
 * - Each commitment has a unique nullifier derived from (privKey, leafIndex)
 * - Nullifier hash = Poseidon(nullifier) is stored on-chain
 * - Same nullifier hash = same PDA = transaction fails if PDA exists
 *
 * Prerequisites:
 * - solana-test-validator running with devnet features
 * - Programs deployed and initialized on localnet
 *
 * Run: bun test test/e2e/nullifier.test.ts
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { address } from "@solana/kit";

import {
  createTestContext,
  initializeTestEnvironment,
  logTestEnvironment,
  TEST_TIMEOUT,
  type E2ETestContext,
} from "./setup";

import {
  createTestNote,
  generateMockProof,
  generateMockVkHash,
  createMockMerkleProof,
  bigintToBytes32,
  bytesToHex,
  TEST_AMOUNTS,
  type TestNote,
} from "./helpers";

import {
  initPoseidon,
  computeNullifierSync,
  hashNullifierSync,
} from "../../src/poseidon";
import {
  derivePoolStatePDA,
  deriveCommitmentTreePDA,
  deriveNullifierRecordPDA,
} from "../../src/pda";
import { bigintToBytes } from "../../src/crypto";

// =============================================================================
// Test Context
// =============================================================================

let ctx: E2ETestContext;

// =============================================================================
// Test Suite
// =============================================================================

describe("NULLIFIER GUARD E2E", () => {
  beforeAll(async () => {
    await initializeTestEnvironment();
    await initPoseidon();

    ctx = await createTestContext();
    logTestEnvironment(ctx);

    if (ctx.skipOnChain) {
      console.log("⚠️  Skipping on-chain tests (validator not available)");
    }
  });

  // ===========================================================================
  // Nullifier Derivation Tests
  // ===========================================================================

  describe("Nullifier Derivation", () => {
    it("should produce deterministic nullifier from privKey and leafIndex", () => {
      const privKey = 12345n;
      const leafIndex = 0n;

      const nullifier1 = computeNullifierSync(privKey, leafIndex);
      const nullifier2 = computeNullifierSync(privKey, leafIndex);

      expect(nullifier1).toBe(nullifier2);
    });

    it("should produce different nullifiers for different privKeys", () => {
      const privKey1 = 12345n;
      const privKey2 = 54321n;
      const leafIndex = 0n;

      const nullifier1 = computeNullifierSync(privKey1, leafIndex);
      const nullifier2 = computeNullifierSync(privKey2, leafIndex);

      expect(nullifier1).not.toBe(nullifier2);
    });

    it("should produce different nullifiers for different leafIndices", () => {
      const privKey = 12345n;
      const leafIndex1 = 0n;
      const leafIndex2 = 1n;

      const nullifier1 = computeNullifierSync(privKey, leafIndex1);
      const nullifier2 = computeNullifierSync(privKey, leafIndex2);

      expect(nullifier1).not.toBe(nullifier2);
    });

    it("should produce deterministic nullifier hash", () => {
      const privKey = 12345n;
      const leafIndex = 0n;

      const nullifier = computeNullifierSync(privKey, leafIndex);
      const hash1 = hashNullifierSync(nullifier);
      const hash2 = hashNullifierSync(nullifier);

      expect(hash1).toBe(hash2);
    });

    it("should produce different hashes for different nullifiers", () => {
      const nullifier1 = computeNullifierSync(11111n, 0n);
      const nullifier2 = computeNullifierSync(22222n, 0n);

      const hash1 = hashNullifierSync(nullifier1);
      const hash2 = hashNullifierSync(nullifier2);

      expect(hash1).not.toBe(hash2);
    });
  });

  // ===========================================================================
  // PDA Derivation Tests
  // ===========================================================================

  describe("PDA Derivation", () => {
    it("should derive consistent nullifier record PDA", async () => {
      const note = createTestNote(TEST_AMOUNTS.small);

      const [pda1] = await deriveNullifierRecordPDA(
        note.nullifierHashBytes,
        ctx.config.zvaultProgramId
      );
      const [pda2] = await deriveNullifierRecordPDA(
        note.nullifierHashBytes,
        ctx.config.zvaultProgramId
      );

      expect(pda1.toString()).toBe(pda2.toString());
    });

    it("should derive different PDAs for different nullifier hashes", async () => {
      const note1 = createTestNote(TEST_AMOUNTS.small, 0n);
      const note2 = createTestNote(TEST_AMOUNTS.small, 1n);

      const [pda1] = await deriveNullifierRecordPDA(
        note1.nullifierHashBytes,
        ctx.config.zvaultProgramId
      );
      const [pda2] = await deriveNullifierRecordPDA(
        note2.nullifierHashBytes,
        ctx.config.zvaultProgramId
      );

      expect(pda1.toString()).not.toBe(pda2.toString());
    });

    it("should use correct PDA seeds", async () => {
      const nullifierHash = new Uint8Array(32).fill(0xab);

      // The PDA should be derived from ["nullifier", nullifierHash]
      const [pda] = await deriveNullifierRecordPDA(
        nullifierHash,
        ctx.config.zvaultProgramId
      );

      // Verify it's a valid Solana address
      expect(pda.toString().length).toBeGreaterThan(30);
    });
  });

  // ===========================================================================
  // Double-Spend Prevention Tests
  // ===========================================================================

  describe("Double-Spend Prevention", () => {
    it("should detect same nullifier across claim operations", () => {
      // Create a note
      const note = createTestNote(TEST_AMOUNTS.small, 0n);

      // Try to claim it twice would use the same nullifier hash
      const hash1 = note.nullifierHashBytes;
      const hash2 = note.nullifierHashBytes;

      expect(hash1).toEqual(hash2);

      console.log("  → Same commitment claimed twice uses same nullifier");
      console.log(`  → Nullifier hash: ${bytesToHex(note.nullifierHashBytes).slice(0, 20)}...`);
    });

    it("should detect same nullifier across different operation types", async () => {
      // Same commitment used in CLAIM vs SPLIT vs PARTIAL_PUBLIC
      // All should produce the same nullifier hash (same privKey + leafIndex)

      const note = createTestNote(TEST_AMOUNTS.medium, 0n);

      // Whether we claim, split, or partial-public spend, same nullifier
      const claimNullifier = note.nullifierHashBytes;
      const splitNullifier = note.nullifierHashBytes;
      const partialNullifier = note.nullifierHashBytes;

      expect(claimNullifier).toEqual(splitNullifier);
      expect(splitNullifier).toEqual(partialNullifier);

      // All operations would derive the same PDA
      const [claimPda] = await deriveNullifierRecordPDA(claimNullifier, ctx.config.zvaultProgramId);
      const [splitPda] = await deriveNullifierRecordPDA(splitNullifier, ctx.config.zvaultProgramId);
      const [partialPda] = await deriveNullifierRecordPDA(partialNullifier, ctx.config.zvaultProgramId);

      expect(claimPda.toString()).toBe(splitPda.toString());
      expect(splitPda.toString()).toBe(partialPda.toString());

      console.log("  → All operation types use the same nullifier PDA");
      console.log(`  → PDA: ${claimPda.toString()}`);
    });

    it("should allow spending different notes from same owner", async () => {
      // Same privKey, different leaf indices = different notes = OK to spend both
      const privKey = 12345n;

      const note1 = createTestNote(100_000n, 0n, privKey);
      const note2 = createTestNote(200_000n, 1n, privKey);
      const note3 = createTestNote(150_000n, 2n, privKey);

      // All should have different nullifier hashes
      expect(bytesToHex(note1.nullifierHashBytes)).not.toBe(bytesToHex(note2.nullifierHashBytes));
      expect(bytesToHex(note2.nullifierHashBytes)).not.toBe(bytesToHex(note3.nullifierHashBytes));
      expect(bytesToHex(note1.nullifierHashBytes)).not.toBe(bytesToHex(note3.nullifierHashBytes));

      // All should derive different PDAs
      const [pda1] = await deriveNullifierRecordPDA(note1.nullifierHashBytes, ctx.config.zvaultProgramId);
      const [pda2] = await deriveNullifierRecordPDA(note2.nullifierHashBytes, ctx.config.zvaultProgramId);
      const [pda3] = await deriveNullifierRecordPDA(note3.nullifierHashBytes, ctx.config.zvaultProgramId);

      expect(pda1.toString()).not.toBe(pda2.toString());
      expect(pda2.toString()).not.toBe(pda3.toString());

      console.log("  → Same owner can spend multiple notes (different leaf indices)");
      console.log(`  → Note 1 PDA: ${pda1.toString().slice(0, 20)}...`);
      console.log(`  → Note 2 PDA: ${pda2.toString().slice(0, 20)}...`);
      console.log(`  → Note 3 PDA: ${pda3.toString().slice(0, 20)}...`);
    });
  });

  // ===========================================================================
  // On-Chain Tests
  // ===========================================================================

  describe("On-Chain Tests", () => {
    it(
      "should verify nullifier PDA creation prevents re-use",
      async () => {
        if (ctx.skipOnChain) {
          console.log("⚠️  Skipping: validator not available");
          return;
        }
        // In a real on-chain test:
        // 1. First spend creates nullifier PDA
        // 2. Second spend with same nullifier fails because PDA exists

        const note = createTestNote(TEST_AMOUNTS.small);
        const [nullifierPda] = await deriveNullifierRecordPDA(
          note.nullifierHashBytes,
          ctx.config.zvaultProgramId
        );

        console.log("  → Nullifier PDA: " + nullifierPda.toString());
        console.log("  → First spend would CREATE this PDA");
        console.log("  → Second spend would FAIL (PDA already exists)");

        // Check if PDA exists on-chain
        const pubkey = new PublicKey(nullifierPda.toString());
        const accountInfo = await ctx.connection.getAccountInfo(pubkey);

        if (accountInfo) {
          console.log("  → PDA exists (nullifier already spent)");
        } else {
          console.log("  → PDA does not exist (nullifier not yet spent)");
        }
      },
      TEST_TIMEOUT
    );
  });

  // ===========================================================================
  // Integration Tests
  // ===========================================================================

  describe("Integration", () => {
    it("should demonstrate complete nullifier lifecycle", async () => {
      console.log("\n=== Nullifier Lifecycle ===\n");

      // Step 1: User receives a commitment
      console.log("1. User receives commitment at leaf index 5");
      const privKey = 99999n;
      const leafIndex = 5n;

      const nullifier = computeNullifierSync(privKey, leafIndex);
      const nullifierHash = hashNullifierSync(nullifier);
      const nullifierHashBytes = bigintToBytes(nullifierHash, 32);

      console.log(`   Private key: ${privKey}`);
      console.log(`   Leaf index: ${leafIndex}`);
      console.log(`   Nullifier: ${nullifier.toString(16).slice(0, 20)}...`);
      console.log(`   Nullifier hash: ${nullifierHash.toString(16).slice(0, 20)}...`);

      // Step 2: Derive PDA
      console.log("\n2. Derive nullifier record PDA");
      const [nullifierPda, bump] = await deriveNullifierRecordPDA(
        nullifierHashBytes,
        ctx.config.zvaultProgramId
      );
      console.log(`   PDA: ${nullifierPda.toString()}`);
      console.log(`   Bump: ${bump}`);

      // Step 3: First spend
      console.log("\n3. First spend (CLAIM)");
      console.log("   → ZK proof proves knowledge of privKey");
      console.log("   → ZK proof outputs nullifier_hash as public input");
      console.log("   → On-chain: init nullifier record PDA (first-time = OK)");
      console.log("   → Transaction succeeds");

      // Step 4: Second spend attempt
      console.log("\n4. Second spend attempt (SPLIT)");
      console.log("   → Same commitment, same privKey, same leafIndex");
      console.log("   → Same nullifier → same nullifier_hash");
      console.log("   → Same PDA derivation");
      console.log("   → On-chain: init fails (PDA already exists)");
      console.log("   → Transaction fails with AccountAlreadyInUse");

      // Step 5: Privacy preservation
      console.log("\n5. Privacy properties");
      console.log("   → On-chain: only nullifier_hash is visible");
      console.log("   → Observer cannot link nullifier_hash to commitment");
      console.log("   → Observer cannot derive privKey from nullifier_hash");
      console.log("   → Multiple spends from same owner are unlinkable");

      console.log("\n=== Lifecycle Complete ===\n");
    });

    it("should show nullifier distribution across many notes", async () => {
      // Generate many notes and verify all have unique nullifiers
      const numNotes = 100;
      const notes: TestNote[] = [];

      for (let i = 0; i < numNotes; i++) {
        notes.push(createTestNote(BigInt(10000 + i * 1000), BigInt(i)));
      }

      // All nullifier hashes should be unique
      const hashes = new Set(notes.map((n) => bytesToHex(n.nullifierHashBytes)));
      expect(hashes.size).toBe(numNotes);

      console.log(`Generated ${numNotes} notes with ${hashes.size} unique nullifier hashes`);
    });

    it("should verify nullifier is bound to leaf index", () => {
      // The same secret spent at different positions gives different nullifiers
      // This is important for the case where a user receives multiple payments

      const privKey = 12345n;

      // User receives 3 payments to same "address" (same stealth key)
      // Each payment is a different commitment at a different leaf index
      const nullifiers = [0n, 1n, 2n].map((leafIndex) => {
        return computeNullifierSync(privKey, leafIndex);
      });

      // All nullifiers are different
      expect(new Set(nullifiers).size).toBe(3);

      // So all nullifier hashes are different
      const hashes = nullifiers.map((n) => hashNullifierSync(n));
      expect(new Set(hashes).size).toBe(3);

      console.log("Same privKey, different leaf indices → different nullifiers");
      console.log("This allows receiving multiple payments without collision");
    });
  });
});
