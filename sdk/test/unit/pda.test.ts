/**
 * PDA derivation and utility tests
 *
 * Tests pure/deterministic functions:
 * - commitmentToBytes: bigint -> 32-byte Uint8Array (big-endian)
 * - derive*PDA: deterministic PDA derivation (same inputs = same output)
 */

import { describe, test, expect } from "bun:test";
import type { Address } from "@solana/kit";
import {
  commitmentToBytes,
  derivePoolStatePDA,
  deriveNullifierRecordPDA,
  deriveDepositReceiptPDA,
  deriveCommitmentTreePDA,
  deriveVkRegistryPDA,
  deriveBlockHeaderPDA,
  deriveHeightIndexPDA,
} from "../../src/pda";

// A fixed program ID for deterministic tests
const TEST_PROGRAM_ID = "AjbX243s2JMFG2uhfTjKkadjPvQEPgcuyV3vfLJv36MT" as Address;
const TEST_BTC_PROGRAM_ID = "859B7kw1xDyY8rzSXY6pAPNxaAsPWrsaAPJk3iivd43g" as Address;

describe("commitmentToBytes", () => {
  test("zero produces 32 zero bytes", () => {
    const bytes = commitmentToBytes(0n);
    expect(bytes.length).toBe(32);
    expect(bytes.every((b) => b === 0)).toBe(true);
  });

  test("known value 1 produces correct bytes", () => {
    const bytes = commitmentToBytes(1n);
    expect(bytes.length).toBe(32);
    // Big-endian: last byte is 1, rest are 0
    expect(bytes[31]).toBe(1);
    expect(bytes.slice(0, 31).every((b) => b === 0)).toBe(true);
  });

  test("known value 0xff produces correct byte", () => {
    const bytes = commitmentToBytes(0xffn);
    expect(bytes.length).toBe(32);
    expect(bytes[31]).toBe(0xff);
    expect(bytes.slice(0, 31).every((b) => b === 0)).toBe(true);
  });

  test("known value 0x0100 produces correct bytes", () => {
    const bytes = commitmentToBytes(0x0100n);
    expect(bytes.length).toBe(32);
    expect(bytes[30]).toBe(0x01);
    expect(bytes[31]).toBe(0x00);
  });

  test("max 256-bit value produces all 0xff bytes", () => {
    const max = (1n << 256n) - 1n;
    const bytes = commitmentToBytes(max);
    expect(bytes.length).toBe(32);
    expect(bytes.every((b) => b === 0xff)).toBe(true);
  });

  test("specific known bigint roundtrips correctly", () => {
    const value = 0xdeadbeef_cafebabe_12345678_9abcdef0n;
    const bytes = commitmentToBytes(value);
    expect(bytes.length).toBe(32);
    // Reconstruct from bytes (big-endian)
    let reconstructed = 0n;
    for (let i = 0; i < 32; i++) {
      reconstructed = (reconstructed << 8n) | BigInt(bytes[i]);
    }
    expect(reconstructed).toBe(value);
  });

  test("always returns exactly 32 bytes", () => {
    const values = [0n, 1n, 255n, 256n, 2n ** 128n, 2n ** 255n];
    for (const v of values) {
      expect(commitmentToBytes(v).length).toBe(32);
    }
  });
});

describe("derivePoolStatePDA", () => {
  test("returns [Address, bump] tuple", async () => {
    const [address, bump] = await derivePoolStatePDA(TEST_PROGRAM_ID);
    expect(typeof address).toBe("string");
    expect(address.length).toBeGreaterThan(30);
    expect(typeof bump).toBe("number");
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(bump).toBeLessThanOrEqual(255);
  });

  test("deterministic - same program ID gives same PDA", async () => {
    const [addr1, bump1] = await derivePoolStatePDA(TEST_PROGRAM_ID);
    const [addr2, bump2] = await derivePoolStatePDA(TEST_PROGRAM_ID);
    expect(addr1).toBe(addr2);
    expect(bump1).toBe(bump2);
  });

  test("different program IDs give different PDAs", async () => {
    const [addr1] = await derivePoolStatePDA(TEST_PROGRAM_ID);
    const [addr2] = await derivePoolStatePDA(TEST_BTC_PROGRAM_ID);
    expect(addr1).not.toBe(addr2);
  });
});

describe("deriveNullifierRecordPDA", () => {
  test("returns valid PDA tuple", async () => {
    const nullifierHash = new Uint8Array(32).fill(0xab);
    const [address, bump] = await deriveNullifierRecordPDA(nullifierHash, TEST_PROGRAM_ID);
    expect(typeof address).toBe("string");
    expect(address.length).toBeGreaterThan(30);
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(bump).toBeLessThanOrEqual(255);
  });

  test("deterministic - same hash gives same PDA", async () => {
    const hash = new Uint8Array(32).fill(0x42);
    const [addr1, bump1] = await deriveNullifierRecordPDA(hash, TEST_PROGRAM_ID);
    const [addr2, bump2] = await deriveNullifierRecordPDA(hash, TEST_PROGRAM_ID);
    expect(addr1).toBe(addr2);
    expect(bump1).toBe(bump2);
  });

  test("different hashes give different PDAs", async () => {
    const hash1 = new Uint8Array(32).fill(0x01);
    const hash2 = new Uint8Array(32).fill(0x02);
    const [addr1] = await deriveNullifierRecordPDA(hash1, TEST_PROGRAM_ID);
    const [addr2] = await deriveNullifierRecordPDA(hash2, TEST_PROGRAM_ID);
    expect(addr1).not.toBe(addr2);
  });
});

describe("deriveDepositReceiptPDA", () => {
  test("returns valid PDA tuple", async () => {
    const txid = new Uint8Array(32).fill(0xcc);
    const [address, bump] = await deriveDepositReceiptPDA(txid, TEST_PROGRAM_ID);
    expect(typeof address).toBe("string");
    expect(address.length).toBeGreaterThan(30);
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(bump).toBeLessThanOrEqual(255);
  });

  test("deterministic - same txid gives same PDA", async () => {
    const txid = new Uint8Array(32).fill(0xdd);
    const [addr1, bump1] = await deriveDepositReceiptPDA(txid, TEST_PROGRAM_ID);
    const [addr2, bump2] = await deriveDepositReceiptPDA(txid, TEST_PROGRAM_ID);
    expect(addr1).toBe(addr2);
    expect(bump1).toBe(bump2);
  });

  test("rejects non-32-byte txid", async () => {
    const badTxid = new Uint8Array(16).fill(0xee);
    await expect(deriveDepositReceiptPDA(badTxid, TEST_PROGRAM_ID)).rejects.toThrow(
      "depositTxid must be 32 bytes"
    );
  });
});

describe("deriveCommitmentTreePDA", () => {
  test("returns valid PDA for default tree index", async () => {
    const [address, bump] = await deriveCommitmentTreePDA(TEST_PROGRAM_ID);
    expect(typeof address).toBe("string");
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(bump).toBeLessThanOrEqual(255);
  });

  test("tree index 0 and undefined give same PDA (backward compat)", async () => {
    const [addr0] = await deriveCommitmentTreePDA(TEST_PROGRAM_ID, 0);
    const [addrUndef] = await deriveCommitmentTreePDA(TEST_PROGRAM_ID, undefined);
    const [addrDefault] = await deriveCommitmentTreePDA(TEST_PROGRAM_ID);
    expect(addr0).toBe(addrUndef);
    expect(addr0).toBe(addrDefault);
  });

  test("different tree indices give different PDAs", async () => {
    const [addr1] = await deriveCommitmentTreePDA(TEST_PROGRAM_ID, 1);
    const [addr2] = await deriveCommitmentTreePDA(TEST_PROGRAM_ID, 2);
    expect(addr1).not.toBe(addr2);
  });
});

describe("deriveVkRegistryPDA", () => {
  test("deterministic for same inputs", async () => {
    const [addr1, bump1] = await deriveVkRegistryPDA(2, 2, TEST_PROGRAM_ID);
    const [addr2, bump2] = await deriveVkRegistryPDA(2, 2, TEST_PROGRAM_ID);
    expect(addr1).toBe(addr2);
    expect(bump1).toBe(bump2);
  });

  test("different N/M give different PDAs", async () => {
    const [addr1x2] = await deriveVkRegistryPDA(1, 2, TEST_PROGRAM_ID);
    const [addr2x1] = await deriveVkRegistryPDA(2, 1, TEST_PROGRAM_ID);
    const [addr2x2] = await deriveVkRegistryPDA(2, 2, TEST_PROGRAM_ID);
    expect(addr1x2).not.toBe(addr2x1);
    expect(addr1x2).not.toBe(addr2x2);
    expect(addr2x1).not.toBe(addr2x2);
  });
});

describe("deriveBlockHeaderPDA", () => {
  test("rejects non-32-byte block hash", async () => {
    const badHash = new Uint8Array(16);
    await expect(deriveBlockHeaderPDA(badHash, TEST_BTC_PROGRAM_ID)).rejects.toThrow(
      "blockHash must be 32 bytes"
    );
  });

  test("deterministic for same block hash", async () => {
    const hash = new Uint8Array(32).fill(0x11);
    const [addr1] = await deriveBlockHeaderPDA(hash, TEST_BTC_PROGRAM_ID);
    const [addr2] = await deriveBlockHeaderPDA(hash, TEST_BTC_PROGRAM_ID);
    expect(addr1).toBe(addr2);
  });
});

describe("deriveHeightIndexPDA", () => {
  test("deterministic for same height", async () => {
    const [addr1] = await deriveHeightIndexPDA(100, TEST_BTC_PROGRAM_ID);
    const [addr2] = await deriveHeightIndexPDA(100, TEST_BTC_PROGRAM_ID);
    expect(addr1).toBe(addr2);
  });

  test("accepts bigint height", async () => {
    const [addr1] = await deriveHeightIndexPDA(100n, TEST_BTC_PROGRAM_ID);
    const [addr2] = await deriveHeightIndexPDA(100, TEST_BTC_PROGRAM_ID);
    expect(addr1).toBe(addr2);
  });

  test("different heights give different PDAs", async () => {
    const [addr1] = await deriveHeightIndexPDA(100, TEST_BTC_PROGRAM_ID);
    const [addr2] = await deriveHeightIndexPDA(200, TEST_BTC_PROGRAM_ID);
    expect(addr1).not.toBe(addr2);
  });
});
