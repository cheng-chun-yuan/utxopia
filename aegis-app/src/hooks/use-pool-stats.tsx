"use client";

/**
 * Pool Statistics Hook
 *
 * Fetches Aegis pool statistics using @solana/kit for efficient RPC calls.
 * Uses SWR for automatic caching, deduplication, and stale-while-revalidate.
 *
 * PoolState layout (repr(C), 268 bytes):
 *   offset 0:   discriminator (u8, 0x01)
 *   offset 132: deposit_count (u64 LE)
 *   offset 140: total_minted (u64 LE)
 *   offset 148: total_burned (u64 LE)
 *   offset 156: pending_redemptions (u64 LE)
 *   offset 188: total_shielded (u64 LE)
 */

import useSWR from "swr";
import { getConfig } from "@aegis/sdk";
import { fetchAccountInfo } from "@/lib/adapters/connection-adapter";

export interface PoolStats {
  /** Total zkBTC currently in shielded commitments (sats) — "Vault" */
  totalShielded: bigint;
  /** Number of deposits (from pool state counter) — "Deposits" */
  depositCount: number;
  /** Total transaction volume: total_minted + total_burned (sats) — "Volume" */
  volume: bigint;
}

/**
 * Fetch pool stats from on-chain data.
 */
async function fetchPoolStats(): Promise<PoolStats> {
  let totalShielded = 0n;
  let depositCount = 0n;
  let totalMinted = 0n;
  let totalBurned = 0n;

  // Fetch pool state for counters
  const poolInfo = await fetchAccountInfo(getConfig().poolStatePda);

  if (poolInfo && poolInfo.data.length >= 196 && poolInfo.data[0] === 0x01) {
    const view = new DataView(
      poolInfo.data.buffer,
      poolInfo.data.byteOffset,
      poolInfo.data.byteLength
    );
    depositCount = view.getBigUint64(132, true);
    totalMinted = view.getBigUint64(140, true);
    totalBurned = view.getBigUint64(148, true);
    totalShielded = view.getBigUint64(188, true);
  }

  // Volume = total minted + total burned (represents all BTC flow through the bridge)
  const volume = totalMinted + totalBurned;

  return { totalShielded, depositCount: Number(depositCount), volume };
}

/**
 * Hook to fetch pool statistics with automatic caching and deduplication.
 */
export function usePoolStats() {
  const {
    data: stats,
    error,
    isLoading,
    mutate,
  } = useSWR<PoolStats>("pool-stats", fetchPoolStats, {
    refreshInterval: 30000,
    dedupingInterval: 5000,
    revalidateOnFocus: false,
    errorRetryCount: 3,
  });

  return {
    stats: stats ?? null,
    isLoading,
    error: error
      ? error instanceof Error
        ? error.message
        : "Failed to fetch stats"
      : null,
    refresh: () => mutate(),
  };
}
