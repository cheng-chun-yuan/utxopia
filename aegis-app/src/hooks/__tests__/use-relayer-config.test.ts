import { describe, it, expect, beforeEach, mock, afterEach } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useRelayerConfig } from "../use-relayer-config";
import type { PayToken } from "@/components/btc-widget/pay-flow/helpers";

// Minimal PayToken fixture
const mockToken: PayToken = {
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

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe("useRelayerConfig", () => {
  it("returns default values before fetch completes", () => {
    // Make fetch hang forever
    global.fetch = mock(() => new Promise(() => {})) as any;

    const { result } = renderHook(() => useRelayerConfig(mockToken));

    expect(result.current.relayerMeta).toBeNull();
    expect(result.current.relayerMetaLoaded).toBe(false);
    expect(result.current.effectiveRelayerFee).toBe(0);
    expect(result.current.effectiveServiceFee).toBe(0);
    expect(result.current.effectiveServiceFeeBps).toBe(0);
  });

  it("returns parsed relayer meta after successful fetch", async () => {
    global.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            stealth_meta: "some-stealth-meta",
            relayer_fee_sats: 3000,
            relayer_fees: { zkBTC: 4000, zkSOL: 6000 },
            service_fee_base: 1500,
            service_fee_bps: 50,
          }),
      })
    ) as any;

    const { result } = renderHook(() => useRelayerConfig(mockToken));

    await waitFor(() => {
      expect(result.current.relayerMetaLoaded).toBe(true);
    });

    expect(result.current.relayerMeta).toEqual({
      stealthMeta: "some-stealth-meta",
      relayerFeeSats: 3000,
      relayerFees: { zkBTC: 4000, zkSOL: 6000 },
      serviceFeeSats: 1500,
      serviceFeeBps: 50,
    });
  });

  it("effectiveRelayerFee picks token-specific fee from map", async () => {
    global.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            relayer_fees: { zkBTC: 7777 },
          }),
      })
    ) as any;

    const { result } = renderHook(() => useRelayerConfig(mockToken));

    await waitFor(() => {
      expect(result.current.relayerMetaLoaded).toBe(true);
    });

    // zkBTC is in the map, so use that value
    expect(result.current.effectiveRelayerFee).toBe(7777);
  });

  it("effectiveRelayerFee falls back to token default when not in map", async () => {
    global.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            relayer_fees: { zkSOL: 9999 }, // no zkBTC entry
          }),
      })
    ) as any;

    const { result } = renderHook(() => useRelayerConfig(mockToken));

    await waitFor(() => {
      expect(result.current.relayerMetaLoaded).toBe(true);
    });

    // Falls back to mockToken.relayerFee = 5000
    expect(result.current.effectiveRelayerFee).toBe(5000);
  });

  it("handles fetch failure gracefully", async () => {
    global.fetch = mock(() => Promise.reject(new Error("network error"))) as any;

    const { result } = renderHook(() => useRelayerConfig(mockToken));

    // Give the rejected promise time to settle
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(result.current.relayerMeta).toBeNull();
    expect(result.current.relayerMetaLoaded).toBe(false);
    expect(result.current.effectiveRelayerFee).toBe(0);
  });
});
