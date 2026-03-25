"use client";

/**
 * Pool Statistics Hook
 *
 * Fetches from backend /api/pool/stats (cached by reconciler, ~30s).
 * Single fetch replaces 5+ client-side RPC calls.
 */

import useSWR from "swr";

/** Per-token TVL info */
export interface TokenTVL {
  symbol: string;
  shieldedSymbol: string;
  totalShielded: bigint;
  decimals: number;
}

export interface PoolStats {
  totalShielded: bigint;
  depositCount: number;
  totalCommitments: number;
  volume: bigint;
  tokenTVL: TokenTVL[];
}

async function fetchPoolStats(): Promise<PoolStats> {
  const resp = await fetch("/api/pool/stats", {
    signal: AbortSignal.timeout(5000),
  });

  if (!resp.ok) {
    return { totalShielded: 0n, depositCount: 0, totalCommitments: 0, volume: 0n, tokenTVL: [] };
  }

  const data = await resp.json();
  const oc = data.onChain;

  if (!oc) {
    return { totalShielded: 0n, depositCount: 0, totalCommitments: 0, volume: 0n, tokenTVL: [] };
  }

  const totalShielded = BigInt(oc.totalShielded ?? 0);
  const totalMinted = BigInt(oc.totalMinted ?? 0);
  const totalBurned = BigInt(oc.totalBurned ?? 0);

  // TODO: per-token TVL from a dedicated backend endpoint
  const tokenTVL: TokenTVL[] = [];
  if (totalShielded > 0n) {
    tokenTVL.push({
      symbol: "BTC",
      shieldedSymbol: "zkBTC",
      totalShielded,
      decimals: 8,
    });
  }

  return {
    totalShielded,
    depositCount: Number(oc.depositCount ?? 0),
    totalCommitments: Number(oc.treeNextIndex ?? 0),
    volume: totalMinted + totalBurned,
    tokenTVL,
  };
}

export function usePoolStats() {
  const { data: stats, error, isLoading, mutate } = useSWR<PoolStats>(
    "pool-stats",
    fetchPoolStats,
    {
      refreshInterval: 30000,
      dedupingInterval: 10000,
      revalidateOnFocus: false,
      errorRetryCount: 3,
    },
  );

  return {
    stats: stats ?? null,
    isLoading,
    error: error ? (error instanceof Error ? error.message : "Failed to fetch stats") : null,
    refresh: () => mutate(),
  };
}
