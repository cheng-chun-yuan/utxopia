import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { SWRConfig } from "swr";
import { ReactNode } from "react";

// Mock the connection adapter
vi.mock("@/lib/adapters/connection-adapter", () => ({
  fetchAccountInfo: vi.fn(),
}));

// Mock SDK config
vi.mock("@zvault/sdk", () => ({
  DEVNET_CONFIG: {
    poolStatePda: "MockPoolStatePda111111111111111111111111111",
    poolVault: "MockPoolVault111111111111111111111111111111",
  },
}));

import { usePoolStats, type PoolStats } from "../use-pool-stats";
import { fetchAccountInfo } from "@/lib/adapters/connection-adapter";

const mockFetchAccountInfo = fetchAccountInfo as ReturnType<typeof vi.fn>;

/**
 * SWR wrapper that disables caching for tests
 */
function SWRWrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      {children}
    </SWRConfig>
  );
}

/**
 * Helper to create mock pool state account data
 */
function createMockPoolStateData(depositCount: number, pendingRedemptions: number): Uint8Array {
  // Pool state layout: discriminator(1) + ...fields... + depositCount(8)@164 + ...fields... + pendingRedemptions(8)@188
  const data = new Uint8Array(196);
  data[0] = 0x01; // discriminator

  const view = new DataView(data.buffer);
  view.setBigUint64(164, BigInt(depositCount), true);
  view.setBigUint64(188, BigInt(pendingRedemptions), true);

  return data;
}

/**
 * Helper to create mock vault account data (SPL Token account)
 */
function createMockVaultData(balance: bigint): Uint8Array {
  // Token account layout: ...fields... + amount(8)@64
  const data = new Uint8Array(72);
  const view = new DataView(data.buffer);
  view.setBigUint64(64, balance, true);
  return data;
}

describe("usePoolStats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("returns loading state initially", async () => {
    // Setup mock to delay response
    mockFetchAccountInfo.mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() => usePoolStats(), {
      wrapper: SWRWrapper,
    });

    expect(result.current.isLoading).toBe(true);
    expect(result.current.stats).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("fetches and returns pool stats successfully", async () => {
    const mockDepositCount = 42;
    const mockPendingRedemptions = 5;
    const mockVaultBalance = 100_000_000n; // 1 BTC

    mockFetchAccountInfo
      .mockResolvedValueOnce({
        data: createMockPoolStateData(mockDepositCount, mockPendingRedemptions),
      })
      .mockResolvedValueOnce({
        data: createMockVaultData(mockVaultBalance),
      });

    const { result } = renderHook(() => usePoolStats(), {
      wrapper: SWRWrapper,
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.stats).toEqual({
      depositCount: mockDepositCount,
      vaultBalance: mockVaultBalance,
      pendingRedemptions: mockPendingRedemptions,
    });
    expect(result.current.error).toBeNull();
  });

  it("handles missing pool state account", async () => {
    mockFetchAccountInfo.mockResolvedValue(null);

    const { result } = renderHook(() => usePoolStats(), {
      wrapper: SWRWrapper,
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Should return default values when accounts don't exist
    expect(result.current.stats).toEqual({
      depositCount: 0,
      vaultBalance: 0n,
      pendingRedemptions: 0,
    });
  });

  it("handles vault account fetch error gracefully", async () => {
    const mockDepositCount = 10;
    const mockPendingRedemptions = 2;

    mockFetchAccountInfo
      .mockResolvedValueOnce({
        data: createMockPoolStateData(mockDepositCount, mockPendingRedemptions),
      })
      .mockRejectedValueOnce(new Error("Vault not found"));

    const { result } = renderHook(() => usePoolStats(), {
      wrapper: SWRWrapper,
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Should return pool state data but 0 vault balance
    expect(result.current.stats).toEqual({
      depositCount: mockDepositCount,
      vaultBalance: 0n,
      pendingRedemptions: mockPendingRedemptions,
    });
  });

  it("handles fetch error", async () => {
    const errorMessage = "RPC connection failed";
    mockFetchAccountInfo.mockRejectedValue(new Error(errorMessage));

    const { result } = renderHook(() => usePoolStats(), {
      wrapper: SWRWrapper,
    });

    await waitFor(() => {
      expect(result.current.error).toBe(errorMessage);
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.stats).toBeNull();
  });

  it("refresh function triggers data refetch", async () => {
    mockFetchAccountInfo
      .mockResolvedValueOnce({
        data: createMockPoolStateData(10, 1),
      })
      .mockResolvedValueOnce({
        data: createMockVaultData(50_000_000n),
      })
      // After refresh
      .mockResolvedValueOnce({
        data: createMockPoolStateData(15, 2),
      })
      .mockResolvedValueOnce({
        data: createMockVaultData(75_000_000n),
      });

    const { result } = renderHook(() => usePoolStats(), {
      wrapper: SWRWrapper,
    });

    await waitFor(() => {
      expect(result.current.stats?.depositCount).toBe(10);
    });

    // Trigger refresh
    await act(async () => {
      await result.current.refresh();
    });

    await waitFor(() => {
      expect(result.current.stats?.depositCount).toBe(15);
    });

    expect(result.current.stats?.vaultBalance).toBe(75_000_000n);
  });

  it("handles invalid discriminator in pool state", async () => {
    const invalidData = new Uint8Array(196);
    invalidData[0] = 0x00; // Invalid discriminator

    mockFetchAccountInfo
      .mockResolvedValueOnce({ data: invalidData })
      .mockResolvedValueOnce({ data: createMockVaultData(100n) });

    const { result } = renderHook(() => usePoolStats(), {
      wrapper: SWRWrapper,
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Should return default values for deposit count and pending redemptions
    expect(result.current.stats?.depositCount).toBe(0);
    expect(result.current.stats?.pendingRedemptions).toBe(0);
    expect(result.current.stats?.vaultBalance).toBe(100n);
  });

  it("handles undersized pool state data", async () => {
    const undersizedData = new Uint8Array(100); // Less than required 196 bytes
    undersizedData[0] = 0x01;

    mockFetchAccountInfo
      .mockResolvedValueOnce({ data: undersizedData })
      .mockResolvedValueOnce(null);

    const { result } = renderHook(() => usePoolStats(), {
      wrapper: SWRWrapper,
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.stats?.depositCount).toBe(0);
  });
});
