"use client";

/**
 * Pool Statistics Hook
 *
 * Fetches from backend /api/pool/stats (cached by reconciler, ~30s).
 * Single fetch replaces 5+ client-side RPC calls.
 */

import useSWR from "swr";
import { detectNetwork, type NetworkId } from "@/lib/network-config";
import { getTokenBySymbol } from "@/lib/supported-tokens";
import { buildTokenIdMap } from "@/lib/token-map";

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

async function fetchPoolStats(network: NetworkId): Promise<PoolStats> {
  const resp = await fetch(`/api/pool/stats?network=${encodeURIComponent(network)}`, {
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

  // Parse per-token TVL from backend
  const tokenTVL: TokenTVL[] = [];
  const backendTVL: { tokenId: string; totalShielded: number }[] = data.tokenTVL ?? [];

  if (backendTVL.length > 0) {
    const idMap = await buildTokenIdMap();
    for (const entry of backendTVL) {
      // Backend returns tokenId as hex from SQLite hex() — try both cases
      const hex = entry.tokenId.toLowerCase().padStart(64, "0");
      const symbol = idMap.get(hex) ?? idMap.get(entry.tokenId.toUpperCase().padStart(64, "0"));
      const token = symbol ? getTokenBySymbol(symbol) : null;
      if (token && entry.totalShielded > 0) {
        tokenTVL.push({
          symbol: token.symbol,
          shieldedSymbol: token.shieldedSymbol,
          totalShielded: BigInt(entry.totalShielded),
          decimals: token.decimals,
        });
      }
    }
  }

  // Fallback: if backend has no per-token data but on-chain shows shielded BTC
  if (tokenTVL.length === 0 && totalShielded > 0n) {
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
  const network = detectNetwork();
  const { data: stats, error, isLoading, mutate } = useSWR<PoolStats>(
    ["pool-stats", network],
    () => fetchPoolStats(network),
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
