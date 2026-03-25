"use client";

import useSWR from "swr";
import type { IndexerLeaf } from "@aegis/sdk";

// =============================================================================
// Types
// =============================================================================

/** BTC-specific metadata */
export interface BtcDepositMeta {
  depositTxid: string | null;
  sweepTxid: string | null;
  taprootAddress: string | null;
  confirmations: number;
  sweepConfirmations: number;
  sweepFeeSats: number | null;
  mintedSats: number | null;
  depositAmountSats: number | null;
  trackerError: string | null;
}

export interface DepositRecord {
  txSignature: string;
  commitment: string;
  amountSats: number;
  leafIndex: number;
  timestamp: number;
  status: string | null;
  instructionDisc: number | null;
  tokenSymbol: string | null;
  tokenId: string | null;
  ephemeralPub?: string;
  /** Gross amount before fee */
  grossAmount: number | null;
  /** Protocol fee deducted */
  fee: number | null;
  /** BTC-specific — null for SPL deposits */
  btcMeta: BtcDepositMeta | null;
}

export interface TransferOutput {
  commitment: string;
  leafIndex: number;
}

/** Typed output in a transaction */
export interface TxOutput {
  type: "commitment" | "unshield" | "withdraw";
  commitment?: string;
  leafIndex?: number;
  amount?: number;
  fee?: number;
  payout?: number;
  recipient?: string;
  requestId?: string;
  btcScript?: string;
  btcTxid?: string;
  localStatus?: string;
}

/** Input in a transaction */
export interface TxInput {
  nullifierHash?: string;
  nullifierPda?: string;
  // Shield-specific
  grossAmount?: number;
  fee?: number;
  netAmount?: number;
  btcDepositTxid?: string;
  btcSweepTxid?: string;
  taprootAddress?: string;
  depositAmountSats?: number;
}

/** Unified transaction type used across the explorer */
export interface ExplorerTransaction {
  txSignature: string;
  type: "shield" | "transfer" | "unshield" | "withdraw";
  tokenId: string | null;
  tokenSymbol: string | null;
  timestamp: number;
  status: string;
  inputs: TxInput[];
  outputs: TxOutput[];
  /** BTC deposit lifecycle (shield only) */
  btcMeta?: any;
}

/** @deprecated Use ExplorerTransaction instead */
export interface GroupedTransfer {
  txSignature: string;
  timestamp: number;
  status: "confirmed" | "processing";
  inputCount: number;
  nullifierPdas: string[];
  outputs: TransferOutput[];
  operationType: number;
  instructionDisc?: number;
  unshieldAmount?: number;
  unshieldRecipient?: string;
  tokenId?: string;
  tokenSymbol?: string;
  transferType?: string;
  unshieldFee?: number;
  unshieldPayout?: number;
}

export interface RedemptionRecord {
  pubkey: string;
  requestId: string;
  amountSats: string;
  status: "Pending" | "Processing" | "Failed" | "Completed";
  requester: string;
  btcScript: string;
  // Enriched from backend tracking
  btcTxid: string | null;
  localStatus: string | null;
  createdAt: number;
  updatedAt: number;
  retryCount: number;
  trackerError: string | null;
  // Actual BTC received by user (net of fees, from completion event)
  actualReceived: string | null;
  // On-chain event tx signatures
  requestTxSignature: string | null;
  processingTxSignature: string | null;
  completeTxSignature: string | null;
  // Fee config + simulation flag
  simulated: boolean;
  /** Service fee locked at request time (from PDA), null if PDA closed */
  serviceFee: string | null;
  serviceFeeBps: number;
  serviceFeeBase: number;
  /** zkBTC actually burned from vault (from completion event) */
  burnAmount: string | null;
  /** Protocol revenue retained in vault (from completion event) */
  protocolRevenue: string | null;
  /** JoinSplit input count (nullifiers spent) */
  inputCount: number;
  /** JoinSplit output count (commitments created + redeem) */
  outputCount: number;
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
  timestamp: number;
  status: string;
  operation_type: number;
  instruction_disc?: number;
  unshield_amount?: number;
  unshield_recipient?: string;
  token_id?: string;
  token_symbol?: string;
  transfer_type?: string;
  unshield_fee?: number;
  unshield_payout?: number;
}

// Backend announcement row from /api/announcements
interface AnnouncementRow {
  leaf_index: number;
  announcement_type: number;
  ephemeral_pub: string;
  encrypted_amount: string;
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
    created_at: 0,
    announcement_type: a.announcement_type,
    amount_sats:
      a.announcement_type === 0 ? decodeLeU64(a.encrypted_amount) : undefined,
    ephemeral_pub: a.ephemeral_pub,
    tx_signature: a.tx_signature,
  }));
}

// =============================================================================
// Hooks — ALL data comes from server-side API routes, zero client RPC calls
// =============================================================================

const SWR_OPTIONS = {
  refreshInterval: 30_000,
  dedupingInterval: 5_000,
  revalidateOnFocus: false,
  errorRetryCount: 3,
};

/** @deprecated Use useExplorer() instead */
export function useDeposits() {
  const { data, error, isLoading, mutate } = useSWR<{ deposits: DepositRecord[]; transactions: ExplorerTransaction[] }>(
    "explorer-deposits",
    async () => {
      const resp = await fetch("/api/explorer/deposits");
      if (!resp.ok) return { deposits: [], transactions: [] };
      const json = await resp.json();
      const deposits = (json.deposits ?? []).map(
        (d: any): DepositRecord => ({ ...d, amountBtc: (d.amountSats / 1e8).toFixed(8) }),
      );
      const transactions = (json.transactions ?? []) as ExplorerTransaction[];
      return { deposits, transactions };
    },
    SWR_OPTIONS,
  );
  return {
    deposits: data?.deposits ?? [],
    shieldTransactions: data?.transactions ?? [],
    isLoading,
    error: error ? (error instanceof Error ? error.message : "Failed to fetch deposits") : null,
    refresh: () => mutate(),
  };
}

export function useTransfers() {
  const { data, error, isLoading, mutate } = useSWR<ExplorerTransaction[]>(
    "explorer-transfers",
    async () => {
      const resp = await fetch("/api/transfers");
      if (!resp.ok) return [];
      const json = await resp.json();
      // New format: json.transactions (typed outputs)
      if (json.transactions) return json.transactions as ExplorerTransaction[];
      // Legacy fallback: json.transfers (flat)
      if (json.transfers) {
        return json.transfers.map((t: any) => ({
          txSignature: t.tx_signature ?? t.txSignature,
          type: t.transfer_type === "redeem" ? "withdraw" : t.transfer_type === "unshield" ? "unshield" : "transfer",
          tokenId: t.token_id ?? t.tokenId ?? null,
          tokenSymbol: t.token_symbol ?? t.tokenSymbol ?? null,
          timestamp: t.timestamp,
          status: t.status ?? "confirmed",
          inputs: (t.nullifier_hashes ?? []).map((h: string, i: number) => ({
            nullifierHash: h,
            nullifierPda: (t.nullifier_pdas ?? [])[i],
          })),
          outputs: [
            ...(t.commitments ?? []).map((c: string, i: number) => ({
              type: "commitment" as const,
              commitment: c,
              leafIndex: (t.leaf_indices ?? [])[i],
            })),
            ...(t.unshield_amount != null ? [{
              type: (t.transfer_type === "redeem" ? "withdraw" : "unshield") as "withdraw" | "unshield",
              amount: t.unshield_amount,
              fee: t.unshield_fee,
              payout: t.unshield_payout,
              recipient: t.unshield_recipient,
            }] : []),
          ],
        }));
      }
      return [];
    },
    {
      ...SWR_OPTIONS,
      refreshInterval: (data?: ExplorerTransaction[]) => {
        if (!data) return SWR_OPTIONS.refreshInterval;
        const hasProcessing = data.some((t) => t.status === "processing");
        return hasProcessing ? 5_000 : SWR_OPTIONS.refreshInterval;
      },
    },
  );
  return {
    transfers: data ?? [],
    isLoading,
    error: error ? (error instanceof Error ? error.message : "Failed to fetch transfers") : null,
    refresh: () => mutate(),
  };
}

export function useRedemptions() {
  const { data, error, isLoading, mutate } = useSWR<RedemptionRecord[]>(
    "explorer-redemptions",
    async () => {
      const resp = await fetch("/api/explorer/redemptions");
      if (!resp.ok) return []; // graceful fallback
      const json = await resp.json();
      return json.redemptions ?? [];
    },
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

// =============================================================================
// Unified hook — single source for all explorer transactions
// =============================================================================

/**
 * Unified explorer hook. Fetches shields (deposits) + transfers/unshields/withdraws
 * in parallel and returns a single sorted ExplorerTransaction[].
 *
 * Types: shield | transfer | unshield | withdraw
 */
export function useExplorer() {
  const { data, error, isLoading, mutate } = useSWR<ExplorerTransaction[]>(
    "explorer-unified",
    async () => {
      const [depositsResp, transfersResp] = await Promise.all([
        fetch("/api/explorer/deposits").catch(() => null),
        fetch("/api/transfers").catch(() => null),
      ]);

      const all: ExplorerTransaction[] = [];

      // Shields from deposits API
      if (depositsResp?.ok) {
        const json = await depositsResp.json();
        const txns = (json.transactions ?? []) as ExplorerTransaction[];
        all.push(...txns);
      }

      // Transfers/unshields/withdraws from transfers API
      if (transfersResp?.ok) {
        const json = await transfersResp.json();
        if (json.transactions) {
          all.push(...(json.transactions as ExplorerTransaction[]));
        }
      }

      // Sort by timestamp desc
      all.sort((a, b) => b.timestamp - a.timestamp);
      return all;
    },
    {
      ...SWR_OPTIONS,
      refreshInterval: (data?: ExplorerTransaction[]) => {
        if (!data) return SWR_OPTIONS.refreshInterval;
        const hasProcessing = data.some((t) => t.status === "processing");
        return hasProcessing ? 5_000 : SWR_OPTIONS.refreshInterval;
      },
    },
  );

  return {
    transactions: data ?? [],
    isLoading,
    error: error ? (error instanceof Error ? error.message : "Failed to fetch explorer data") : null,
    refresh: () => mutate(),
  };
}

// Re-export for backwards compatibility — SDK callers that need IndexerLeaf[]
export { fetchAnnouncements, toIndexerLeaves };
