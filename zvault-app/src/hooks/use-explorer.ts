"use client";

import useSWR from "swr";
import {
  DEVNET_CONFIG,
  fetchExplorerDeposits,
  fetchExplorerTransfers,
  fetchExplorerRedemptions,
  type ExplorerDeposit,
  type ExplorerTransferEvent,
  type ExplorerRedemption,
  type RpcClient,
  type IndexerLeaf,
} from "@zvault/sdk";
import { getRpc } from "@/lib/adapters/connection-adapter";
import { address } from "@solana/kit";

const ZVAULT_PROGRAM_ID = DEVNET_CONFIG.zvaultProgramId;

// Re-export types for the page component
export type { ExplorerDeposit, ExplorerTransferEvent, ExplorerRedemption };

// Convenience aliases matching the old names used by the page
export type DepositRecord = ExplorerDeposit;
export type TransferEvent = ExplorerTransferEvent;
export type RedemptionRecord = ExplorerRedemption;

/**
 * Adapt @solana/kit Rpc (requires .send()) to SDK's RpcClient interface
 */
function createRpcAdapter(): RpcClient {
  const rpc = getRpc();
  return {
    async getProgramAccounts(programId, config) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const filters: any[] = [];
      if (config?.filters) {
        for (const f of config.filters) {
          if ("dataSize" in f) {
            filters.push({ dataSize: BigInt(f.dataSize) });
          } else if ("memcmp" in f) {
            filters.push({
              memcmp: {
                offset: BigInt(f.memcmp.offset),
                bytes: f.memcmp.bytes,
                encoding: "base58" as const,
              },
            });
          }
        }
      }

      const accounts = await rpc
        .getProgramAccounts(address(programId), {
          encoding: "base64",
          filters,
        })
        .send();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (accounts as any[]).map((acc: any) => ({
        pubkey: String(acc.pubkey),
        account: { data: acc.account.data },
      }));
    },
  };
}

// =============================================================================
// Hooks
// =============================================================================

const SWR_OPTIONS = {
  refreshInterval: 30_000,
  dedupingInterval: 5_000,
  revalidateOnFocus: false,
  errorRetryCount: 3,
};

/** Fetch leaf data from the backend event indexer (proxied via Next.js API route) */
async function fetchIndexerLeaves(): Promise<IndexerLeaf[]> {
  try {
    const resp = await fetch("/api/tree/leaves");
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.leaves ?? [];
  } catch {
    return [];
  }
}

export function useDeposits() {
  const { data, error, isLoading, mutate } = useSWR<ExplorerDeposit[]>(
    "explorer-deposits",
    async () => {
      const [rpcAdapter, leaves] = await Promise.all([
        Promise.resolve(createRpcAdapter()),
        fetchIndexerLeaves(),
      ]);
      return fetchExplorerDeposits(rpcAdapter, ZVAULT_PROGRAM_ID, leaves);
    },
    SWR_OPTIONS
  );
  return {
    deposits: data ?? [],
    isLoading,
    error: error ? (error instanceof Error ? error.message : "Failed to fetch deposits") : null,
    refresh: () => mutate(),
  };
}

export function useTransfers() {
  const { data, error, isLoading, mutate } = useSWR<ExplorerTransferEvent[]>(
    "explorer-transfers",
    async () => {
      const [rpcAdapter, leaves] = await Promise.all([
        Promise.resolve(createRpcAdapter()),
        fetchIndexerLeaves(),
      ]);
      return fetchExplorerTransfers(rpcAdapter, ZVAULT_PROGRAM_ID, leaves);
    },
    SWR_OPTIONS
  );
  return {
    events: data ?? [],
    isLoading,
    error: error ? (error instanceof Error ? error.message : "Failed to fetch transfers") : null,
    refresh: () => mutate(),
  };
}

export function useRedemptions() {
  const { data, error, isLoading, mutate } = useSWR<ExplorerRedemption[]>(
    "explorer-redemptions",
    () => fetchExplorerRedemptions(createRpcAdapter(), ZVAULT_PROGRAM_ID),
    SWR_OPTIONS
  );
  return {
    redemptions: data ?? [],
    isLoading,
    error: error ? (error instanceof Error ? error.message : "Failed to fetch redemptions") : null,
    refresh: () => mutate(),
  };
}
