"use client";

import useSWR from "swr";
import type { IndexerLeaf } from "@utxopia/sdk";
import { detectNetwork } from "@/lib/network-config";

// =============================================================================
// Types
// =============================================================================

/** BTC-specific metadata */
export interface BtcDepositMeta {
  depositTxid: string | null;
  sweepTxid: string | null;
  taprootAddress: string | null;
  /** Mempool conf count from the tracker (pending deposits only). Null
   *  once landed — use depositBlockHeight + the live tip height instead. */
  confirmations: number | null;
  sweepConfirmations: number | null;
  sweepFeeSats: number | null;
  mintedSats: number | null;
  depositAmountSats: number | null;
  /** BTC block where the deposit tx confirmed. Frontend computes
   *  `tip − depositBlockHeight + 1` for live confirmations. */
  depositBlockHeight: number | null;
  /** BTC block where the sweep tx confirmed. */
  sweepBlockHeight: number | null;
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
  btcMeta?: BtcDepositMeta;
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
  const network = detectNetwork();
  const { data, error, isLoading, mutate } = useSWR<ExplorerTransaction[]>(
    ["explorer-unified", network],
    async () => {
      const resp = await fetch(`/api/explorer/transactions?network=${encodeURIComponent(network)}`);
      if (!resp.ok) return [];
      const json = await resp.json();
      return (json.transactions ?? []) as ExplorerTransaction[];
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

// =============================================================================
// Helpers — convert ExplorerTransaction (shield) → DepositRecord
// =============================================================================

/** Convert a shield ExplorerTransaction back to DepositRecord shape for deposit UI components */
export function toDepositRecord(tx: ExplorerTransaction): DepositRecord {
  const input = tx.inputs[0] ?? {};
  const output = tx.outputs[0] ?? {};
  return {
    txSignature: tx.txSignature,
    commitment: output.commitment ?? "",
    amountSats: output.amount ?? input.netAmount ?? 0,
    leafIndex: output.leafIndex ?? -1,
    timestamp: tx.timestamp,
    status: tx.status,
    instructionDisc: tx.btcMeta ? 1 : (tx.tokenId ? 29 : 1),
    tokenSymbol: tx.tokenSymbol,
    tokenId: tx.tokenId,
    grossAmount: input.grossAmount ?? null,
    fee: input.fee ?? null,
    btcMeta: tx.btcMeta ?? null,
  };
}

// Re-export for SDK callers that need IndexerLeaf[]
export { fetchAnnouncements, toIndexerLeaves };
