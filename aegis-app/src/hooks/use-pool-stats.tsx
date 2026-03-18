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
import { getRpc } from "@/lib/adapters/connection-adapter";
import { VAULT_TOKENS } from "@/lib/supported-tokens";

/** Per-token TVL info */
export interface TokenTVL {
  symbol: string;
  shieldedSymbol: string;
  totalShielded: bigint;
  decimals: number;
}

export interface PoolStats {
  /** Total zkBTC currently in shielded commitments (sats) — "Vault" */
  totalShielded: bigint;
  /** Number of deposits (from pool state counter) */
  depositCount: number;
  /** Total commitments in merkle tree (deposits + transfers + redeems) — "Transactions" */
  totalCommitments: number;
  /** Total transaction volume: total_minted + total_burned (sats) — "Volume" */
  volume: bigint;
  /** Per-token TVL from TokenConfig PDAs */
  tokenTVL: TokenTVL[];
}

/**
 * Fetch pool stats from on-chain data.
 */
/**
 * Derive TokenConfig PDA address for a given mint.
 * Seeds: ["token_config", mint_pubkey_bytes]
 */
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

async function fetchPoolStats(): Promise<PoolStats> {
  let totalShielded = 0n;
  let depositCount = 0n;
  let totalMinted = 0n;
  let totalBurned = 0n;
  let totalCommitments = 0;
  const tokenTVL: TokenTVL[] = [];

  // Fetch pool state + commitment tree in parallel
  const [poolInfo, treeInfo] = await Promise.all([
    fetchAccountInfo(getConfig().poolStatePda),
    fetchAccountInfo(getConfig().commitmentTreePda),
  ]);

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

  // Commitment tree: next_index at offset 8 (after disc(1) + bump(1) + padding(6))
  // counts all commitments (deposits + transfers + redeems)
  if (treeInfo && treeInfo.data.length >= 48 && treeInfo.data[0] === 0x05) {
    const view = new DataView(
      treeInfo.data.buffer,
      treeInfo.data.byteOffset,
      treeInfo.data.byteLength
    );
    // next_index is at offset 40 (disc:1 + bump:1 + padding:6 + current_root:32 = 40)
    totalCommitments = Number(view.getBigUint64(40, true));
  }

  // Fetch per-token TVL from TokenConfig PDAs
  // TokenConfig layout: disc(1) + bump(1) + mint(32) + token_id(32) + vault(32) + decimals(1) + enabled(1)
  //   + service_fee(8) + min_deposit(8) + max_deposit(8) + deposit_cap(8) + total_shielded(8) + ...
  // total_shielded is at offset 132
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
  } catch (e) {
    // Non-critical — TVL just won't show per-token data
    console.warn("Failed to fetch TokenConfig PDAs:", e);
  }

  // Also add zkBTC from pool state (BTC deposits tracked separately)
  if (totalShielded > 0n) {
    tokenTVL.unshift({
      symbol: "BTC",
      shieldedSymbol: "zkBTC",
      totalShielded,
      decimals: 8,
    });
  }

  // Volume = total minted + total burned (represents all BTC flow through the bridge)
  const volume = totalMinted + totalBurned;

  return { totalShielded, depositCount: Number(depositCount), totalCommitments, volume, tokenTVL };
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
