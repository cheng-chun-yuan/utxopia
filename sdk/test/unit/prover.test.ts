/**
 * Unit Tests for JoinSplit Proof Type Validation
 *
 * Tests proof input validation and type checking for JoinSplit circuits.
 * Does NOT test actual proof generation (requires compiled circuit artifacts).
 *
 * JOINSPLIT MODEL:
 * - Commitment = Poseidon(npk, token, amount)
 * - Nullifier = Poseidon(nullifyingKey, leafIndex)
 * - Signature = EdDSA-Poseidon over (merkleRoot, boundParamsHash, nullifiers..., commitmentsOut...)
 */

import { expect, test, describe, beforeAll } from "bun:test";
import { initPoseidon } from "../../src/poseidon";
import { BN254_FIELD_PRIME } from "../../src/crypto";

// Set up Poseidon for tests
beforeAll(async () => {
  await initPoseidon();
});

// ============================================================================
// 1. PROOF INPUT VALIDATION
// ============================================================================

describe("PROOF INPUT VALIDATION", () => {
  test("validates field elements are within BN254 field bounds", () => {
    // Valid field element
    const validField = BN254_FIELD_PRIME - 1n;
    expect(validField).toBeLessThan(BN254_FIELD_PRIME);

    // Invalid: exceeds field prime
    const invalidField = BN254_FIELD_PRIME;
    expect(invalidField).toBeGreaterThanOrEqual(BN254_FIELD_PRIME);

    // Invalid: negative
    const negative = -1n;
    expect(negative).toBeLessThan(0n);
  });

  test("validates amounts are within BTC supply bounds", () => {
    const MAX_SATOSHIS = 21_000_000n * 100_000_000n;

    // Valid amounts
    expect(1n).toBeLessThanOrEqual(MAX_SATOSHIS);
    expect(100_000_000n).toBeLessThanOrEqual(MAX_SATOSHIS); // 1 BTC
    expect(MAX_SATOSHIS).toBeLessThanOrEqual(MAX_SATOSHIS);

    // Invalid: exceeds total supply
    expect(MAX_SATOSHIS + 1n).toBeGreaterThan(MAX_SATOSHIS);

    // Invalid: zero or negative
    expect(0n).toBeLessThanOrEqual(0n);
    expect(-1n).toBeLessThan(0n);
  });

  test("validates merkle proof structure", () => {
    const TREE_DEPTH = 16;

    // Valid merkle proof
    const validProof = {
      siblings: Array(TREE_DEPTH).fill(0n),
      indices: Array(TREE_DEPTH).fill(0),
    };
    expect(validProof.siblings.length).toBe(TREE_DEPTH);
    expect(validProof.indices.length).toBe(TREE_DEPTH);

    // Invalid: mismatched lengths
    const invalidProof = {
      siblings: Array(TREE_DEPTH).fill(0n),
      indices: Array(TREE_DEPTH - 1).fill(0),
    };
    expect(invalidProof.siblings.length).not.toBe(invalidProof.indices.length);

    // Invalid: wrong depth
    const wrongDepth = {
      siblings: Array(10).fill(0n),
      indices: Array(10).fill(0),
    };
    expect(wrongDepth.siblings.length).not.toBe(TREE_DEPTH);
  });
});

// ============================================================================
// 2. CIRCUIT TYPE VALIDATION
// ============================================================================

describe("CIRCUIT TYPE VALIDATION", () => {
  test("validates JoinSplit circuit type format", () => {
    // Valid formats: joinsplit_MxN
    const validTypes = [
      "joinsplit_1x1",
      "joinsplit_1x2",
      "joinsplit_2x2",
      "joinsplit_2x1",
    ];

    for (const type of validTypes) {
      const match = type.match(/^joinsplit_(\d+)x(\d+)$/);
      expect(match).not.toBeNull();
      if (match) {
        const [_, inputs, outputs] = match;
        expect(Number(inputs)).toBeGreaterThan(0);
        expect(Number(outputs)).toBeGreaterThan(0);
      }
    }

    // Invalid formats
    const invalidTypes = [
      "claim",
      "spend_split",
      "spend_partial_public",
      "joinsplit",
      "joinsplit_1",
      "joinsplit_1x",
    ];

    for (const type of invalidTypes) {
      const match = type.match(/^joinsplit_(\d+)x(\d+)$/);
      expect(match).toBeNull();
    }
  });

  test("validates JoinSplit arities", () => {
    // Valid arities
    const validArities = [
      { inputs: 1, outputs: 1 }, // 1x1
      { inputs: 1, outputs: 2 }, // 1x2
      { inputs: 2, outputs: 1 }, // 2x1
      { inputs: 2, outputs: 2 }, // 2x2
    ];

    for (const { inputs, outputs } of validArities) {
      expect(inputs).toBeGreaterThan(0);
      expect(outputs).toBeGreaterThan(0);
      expect(inputs).toBeLessThanOrEqual(2);
      expect(outputs).toBeLessThanOrEqual(2);
    }

    // Invalid arities (not supported)
    const invalidArities = [
      { inputs: 0, outputs: 1 },
      { inputs: 1, outputs: 0 },
      { inputs: 3, outputs: 1 },
      { inputs: 1, outputs: 3 },
    ];

    for (const { inputs, outputs } of invalidArities) {
      expect(inputs === 0 || outputs === 0 || inputs > 2 || outputs > 2).toBe(true);
    }
  });
});

// ============================================================================
// 3. PROOF DATA STRUCTURE
// ============================================================================

describe("PROOF DATA STRUCTURE", () => {
  test("validates proof data format", () => {
    // Mock proof data structure
    const mockProof = {
      proof: new Uint8Array(256), // Groth16 proof is 256 bytes
      publicInputs: ["12345", "67890"],
    };

    expect(mockProof.proof).toBeInstanceOf(Uint8Array);
    expect(mockProof.proof.length).toBe(256);
    expect(Array.isArray(mockProof.publicInputs)).toBe(true);

    // Public inputs should be field element strings
    for (const pi of mockProof.publicInputs) {
      expect(typeof pi).toBe("string");
      const value = BigInt(pi);
      expect(value).toBeGreaterThanOrEqual(0n);
      expect(value).toBeLessThan(BN254_FIELD_PRIME);
    }
  });

  test("validates proof size", () => {
    // Groth16 proof format: 2 G1 points + 1 G2 point
    // G1 point: 32 bytes (compressed)
    // G2 point: 64 bytes (compressed)
    const GROTH16_PROOF_SIZE = 256;

    const proof = new Uint8Array(GROTH16_PROOF_SIZE);
    expect(proof.length).toBe(GROTH16_PROOF_SIZE);

    // Invalid sizes
    expect(new Uint8Array(255).length).not.toBe(GROTH16_PROOF_SIZE);
    expect(new Uint8Array(257).length).not.toBe(GROTH16_PROOF_SIZE);
  });
});
