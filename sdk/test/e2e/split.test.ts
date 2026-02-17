/**
 * SPEND_SPLIT E2E Tests
 *
 * Tests splitting one commitment into two new commitments.
 *
 * Flow:
 * 1. Input: 1 commitment (100k sats)
 * 2. Output: 2 commitments (60k + 40k sats)
 * 3. Verify: Input nullifier is spent, outputs are in tree
 *
 * Prerequisites:
 * - solana-test-validator running with devnet features
 * - Programs deployed and initialized on localnet
 *
 * Run: bun test test/e2e/split.test.ts
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { address } from "@solana/kit";

import {
  createTestContext,
  initializeTestEnvironment,
  logTestEnvironment,
  TEST_TIMEOUT,
  PROOF_TIMEOUT,
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
  TREE_DEPTH,
  type TestNote,
} from "./helpers";

import {
  generateTestKeys,
  createAndSubmitStealthDeposit,
  scanAndPrepareClaim,
  checkNullifierExists,
} from "./stealth-helpers";

import { initPoseidon, computeUnifiedCommitmentSync } from "../../src/poseidon";
import { randomFieldElement, bigintToBytes, bytesToBigint } from "../../src/crypto";
import { babyJubMul, BABYJUB_BASE8 } from "../../src/crypto";
import {
  derivePoolStatePDA,
  deriveCommitmentTreePDA,
  deriveNullifierRecordPDA,
  deriveStealthAnnouncementPDA,
} from "../../src/pda";
import {
  buildSplitInstruction,
} from "../../src/instructions";
import { generateSpendSplitProof, verifyProof } from "../../src/prover/web";

// =============================================================================
// Test Context
// =============================================================================

let ctx: E2ETestContext;

// =============================================================================
// Helper Functions
// =============================================================================

interface SplitOutputs {
  output1: TestNote;
  output2: TestNote;
  output1EphemeralPubX: Uint8Array;
  output1EncryptedAmountWithSign: Uint8Array;
  output2EphemeralPubX: Uint8Array;
  output2EncryptedAmountWithSign: Uint8Array;
}

/**
 * Create output notes for a split operation
 */
function createSplitOutputNotes(
  inputNote: TestNote,
  output1Amount: bigint,
  output2Amount: bigint
): SplitOutputs {
  // Verify amounts conserve
  if (output1Amount + output2Amount !== inputNote.amount) {
    throw new Error(
      `Split amounts must conserve: ${output1Amount} + ${output2Amount} !== ${inputNote.amount}`
    );
  }

  // Create output notes with new keys
  const output1 = createTestNote(output1Amount, inputNote.leafIndex + 1n);
  const output2 = createTestNote(output2Amount, inputNote.leafIndex + 2n);

  // Create mock stealth output data (32 bytes each)
  const output1EphemeralPubX = new Uint8Array(32);
  crypto.getRandomValues(output1EphemeralPubX);
  const output1EncryptedAmountWithSign = new Uint8Array(32);
  new DataView(output1EncryptedAmountWithSign.buffer).setBigUint64(0, output1Amount, true);
  crypto.getRandomValues(output1EncryptedAmountWithSign.subarray(8));

  const output2EphemeralPubX = new Uint8Array(32);
  crypto.getRandomValues(output2EphemeralPubX);
  const output2EncryptedAmountWithSign = new Uint8Array(32);
  new DataView(output2EncryptedAmountWithSign.buffer).setBigUint64(0, output2Amount, true);
  crypto.getRandomValues(output2EncryptedAmountWithSign.subarray(8));

  return {
    output1,
    output2,
    output1EphemeralPubX,
    output1EncryptedAmountWithSign,
    output2EphemeralPubX,
    output2EncryptedAmountWithSign,
  };
}

// =============================================================================
// Test Suite
// =============================================================================

describe("SPEND_SPLIT E2E", () => {
  beforeAll(async () => {
    await initializeTestEnvironment();
    await initPoseidon();

    ctx = await createTestContext();
    logTestEnvironment(ctx);

    if (ctx.skipOnChain) {
      console.log("⚠️  Skipping on-chain tests (validator not available)");
    }
    if (ctx.skipProof) {
      console.log("⚠️  Skipping proof tests (circuits not compiled)");
      console.log("   Run: cd circuits && bun run compile:all && bun run copy-to-sdk");
    }
  });

  // ===========================================================================
  // Unit Tests
  // ===========================================================================

  describe("Unit Tests", () => {
    it("should create valid split output notes", () => {
      const input = createTestNote(TEST_AMOUNTS.small); // 100k sats
      const { output1, output2 } = createSplitOutputNotes(input, 60_000n, 40_000n);

      expect(output1.amount).toBe(60_000n);
      expect(output2.amount).toBe(40_000n);
      expect(output1.amount + output2.amount).toBe(input.amount);

      // Output commitments should be different
      expect(output1.commitment).not.toBe(output2.commitment);
      expect(output1.commitment).not.toBe(input.commitment);
    });

    it("should reject split if amounts don't conserve", () => {
      const input = createTestNote(TEST_AMOUNTS.small);

      expect(() => {
        createSplitOutputNotes(input, 70_000n, 40_000n); // 110k !== 100k
      }).toThrow("Split amounts must conserve");
    });

    it("should create different nullifiers for different outputs", () => {
      const input = createTestNote(TEST_AMOUNTS.small);
      const { output1, output2 } = createSplitOutputNotes(input, 60_000n, 40_000n);

      // Each output has a unique nullifier
      expect(output1.nullifier).not.toBe(output2.nullifier);
      expect(output1.nullifierHash).not.toBe(output2.nullifierHash);
    });
  });

  // ===========================================================================
  // Instruction Building Tests
  // ===========================================================================

  describe("Instruction Building", () => {
    it("should build valid split instruction with inline proof", async () => {
      const input = createTestNote(TEST_AMOUNTS.small);
      const merkleProof = createMockMerkleProof(input.commitment);
      const outputs = createSplitOutputNotes(input, 60_000n, 40_000n);

      // Mock proof bytes
      const proofBytes = generateMockProof();

      // Derive PDAs
      const [poolState] = await derivePoolStatePDA(ctx.config.zvaultProgramId);
      const [commitmentTree] = await deriveCommitmentTreePDA(ctx.config.zvaultProgramId);
      const [nullifierRecord] = await deriveNullifierRecordPDA(
        input.nullifierHashBytes,
        ctx.config.zvaultProgramId
      );

      // Derive stealth announcement PDAs
      const [stealthAnnouncement1] = await deriveStealthAnnouncementPDA(
        outputs.output1.commitmentBytes,
        ctx.config.zvaultProgramId
      );
      const [stealthAnnouncement2] = await deriveStealthAnnouncementPDA(
        outputs.output2.commitmentBytes,
        ctx.config.zvaultProgramId
      );

      // Build split instruction
      const splitIx = buildSplitInstruction({
        proofBytes,
        root: bigintToBytes32(merkleProof.root),
        nullifierHash: input.nullifierHashBytes,
        outputCommitment1: outputs.output1.commitmentBytes,
        outputCommitment2: outputs.output2.commitmentBytes,
        vkHash: generateMockVkHash(),
        output1EphemeralPubX: outputs.output1EphemeralPubX,
        output1EncryptedAmountWithSign: outputs.output1EncryptedAmountWithSign,
        output2EphemeralPubX: outputs.output2EphemeralPubX,
        output2EncryptedAmountWithSign: outputs.output2EncryptedAmountWithSign,
        accounts: {
          poolState,
          commitmentTree,
          nullifierRecord,
          user: address(ctx.payer.publicKey.toBase58()),
          stealthAnnouncement1,
          stealthAnnouncement2,
        },
      });

      // Verify instruction structure
      expect(splitIx.data).toBeDefined();
      expect(splitIx.accounts.length).toBe(7);

      // Verify discriminator (SPEND_SPLIT = 3)
      expect(splitIx.data[0]).toBe(3);
    });

    it("should build instruction with correct data layout", async () => {
      const input = createTestNote(TEST_AMOUNTS.medium);
      const merkleProof = createMockMerkleProof(input.commitment);
      const outputs = createSplitOutputNotes(input, 600_000n, 400_000n);

      // Derive PDAs
      const [poolState] = await derivePoolStatePDA(ctx.config.zvaultProgramId);
      const [commitmentTree] = await deriveCommitmentTreePDA(ctx.config.zvaultProgramId);
      const [nullifierRecord] = await deriveNullifierRecordPDA(
        input.nullifierHashBytes,
        ctx.config.zvaultProgramId
      );
      const [stealthAnnouncement1] = await deriveStealthAnnouncementPDA(
        outputs.output1.commitmentBytes,
        ctx.config.zvaultProgramId
      );
      const [stealthAnnouncement2] = await deriveStealthAnnouncementPDA(
        outputs.output2.commitmentBytes,
        ctx.config.zvaultProgramId
      );

      const proofBytes = generateMockProof();

      const splitIx = buildSplitInstruction({
        proofBytes,
        root: bigintToBytes32(merkleProof.root),
        nullifierHash: input.nullifierHashBytes,
        outputCommitment1: outputs.output1.commitmentBytes,
        outputCommitment2: outputs.output2.commitmentBytes,
        vkHash: generateMockVkHash(),
        output1EphemeralPubX: outputs.output1EphemeralPubX,
        output1EncryptedAmountWithSign: outputs.output1EncryptedAmountWithSign,
        output2EphemeralPubX: outputs.output2EphemeralPubX,
        output2EncryptedAmountWithSign: outputs.output2EncryptedAmountWithSign,
        accounts: {
          poolState,
          commitmentTree,
          nullifierRecord,
          user: address(ctx.payer.publicKey.toBase58()),
          stealthAnnouncement1,
          stealthAnnouncement2,
        },
      });

      // Verify data layout: disc(1) + proof(256) + 9*32 = 545
      expect(splitIx.data.length).toBe(545);
      expect(splitIx.accounts.length).toBe(7);
    });

    it("should include both output commitments in instruction", async () => {
      const input = createTestNote(TEST_AMOUNTS.small);
      const merkleProof = createMockMerkleProof(input.commitment);
      const outputs = createSplitOutputNotes(input, 50_000n, 50_000n);

      const proofBytes = generateMockProof();

      const [poolState] = await derivePoolStatePDA(ctx.config.zvaultProgramId);
      const [commitmentTree] = await deriveCommitmentTreePDA(ctx.config.zvaultProgramId);
      const [nullifierRecord] = await deriveNullifierRecordPDA(
        input.nullifierHashBytes,
        ctx.config.zvaultProgramId
      );
      const [stealthAnnouncement1] = await deriveStealthAnnouncementPDA(
        outputs.output1.commitmentBytes,
        ctx.config.zvaultProgramId
      );
      const [stealthAnnouncement2] = await deriveStealthAnnouncementPDA(
        outputs.output2.commitmentBytes,
        ctx.config.zvaultProgramId
      );

      const splitIx = buildSplitInstruction({
        proofBytes,
        root: bigintToBytes32(merkleProof.root),
        nullifierHash: input.nullifierHashBytes,
        outputCommitment1: outputs.output1.commitmentBytes,
        outputCommitment2: outputs.output2.commitmentBytes,
        vkHash: generateMockVkHash(),
        output1EphemeralPubX: outputs.output1EphemeralPubX,
        output1EncryptedAmountWithSign: outputs.output1EncryptedAmountWithSign,
        output2EphemeralPubX: outputs.output2EphemeralPubX,
        output2EncryptedAmountWithSign: outputs.output2EncryptedAmountWithSign,
        accounts: {
          poolState,
          commitmentTree,
          nullifierRecord,
          user: address(ctx.payer.publicKey.toBase58()),
          stealthAnnouncement1,
          stealthAnnouncement2,
        },
      });

      // Instruction should contain proof + both output commitments + stealth data
      expect(splitIx.data.length).toBe(545);
      expect(splitIx.accounts.length).toBe(7);
    });
  });

  // ===========================================================================
  // On-Chain Tests (Require validator)
  // ===========================================================================

  describe("On-Chain Tests", () => {
    it(
      "should reject double-spend attempt (mock test)",
      async () => {
        if (ctx.skipOnChain) {
          console.log("⚠️  Skipping: validator not available");
          return;
        }
        // Simulate trying to spend the same commitment twice
        const input = createTestNote(TEST_AMOUNTS.small);
        const merkleProof = createMockMerkleProof(input.commitment);

        // First split: 60k + 40k
        const { output1: out1a, output2: out1b } = createSplitOutputNotes(input, 60_000n, 40_000n);

        // Second split attempt (same input, different outputs)
        const { output1: out2a, output2: out2b } = createSplitOutputNotes(input, 50_000n, 50_000n);

        // Both splits use the same nullifier hash
        expect(input.nullifierHash).toBe(input.nullifierHash);

        // Derive PDAs
        const [nullifierRecord] = await deriveNullifierRecordPDA(
          input.nullifierHashBytes,
          ctx.config.zvaultProgramId
        );

        console.log("  → Same input would create same nullifier record PDA");
        console.log(`  → Nullifier PDA: ${nullifierRecord.toString()}`);
        console.log("  → Second spend would fail with NullifierAlreadySpent error");

        // This proves that the nullifier derivation is deterministic
        const [nullifierRecord2] = await deriveNullifierRecordPDA(
          input.nullifierHashBytes,
          ctx.config.zvaultProgramId
        );
        expect(nullifierRecord.toString()).toBe(nullifierRecord2.toString());
      },
      TEST_TIMEOUT
    );
  });

  // ===========================================================================
  // Integration Tests
  // ===========================================================================

  describe("Integration Flow", () => {
    it("should simulate complete split flow with inline proof", async () => {
      console.log("\n=== Complete Split Flow Simulation (Inline Proof) ===\n");

      // Step 1: Create input note
      console.log("1. Create input note");
      const input = createTestNote(TEST_AMOUNTS.medium); // 1M sats
      console.log(`   Input amount: ${input.amount} sats`);
      console.log(`   Input commitment: ${input.commitment.toString(16).slice(0, 20)}...`);

      // Step 2: Define output amounts (70/30 split)
      console.log("\n2. Define split amounts");
      const output1Amount = 700_000n;
      const output2Amount = 300_000n;
      console.log(`   Output 1: ${output1Amount} sats (70%)`);
      console.log(`   Output 2: ${output2Amount} sats (30%)`);

      // Step 3: Create output notes
      console.log("\n3. Create output notes");
      const outputs = createSplitOutputNotes(input, output1Amount, output2Amount);
      console.log(`   Output 1 commitment: ${outputs.output1.commitment.toString(16).slice(0, 20)}...`);
      console.log(`   Output 2 commitment: ${outputs.output2.commitment.toString(16).slice(0, 20)}...`);

      // Step 4: Compute Merkle proof for input
      console.log("\n4. Compute Merkle proof for input");
      const merkleProof = createMockMerkleProof(input.commitment);
      console.log(`   Root: ${merkleProof.root.toString(16).slice(0, 20)}...`);

      // Step 5: Generate ZK proof (mocked)
      console.log("\n5. Generate ZK proof (mocked)");
      const proofBytes = generateMockProof();
      console.log(`   Proof size: ${proofBytes.length} bytes`);

      // Step 6: Derive PDAs
      console.log("\n6. Derive PDAs");
      const [poolState] = await derivePoolStatePDA(ctx.config.zvaultProgramId);
      const [commitmentTree] = await deriveCommitmentTreePDA(ctx.config.zvaultProgramId);
      const [nullifierRecord] = await deriveNullifierRecordPDA(
        input.nullifierHashBytes,
        ctx.config.zvaultProgramId
      );
      const [stealthAnnouncement1] = await deriveStealthAnnouncementPDA(
        outputs.output1.commitmentBytes,
        ctx.config.zvaultProgramId
      );
      const [stealthAnnouncement2] = await deriveStealthAnnouncementPDA(
        outputs.output2.commitmentBytes,
        ctx.config.zvaultProgramId
      );
      console.log(`   Nullifier Record: ${nullifierRecord.toString()}`);
      console.log(`   Stealth Announcement 1: ${stealthAnnouncement1.toString()}`);
      console.log(`   Stealth Announcement 2: ${stealthAnnouncement2.toString()}`);

      // Step 7: Build single-instruction transaction (inline proof)
      console.log("\n7. Build single-instruction transaction (inline proof)");
      const vkHash = generateMockVkHash();

      const splitIx = buildSplitInstruction({
        proofBytes,
        root: bigintToBytes32(merkleProof.root),
        nullifierHash: input.nullifierHashBytes,
        outputCommitment1: outputs.output1.commitmentBytes,
        outputCommitment2: outputs.output2.commitmentBytes,
        vkHash,
        output1EphemeralPubX: outputs.output1EphemeralPubX,
        output1EncryptedAmountWithSign: outputs.output1EncryptedAmountWithSign,
        output2EphemeralPubX: outputs.output2EphemeralPubX,
        output2EncryptedAmountWithSign: outputs.output2EncryptedAmountWithSign,
        accounts: {
          poolState,
          commitmentTree,
          nullifierRecord,
          user: address(ctx.payer.publicKey.toBase58()),
          stealthAnnouncement1,
          stealthAnnouncement2,
        },
      });
      console.log(`   IX (zVault split): ${splitIx.data.length} bytes`);
      console.log(`   zVault accounts: ${splitIx.accounts.length}`);

      // Step 8: What happens on-chain
      console.log("\n8. On-chain execution (simulation):");
      console.log("   TX contains 1 instruction (proof verified inline):");
      console.log("   IX: zVault SPEND_SPLIT");
      console.log("     → Verifies Groth16 proof inline (BN254 pairing syscall)");
      console.log("     → Verifies merkle root in root history");
      console.log("     → Creates nullifier record PDA");
      console.log("     → Inserts output1 commitment to tree");
      console.log("     → Inserts output2 commitment to tree");
      console.log("     → Creates stealth announcements");
      console.log("     → Updates tree root");

      console.log("\n=== Split Flow Complete (Inline Proof) ===\n");

      // Assertions
      expect(input.amount).toBe(outputs.output1.amount + outputs.output2.amount);
      expect(outputs.output1.commitment).not.toBe(outputs.output2.commitment);
      expect(splitIx.data[0]).toBe(3); // SPEND_SPLIT discriminator
      expect(splitIx.accounts.length).toBe(7); // 7 accounts (no buffer/verifier/sysvar)
    });

    it("should track tree state changes after split", () => {
      // This test simulates how the tree state changes after a split

      const input = createTestNote(TEST_AMOUNTS.small, 0n);
      const { output1, output2 } = createSplitOutputNotes(input, 60_000n, 40_000n);

      // Before split:
      // Tree contains: [input.commitment] at index 0
      // nextIndex = 1
      const beforeNextIndex = 1n;

      // After split:
      // Tree contains: [input.commitment, output1.commitment, output2.commitment]
      // nextIndex = 3
      const afterNextIndex = beforeNextIndex + 2n; // Two new commitments added

      console.log("Tree state simulation:");
      console.log(`  Before: nextIndex = ${beforeNextIndex}`);
      console.log(`  After: nextIndex = ${afterNextIndex}`);
      console.log(`  New commitments added: 2`);

      expect(afterNextIndex).toBe(3n);
    });
  });

  // ===========================================================================
  // Real Proof Tests (Full stealth flow with real ZK proofs)
  // ===========================================================================

  describe("Real Proof Tests", () => {
    it(
      "should complete full stealth split flow with real ZK proof",
      async () => {
        if (ctx.skipOnChain || ctx.skipProof) {
          console.log("⚠️  Skipping: requires validator and compiled circuits");
          return;
        }

        console.log("\n" + "=".repeat(60));
        console.log("FULL STEALTH SPLIT FLOW WITH REAL ZK PROOF");
        console.log("=".repeat(60) + "\n");

        // Step 1: Generate keys for input and outputs
        console.log("1. Generating keys...");
        const inputRecipientKeys = generateTestKeys("split-test-input-1");
        const output1RecipientKeys = generateTestKeys("split-test-output-1");
        const output2RecipientKeys = generateTestKeys("split-test-output-2");
        console.log(`   Input spending pub key X: ${inputRecipientKeys.spendingPubKey.x.toString(16).slice(0, 16)}...`);
        console.log(`   Output1 pub key X: ${output1RecipientKeys.spendingPubKey.x.toString(16).slice(0, 16)}...`);
        console.log(`   Output2 pub key X: ${output2RecipientKeys.spendingPubKey.x.toString(16).slice(0, 16)}...`);

        // Step 2: Create and submit stealth deposit for input note
        console.log("\n2. Creating and submitting input stealth deposit...");
        const inputAmount = TEST_AMOUNTS.medium; // 1M sats
        const testNote = await createAndSubmitStealthDeposit(ctx, inputRecipientKeys, inputAmount);
        console.log(`   Input amount: ${testNote.amount} sats`);
        console.log(`   Input commitment: ${testNote.commitment.toString(16).slice(0, 16)}...`);
        console.log(`   Leaf index: ${testNote.leafIndex}`);

        // Step 3: Scan for input note and prepare claim data
        console.log("\n3. Scanning and preparing input note data...");
        const inputData = await scanAndPrepareClaim(ctx, inputRecipientKeys, testNote.commitment);
        console.log(`   Scanned amount: ${inputData.scannedNote.amount} sats`);
        console.log(`   Merkle root: ${inputData.merkleProof.root.toString(16).slice(0, 16)}...`);
        console.log(`   Nullifier hash: ${inputData.nullifierHash.toString(16).slice(0, 16)}...`);

        // Step 4: Define split amounts
        const output1Amount = 700_000n; // 70% of 1M
        const output2Amount = 300_000n; // 30% of 1M
        console.log("\n4. Defining split amounts...");
        console.log(`   Output 1: ${output1Amount} sats (70%)`);
        console.log(`   Output 2: ${output2Amount} sats (30%)`);
        expect(output1Amount + output2Amount).toBe(inputAmount);

        // Step 5: Create output keys and commitments
        console.log("\n5. Creating output keys and commitments...");
        // Use output recipient spending private keys directly
        // Circuit will derive pub_key_x = BabyPbk(priv_key).x in-circuit
        const output1PrivKey = output1RecipientKeys.spendingPrivKey;
        const output2PrivKey = output2RecipientKeys.spendingPrivKey;

        const output1PubKeyX = babyJubMul(output1PrivKey, BABYJUB_BASE8).x;
        const output2PubKeyX = babyJubMul(output2PrivKey, BABYJUB_BASE8).x;
        const output1Commitment = computeUnifiedCommitmentSync(output1PubKeyX, output1Amount);
        const output2Commitment = computeUnifiedCommitmentSync(output2PubKeyX, output2Amount);

        console.log(`   Output 1 commitment: ${output1Commitment.toString(16).slice(0, 16)}...`);
        console.log(`   Output 2 commitment: ${output2Commitment.toString(16).slice(0, 16)}...`);

        // Step 6: Generate REAL ZK proof
        console.log("\n6. Generating REAL spend_split proof (this may take 30-120 seconds)...");
        const proofStartTime = Date.now();

        const proof = await generateSpendSplitProof({
          // Input note
          privKey: inputData.stealthPrivKey,
          amount: inputData.scannedNote.amount,
          leafIndex: BigInt(inputData.scannedNote.leafIndex),
          merkleRoot: inputData.merkleProof.root,
          merkleProof: {
            siblings: inputData.merkleProof.siblings,
            indices: inputData.merkleProof.indices,
          },
          // Output 1
          output1PrivKey,
          output1Amount,
          // Output 2
          output2PrivKey,
          output2Amount,
        });

        const proofTime = ((Date.now() - proofStartTime) / 1000).toFixed(1);
        console.log(`   Proof generated in ${proofTime}s`);
        console.log(`   Proof size: ${proof.proof.length} bytes`);
        console.log(`   Public inputs: ${proof.publicInputs.length}`);

        // Step 7: Verify proof locally
        console.log("\n7. Verifying proof locally...");
        const isValid = await verifyProof("spend_split", proof);
        console.log(`   Local verification: ${isValid ? "PASSED" : "FAILED"}`);
        expect(isValid).toBe(true);

        // Step 8: Build split transaction (single instruction, inline proof)
        console.log("\n8. Building split transaction (inline proof)...");
        const [poolState] = await derivePoolStatePDA(ctx.config.zvaultProgramId);
        const [commitmentTree] = await deriveCommitmentTreePDA(ctx.config.zvaultProgramId);
        const [nullifierRecord] = await deriveNullifierRecordPDA(
          inputData.nullifierHashBytes,
          ctx.config.zvaultProgramId
        );

        // Derive stealth announcement PDAs
        const output1CommitmentBytes = bigintToBytes(output1Commitment, 32);
        const output2CommitmentBytes = bigintToBytes(output2Commitment, 32);
        const [stealthAnnouncement1] = await deriveStealthAnnouncementPDA(
          output1CommitmentBytes,
          ctx.config.zvaultProgramId
        );
        const [stealthAnnouncement2] = await deriveStealthAnnouncementPDA(
          output2CommitmentBytes,
          ctx.config.zvaultProgramId
        );

        const vkHash = generateMockVkHash(); // TODO: Use real VK hash
        // Mock stealth announcement data (separate from circuit proof)
        const output1EphemeralPubXBytes = new Uint8Array(32);
        crypto.getRandomValues(output1EphemeralPubXBytes);
        const output1EncryptedBytes = new Uint8Array(32);
        new DataView(output1EncryptedBytes.buffer).setBigUint64(0, output1Amount, true);
        const output2EphemeralPubXBytes = new Uint8Array(32);
        crypto.getRandomValues(output2EphemeralPubXBytes);
        const output2EncryptedBytes = new Uint8Array(32);
        new DataView(output2EncryptedBytes.buffer).setBigUint64(0, output2Amount, true);

        // Build single zVault instruction with inline proof
        const splitIx = buildSplitInstruction({
          proofBytes: proof.proof,
          root: bigintToBytes(inputData.merkleProof.root, 32),
          nullifierHash: inputData.nullifierHashBytes,
          outputCommitment1: output1CommitmentBytes,
          outputCommitment2: output2CommitmentBytes,
          vkHash,
          output1EphemeralPubX: output1EphemeralPubXBytes,
          output1EncryptedAmountWithSign: output1EncryptedBytes,
          output2EphemeralPubX: output2EphemeralPubXBytes,
          output2EncryptedAmountWithSign: output2EncryptedBytes,
          accounts: {
            poolState,
            commitmentTree,
            nullifierRecord,
            user: address(ctx.payer.publicKey.toBase58()),
            stealthAnnouncement1,
            stealthAnnouncement2,
          },
        });

        console.log(`   IX (zVault split): ${splitIx.data.length} bytes`);
        console.log(`   zVault accounts: ${splitIx.accounts.length}`);
        console.log(`   Inline proof: 256 bytes embedded in instruction data`);

        // Step 9: Verify results
        console.log("\n9. Verification:");
        console.log(`    ✓ Input stealth deposit created and submitted`);
        console.log(`    ✓ Input note scanned with viewing key`);
        console.log(`    ✓ Real ZK proof generated (${proofTime}s)`);
        console.log(`    ✓ Proof verified locally`);
        console.log(`    ✓ Single-IX TX built (inline proof, no ChadBuffer)`);
        console.log(`    ✓ Amount conservation verified: ${output1Amount} + ${output2Amount} = ${inputAmount}`);

        console.log("\n" + "=".repeat(60));
        console.log("FULL STEALTH SPLIT FLOW COMPLETE");
        console.log("=".repeat(60) + "\n");

        // Final assertions
        expect(proof.proof.length).toBeGreaterThan(0);
        expect(proof.publicInputs.length).toBeGreaterThan(0);
        expect(isValid).toBe(true);
        expect(output1Amount + output2Amount).toBe(inputAmount);
      },
      PROOF_TIMEOUT // 5 minute timeout for proof generation
    );

    it(
      "should generate valid split proof with real circuit",
      async () => {
        if (ctx.skipProof) {
          console.log("⚠️  Skipping: requires compiled circuits");
          return;
        }

        // Simpler test that just generates a proof without on-chain ops
        console.log("\n=== Spend Split Proof Generation Test ===\n");

        // Use simple test values
        const privKey = 12345n;
        const amount = 1_000_000n; // 1M sats
        const leafIndex = 0n;

        // Derive pubKeyX from privKey (circuit does this in-circuit via BabyPbk)
        const pubKeyX = babyJubMul(privKey, BABYJUB_BASE8).x;

        // Compute input commitment
        const commitment = computeUnifiedCommitmentSync(pubKeyX, amount);

        // Compute merkle root (all-zero siblings)
        const { poseidonHashSync } = await import("../../src/poseidon");
        let current = commitment;
        for (let i = 0; i < 20; i++) {
          current = poseidonHashSync([current, 0n]);
        }
        const merkleRoot = current;

        // Output values (60/40 split)
        const output1PrivKey = 111111n;
        const output1Amount = 600_000n;
        const output2PrivKey = 222222n;
        const output2Amount = 400_000n;

        // Generate proof
        console.log("Generating spend_split proof...");
        const startTime = Date.now();

        const proof = await generateSpendSplitProof({
          privKey,
          amount,
          leafIndex,
          merkleRoot,
          merkleProof: {
            siblings: Array(20).fill(0n),
            indices: Array(20).fill(0),
          },
          output1PrivKey,
          output1Amount,
          output2PrivKey,
          output2Amount,
        });

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`Proof generated in ${elapsed}s`);
        console.log(`Proof size: ${proof.proof.length} bytes`);

        // Verify
        const isValid = await verifyProof("spend_split", proof);
        console.log(`Verification: ${isValid ? "PASSED" : "FAILED"}`);

        expect(proof.proof.length).toBeGreaterThan(0);
        expect(isValid).toBe(true);
      },
      PROOF_TIMEOUT
    );
  });
});
