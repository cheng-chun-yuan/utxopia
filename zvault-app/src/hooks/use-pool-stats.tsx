"use client";

/**
 * Pool Statistics Hook
 *
 * Fetches zVault pool statistics using @solana/kit for efficient RPC calls.
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
import { DEVNET_CONFIG } from "@zvault/sdk";
import { fetchAccountInfo, getRpc } from "@/lib/adapters/connection-adapter";
import { address } from "@solana/kit";

export interface PoolStats {
  /** Total zBTC currently in shielded commitments (sats) — "Vault" */
  totalShielded: bigint;
  /** Number of stealth announcement PDAs on-chain — "Deposits" */
  stealthAnnouncementCount: number;
  /** Total transaction volume: deposit_count + total_minted + total_burned (sats) — "Volume" */
  volume: bigint;
}

const POOL_STATE_ADDRESS = DEVNET_CONFIG.poolStatePda;
const ZVAULT_PROGRAM_ID = DEVNET_CONFIG.zvaultProgramId;
const STEALTH_ANNOUNCEMENT_SIZE = 90;

/**
 * Fetch pool stats from on-chain data.
 */
async function fetchPoolStats(): Promise<PoolStats> {
  let totalShielded = 0n;
  let depositCount = 0n;
  let totalMinted = 0n;
  let totalBurned = 0n;
  let stealthAnnouncementCount = 0;

  // Fetch pool state for counters
  const poolInfo = await fetchAccountInfo(POOL_STATE_ADDRESS);

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

  // Count stealth announcements (deposits + transfers) via getProgramAccounts
  try {
    const rpc = getRpc();
    const accounts = await rpc
      .getProgramAccounts(address(ZVAULT_PROGRAM_ID), {
        dataSlice: { offset: 0, length: 1 },
        filters: [{ dataSize: BigInt(STEALTH_ANNOUNCEMENT_SIZE) }],
        encoding: "base64",
      })
      .send();
    stealthAnnouncementCount = accounts.length;
  } catch {
    // Fall back to deposit_count if getProgramAccounts fails
    stealthAnnouncementCount = Number(depositCount);
  }

  // Volume = total minted + total burned (represents all BTC flow through the bridge)
  const volume = totalMinted + totalBurned;

  return { totalShielded, stealthAnnouncementCount, volume };
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
