import { describe, it, expect, mock } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { useTokenBalance } from "../use-token-balance";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import type { SupportedToken } from "@/lib/supported-tokens";
import { BTC_MINER_FEE_ESTIMATE } from "@/lib/btc-constants";

// Minimal token fixtures
const btcToken: SupportedToken = {
  symbol: "BTC",
  name: "Bitcoin",
  decimals: 8,
  logo: "",
  mint: "",
  isBtcNative: true,
  isSOL: false,
  enabled: true,
  unit: "sats",
  priceKey: "btc",
  shieldedSymbol: "zkBTC",
  shieldedLogo: "",
  explorerFilter: "btc",
  showRawAmount: true,
  explorerColors: { from: "", to: "" },
  explorerLabel: "BTC",
  explorerSubtitle: "",
  relayerFee: 5000,
};

const solToken: SupportedToken = {
  symbol: "SOL",
  name: "Solana",
  decimals: 9,
  logo: "",
  mint: "",
  isBtcNative: false,
  isSOL: true,
  enabled: true,
  unit: "SOL",
  priceKey: "sol",
  shieldedSymbol: "zkSOL",
  shieldedLogo: "",
  explorerFilter: "sol" as any,
  showRawAmount: false,
  explorerColors: { from: "", to: "" },
  explorerLabel: "SOL",
  explorerSubtitle: "",
  relayerFee: 5000,
};

function makeMockConnection(overrides: Record<string, any> = {}): any {
  return {
    getBalance: mock(() => Promise.resolve(0)),
    getTokenAccountsByOwner: mock(() => Promise.resolve({ value: [] })),
    ...overrides,
  };
}

describe("useTokenBalance", () => {
  it("returns null balances initially", () => {
    const conn = makeMockConnection();
    const { result } = renderHook(() =>
      useTokenBalance(btcToken, null, conn, null)
    );

    expect(result.current.solBalance).toBeNull();
    expect(result.current.splBalance).toBeNull();
  });

  it("handleMax returns '0' when no balance available", () => {
    const conn = makeMockConnection();
    const { result } = renderHook(() =>
      useTokenBalance(btcToken, null, conn, null)
    );

    expect(result.current.handleMax()).toBe("0");
  });

  it("handleMax returns correct max for BTC token (subtracts miner fee)", () => {
    const conn = makeMockConnection();
    const btcBalanceSats = 50_000;

    const { result } = renderHook(() =>
      useTokenBalance(btcToken, null, conn, btcBalanceSats)
    );

    const expected = ((btcBalanceSats - BTC_MINER_FEE_ESTIMATE) / 1e8).toFixed(8);
    expect(result.current.handleMax()).toBe(expected);
  });

  it("handleMax returns correct max for SOL token (subtracts rent)", async () => {
    const solBalanceLamports = 2 * LAMPORTS_PER_SOL; // 2 SOL
    const conn = makeMockConnection({
      getBalance: mock(() => Promise.resolve(solBalanceLamports)),
    });

    const pubkey = PublicKey.default;
    const { result } = renderHook(() =>
      useTokenBalance(solToken, pubkey, conn, null)
    );

    // Wait for the getBalance effect to resolve
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const expectedLamports = Math.max(0, solBalanceLamports - 0.01 * LAMPORTS_PER_SOL);
    const expected = (expectedLamports / LAMPORTS_PER_SOL).toFixed(9);
    expect(result.current.handleMax()).toBe(expected);
  });
});
