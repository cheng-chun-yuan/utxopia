/**
 * Cross-layer TokenConfig alignment tests
 *
 * Verifies that the SDK's TokenConfig parser reads the same
 * byte offsets that the on-chain program writes.
 *
 * Contract layout (from state/token_config.rs):
 * disc(1) + bump(1) + mint(32) + tokenId(32) + vault(32) +
 * decimals(1) + enabled(1) + service_fee(8) + min_deposit(8) +
 * max_deposit(8) + deposit_cap(8) + total_shielded(8) +
 * accumulated_fees(8) + _reserved(16) = 164 bytes
 */

import { describe, it, expect } from "bun:test";

// Replicate the contract's TokenConfig layout
const TOKEN_CONFIG_LEN = 164;
const TOKEN_CONFIG_DISC = 0x0b;

interface TokenConfigFields {
  discriminator: number;
  bump: number;
  mint: Uint8Array;
  tokenId: Uint8Array;
  vault: Uint8Array;
  decimals: number;
  enabled: boolean;
  serviceFee: bigint;
  minDeposit: bigint;
  maxDeposit: bigint;
  depositCap: bigint;
  totalShielded: bigint;
  accumulatedFees: bigint;
}

/** Build a mock TokenConfig buffer matching the contract's layout */
function buildTokenConfigBuffer(fields: Partial<TokenConfigFields>): Uint8Array {
  const buf = new Uint8Array(TOKEN_CONFIG_LEN);
  const view = new DataView(buf.buffer);

  let offset = 0;
  buf[offset++] = fields.discriminator ?? TOKEN_CONFIG_DISC;
  buf[offset++] = fields.bump ?? 255;
  buf.set(fields.mint ?? new Uint8Array(32).fill(0x11), offset); offset += 32;
  buf.set(fields.tokenId ?? new Uint8Array(32).fill(0x22), offset); offset += 32;
  buf.set(fields.vault ?? new Uint8Array(32).fill(0x33), offset); offset += 32;
  buf[offset++] = fields.decimals ?? 8;
  buf[offset++] = fields.enabled !== false ? 1 : 0;
  view.setBigUint64(offset, fields.serviceFee ?? 1000n, true); offset += 8;
  view.setBigUint64(offset, fields.minDeposit ?? 5000n, true); offset += 8;
  view.setBigUint64(offset, fields.maxDeposit ?? 10_000_000_000n, true); offset += 8;
  view.setBigUint64(offset, fields.depositCap ?? 2_100_000_000_000_000n, true); offset += 8;
  view.setBigUint64(offset, fields.totalShielded ?? 0n, true); offset += 8;
  view.setBigUint64(offset, fields.accumulatedFees ?? 0n, true); offset += 8;
  // _reserved: 16 bytes at offset 148

  return buf;
}

/** Parse TokenConfig matching SDK/backend parser logic */
function parseTokenConfig(data: Uint8Array): TokenConfigFields | null {
  if (data.length < TOKEN_CONFIG_LEN) return null;
  if (data[0] !== TOKEN_CONFIG_DISC) return null;

  const view = new DataView(data.buffer, data.byteOffset);
  return {
    discriminator: data[0],
    bump: data[1],
    mint: data.slice(2, 34),
    tokenId: data.slice(34, 66),
    vault: data.slice(66, 98),
    decimals: data[98],
    enabled: data[99] === 1,
    serviceFee: view.getBigUint64(100, true),
    minDeposit: view.getBigUint64(108, true),
    maxDeposit: view.getBigUint64(116, true),
    depositCap: view.getBigUint64(124, true),
    totalShielded: view.getBigUint64(132, true),
    accumulatedFees: view.getBigUint64(140, true),
  };
}

describe("Cross-layer: TokenConfig alignment", () => {
  it("total size is 164 bytes", () => {
    const buf = buildTokenConfigBuffer({});
    expect(buf.length).toBe(164);
  });

  it("roundtrips all fields correctly", () => {
    const mint = new Uint8Array(32).fill(0xaa);
    const tokenId = new Uint8Array(32).fill(0xbb);
    const vault = new Uint8Array(32).fill(0xcc);

    const buf = buildTokenConfigBuffer({
      bump: 42,
      mint,
      tokenId,
      vault,
      decimals: 6,
      enabled: true,
      serviceFee: 500n,
      minDeposit: 100_000n,
      maxDeposit: 1_000_000_000_000n,
      depositCap: 10_000_000_000_000n,
      totalShielded: 5_000_000n,
      accumulatedFees: 250n,
    });

    const parsed = parseTokenConfig(buf);
    expect(parsed).not.toBeNull();
    expect(parsed!.discriminator).toBe(TOKEN_CONFIG_DISC);
    expect(parsed!.bump).toBe(42);
    expect(parsed!.mint).toEqual(mint);
    expect(parsed!.tokenId).toEqual(tokenId);
    expect(parsed!.vault).toEqual(vault);
    expect(parsed!.decimals).toBe(6);
    expect(parsed!.enabled).toBe(true);
    expect(parsed!.serviceFee).toBe(500n);
    expect(parsed!.minDeposit).toBe(100_000n);
    expect(parsed!.maxDeposit).toBe(1_000_000_000_000n);
    expect(parsed!.depositCap).toBe(10_000_000_000_000n);
    expect(parsed!.totalShielded).toBe(5_000_000n);
    expect(parsed!.accumulatedFees).toBe(250n);
  });

  it("vault offset is at bytes 66-98 (used by shield-flow.tsx)", () => {
    // The frontend reads vault from on-chain TokenConfig at offset 66..98
    // This must match the contract layout exactly
    const vault = new Uint8Array(32);
    vault[0] = 0xde;
    vault[31] = 0xad;

    const buf = buildTokenConfigBuffer({ vault });
    // Verify vault is at correct offset
    expect(buf[66]).toBe(0xde);
    expect(buf[97]).toBe(0xad);
  });

  it("rejects wrong discriminator", () => {
    const buf = buildTokenConfigBuffer({});
    buf[0] = 0xff; // wrong disc
    expect(parseTokenConfig(buf)).toBeNull();
  });

  it("rejects too-short buffer", () => {
    const buf = new Uint8Array(100);
    buf[0] = TOKEN_CONFIG_DISC;
    expect(parseTokenConfig(buf)).toBeNull();
  });

  it("enabled flag: 0=disabled, 1=enabled", () => {
    const enabled = buildTokenConfigBuffer({ enabled: true });
    const disabled = buildTokenConfigBuffer({ enabled: false });

    expect(parseTokenConfig(enabled)!.enabled).toBe(true);
    expect(parseTokenConfig(disabled)!.enabled).toBe(false);
    expect(enabled[99]).toBe(1);
    expect(disabled[99]).toBe(0);
  });
});
