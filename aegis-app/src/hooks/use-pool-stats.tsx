"use client";

/**
 * Pool Statistics Hook
 *
 * Fetches from backend /api/pool/stats (cached by reconciler, ~30s).
 * Single fetch replaces 5+ client-side RPC calls.
 */

import useSWR from "swr";
import { PublicKey } from "@solana/web3.js";
import { computeTokenId, initPoseidon } from "@aegis/sdk";
import { SUPPORTED_TOKENS, type SupportedToken } from "@/lib/supported-tokens";
import { getConfig } from "@aegis/sdk";

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

/** Cached token ID hex → token metadata map (built once) */
let tokenIdMap: Map<string, SupportedToken> | null = null;

async function buildTokenIdMap(): Promise<Map<string, SupportedToken>> {
  if (tokenIdMap) return tokenIdMap;

  await initPoseidon();
  const config = getConfig();
  const map = new Map<string, SupportedToken>();

  for (const token of SUPPORTED_TOKENS) {
    try {
      let mintAddr = token.mint;
      if (!mintAddr && token.symbol === "zkBTC") mintAddr = config.zkbtcMint;
      if (!mintAddr || token.isBtcNative) continue;

      const mintBytes = new PublicKey(mintAddr).toBytes();
      const tokenId = computeTokenId(mintBytes);
      // Convert to uppercase hex to match backend hex() output
      const hex = tokenId.toString(16).toUpperCase().padStart(64, "0");
      map.set(hex, token);
    } catch { /* skip invalid mints */ }
  }

  tokenIdMap = map;
  return map;
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

  // Parse per-token TVL from backend
  const tokenTVL: TokenTVL[] = [];
  const backendTVL: { tokenId: string; totalShielded: number }[] = data.tokenTVL ?? [];

  if (backendTVL.length > 0) {
    const idMap = await buildTokenIdMap();
    for (const entry of backendTVL) {
      // Backend returns tokenId as hex from SQLite hex() — uppercase, no 0x prefix
      const hex = entry.tokenId.toUpperCase().padStart(64, "0");
      const token = idMap.get(hex);
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
