"use client";

/**
 * Pool Statistics Hook
 *
 * Fetches zVault pool statistics using @solana/kit for efficient RPC calls.
 * Uses SWR for automatic caching, deduplication, and stale-while-revalidate.
 */

import useSWR from "swr";
import { DEVNET_CONFIG } from "@zvault/sdk";
import { fetchAccountInfo } from "@/lib/adapters/connection-adapter";

export interface PoolStats {
  depositCount: number;
  vaultBalance: bigint;
  pendingRedemptions: number;
}

/**
 * Pre-computed static addresses from SDK config.
 * Avoids recalculating on every poll.
 */
const POOL_STATE_ADDRESS = DEVNET_CONFIG.poolStatePda;
const POOL_VAULT_ADDRESS = DEVNET_CONFIG.poolVault;

/**
 * Fetch pool stats using @solana/kit RPC.
 * Extracted as a standalone function for SWR.
 */
async function fetchPoolStats(): Promise<PoolStats> {
  let depositCount = 0;
  let pendingRedemptions = 0;
  let vaultBalance = 0n;

  // Fetch pool state for counts
  const poolInfo = await fetchAccountInfo(POOL_STATE_ADDRESS);

  if (poolInfo && poolInfo.data.length >= 196 && poolInfo.data[0] === 0x01) {
    const view = new DataView(poolInfo.data.buffer, poolInfo.data.byteOffset, poolInfo.data.byteLength);
    depositCount = Number(view.getBigUint64(164, true));
    pendingRedemptions = Number(view.getBigUint64(188, true));
  }

  // Fetch vault balance
  try {
    const vaultInfo = await fetchAccountInfo(POOL_VAULT_ADDRESS);

    if (vaultInfo && vaultInfo.data.length >= 72) {
      const view = new DataView(vaultInfo.data.buffer, vaultInfo.data.byteOffset, vaultInfo.data.byteLength);
      vaultBalance = view.getBigUint64(64, true);
    }
  } catch {
    // Vault may not exist yet
  }

  return { depositCount, vaultBalance, pendingRedemptions };
}

/**
 * Hook to fetch pool statistics with automatic caching and deduplication.
 * Uses SWR for:
 * - Request deduplication (multiple components share one request)
 * - Stale-while-revalidate (show cached data while fetching fresh)
 * - Automatic polling every 30 seconds
 * - Error retry with exponential backoff
 */
export function usePoolStats() {
  const { data: stats, error, isLoading, mutate } = useSWR<PoolStats>(
    "pool-stats",
    fetchPoolStats,
    {
      refreshInterval: 30000, // Poll every 30 seconds
      dedupingInterval: 5000, // Dedupe requests within 5 seconds
      revalidateOnFocus: false, // Don't refetch on tab focus
      errorRetryCount: 3, // Retry 3 times on error
    }
  );

  return {
    stats: stats ?? null,
    isLoading,
    error: error ? (error instanceof Error ? error.message : "Failed to fetch stats") : null,
    refresh: () => mutate(),
  };
}
