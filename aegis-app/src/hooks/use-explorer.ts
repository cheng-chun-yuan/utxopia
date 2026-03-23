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

export interface GroupedTransfer {
  txSignature: string;
  timestamp: number;
  /** "confirmed" when timestamp > 0, "processing" when not yet confirmed */
  status: "confirmed" | "processing";
  inputCount: number;
  nullifierPdas: string[];
  outputs: TransferOutput[];
  /** NullifierOperationType: 0=FullWithdrawal (unshield), 2=PrivateTransfer */
  operationType: number;
  /** Aegis instruction discriminator: 14=transact, 15=unshield */
  instructionDisc?: number;
  /** Token transfer amount in sats (unshield txs only) */
  unshieldAmount?: number;
  /** Token transfer recipient wallet (unshield txs only) */
  unshieldRecipient?: string;
  /** Token ID hex from on-chain event (identifies which token) */
  tokenId?: string;
  /** Resolved token symbol (BTC, SOL, USDC, USDT) from backend */
  tokenSymbol?: string;
  /** Event-derived transfer type: "private_transfer", "unshield", "redeem", "deposit" */
  transferType?: string;
  /** Protocol fee deducted from unshield (from UnshieldMeta v2 event) */
  unshieldFee?: number;
  /** Net payout after fee (from UnshieldMeta v2 event) */
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

export function useDeposits() {
  const { data, error, isLoading, mutate } = useSWR<DepositRecord[]>(
    "explorer-deposits",
    async () => {
      const resp = await fetch("/api/explorer/deposits");
      if (!resp.ok) return [];
      const json = await resp.json();
      return (json.deposits ?? []).map(
        (d: any): DepositRecord => ({
          ...d,
          amountBtc: (d.amountSats / 1e8).toFixed(8),
        }),
      );
    },
    {
      ...SWR_OPTIONS,
      // Auto-refetch faster when any deposit is missing leaf index or timestamp
      refreshInterval: (data?: DepositRecord[]) => {
        if (!data) return SWR_OPTIONS.refreshInterval;
        const hasIncomplete = data.some(
          (d) => !d.timestamp || d.leafIndex < 0,
        );
        return hasIncomplete ? 5_000 : SWR_OPTIONS.refreshInterval;
      },
    },
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
      const resp = await fetch("/api/transfers");
      if (!resp.ok) return []; // graceful fallback — backend may not have this endpoint yet
      const json = await resp.json();
      if (!json.success || !json.transfers) return [];
      return json.transfers.map((t: BackendTransferRow) => ({
        txSignature: t.tx_signature,
        timestamp: t.timestamp,
        status: t.status === "processing" ? "processing" : "confirmed",
        inputCount: t.input_count,
        nullifierPdas: t.nullifier_pdas ?? [],
        outputs: (t.commitments ?? []).map((c: string, i: number) => ({
          commitment: c,
          leafIndex: (t.leaf_indices ?? [])[i] ?? 0,
        })),
        operationType: t.operation_type ?? 2,
        instructionDisc: t.instruction_disc,
        unshieldAmount: t.unshield_amount,
        unshieldRecipient: t.unshield_recipient,
        tokenId: t.token_id,
        tokenSymbol: t.token_symbol,
        transferType: t.transfer_type,
        unshieldFee: t.unshield_fee,
        unshieldPayout: t.unshield_payout,
      }));
    },
    {
      ...SWR_OPTIONS,
      // Auto-refetch faster when any transfer is processing (unconfirmed)
      refreshInterval: (data?: GroupedTransfer[]) => {
        if (!data) return SWR_OPTIONS.refreshInterval;
        const hasProcessing = data.some((t) => t.status === "processing");
        return hasProcessing ? 5_000 : SWR_OPTIONS.refreshInterval;
      },
    },
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

// Re-export for backwards compatibility — SDK callers that need IndexerLeaf[]
export { fetchAnnouncements, toIndexerLeaves };
