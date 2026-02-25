/**
 * ChadBuffer Integration E2E Test
 *
 * DEPRECATED: Legacy test for old proof upload flow.
 * ChadBuffer is now only used for SPV verification data, not ZK proofs.
 * Groth16 proofs are 256 bytes and fit inline in Solana transactions.
 *
 * Run with: bun test test/chadbuffer-e2e.test.ts
 */

import { describe as _describe, it, expect, beforeAll } from "bun:test";
const describe = _describe.skip;
import {
  address,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  generateKeyPairSigner,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";

import {
  uploadTransactionToBuffer,
  closeBuffer,
  readBufferData,
  CHADBUFFER_PROGRAM_ID,
} from "../src/chadbuffer";
import {
  hexToBytes,
  bytesToHex,
} from "../src/instructions";
import {
  needsBuffer,
} from "../src/chadbuffer";
import { getConfig, DEVNET_CONFIG, setConfig } from "../src/config";

// =============================================================================
// Test Setup
// =============================================================================

const RPC_URL = "https://api.devnet.solana.com";
const WS_URL = "wss://api.devnet.solana.com";

// Mock proof data (simulated Groth16 proof - 10KB)
const MOCK_PROOF_SIZE = 10 * 1024; // 10KB
const createMockProof = (size: number): Uint8Array => {
  const proof = new Uint8Array(size);
  // Fill with pseudo-random data
  for (let i = 0; i < size; i++) {
    proof[i] = (i * 17 + 31) % 256;
  }
  return proof;
};

// Mock 32-byte values
const createMock32Bytes = (seed: number): Uint8Array => {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = (seed + i * 7) % 256;
  }
  return bytes;
};

describe("ChadBuffer Integration", () => {
  beforeAll(() => {
    setConfig("devnet");
  });

  describe("needsBuffer utility", () => {
    it("should return false for small proofs (< 900 bytes)", () => {
      const smallProof = new Uint8Array(500);
      expect(needsBuffer(smallProof)).toBe(false);
    });

    it("should return true for large proofs (> 900 bytes)", () => {
      const largeProof = new Uint8Array(1000);
      expect(needsBuffer(largeProof)).toBe(true);
    });

    it("should return true for typical Groth16 proofs (8-16KB)", () => {
      const groth16Proof = createMockProof(12000);
      expect(needsBuffer(groth16Proof)).toBe(true);
    });
  });

  describe("buildClaimInstructionData", () => {
    const mockRoot = createMock32Bytes(1);
    const mockNullifier = createMock32Bytes(2);
    const mockVkHash = createMock32Bytes(3);
    const mockRecipient = address("DKpjj5ygnJwGZfXMWrZaPf3ZdxtxSgvHg2Kk8HhGhdXV");
    const mockAmount = 100_000n;

    it("should build inline mode instruction data correctly", () => {
      const mockProof = new Uint8Array(500);

      const data = buildClaimInstructionData({
        proofSource: "inline",
        proofBytes: mockProof,
        root: mockRoot,
        nullifierHash: mockNullifier,
        amountSats: mockAmount,
        recipient: mockRecipient,
        vkHash: mockVkHash,
      });

      // Check structure: discriminator(1) + proof_source(1) + proof_len(4) + proof(500) + root(32) + nullifier(32) + amount(8) + recipient(32) + vk_hash(32)
      const expectedSize = 1 + 1 + 4 + 500 + 32 + 32 + 8 + 32 + 32;
      expect(data.length).toBe(expectedSize);

      // Check discriminator (CLAIM = 2)
      expect(data[0]).toBe(2);

      // Check proof_source (inline = 0)
      expect(data[1]).toBe(0);

      // Check proof_len
      const proofLen = new DataView(data.buffer).getUint32(2, true);
      expect(proofLen).toBe(500);
    });

    it("should build buffer mode instruction data correctly", () => {
      const data = buildClaimInstructionData({
        proofSource: "buffer",
        root: mockRoot,
        nullifierHash: mockNullifier,
        amountSats: mockAmount,
        recipient: mockRecipient,
        vkHash: mockVkHash,
      });

      // Check structure: discriminator(1) + proof_source(1) + root(32) + nullifier(32) + amount(8) + recipient(32) + vk_hash(32)
      const expectedSize = 1 + 1 + 32 + 32 + 8 + 32 + 32;
      expect(data.length).toBe(expectedSize);

      // Check discriminator (CLAIM = 2)
      expect(data[0]).toBe(2);

      // Check proof_source (buffer = 1)
      expect(data[1]).toBe(1);
    });

    it("should throw if proofBytes missing for inline mode", () => {
      expect(() =>
        buildClaimInstructionData({
          proofSource: "inline",
          // Missing proofBytes
          root: mockRoot,
          nullifierHash: mockNullifier,
          amountSats: mockAmount,
          recipient: mockRecipient,
          vkHash: mockVkHash,
        })
      ).toThrow("proofBytes required for inline mode");
    });
  });

  describe("buildSplitInstructionData", () => {
    const mockRoot = createMock32Bytes(1);
    const mockNullifier = createMock32Bytes(2);
    const mockOutput1 = createMock32Bytes(3);
    const mockOutput2 = createMock32Bytes(4);
    const mockVkHash = createMock32Bytes(5);

    it("should build inline mode instruction data correctly", () => {
      const mockProof = new Uint8Array(600);

      const data = buildSplitInstructionData({
        proofSource: "inline",
        proofBytes: mockProof,
        root: mockRoot,
        nullifierHash: mockNullifier,
        outputCommitment1: mockOutput1,
        outputCommitment2: mockOutput2,
        vkHash: mockVkHash,
      });

      // Check structure: discriminator(1) + proof_source(1) + proof_len(4) + proof(600) + root(32) + nullifier(32) + out1(32) + out2(32) + vk_hash(32)
      const expectedSize = 1 + 1 + 4 + 600 + 32 + 32 + 32 + 32 + 32;
      expect(data.length).toBe(expectedSize);

      // Check discriminator (SPEND_SPLIT = 3)
      expect(data[0]).toBe(3);

      // Check proof_source (inline = 0)
      expect(data[1]).toBe(0);
    });

    it("should build buffer mode instruction data correctly", () => {
      const data = buildSplitInstructionData({
        proofSource: "buffer",
        root: mockRoot,
        nullifierHash: mockNullifier,
        outputCommitment1: mockOutput1,
        outputCommitment2: mockOutput2,
        vkHash: mockVkHash,
      });

      // Check structure: discriminator(1) + proof_source(1) + root(32) + nullifier(32) + out1(32) + out2(32) + vk_hash(32)
      const expectedSize = 1 + 1 + 32 + 32 + 32 + 32 + 32;
      expect(data.length).toBe(expectedSize);

      // Check discriminator (SPEND_SPLIT = 3)
      expect(data[0]).toBe(3);

      // Check proof_source (buffer = 1)
      expect(data[1]).toBe(1);
    });
  });

  describe("hex utilities", () => {
    it("should convert hex to bytes correctly", () => {
      const hex = "0x48656c6c6f"; // "Hello"
      const bytes = hexToBytes(hex);
      expect(bytes).toEqual(new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]));
    });

    it("should convert bytes to hex correctly", () => {
      const bytes = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
      const hex = bytesToHex(bytes);
      expect(hex).toBe("48656c6c6f");
    });
  });
});

// =============================================================================
// On-chain tests (require funded keypair)
// =============================================================================

describe("ChadBuffer On-chain (devnet)", () => {
  // Skip these tests in CI - they require a funded keypair
  const skipOnchainTests = !process.env.TEST_KEYPAIR_SECRET;

  it.skipIf(skipOnchainTests)("should upload and read buffer data", async () => {
    // This test requires a funded keypair
    // Set TEST_KEYPAIR_SECRET env var to run

    const rpc = createSolanaRpc(RPC_URL);
    const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);
    const payer = await generateKeyPairSigner();

    // Create mock proof data (simulating Groth16 proof)
    const mockProof = createMockProof(MOCK_PROOF_SIZE);

    console.log(`Uploading ${mockProof.length} bytes to ChadBuffer...`);

    // Upload to buffer
    const bufferAddress = await uploadTransactionToBuffer(
      rpc,
      rpcSubscriptions,
      payer,
      mockProof
    );

    console.log(`Buffer created: ${bufferAddress}`);

    // Read back the data
    const { authority, data } = await readBufferData(rpc, bufferAddress);

    // Verify data matches
    expect(data.length).toBe(mockProof.length);
    expect(data).toEqual(mockProof);

    // Clean up - close buffer
    const closeSig = await closeBuffer(rpc, rpcSubscriptions, payer, bufferAddress);
    console.log(`Buffer closed: ${closeSig}`);
  });
});

// =============================================================================
// Integration test (with actual circuit if available)
// =============================================================================

describe("Full Integration Flow", () => {
  it("should demonstrate the complete buffer mode flow", () => {
    // This is a documentation test showing the complete flow

    // 1. Generate or receive an Groth16 proof (simulated)
    const proof = createMockProof(MOCK_PROOF_SIZE);
    expect(needsBuffer(proof)).toBe(true);

    // 2. For buffer mode, first upload proof to ChadBuffer
    // (actual upload would happen here with funded keypair)

    // 3. Build instruction data with buffer mode
    const claimData = buildClaimInstructionData({
      proofSource: "buffer",
      root: createMock32Bytes(1),
      nullifierHash: createMock32Bytes(2),
      amountSats: 100_000n,
      recipient: address("DKpjj5ygnJwGZfXMWrZaPf3ZdxtxSgvHg2Kk8HhGhdXV"),
      vkHash: createMock32Bytes(3),
    });

    // Verify instruction data is compact (no proof bytes inline)
    expect(claimData.length).toBeLessThan(200);

    // 4. Build the full instruction with buffer account reference
    // (would add bufferAddress to accounts list)

    // 5. Submit transaction to Solana
    // (contract reads proof from ChadBuffer, verifies, executes)

    console.log("Buffer mode integration flow validated");
    console.log(`Proof size: ${proof.length} bytes`);
    console.log(`Instruction data size (buffer mode): ${claimData.length} bytes`);
  });
});
