/**
 * Priority Fee Tests
 *
 * Tests for priority fee estimation utilities
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  estimatePriorityFee,
  buildPriorityFeeInstructionData,
  encodeSetComputeUnitLimit,
  encodeSetComputeUnitPrice,
  getHeliusRpcUrl,
  DEFAULT_COMPUTE_UNITS,
  DEFAULT_PRIORITY_FEE,
  COMPUTE_BUDGET_DISCRIMINATORS,
} from "../src/solana/priority-fee";

// =============================================================================
// Constants Tests
// =============================================================================

describe("Constants", () => {
  test("DEFAULT_COMPUTE_UNITS is reasonable", () => {
    expect(DEFAULT_COMPUTE_UNITS).toBe(200_000);
    expect(DEFAULT_COMPUTE_UNITS).toBeGreaterThan(0);
    expect(DEFAULT_COMPUTE_UNITS).toBeLessThan(1_400_000); // Max CU per tx
  });

  test("DEFAULT_PRIORITY_FEE is reasonable", () => {
    expect(DEFAULT_PRIORITY_FEE).toBe(1000);
    expect(DEFAULT_PRIORITY_FEE).toBeGreaterThan(0);
  });

  test("COMPUTE_BUDGET_DISCRIMINATORS match Solana spec", () => {
    expect(COMPUTE_BUDGET_DISCRIMINATORS.SET_COMPUTE_UNIT_LIMIT).toBe(2);
    expect(COMPUTE_BUDGET_DISCRIMINATORS.SET_COMPUTE_UNIT_PRICE).toBe(3);
  });
});

// =============================================================================
// Encoding Tests
// =============================================================================

describe("encodeSetComputeUnitLimit", () => {
  test("encodes correctly", () => {
    const data = encodeSetComputeUnitLimit(200_000);
    expect(data.length).toBe(5);
    expect(data[0]).toBe(COMPUTE_BUDGET_DISCRIMINATORS.SET_COMPUTE_UNIT_LIMIT);

    // 200,000 = 0x30D40 in little-endian: 40 0D 03 00
    expect(data[1]).toBe(0x40);
    expect(data[2]).toBe(0x0d);
    expect(data[3]).toBe(0x03);
    expect(data[4]).toBe(0x00);
  });

  test("encodes max value", () => {
    const data = encodeSetComputeUnitLimit(1_400_000);
    expect(data.length).toBe(5);
    expect(data[0]).toBe(2);
  });

  test("encodes zero", () => {
    const data = encodeSetComputeUnitLimit(0);
    expect(data).toEqual(new Uint8Array([2, 0, 0, 0, 0]));
  });
});

describe("encodeSetComputeUnitPrice", () => {
  test("encodes correctly", () => {
    const data = encodeSetComputeUnitPrice(1000n);
    expect(data.length).toBe(9);
    expect(data[0]).toBe(COMPUTE_BUDGET_DISCRIMINATORS.SET_COMPUTE_UNIT_PRICE);

    // 1000 = 0x3E8 in little-endian: E8 03 00 00 00 00 00 00
    expect(data[1]).toBe(0xe8);
    expect(data[2]).toBe(0x03);
    expect(data[3]).toBe(0x00);
  });

  test("encodes zero", () => {
    const data = encodeSetComputeUnitPrice(0n);
    expect(data).toEqual(new Uint8Array([3, 0, 0, 0, 0, 0, 0, 0, 0]));
  });

  test("encodes large value", () => {
    const data = encodeSetComputeUnitPrice(1_000_000_000n);
    expect(data.length).toBe(9);
    expect(data[0]).toBe(3);
  });
});

// =============================================================================
// getHeliusRpcUrl Tests
// =============================================================================

describe("getHeliusRpcUrl", () => {
  test("returns public devnet without API key", () => {
    const url = getHeliusRpcUrl("devnet");
    expect(url).toBe("https://api.devnet.solana.com");
  });

  test("returns public mainnet without API key", () => {
    const url = getHeliusRpcUrl("mainnet");
    expect(url).toBe("https://api.mainnet-beta.solana.com");
  });

  test("returns Helius devnet with API key", () => {
    const url = getHeliusRpcUrl("devnet", "test-api-key");
    expect(url).toBe("https://devnet.helius-rpc.com/?api-key=test-api-key");
  });

  test("returns Helius mainnet with API key", () => {
    const url = getHeliusRpcUrl("mainnet", "test-api-key");
    expect(url).toBe("https://mainnet.helius-rpc.com/?api-key=test-api-key");
  });
});

// =============================================================================
// estimatePriorityFee Tests
// =============================================================================

describe("estimatePriorityFee", () => {
  test("returns defaults without API key", async () => {
    const result = await estimatePriorityFee(["So11111111111111111111111111111111111111112"]);
    expect(result.priorityFee).toBe(DEFAULT_PRIORITY_FEE);
    expect(result.computeUnits).toBe(DEFAULT_COMPUTE_UNITS);
  });

  test("respects custom defaults", async () => {
    const result = await estimatePriorityFee(
      ["So11111111111111111111111111111111111111112"],
      {
        defaultComputeUnits: 300_000,
        defaultPriorityFee: 5000,
      }
    );
    expect(result.priorityFee).toBe(5000);
    expect(result.computeUnits).toBe(300_000);
  });
});

// =============================================================================
// buildPriorityFeeInstructionData Tests
// =============================================================================

describe("buildPriorityFeeInstructionData", () => {
  test("builds instruction data without API", async () => {
    const result = await buildPriorityFeeInstructionData(
      ["So11111111111111111111111111111111111111112"]
    );

    expect(result.setComputeUnitLimit.discriminator).toBe(2);
    expect(result.setComputeUnitLimit.units).toBe(DEFAULT_COMPUTE_UNITS);
    expect(result.setComputeUnitPrice?.discriminator).toBe(3);
    expect(result.setComputeUnitPrice?.microLamports).toBe(BigInt(DEFAULT_PRIORITY_FEE));
  });

  test("returns null price when fee is 0", async () => {
    const result = await buildPriorityFeeInstructionData(
      ["So11111111111111111111111111111111111111112"],
      { defaultPriorityFee: 0 }
    );

    expect(result.setComputeUnitLimit).toBeDefined();
    expect(result.setComputeUnitPrice).toBeNull();
  });
});
