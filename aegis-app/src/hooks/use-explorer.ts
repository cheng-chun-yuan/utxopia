"use client";

import useSWR from "swr";
import {
  DEVNET_CONFIG,
  fetchExplorerRedemptions,
  type ExplorerRedemption,
  type RpcClient,
  type IndexerLeaf,
} from "@aegis/sdk";
import { getRpc } from "@/lib/adapters/connection-adapter";
import { address } from "@solana/kit";

const AEGIS_PROGRAM_ID = DEVNET_CONFIG.aegisProgramId;

// =============================================================================
// Types
// =============================================================================

export interface DepositRecord {
  txSignature: string;
  commitment: string;
  amountBtc: string;
  amountSats: number;
  leafIndex: number;
  timestamp: number;
  ephemeralPub?: string;
}

export interface TransferOutput {
  commitment: string;
  leafIndex: number;
}

export interface GroupedTransfer {
  txSignature: string;
  timestamp: number;
  outputs: TransferOutput[];
}

export type { ExplorerRedemption as RedemptionRecord };

// =============================================================================
// Helpers
// =============================================================================

function createRpcAdapter(): RpcClient {
  const rpc = getRpc();
  return {
    async getProgramAccounts(programId, config) {
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
        .getProgramAccounts(address(programId), { encoding: "base64", filters })
        .send();
      return (accounts as any[]).map((acc: any) => ({
        pubkey: String(acc.pubkey),
        account: { data: acc.account.data },
      }));
    },
  };
}

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

// =============================================================================
// Hooks
// =============================================================================

const SWR_OPTIONS = {
  refreshInterval: 30_000,
  dedupingInterval: 5_000,
  revalidateOnFocus: false,
  errorRetryCount: 3,
};

export function useDeposits() {
  const { data, error, isLoading, mutate } = useSWR<DepositRecord[]>(
    "explorer-deposits",
    async () => {
      const leaves = await fetchIndexerLeaves();
      return leaves
        .filter((l) => l.announcement_type === 0)
        .map((l): DepositRecord => ({
          txSignature: l.tx_signature ?? "",
          commitment: l.commitment,
          amountSats: l.amount_sats ?? 0,
          amountBtc: ((l.amount_sats ?? 0) / 1e8).toFixed(8),
          leafIndex: l.leaf_index,
          timestamp: l.created_at ?? 0,
          ephemeralPub: l.ephemeral_pub,
        }))
        .sort((a, b) => b.timestamp - a.timestamp);
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
  const { data, error, isLoading, mutate } = useSWR<GroupedTransfer[]>(
    "explorer-transfers",
    async () => {
      const leaves = await fetchIndexerLeaves();
      const transferLeaves = leaves.filter((l) => l.announcement_type === 1);

      const groups = new Map<string, { timestamp: number; outputs: TransferOutput[] }>();
      for (const leaf of transferLeaves) {
        const sig = leaf.tx_signature ?? "unknown";
        if (!groups.has(sig)) {
          groups.set(sig, { timestamp: leaf.created_at ?? 0, outputs: [] });
        }
        groups.get(sig)!.outputs.push({
          commitment: leaf.commitment,
          leafIndex: leaf.leaf_index,
        });
      }

      return Array.from(groups.entries())
        .map(([txSignature, group]) => ({
          txSignature,
          timestamp: group.timestamp,
          outputs: group.outputs.sort((a, b) => a.leafIndex - b.leafIndex),
        }))
        .sort((a, b) => b.timestamp - a.timestamp);
    },
    SWR_OPTIONS
  );
  return {
    transfers: data ?? [],
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
