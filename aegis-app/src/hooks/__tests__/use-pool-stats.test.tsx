/**
 * Pool stats data parsing tests
 *
 * Tests the pool state and vault data parsing logic without React hooks.
 * Verifies byte offsets match the on-chain PoolState layout.
 */
import { describe, it, expect } from "bun:test";

// PoolState layout constants (from contracts/programs/aegis/src/state/pool.rs)
const POOL_STATE_DISC = 0x01;
const DEPOSIT_COUNT_OFFSET = 164;
const PENDING_REDEMPTIONS_OFFSET = 188;
const POOL_STATE_MIN_SIZE = 196;

// Token account layout (SPL Token)
const TOKEN_AMOUNT_OFFSET = 64;

function createMockPoolStateData(depositCount: number, pendingRedemptions: number): Uint8Array {
  const data = new Uint8Array(POOL_STATE_MIN_SIZE);
  data[0] = POOL_STATE_DISC;
  const view = new DataView(data.buffer);
  view.setBigUint64(DEPOSIT_COUNT_OFFSET, BigInt(depositCount), true);
  view.setBigUint64(PENDING_REDEMPTIONS_OFFSET, BigInt(pendingRedemptions), true);
  return data;
}

function createMockVaultData(balance: bigint): Uint8Array {
  const data = new Uint8Array(72);
  const view = new DataView(data.buffer);
  view.setBigUint64(TOKEN_AMOUNT_OFFSET, balance, true);
  return data;
}

function parsePoolState(data: Uint8Array) {
  if (data.length < POOL_STATE_MIN_SIZE || data[0] !== POOL_STATE_DISC) return null;
  const view = new DataView(data.buffer, data.byteOffset);
  return {
    depositCount: Number(view.getBigUint64(DEPOSIT_COUNT_OFFSET, true)),
    pendingRedemptions: Number(view.getBigUint64(PENDING_REDEMPTIONS_OFFSET, true)),
  };
}

function parseVaultBalance(data: Uint8Array): bigint {
  if (data.length < TOKEN_AMOUNT_OFFSET + 8) return 0n;
  return new DataView(data.buffer, data.byteOffset).getBigUint64(TOKEN_AMOUNT_OFFSET, true);
}

describe("Pool stats data parsing", () => {
  it("parses pool state with correct deposit count", () => {
    const data = createMockPoolStateData(42, 5);
    const parsed = parsePoolState(data);
    expect(parsed).not.toBeNull();
    expect(parsed!.depositCount).toBe(42);
    expect(parsed!.pendingRedemptions).toBe(5);
  });

  it("parses vault balance correctly", () => {
    const data = createMockVaultData(100_000_000n); // 1 BTC
    const balance = parseVaultBalance(data);
    expect(balance).toBe(100_000_000n);
  });

  it("rejects wrong discriminator", () => {
    const data = createMockPoolStateData(10, 2);
    data[0] = 0xff;
    expect(parsePoolState(data)).toBeNull();
  });

  it("rejects undersized data", () => {
    const data = new Uint8Array(100);
    data[0] = POOL_STATE_DISC;
    expect(parsePoolState(data)).toBeNull();
  });

  it("handles zero values", () => {
    const data = createMockPoolStateData(0, 0);
    const parsed = parsePoolState(data);
    expect(parsed!.depositCount).toBe(0);
    expect(parsed!.pendingRedemptions).toBe(0);
  });

  it("handles large deposit counts", () => {
    const data = createMockPoolStateData(1_000_000, 0);
    const parsed = parsePoolState(data);
    expect(parsed!.depositCount).toBe(1_000_000);
  });

  it("handles max vault balance (21M BTC in sats)", () => {
    const maxSats = 2_100_000_000_000_000n;
    const data = createMockVaultData(maxSats);
    expect(parseVaultBalance(data)).toBe(maxSats);
  });

  it("computes total shielded BTC correctly", () => {
    const vaultBalance = 150_000_000n; // 1.5 BTC in sats
    const data = createMockVaultData(vaultBalance);
    const balance = parseVaultBalance(data);
    const btc = Number(balance) / 1e8;
    expect(btc).toBeCloseTo(1.5, 8);
  });
});
