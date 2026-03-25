"use client";

/**
 * Pool Statistics Hook
 *
 * Fetches pool stats from backend /api/reconciliation/status (which reads on-chain PDAs).
 * Falls back to direct RPC if backend unavailable.
 */

import useSWR from "swr";
import { getConfig } from "@aegis/sdk";
import { fetchAccountInfo } from "@/lib/adapters/connection-adapter";
import { VAULT_TOKENS } from "@/lib/supported-tokens";
import { getNetworkConfig } from "@/lib/network-config";

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

async function deriveTokenConfigAddress(mintBase58: string): Promise<string> {
  const { PublicKey } = await import("@solana/web3.js");
  const config = getConfig();
  const programId = new PublicKey(config.aegisProgramId);
  const mintPubkey = new PublicKey(mintBase58);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_config"), mintPubkey.toBuffer()],
    programId
  );
  return pda.toBase58();
}

async function fetchFromBackend(): Promise<PoolStats | null> {
  try {
    const backendUrl = getNetworkConfig().backend.url;
    if (!backendUrl) return null;

    const resp = await fetch(`${backendUrl}/api/reconciliation/status`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;

    const data = await resp.json();
    const onChain = data.reconciliation?.on_chain;
    if (!onChain) return null;

    return {
      totalShielded: BigInt(onChain.total_shielded ?? 0),
      depositCount: Number(onChain.deposit_count ?? 0),
      totalCommitments: Number(onChain.tree_next_index ?? 0),
      volume: BigInt(onChain.total_minted ?? 0) + BigInt(onChain.total_burned ?? 0),
      tokenTVL: [], // filled by RPC fallback below if needed
    };
  } catch {
    return null;
  }
}

async function fetchTokenTVL(): Promise<TokenTVL[]> {
  const tokenTVL: TokenTVL[] = [];
  try {
    const tokensWithMint = VAULT_TOKENS.filter((t) => t.mint);
    const configAddresses = await Promise.all(
      tokensWithMint.map((t) => deriveTokenConfigAddress(t.mint))
    );
    const configInfos = await Promise.all(
      configAddresses.map((addr) => fetchAccountInfo(addr))
    );

    for (let i = 0; i < tokensWithMint.length; i++) {
      const info = configInfos[i];
      const token = tokensWithMint[i];
      if (info && info.data.length >= 140 && info.data[0] === 0x0b) {
        const view = new DataView(
          info.data.buffer,
          info.data.byteOffset,
          info.data.byteLength
        );
        const shielded = view.getBigUint64(132, true);
        if (shielded > 0n) {
          tokenTVL.push({
            symbol: token.symbol,
            shieldedSymbol: token.shieldedSymbol,
            totalShielded: shielded,
            decimals: token.decimals,
          });
        }
      }
    }
  } catch {
    // Non-critical
  }
  return tokenTVL;
}

async function fetchPoolStats(): Promise<PoolStats> {
  // Try backend first (reads on-chain via reconciler)
  const backendStats = await fetchFromBackend();

  if (backendStats) {
    // Enrich with per-token TVL from RPC (backend doesn't track this)
    const tokenTVL = await fetchTokenTVL();
    if (backendStats.totalShielded > 0n) {
      tokenTVL.unshift({
        symbol: "BTC",
        shieldedSymbol: "zkBTC",
        totalShielded: backendStats.totalShielded,
        decimals: 8,
      });
    }
    return { ...backendStats, tokenTVL };
  }

  // Fallback: direct RPC
  let totalShielded = 0n;
  let depositCount = 0n;
  let totalMinted = 0n;
  let totalBurned = 0n;
  let totalCommitments = 0;

  const [poolInfo, treeInfo] = await Promise.all([
    fetchAccountInfo(getConfig().poolStatePda),
    fetchAccountInfo(getConfig().commitmentTreePda),
  ]);

  if (poolInfo && poolInfo.data.length >= 196 && poolInfo.data[0] === 0x01) {
    const view = new DataView(poolInfo.data.buffer, poolInfo.data.byteOffset, poolInfo.data.byteLength);
    depositCount = view.getBigUint64(132, true);
    totalMinted = view.getBigUint64(140, true);
    totalBurned = view.getBigUint64(148, true);
    totalShielded = view.getBigUint64(188, true);
  }

  if (treeInfo && treeInfo.data.length >= 48 && treeInfo.data[0] === 0x05) {
    const view = new DataView(treeInfo.data.buffer, treeInfo.data.byteOffset, treeInfo.data.byteLength);
    totalCommitments = Number(view.getBigUint64(40, true));
  }

  const tokenTVL = await fetchTokenTVL();
  if (totalShielded > 0n) {
    tokenTVL.unshift({
      symbol: "BTC",
      shieldedSymbol: "zkBTC",
      totalShielded,
      decimals: 8,
    });
  }

  return { totalShielded, depositCount: Number(depositCount), totalCommitments, volume: totalMinted + totalBurned, tokenTVL };
}

export function usePoolStats() {
  const { data: stats, error, isLoading, mutate } = useSWR<PoolStats>("pool-stats", fetchPoolStats, {
    refreshInterval: 30000,
    dedupingInterval: 5000,
    revalidateOnFocus: false,
    errorRetryCount: 3,
  });

  return {
    stats: stats ?? null,
    isLoading,
    error: error ? (error instanceof Error ? error.message : "Failed to fetch stats") : null,
    refresh: () => mutate(),
  };
}
