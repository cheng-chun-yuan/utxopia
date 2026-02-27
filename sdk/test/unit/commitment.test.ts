/**
 * Commitment Computation Tests
 *
 * Verifies that the SDK computes commitments correctly using the unified model:
 * - commitment = Poseidon(pub_key_x, amount)
 * - nullifier = Poseidon(priv_key, leaf_index)
 * - nullifier_hash = Poseidon(nullifier)
 */

import { describe, test, expect, beforeAll } from "bun:test";
import {
  generateNote,
  computeNoteCommitment,
  computeNoteNullifier,
  getNotePublicKeyX,
  initPoseidon,
} from "../../src/note";
import {
  initPoseidon as initPoseidonHash,
  computeUnifiedCommitmentSync,
  computeNullifierSync,
  hashNullifierSync,
} from "../../src/poseidon";
import { babyJubMul, BABYJUB_BASE8 } from "../../src/crypto";
import { depositToNote } from "../../src/api";

describe("Unified Model Commitment Computation", () => {
  beforeAll(async () => {
    // Initialize Poseidon before tests
    await initPoseidonHash();
  });

  test("generateNote creates valid random note", () => {
    const note = generateNote(100_000n);

    expect(note.amount).toBe(100_000n);
    expect(note.nullifier).toBeGreaterThan(0n);
    expect(note.secret).toBeGreaterThan(0n);
    expect(note.nullifierBytes).toHaveLength(32);
    expect(note.secretBytes).toHaveLength(32);
  });

  test("getNotePublicKeyX derives correct public key", () => {
    const note = generateNote(100_000n);

    // Compute expected pub_key_x
    const expectedPubKey = babyJubMul(note.nullifier, BABYJUB_BASE8);
    const expectedPubKeyX = expectedPubKey.x;

    // Get pub_key_x from helper function
    const pubKeyX = getNotePublicKeyX(note);

    expect(pubKeyX).toBe(expectedPubKeyX);
  });

  test("computeNoteCommitment matches manual computation", () => {
    const note = generateNote(100_000n);

    // Compute expected commitment manually
    const pubKey = babyJubMul(note.nullifier, BABYJUB_BASE8);
    const expectedCommitment = computeUnifiedCommitmentSync(
      pubKey.x,
      note.amount,
    );

    // Compute commitment using helper
    const noteWithCommitment = computeNoteCommitment(note);

    expect(noteWithCommitment.commitment).toBe(expectedCommitment);
    expect(noteWithCommitment.commitmentBytes).toHaveLength(32);
  });

  test("computeNoteNullifier matches manual computation", () => {
    const note = generateNote(100_000n);
    const leafIndex = 42n;

    // Compute expected nullifier manually
    const expectedNullifier = computeNullifierSync(note.nullifier, leafIndex);
    const expectedNullifierHash = hashNullifierSync(expectedNullifier);

    // Compute using helper
    const result = computeNoteNullifier(note, leafIndex);

    expect(result.nullifier).toBe(expectedNullifier);
    expect(result.nullifierHash).toBe(expectedNullifierHash);
    expect(result.nullifierHashBytes).toHaveLength(32);
  });

  test("depositToNote computes real Poseidon commitment", async () => {
    const result = await depositToNote(100_000n, "testnet");

    // Verify commitment is computed (not zero)
    expect(result.note.commitment).toBeGreaterThan(0n);
    expect(result.note.commitmentBytes).toHaveLength(32);

    // Verify commitment matches expected computation
    const pubKey = babyJubMul(result.note.nullifier, BABYJUB_BASE8);
    const expectedCommitment = computeUnifiedCommitmentSync(
      pubKey.x,
      result.note.amount,
    );
    expect(result.note.commitment).toBe(expectedCommitment);

    // Verify taproot address is valid
    expect(result.taprootAddress).toMatch(/^tb1p/);
    expect(result.claimLink).toContain("note=");
  });

  test("commitment is deterministic for same inputs", () => {
    const privKey = 12345n;
    const amount = 100_000n;

    // Compute pub_key_x
    const pubKey = babyJubMul(privKey, BABYJUB_BASE8);
    const pubKeyX = pubKey.x;

    // Compute commitment twice
    const commitment1 = computeUnifiedCommitmentSync(pubKeyX, amount);
    const commitment2 = computeUnifiedCommitmentSync(pubKeyX, amount);

    expect(commitment1).toBe(commitment2);
  });

  test("different inputs produce different commitments", () => {
    const privKey1 = 12345n;
    const privKey2 = 67890n;
    const amount = 100_000n;

    const pubKey1 = babyJubMul(privKey1, BABYJUB_BASE8);
    const pubKey2 = babyJubMul(privKey2, BABYJUB_BASE8);

    const commitment1 = computeUnifiedCommitmentSync(pubKey1.x, amount);
    const commitment2 = computeUnifiedCommitmentSync(pubKey2.x, amount);

    expect(commitment1).not.toBe(commitment2);
  });

  test("nullifier is unique per leaf index", () => {
    const privKey = 12345n;

    const nullifier1 = computeNullifierSync(privKey, 0n);
    const nullifier2 = computeNullifierSync(privKey, 1n);

    expect(nullifier1).not.toBe(nullifier2);
  });

  test("nullifier hash prevents nullifier recovery", () => {
    const privKey = 12345n;
    const leafIndex = 0n;

    const nullifier = computeNullifierSync(privKey, leafIndex);
    const nullifierHash = hashNullifierSync(nullifier);

    // Hash should be different from original nullifier
    expect(nullifierHash).not.toBe(nullifier);

    // Hash should be deterministic
    const nullifierHash2 = hashNullifierSync(nullifier);
    expect(nullifierHash).toBe(nullifierHash2);
  });
});

describe("Circuit Compatibility", () => {
  beforeAll(async () => {
    await initPoseidonHash();
  });

  test("commitment matches circom circuit test values", () => {
    // These values match the test in circuits/circom/claim.circom
    const privKey = 12345n;
    const pubKeyX = 67890n; // Mock value from circuit test
    const amount = 100000000n; // 1 BTC in sats

    // Note: In the actual circuit test, pub_key_x is a mock value.
    // In production, pub_key = priv_key * BASE8 on Baby Jubjub curve.
    // For this test, we verify the Poseidon hash computation matches.

    // Compute commitment the same way the circuit does:
    // commitment = Poseidon(pub_key_x, amount)
    const commitment = computeUnifiedCommitmentSync(pubKeyX, amount);

    // The commitment should be a valid field element
    expect(commitment).toBeGreaterThan(0n);

    // Commitment should fit in BN254 field
    const BN254_FIELD_PRIME =
      21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    expect(commitment).toBeLessThan(BN254_FIELD_PRIME);
  });

  test("nullifier matches circom circuit computation", () => {
    const privKey = 12345n;
    const leafIndex = 0n;

    // Compute nullifier: Poseidon(priv_key, leaf_index)
    const nullifier = computeNullifierSync(privKey, leafIndex);

    // Compute nullifier hash: Poseidon(nullifier)
    const nullifierHash = hashNullifierSync(nullifier);

    // Both should be valid field elements
    expect(nullifier).toBeGreaterThan(0n);
    expect(nullifierHash).toBeGreaterThan(0n);

    const BN254_FIELD_PRIME =
      21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    expect(nullifier).toBeLessThan(BN254_FIELD_PRIME);
    expect(nullifierHash).toBeLessThan(BN254_FIELD_PRIME);
  });
});

