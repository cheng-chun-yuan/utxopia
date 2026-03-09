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
} from "@aegis/sdk";
import { getRpc } from "@/lib/adapters/connection-adapter";
import { address } from "@solana/kit";

const AEGIS_PROGRAM_ID = DEVNET_CONFIG.aegisProgramId;

// Re-export types for the page component
export type { ExplorerDeposit, ExplorerTransferEvent, ExplorerRedemption };

// Enriched deposit with BTC tracker data
export interface EnrichedDeposit extends ExplorerDeposit {
  btcTxid?: string;
  sweepTxid?: string;
  taprootAddress?: string;
  depositStatus?: string;
  confirmations?: number;
  sweepConfirmations?: number;
}

// Convenience aliases matching the old names used by the page
export type DepositRecord = EnrichedDeposit;
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

/** Deposit tracker status response */
interface DepositTrackerItem {
  id: string;
  status: string;
  taproot_address: string;
  amount_sats: number;
  confirmations: number;
  btc_txid?: string;
  sweep_txid?: string;
  sweep_confirmations: number;
  solana_tx?: string;
  leaf_index?: number;
  npk?: string;
  ephemeral_pub?: string;
}

/** Fetch deposit tracker data from backend */
async function fetchDepositTrackerData(): Promise<DepositTrackerItem[]> {
  try {
    const resp = await fetch("/api/deposits");
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.deposits ?? [];
  } catch {
    return [];
  }
}

export function useDeposits() {
  const { data, error, isLoading, mutate } = useSWR<EnrichedDeposit[]>(
    "explorer-deposits",
    async () => {
      const [rpcAdapter, leaves, trackerDeposits] = await Promise.all([
        Promise.resolve(createRpcAdapter()),
        fetchIndexerLeaves(),
        fetchDepositTrackerData(),
      ]);
      const deposits = await fetchExplorerDeposits(rpcAdapter, AEGIS_PROGRAM_ID, leaves);

      // Build lookup maps from tracker data
      const byLeafIndex = new Map<number, DepositTrackerItem>();
      const byCommitment = new Map<string, DepositTrackerItem>();
      for (const td of trackerDeposits) {
        if (td.leaf_index != null) byLeafIndex.set(td.leaf_index, td);
      }

      // Enrich deposits with tracker data
      return deposits.map((d): EnrichedDeposit => {
        const tracker = byLeafIndex.get(Number(d.leafIndex));
        if (!tracker) return d;
        return {
          ...d,
          btcTxid: tracker.btc_txid ?? undefined,
          sweepTxid: tracker.sweep_txid ?? undefined,
          taprootAddress: tracker.taproot_address,
          depositStatus: tracker.status,
          confirmations: tracker.confirmations,
          sweepConfirmations: tracker.sweep_confirmations,
        };
      });
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
      return fetchExplorerTransfers(rpcAdapter, AEGIS_PROGRAM_ID, leaves);
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
    () => fetchExplorerRedemptions(createRpcAdapter(), AEGIS_PROGRAM_ID),
    SWR_OPTIONS
  );
  return {
    redemptions: data ?? [],
    isLoading,
    error: error ? (error instanceof Error ? error.message : "Failed to fetch redemptions") : null,
    refresh: () => mutate(),
  };
}
