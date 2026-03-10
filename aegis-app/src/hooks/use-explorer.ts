"use client";

import useSWR from "swr";
import {
  DEVNET_CONFIG,
  fetchExplorerRedemptions,
  parseProgramEvents,
  type ExplorerRedemption,
  type RpcClient,
  type IndexerLeaf,
} from "@aegis/sdk";
import { getRpc } from "@/lib/adapters/connection-adapter";
import { address, getBase58Decoder } from "@solana/kit";

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
  inputCount: number;
  nullifierPdas: string[];
  outputs: TransferOutput[];
}

// Backend transfer row from /api/transfers
interface BackendTransferRow {
  tx_signature: string;
  commitments: string[];
  leaf_indices: number[];
  nullifier_hashes: string[];
  nullifier_pdas: string[];
  output_count: number;
  input_count: number;
  timestamp: number; // spent_at from nullifier_events
}

interface TransfersResponse {
  success: boolean;
  transfers: BackendTransferRow[];
  count: number;
}

export type { ExplorerRedemption as RedemptionRecord };

// Backend announcement row from /api/announcements
interface AnnouncementRow {
  leaf_index: number;
  announcement_type: number;
  ephemeral_pub: string;
  encrypted_amount: string; // hex — for deposits (type=0), this is LE u64 plaintext
  commitment: string;
  tx_signature: string;
  slot: number;
}

interface AnnouncementsResponse {
  success: boolean;
  announcements: AnnouncementRow[];
  count: number;
  latest_leaf_index: number | null;
}

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

/** Decode LE u64 from hex string (for deposit amounts) */
function decodeLeU64(hex: string): number {
  try {
    const bytes = Uint8Array.from(
      hex.match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) ?? [],
    );
    if (bytes.length < 8) return 0;
    const view = new DataView(bytes.buffer);
    return Number(view.getBigUint64(0, true));
  } catch {
    return 0;
  }
}

async function fetchAnnouncements(): Promise<AnnouncementRow[]> {
  try {
    const resp = await fetch("/api/announcements");
    if (!resp.ok) return [];
    const data: AnnouncementsResponse = await resp.json();
    return data.announcements ?? [];
  } catch {
    return [];
  }
}

/** Convert announcements to IndexerLeaf format for SDK compatibility */
function toIndexerLeaves(announcements: AnnouncementRow[]): IndexerLeaf[] {
  return announcements.map((a) => ({
    leaf_index: a.leaf_index,
    commitment: a.commitment,
    created_at: 0, // announcements don't carry created_at; use slot as proxy
    announcement_type: a.announcement_type,
    amount_sats:
      a.announcement_type === 0 ? decodeLeU64(a.encrypted_amount) : undefined,
    ephemeral_pub: a.ephemeral_pub,
    tx_signature: a.tx_signature,
  }));
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
      const announcements = await fetchAnnouncements();
      const deposits = announcements.filter((a) => a.announcement_type === 0);

      // Fetch blockTime for each unique tx
      const rpc = getRpc();
      const sigs = [...new Set(deposits.map((a) => a.tx_signature).filter(Boolean))];
      const txResults = await Promise.allSettled(
        sigs.map((sig) =>
          rpc
            .getTransaction(sig as Parameters<typeof rpc.getTransaction>[0], {
              encoding: "json",
              maxSupportedTransactionVersion: 0,
            })
            .send()
        ),
      );
      const timeMap = new Map<string, number>();
      for (let i = 0; i < sigs.length; i++) {
        const r = txResults[i];
        if (r.status === "fulfilled" && r.value) {
          timeMap.set(sigs[i], Number((r.value as any).blockTime ?? 0));
        }
      }

      return deposits
        .map(
          (a): DepositRecord => ({
            txSignature: a.tx_signature ?? "",
            commitment: a.commitment,
            amountSats: decodeLeU64(a.encrypted_amount),
            amountBtc: (decodeLeU64(a.encrypted_amount) / 1e8).toFixed(8),
            leafIndex: a.leaf_index,
            timestamp: timeMap.get(a.tx_signature) ?? 0,
            ephemeralPub: a.ephemeral_pub,
          }),
        )
        .sort((a, b) => b.leafIndex - a.leafIndex);
    },
    SWR_OPTIONS,
  );
  return {
    deposits: data ?? [],
    isLoading,
    error: error
      ? error instanceof Error
        ? error.message
        : "Failed to fetch deposits"
      : null,
    refresh: () => mutate(),
  };
}

export function useTransfers() {
  const { data, error, isLoading, mutate } = useSWR<GroupedTransfer[]>(
    "explorer-transfers",
    async () => {
      // Try backend /api/transfers (pre-joined with nullifiers)
      try {
        const resp = await fetch("/api/transfers");
        if (resp.ok) {
          const data: TransfersResponse = await resp.json();
          if (data.success && data.transfers) {
            return data.transfers.map((t) => ({
              txSignature: t.tx_signature,
              timestamp: t.timestamp,
              inputCount: t.input_count,
              nullifierPdas: t.nullifier_pdas ?? [],
              outputs: t.commitments.map((c, i) => ({
                commitment: c,
                leafIndex: t.leaf_indices[i] ?? 0,
              })),
            }));
          }
        }
      } catch {
        // fall through to announcement-based fallback
      }

      // Fallback: group announcements + fetch each tx for inputs/time
      const announcements = await fetchAnnouncements();
      const transferAnn = announcements.filter(
        (a) => a.announcement_type === 1,
      );

      const groups = new Map<
        string,
        { outputs: TransferOutput[] }
      >();
      for (const a of transferAnn) {
        const sig = a.tx_signature ?? "unknown";
        if (!groups.has(sig)) {
          groups.set(sig, { outputs: [] });
        }
        groups.get(sig)!.outputs.push({
          commitment: a.commitment,
          leafIndex: a.leaf_index,
        });
      }

      // Fetch each tx to get blockTime + parse nullifier events from logs
      const rpc = getRpc();
      const sigs = Array.from(groups.keys()).filter((s) => s !== "unknown");
      const txDetails = await Promise.allSettled(
        sigs.map((sig) =>
          rpc
            .getTransaction(sig as Parameters<typeof rpc.getTransaction>[0], {
              encoding: "json",
              maxSupportedTransactionVersion: 0,
            })
            .send()
        ),
      );

      const txMap = new Map<
        string,
        { timestamp: number; nullifierPdas: string[] }
      >();
      for (let i = 0; i < sigs.length; i++) {
        const result = txDetails[i];
        if (result.status !== "fulfilled" || !result.value) continue;
        const tx = result.value as any;
        const blockTime = Number(tx.blockTime ?? 0);

        // Parse nullifier events from transaction logs
        const logs: string[] = tx.meta?.logMessages ?? [];
        const events = parseProgramEvents(logs, AEGIS_PROGRAM_ID);
        const nullifierPdas: string[] = [];
        for (const evt of events) {
          if (evt.type === "nullifier_spent") {
            const hashHex = Array.from(evt.nullifierHash)
              .map((b: number) => b.toString(16).padStart(2, "0"))
              .join("");
            try {
              const { nullifierHashToPDA } = await import(
                "@/lib/nullifier-utils"
              );
              nullifierPdas.push(nullifierHashToPDA(hashHex));
            } catch {
              // skip if PDA derivation fails
            }
          }
        }

        txMap.set(sigs[i], { timestamp: blockTime, nullifierPdas });
      }

      return Array.from(groups.entries())
        .map(([txSignature, group]) => {
          const detail = txMap.get(txSignature);
          return {
            txSignature,
            timestamp: detail?.timestamp ?? 0,
            inputCount: detail?.nullifierPdas.length ?? 0,
            nullifierPdas: detail?.nullifierPdas ?? [],
            outputs: group.outputs.sort((a, b) => a.leafIndex - b.leafIndex),
          };
        })
        .sort((a, b) => b.timestamp - a.timestamp);
    },
    SWR_OPTIONS,
  );
  return {
    transfers: data ?? [],
    isLoading,
    error: error
      ? error instanceof Error
        ? error.message
        : "Failed to fetch transfers"
      : null,
    refresh: () => mutate(),
  };
}

export function useRedemptions() {
  const { data, error, isLoading, mutate } = useSWR<ExplorerRedemption[]>(
    "explorer-redemptions",
    () => fetchExplorerRedemptions(createRpcAdapter(), AEGIS_PROGRAM_ID),
    SWR_OPTIONS,
  );
  return {
    redemptions: data ?? [],
    isLoading,
    error: error
      ? error instanceof Error
        ? error.message
        : "Failed to fetch redemptions"
      : null,
    refresh: () => mutate(),
  };
}

// Re-export for backwards compatibility — SDK callers that need IndexerLeaf[]
export { fetchAnnouncements, toIndexerLeaves };
