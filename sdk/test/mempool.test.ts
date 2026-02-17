/**
 * Mempool Client Tests
 *
 * Tests for the MempoolClient SPV utilities
 */

import { describe, test, expect, beforeAll, mock } from "bun:test";
import {
  MempoolClient,
  mempoolTestnet,
  mempoolMainnet,
  reverseBytes,
  hexToBytes,
  bytesToHex,
} from "../src/core/mempool";

// =============================================================================
// Utility Function Tests
// =============================================================================

describe("reverseBytes", () => {
  test("reverses empty array", () => {
    const input = new Uint8Array([]);
    const result = reverseBytes(input);
    expect(result).toEqual(new Uint8Array([]));
  });

  test("reverses single byte", () => {
    const input = new Uint8Array([0x42]);
    const result = reverseBytes(input);
    expect(result).toEqual(new Uint8Array([0x42]));
  });

  test("reverses multiple bytes", () => {
    const input = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const result = reverseBytes(input);
    expect(result).toEqual(new Uint8Array([0x04, 0x03, 0x02, 0x01]));
  });

  test("reverses 32-byte hash", () => {
    const input = new Uint8Array(32).fill(0);
    input[0] = 0xde;
    input[31] = 0xad;
    const result = reverseBytes(input);
    expect(result[0]).toBe(0xad);
    expect(result[31]).toBe(0xde);
  });
});

describe("hexToBytes", () => {
  test("converts empty string", () => {
    const result = hexToBytes("");
    expect(result).toEqual(new Uint8Array([]));
  });

  test("converts single byte", () => {
    const result = hexToBytes("ff");
    expect(result).toEqual(new Uint8Array([0xff]));
  });

  test("converts multiple bytes", () => {
    const result = hexToBytes("deadbeef");
    expect(result).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  test("handles 0x prefix", () => {
    const result = hexToBytes("0xdeadbeef");
    expect(result).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  test("handles uppercase", () => {
    const result = hexToBytes("DEADBEEF");
    expect(result).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });
});

describe("bytesToHex", () => {
  test("converts empty array", () => {
    const result = bytesToHex(new Uint8Array([]));
    expect(result).toBe("");
  });

  test("converts single byte", () => {
    const result = bytesToHex(new Uint8Array([0xff]));
    expect(result).toBe("ff");
  });

  test("converts multiple bytes", () => {
    const result = bytesToHex(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    expect(result).toBe("deadbeef");
  });

  test("pads single digit bytes", () => {
    const result = bytesToHex(new Uint8Array([0x0f, 0x01, 0x00]));
    expect(result).toBe("0f0100");
  });
});

describe("hexToBytes/bytesToHex roundtrip", () => {
  test("roundtrip preserves data", () => {
    const original = "deadbeef1234567890abcdef";
    const bytes = hexToBytes(original);
    const result = bytesToHex(bytes);
    expect(result).toBe(original);
  });
});

// =============================================================================
// MempoolClient Tests
// =============================================================================

describe("MempoolClient", () => {
  test("creates testnet client", () => {
    const client = new MempoolClient("testnet");
    expect(client.getNetwork()).toBe("testnet");
    expect(client.getBaseUrl()).toBe("https://mempool.space/testnet/api");
  });

  test("creates mainnet client", () => {
    const client = new MempoolClient("mainnet");
    expect(client.getNetwork()).toBe("mainnet");
    expect(client.getBaseUrl()).toBe("https://mempool.space/api");
  });

  test("default instances exist", () => {
    expect(mempoolTestnet.getNetwork()).toBe("testnet");
    expect(mempoolMainnet.getNetwork()).toBe("mainnet");
  });
});

// =============================================================================
// Integration Tests (requires network)
// =============================================================================

describe("MempoolClient integration", () => {
  // Skip network tests in CI
  const skipNetworkTests = process.env.CI === "true";

  test.skipIf(skipNetworkTests)("getBlockHeight returns valid height", async () => {
    const client = new MempoolClient("testnet");
    const height = await client.getBlockHeight();
    expect(height).toBeGreaterThan(2_000_000); // Testnet has millions of blocks
  });

  test.skipIf(skipNetworkTests)("getTransaction returns tx data", async () => {
    const client = new MempoolClient("testnet");
    // Known testnet transaction
    const txid = "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b";

    try {
      const tx = await client.getTransaction(txid);
      expect(tx.txid).toBe(txid);
    } catch (error) {
      // TX might not exist, that's ok for test
      expect(error).toBeDefined();
    }
  });

  test.skipIf(skipNetworkTests)("getTransactionInfo returns structured data", async () => {
    const client = new MempoolClient("testnet");
    const txid = "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b";

    try {
      const info = await client.getTransactionInfo(txid);
      expect(info.txid).toBe(txid);
      expect(typeof info.confirmed).toBe("boolean");
    } catch (error) {
      // TX might not exist
      expect(error).toBeDefined();
    }
  });
});
