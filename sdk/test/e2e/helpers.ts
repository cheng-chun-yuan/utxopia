/**
 * E2E Test Helpers
 *
 * Common test utilities for E2E tests.
 * Provides mock data generation, note creation, and assertion helpers.
 *
 * NOTE: For full e2e flow, use scripts/e2e-mock-spv.ts or the localnet setup.sh.
 * - checkNullifierExists() - Verify nullifier spent
 */

import { Connection, PublicKey, Keypair, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { address, type Address } from "@solana/kit";

import {
  computeUnifiedCommitmentSync,
  computeNullifierSync,
  hashNullifierSync,
  poseidonHashSync,
  initPoseidon,
} from "../../src/poseidon";
import { randomFieldElement, bigintToBytes, bytesToBigint } from "../../src/crypto";
import { derivePoolStatePDA, deriveCommitmentTreePDA, deriveNullifierRecordPDA } from "../../src/pda";
import { DEMO_INSTRUCTION, buildAddDemoStealthData } from "../../src/demo";
import {
  ed25519GenerateKeyPair,
} from "../../src/crypto";
import { REAL_PROOF_SIZE } from "./setup";

/** @deprecated Use REAL_PROOF_SIZE from setup.ts */
export const MOCK_PROOF_SIZE = REAL_PROOF_SIZE;

// =============================================================================
// Types
// =============================================================================

export interface TestNote {
  /** Private key (spending key) */
  privKey: bigint;
  /** Public key X-coordinate */
  pubKeyX: bigint;
  /** Amount in satoshis */
  amount: bigint;
  /** Commitment = Poseidon(pubKeyX, amount) */
  commitment: bigint;
  /** Commitment as 32 bytes */
  commitmentBytes: Uint8Array;
  /** Leaf index in the commitment tree */
  leafIndex: bigint;
  /** Nullifier = Poseidon(privKey, leafIndex) */
  nullifier: bigint;
  /** Nullifier hash = Poseidon(nullifier) */
  nullifierHash: bigint;
  /** Nullifier hash as 32 bytes */
  nullifierHashBytes: Uint8Array;
}

export interface MerkleProof {
  /** Sibling hashes at each level */
  siblings: bigint[];
  /** Path indices (0 = left, 1 = right) at each level */
  indices: number[];
  /** Merkle root */
  root: bigint;
}

// =============================================================================
// Constants
// =============================================================================

/** Standard tree depth for commitment tree */
export const TREE_DEPTH = 20;

/** Minimum deposit in satoshis (0.0001 BTC) */
export const MIN_DEPOSIT_SATS = 10_000n;

/** Common test amounts */
export const TEST_AMOUNTS = {
  small: 100_000n, // 0.001 BTC
  medium: 1_000_000n, // 0.01 BTC
  large: 10_000_000n, // 0.1 BTC
  btc: 100_000_000n, // 1 BTC
};

// =============================================================================
// Note Creation
// =============================================================================

/**
 * Create a test note with computed commitment and nullifier
 *
 * Uses the unified model:
 * - Commitment = Poseidon(pubKeyX, amount)
 * - Nullifier = Poseidon(privKey, leafIndex)
 */
export function createTestNote(
  amount: bigint,
  leafIndex: bigint = 0n,
  privKey?: bigint
): TestNote {
  // Generate or use provided private key
  const pk = privKey ?? randomFieldElement();

  // For testing, we use a random pubKeyX since we're not doing real EC operations
  // In production, pubKeyX would be derived from privKey via Baby Jubjub BabyPbk()
  const pubKeyX = randomFieldElement();

  // Compute commitment = Poseidon(pubKeyX, amount)
  const commitment = computeUnifiedCommitmentSync(pubKeyX, amount);
  const commitmentBytes = bigintToBytes(commitment, 32);

  // Compute nullifier = Poseidon(privKey, leafIndex)
  const nullifier = computeNullifierSync(pk, leafIndex);
  const nullifierHash = hashNullifierSync(nullifier);
  const nullifierHashBytes = bigintToBytes(nullifierHash, 32);

  return {
    privKey: pk,
    pubKeyX,
    amount,
    commitment,
    commitmentBytes,
    leafIndex,
    nullifier,
    nullifierHash,
    nullifierHashBytes,
  };
}

/**
 * Create multiple test notes
 */
export function createTestNotes(
  amounts: bigint[],
  startLeafIndex: bigint = 0n
): TestNote[] {
  return amounts.map((amount, i) =>
    createTestNote(amount, startLeafIndex + BigInt(i))
  );
}

// =============================================================================
// Mock Data Generation
// =============================================================================

/**
 * Create mock Groth16 proof bytes
 *
 * Generates deterministic pseudo-random bytes for testing.
 *
 * @deprecated For real proof tests, use the prover:
 * ```typescript
 * import { generateClaimProof, generateSpendSplitProof } from "../../src/prover/web";
 * const proof = await generateClaimProof(inputs);
 * ```
 */
export function generateMockProof(size: number = REAL_PROOF_SIZE): Uint8Array {
  const proof = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    proof[i] = (i * 17 + 31) % 256;
  }
  return proof;
}

/**
 * Create mock 32-byte hash value
 */
export function createMock32Bytes(seed: number): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = (seed + i * 7) % 256;
  }
  return bytes;
}

/**
 * Create random bytes
 */
export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

/**
 * Generate mock VK hash
 */
export function generateMockVkHash(): Uint8Array {
  return createMock32Bytes(99);
}

// =============================================================================
// Merkle Tree Utilities
// =============================================================================

/**
 * Compute Merkle root from a single commitment using zero siblings
 *
 * This mirrors what the circom circuit does for a tree with one leaf.
 */
export function computeMerkleRootFromCommitment(
  commitment: bigint,
  depth: number = TREE_DEPTH
): bigint {
  let current = commitment;
  for (let i = 0; i < depth; i++) {
    // At each level, hash with zero sibling (left child)
    current = poseidonHashSync([current, 0n]);
  }
  return current;
}

/**
 * Create a mock Merkle proof for a commitment at index 0
 *
 * Uses all-zero siblings (simulating a tree with one leaf).
 */
export function createMockMerkleProof(
  commitment: bigint,
  depth: number = TREE_DEPTH
): MerkleProof {
  const siblings: bigint[] = Array(depth).fill(0n);
  const indices: number[] = Array(depth).fill(0);
  const root = computeMerkleRootFromCommitment(commitment, depth);

  return { siblings, indices, root };
}

/**
 * Verify a Merkle proof
 */
export function verifyMerkleProof(
  commitment: bigint,
  proof: MerkleProof
): boolean {
  let current = commitment;

  for (let i = 0; i < proof.siblings.length; i++) {
    const sibling = proof.siblings[i];
    const isLeft = proof.indices[i] === 0;

    if (isLeft) {
      current = poseidonHashSync([current, sibling]);
    } else {
      current = poseidonHashSync([sibling, current]);
    }
  }

  return current === proof.root;
}

// =============================================================================
// Stealth Address Helpers
// =============================================================================

/**
 * Create a mock stealth deposit announcement
 *
 * Generates ephemeral key, commitment, and encrypted amount
 * as would be created during a real stealth deposit.
 */
export function createMockStealthAnnouncement(
  amount: bigint
): {
  ephemeralPub: Uint8Array;
  commitment: Uint8Array;
  encryptedAmount: Uint8Array;
} {
  // Generate ephemeral key (Ed25519 - 32 bytes)
  const ephemeralKey = ed25519GenerateKeyPair();
  const ephemeralPub = ephemeralKey.pubKey;

  // Create commitment (mock)
  const commitment = randomBytes(32);

  // Encrypt amount (mock - just use amount bytes for testing)
  const encryptedAmount = new Uint8Array(8);
  const view = new DataView(encryptedAmount.buffer);
  view.setBigUint64(0, amount, true); // little-endian

  return { ephemeralPub, commitment, encryptedAmount };
}

// =============================================================================
// PDA Helpers
// =============================================================================

/**
 * Derive nullifier record PDA from nullifier hash
 */
export async function deriveNullifierPDA(
  nullifierHashBytes: Uint8Array,
  programId: Address
): Promise<[Address, number]> {
  return deriveNullifierRecordPDA(nullifierHashBytes, programId);
}

/**
 * Check if a nullifier has been spent (PDA exists)
 */
export async function isNullifierSpent(
  connection: Connection,
  nullifierHashBytes: Uint8Array,
  programId: Address
): Promise<boolean> {
  const [nullifierPda] = await deriveNullifierRecordPDA(nullifierHashBytes, programId);
  const pubkey = new PublicKey(nullifierPda.toString());

  try {
    const info = await connection.getAccountInfo(pubkey);
    return info !== null;
  } catch {
    return false;
  }
}

// =============================================================================
// Assertion Helpers
// =============================================================================

/**
 * Assert that two Uint8Arrays are equal
 */
export function assertBytesEqual(
  actual: Uint8Array,
  expected: Uint8Array,
  message?: string
): void {
  if (actual.length !== expected.length) {
    throw new Error(
      `${message || "Bytes mismatch"}: length ${actual.length} !== ${expected.length}`
    );
  }

  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) {
      throw new Error(
        `${message || "Bytes mismatch"}: byte ${i} is ${actual[i]} !== ${expected[i]}`
      );
    }
  }
}

/**
 * Assert that an error contains expected message
 */
export function assertErrorContains(
  error: unknown,
  expectedMessage: string
): void {
  if (!(error instanceof Error)) {
    throw new Error(`Expected Error but got: ${typeof error}`);
  }

  if (!error.message.includes(expectedMessage)) {
    throw new Error(
      `Expected error message to contain "${expectedMessage}" but got: "${error.message}"`
    );
  }
}

// =============================================================================
// Byte Conversion Utilities
// =============================================================================

/**
 * Convert bigint to 32-byte array (big-endian)
 */
export function bigintToBytes32(n: bigint): Uint8Array {
  const hex = n.toString(16).padStart(64, "0");
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Convert 32-byte array to bigint (big-endian)
 */
export function bytes32ToBigint(bytes: Uint8Array): bigint {
  if (bytes.length !== 32) {
    throw new Error(`Expected 32 bytes, got ${bytes.length}`);
  }

  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return BigInt("0x" + hex);
}

/**
 * Convert bytes to hex string
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Convert hex string to bytes
 */
export function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// =============================================================================
// Demo Deposit Helper
// =============================================================================

/**
 * Build instruction data for adding a demo stealth announcement
 *
 * This is used to seed the commitment tree for testing.
 */
export function buildDemoStealthInstructionData(
  ephemeralPub: Uint8Array,
  commitment: Uint8Array,
  encryptedAmount: Uint8Array
): Uint8Array {
  return buildAddDemoStealthData(ephemeralPub, commitment, encryptedAmount);
}

/**
 * Create demo deposit for testing
 *
 * Returns both the note and the instruction data needed to add it on-chain.
 */
export function createDemoDeposit(amount: bigint): {
  note: TestNote;
  instructionData: Uint8Array;
  ephemeralPub: Uint8Array;
} {
  const note = createTestNote(amount, 0n);

  // Create mock stealth announcement
  const { ephemeralPub, encryptedAmount } = createMockStealthAnnouncement(amount);

  // Build instruction data
  const instructionData = buildDemoStealthInstructionData(
    ephemeralPub,
    note.commitmentBytes,
    encryptedAmount
  );

  return { note, instructionData, ephemeralPub };
}
