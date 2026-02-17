/**
 * Integration Tests for Groth16 Proof Generation (Unified Model)
 *
 * Tests real proof generation and verification using compiled circom circuits.
 * These tests require circuit artifacts in ./circuits directory.
 *
 * UNIFIED MODEL:
 * - Commitment = Poseidon(pub_key_x, amount)
 * - Nullifier = Poseidon(priv_key, leaf_index)
 * - Public keys derived in-circuit from private keys via BabyPbk()
 */

import { expect, test, describe, beforeAll } from "bun:test";
import {
  initProver,
  setCircuitPath,
  isProverAvailable,
  generateClaimProof,
  generateSpendSplitProof,
  generateSpendPartialPublicProof,
  verifyProof,
  cleanup,
  circuitExists,
} from "./prover/web";
import { computeUnifiedCommitmentSync, poseidonHashSync, initPoseidon } from "./poseidon";
import { babyJubMul, BABYJUB_BASE8 } from "./crypto";

/**
 * Compute merkle root from commitment using all-zero siblings.
 * This mirrors what the circom circuit does in tests.
 */
function computeMerkleRootFromCommitment(commitment: bigint, depth: number): bigint {
  let current = commitment;
  for (let i = 0; i < depth; i++) {
    current = poseidonHashSync([current, 0n]);
  }
  return current;
}

// Set circuit path and initialize Poseidon for tests
beforeAll(async () => {
  setCircuitPath("./circuits");
  await initPoseidon();
});

// ============================================================================
// 1. PROVER INITIALIZATION
// ============================================================================

describe("PROVER INITIALIZATION", () => {
  test("initProver() loads WASM modules", async () => {
    await initProver();
    // Should complete without throwing
    expect(true).toBe(true);
  });

  test("isProverAvailable() returns true when circuits exist", async () => {
    const available = await isProverAvailable();
    expect(available).toBe(true);
  });

  test("circuitExists() finds compiled circuits", async () => {
    expect(await circuitExists("claim")).toBe(true);
    expect(await circuitExists("spend_split")).toBe(true);
    expect(await circuitExists("spend_partial_public")).toBe(true);
  });
});

// ============================================================================
// 2. CLAIM PROOF GENERATION (Unified Model)
// ============================================================================

describe("CLAIM PROOF (Unified Model)", () => {
  test("generates and verifies claim proof", async () => {
    // Unified model: priv_key → BabyPbk(priv_key) → pub_key_x (derived in-circuit)
    const privKey = 12345n;
    const pubKeyX = babyJubMul(privKey, BABYJUB_BASE8).x;
    const amount = 100000000n; // 1 BTC in satoshis

    // Compute commitment = Poseidon(pub_key_x, amount)
    const commitment = computeUnifiedCommitmentSync(pubKeyX, amount);

    // Compute merkle root using depth-20 tree with all-zero siblings
    const merkleRoot = computeMerkleRootFromCommitment(commitment, 20);

    // Create a 20-level merkle proof (all zeros, index 0 = left child at each level)
    const merkleProof = {
      siblings: Array(20).fill(0n),
      indices: Array(20).fill(0),
    };

    const proof = await generateClaimProof({
      privKey,
      amount,
      leafIndex: 0n,
      merkleRoot,
      merkleProof,
      recipient: 999999n, // Mock recipient
    });

    expect(proof.proof).toBeInstanceOf(Uint8Array);
    expect(proof.proof.length).toBeGreaterThan(0);
    expect(proof.publicInputs).toBeArray();

    // Verify the proof
    const isValid = await verifyProof("claim", proof);
    expect(isValid).toBe(true);
  }, 120000); // 120s timeout for proof generation
});

// ============================================================================
// 3. SPEND SPLIT PROOF GENERATION (Unified Model)
// ============================================================================

describe("SPEND SPLIT PROOF (Unified Model)", () => {
  test("generates and verifies spend split proof (1→2)", async () => {
    // Input commitment (unified model)
    const privKey = 12345n;
    const pubKeyX = babyJubMul(privKey, BABYJUB_BASE8).x;
    const amount = 100000000n;
    const leafIndex = 0n;

    // Output 1: Recipient 1 gets 60%
    const output1PrivKey = 11111n;
    const output1Amount = 60000000n;

    // Output 2: Recipient 2 gets 40%
    const output2PrivKey = 22222n;
    const output2Amount = 40000000n; // 60M + 40M = 100M

    // Compute input commitment and merkle root (depth 20)
    const inputCommitment = computeUnifiedCommitmentSync(pubKeyX, amount);
    const merkleRoot = computeMerkleRootFromCommitment(inputCommitment, 20);

    // 20-level merkle proof (matching circuit)
    const merkleProof = {
      siblings: Array(20).fill(0n),
      indices: Array(20).fill(0),
    };

    const proof = await generateSpendSplitProof({
      privKey,
      amount,
      leafIndex,
      merkleRoot,
      merkleProof,
      output1PrivKey,
      output1Amount,
      output2PrivKey,
      output2Amount,
    });

    expect(proof.proof).toBeInstanceOf(Uint8Array);
    expect(proof.proof.length).toBeGreaterThan(0);

    // Verify
    const isValid = await verifyProof("spend_split", proof);
    expect(isValid).toBe(true);
  }, 120000);

  test("spend split proof fails if amounts don't conserve", async () => {
    const merkleProof = {
      siblings: Array(20).fill(0n),
      indices: Array(20).fill(0),
    };

    await expect(
      generateSpendSplitProof({
        privKey: 12345n,
        amount: 100000000n,
        leafIndex: 0n,
        merkleRoot: 0n,
        merkleProof,
        output1PrivKey: 11111n,
        output1Amount: 60000000n,
        output2PrivKey: 22222n,
        output2Amount: 50000000n, // 60M + 50M = 110M ≠ 100M
      })
    ).rejects.toThrow("Spend split must conserve amount");
  });
});

// ============================================================================
// 4. SPEND PARTIAL PUBLIC PROOF GENERATION (Unified Model)
// ============================================================================

describe("SPEND PARTIAL PUBLIC PROOF (Unified Model)", () => {
  test("generates and verifies spend partial public proof", async () => {
    // Input commitment
    const privKey = 12345n;
    const pubKeyX = babyJubMul(privKey, BABYJUB_BASE8).x;
    const amount = 100000000n;
    const leafIndex = 0n;

    // Public claim: 60M to public wallet
    const publicAmount = 60000000n;
    const recipient = 999999n; // Mock Solana wallet

    // Change: 40M back to self
    const changePrivKey = 11111n;
    const changeAmount = 40000000n;

    // Compute input commitment and merkle root
    const inputCommitment = computeUnifiedCommitmentSync(pubKeyX, amount);
    const merkleRoot = computeMerkleRootFromCommitment(inputCommitment, 20);

    const merkleProof = {
      siblings: Array(20).fill(0n),
      indices: Array(20).fill(0),
    };

    const proof = await generateSpendPartialPublicProof({
      privKey,
      amount,
      leafIndex,
      merkleRoot,
      merkleProof,
      publicAmount,
      changePrivKey,
      changeAmount,
      recipient,
    });

    expect(proof.proof).toBeInstanceOf(Uint8Array);
    expect(proof.proof.length).toBeGreaterThan(0);

    // Verify
    const isValid = await verifyProof("spend_partial_public", proof);
    expect(isValid).toBe(true);
  }, 120000);

  test("spend partial public proof fails if amounts don't conserve", async () => {
    const merkleProof = {
      siblings: Array(20).fill(0n),
      indices: Array(20).fill(0),
    };

    await expect(
      generateSpendPartialPublicProof({
        privKey: 12345n,
        amount: 100000000n,
        leafIndex: 0n,
        merkleRoot: 0n,
        merkleProof,
        publicAmount: 70000000n,
        changePrivKey: 11111n,
        changeAmount: 40000000n, // 70M + 40M = 110M ≠ 100M
        recipient: 999999n,
      })
    ).rejects.toThrow("Spend partial public must conserve amount");
  });
});

// ============================================================================
// 5. PROOF SERIALIZATION
// ============================================================================

describe("PROOF SERIALIZATION", () => {
  test("proof bytes are consistent", async () => {
    const privKey = 12345n;
    const pubKeyX = babyJubMul(privKey, BABYJUB_BASE8).x;
    const amount = 100000000n;

    const commitment = computeUnifiedCommitmentSync(pubKeyX, amount);
    const merkleRoot = computeMerkleRootFromCommitment(commitment, 20);

    const merkleProof = {
      siblings: Array(20).fill(0n),
      indices: Array(20).fill(0),
    };

    const proof = await generateClaimProof({
      privKey,
      amount,
      leafIndex: 0n,
      merkleRoot,
      merkleProof,
      recipient: 999999n,
    });

    // Proof should be consistent format
    expect(proof.proof[0]).toBeDefined();
    expect(proof.publicInputs.length).toBeGreaterThan(0);

    // Public inputs should be field elements as strings
    for (const pi of proof.publicInputs) {
      expect(typeof pi).toBe("string");
      expect(BigInt(pi)).toBeGreaterThanOrEqual(0n);
    }
  }, 120000);
});

// ============================================================================
// 6. CLEANUP
// ============================================================================

describe("CLEANUP", () => {
  test("cleanup() releases resources", async () => {
    await cleanup();
    // Should complete without throwing
    expect(true).toBe(true);
  });
});
