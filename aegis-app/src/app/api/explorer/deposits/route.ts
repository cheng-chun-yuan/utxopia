/**
 * GET /api/explorer/deposits
 *
 * Server-side join of announcements (type=0) + deposit tracker data.
 * Returns a unified list so the client makes ONE fetch instead of many RPC calls.
 *
 * Timestamps use block_time from getTransaction RPC (real Solana block time),
 * falling back to created_at (on-chain Clock::get()) from leaf events.
 *
 * BTC txids come from:
 *  1. Deposit tracker (if running and matched)
 *  2. Backend event indexer (extracted from verify_stealth_deposit instruction data)
 */

import { NextResponse } from "next/server";
import { fetchAnnouncementsFromRpc } from "@/lib/api/rpc-fallback";
import { getBackendUrl } from "@/lib/api/constants";
export const dynamic = "force-dynamic";

const BACKEND_URL = getBackendUrl();

interface AnnouncementRow {
  leaf_index: number;
  announcement_type: number;
  ephemeral_pub: string;
  encrypted_amount: string;
  commitment: string;
  tx_signature: string;
  slot: number;
  block_time: number; // Unix timestamp from getTransaction RPC
  is_verified: boolean; // true = SPV-verified BTC deposit, false = demo or unknown
  btc_deposit_txid?: string | null; // BTC deposit txid (from instruction data)
  btc_sweep_txid?: string | null;   // BTC sweep txid (from instruction data)
  btc_deposit_amount_sats?: number | null; // Original BTC deposit amount (from mempool)
  token_id?: string | null; // Token ID hex (32 bytes, from on-chain event)
  deposit_gross_amount?: number | null; // Gross amount before fee (from ShieldMeta event)
  deposit_fee?: number | null; // Fee deducted (from ShieldMeta event)
}

interface TrackerDeposit {
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
  sweep_fee_sats?: number;
  minted_sats?: number;
  error?: string;
  created_at: number;
  updated_at: number;
}

/** BTC-specific metadata (only present for BTC SPV deposits) */
export interface BtcDepositMeta {
  depositTxid: string | null;
  sweepTxid: string | null;
  taprootAddress: string | null;
  confirmations: number;
  sweepConfirmations: number;
  sweepFeeSats: number | null;
  mintedSats: number | null;
  /** Original deposit amount in sats (what user sent to taproot) */
  depositAmountSats: number | null;
  trackerError: string | null;
}

export interface ExplorerDeposit {
  txSignature: string;
  commitment: string;
  /** Shielded amount (after fees) */
  amountSats: number;
  leafIndex: number;
  timestamp: number;
  status: string | null;
  /** Instruction discriminator: 1=BTC SPV deposit, 29=SPL shield */
  instructionDisc: number | null;
  tokenSymbol: string | null;
  tokenId: string | null;
  ephemeralPub?: string;
  /** Gross amount before fee (from ShieldMeta event or tracker) */
  grossAmount: number | null;
  /** Protocol fee deducted (from ShieldMeta event) */
  fee: number | null;
  /** BTC-specific metadata — null for SPL shield deposits */
  btcMeta: BtcDepositMeta | null;
}

interface LeafRow {
  leaf_index: number;
  commitment: string;
  created_at: number;
  tx_signature: string;
  slot: number;
  announcement_type?: number;
  amount_sats?: number;
  ephemeral_pub?: string;
}

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

export async function GET() {
  try {
    // tokenSymbol resolved on frontend via token-map.ts (no server-side Poseidon needed)

    const [annResp, depResp, leavesResp] = await Promise.all([
      fetch(`${BACKEND_URL}/api/announcements`),
      fetch(`${BACKEND_URL}/api/deposits`),
      fetch(`${BACKEND_URL}/api/tree/leaves`),
    ]);

    const annData = annResp.ok
      ? await annResp.json()
      : { announcements: [] };
    const depData = depResp.ok ? await depResp.json() : { deposits: [] };
    const leavesData = leavesResp.ok ? await leavesResp.json() : { leaves: [] };

    const announcements: AnnouncementRow[] = annData.announcements ?? [];
    const trackerDeposits: TrackerDeposit[] = depData.deposits ?? [];
    const leaves: LeafRow[] = leavesData.leaves ?? leavesData ?? [];

    // Index tracker deposits by solana_tx for fast lookup (only reliable join key)
    const trackerBySolTx = new Map<string, TrackerDeposit>();
    for (const d of trackerDeposits) {
      if (d.solana_tx) trackerBySolTx.set(d.solana_tx, d);
    }

    // Index leaves by leaf_index for created_at timestamps (fallback)
    const leafTimestamps = new Map<number, number>();
    for (const l of leaves) {
      if (l.created_at) leafTimestamps.set(l.leaf_index, l.created_at);
    }

    // Filter deposits (type=0) and join with tracker + timestamps
    // Timestamp priority: block_time (RPC) > created_at (on-chain Clock) > tracker.created_at
    const matchedTrackerSolTxs = new Set<string>();
    const deposits: ExplorerDeposit[] = announcements
      .filter((a) => a.announcement_type === 0)
      .map((a) => {
        // Match tracker by solana_tx only (leaf_index can collide after tree reset)
        const tracker = trackerBySolTx.get(a.tx_signature);
        if (tracker) matchedTrackerSolTxs.add(a.tx_signature);
        // Detect deposit type from backend data:
        // - BTC SPV: is_verified=true, has btc_deposit_txid
        // - SPL shield: is_verified=false, no btc_txid, has token_id
        const isBtc = a.is_verified && !!a.btc_deposit_txid;
        const leafTime = leafTimestamps.get(a.leaf_index) ?? 0;
        const timestamp = a.block_time || leafTime || (tracker?.created_at ?? 0);

        // For verified deposits without tracker data, infer completed status
        const isVerifiedNoTracker = !tracker && a.is_verified;

        // Detect instruction type:
        // - is_verified + has btc_deposit_txid = real BTC SPV (disc=1)
        // - otherwise with token_id = SPL shield (disc=29)
        const isBtcDeposit = a.is_verified && !!a.btc_deposit_txid;
        const isSplShield = !isBtcDeposit && !!a.token_id;
        const disc = isBtcDeposit ? 1 : isSplShield ? 29 : 1;

        return {
          txSignature: a.tx_signature,
          commitment: a.commitment,
          amountSats: decodeLeU64(a.encrypted_amount),
          leafIndex: a.leaf_index,
          timestamp,
          status: tracker?.status ?? (isVerifiedNoTracker ? "claimed" : "claimed"),
          instructionDisc: disc,
          tokenId: a.token_id ?? null,
          tokenSymbol: null, // resolved on frontend
          ephemeralPub: a.ephemeral_pub,
          grossAmount: a.deposit_gross_amount ?? (tracker?.amount_sats ?? a.btc_deposit_amount_sats ?? null),
          fee: a.deposit_fee ?? null,
          btcMeta: isBtcDeposit ? {
            depositTxid: tracker?.btc_txid ?? a.btc_deposit_txid ?? null,
            sweepTxid: tracker?.sweep_txid ?? a.btc_sweep_txid ?? null,
            taprootAddress: tracker?.taproot_address ?? null,
            confirmations: tracker?.confirmations ?? 0,
            sweepConfirmations: tracker?.sweep_confirmations ?? 0,
            sweepFeeSats: tracker?.sweep_fee_sats ?? null,
            mintedSats: isVerifiedNoTracker ? decodeLeU64(a.encrypted_amount) : (tracker?.minted_sats ?? null),
            depositAmountSats: tracker?.amount_sats ?? a.btc_deposit_amount_sats ?? null,
            trackerError: tracker?.error ?? null,
          } : null,
        };
      });

    // Track which btcTxids are already represented from announcements
    const matchedBtcTxids = new Set<string>();
    for (const d of deposits) {
      if (d.btcMeta?.depositTxid) matchedBtcTxids.add(d.btcMeta.depositTxid);
    }

    // Add tracker-only deposits (ongoing: detected, confirming, sweeping, etc.)
    // These don't have on-chain announcements yet since they haven't been verified on Solana.
    for (const tracker of trackerDeposits) {
      if (tracker.solana_tx && matchedTrackerSolTxs.has(tracker.solana_tx)) continue;
      // Skip if this btcTxid is already represented (e.g. "already_verified" tracker for a deposit that was matched by announcement)
      if (tracker.btc_txid && matchedBtcTxids.has(tracker.btc_txid)) continue;
      deposits.push({
        txSignature: tracker.solana_tx ?? "",
        commitment: "",
        amountSats: tracker.minted_sats ?? tracker.amount_sats ?? 0,
        leafIndex: tracker.leaf_index ?? -1,
        timestamp: tracker.created_at ?? 0,
        status: tracker.status,
        instructionDisc: 1,
        tokenId: null,
        tokenSymbol: "BTC",
        ephemeralPub: tracker.ephemeral_pub,
        grossAmount: tracker.amount_sats ?? null,
        fee: null,
        btcMeta: {
          depositTxid: tracker.btc_txid ?? null,
          sweepTxid: tracker.sweep_txid ?? null,
          taprootAddress: tracker.taproot_address ?? null,
          confirmations: tracker.confirmations ?? 0,
          sweepConfirmations: tracker.sweep_confirmations ?? 0,
          sweepFeeSats: tracker.sweep_fee_sats ?? null,
          mintedSats: tracker.minted_sats ?? null,
          depositAmountSats: tracker.amount_sats ?? null,
          trackerError: tracker.error ?? null,
        },
      });
    }

    // Sort by timestamp descending (newest first); ongoing deposits (with recent created_at) appear at top
    deposits.sort((a, b) => b.timestamp - a.timestamp);

    return NextResponse.json({ success: true, deposits, count: deposits.length });
  } catch (err) {
    console.error("[Explorer Deposits API] Backend unavailable, trying RPC fallback:", err);

    try {
      const txMetas = await fetchAnnouncementsFromRpc(0); // type=0 = deposits
      const deposits: ExplorerDeposit[] = [];

      // disc=1 is verify_stealth_deposit (real BTC)
      const VERIFY_DISC = 1;

      for (const tx of txMetas) {
        const isVerified = tx.instructionDisc === VERIFY_DISC;
        for (const ann of tx.announcements) {
          deposits.push({
            txSignature: tx.signature,
            commitment: ann.commitment,
            amountSats: decodeLeU64(ann.encryptedAmount),
            leafIndex: ann.leafIndex,
            timestamp: tx.blockTime,
            status: isVerified ? "claimed" : null,
            instructionDisc: tx.instructionDisc,
            tokenId: null,
            tokenSymbol: null,
            ephemeralPub: ann.ephemeralPub,
            grossAmount: null,
            fee: null,
            btcMeta: null,
          });
        }
      }

      deposits.sort((a, b) => b.timestamp - a.timestamp);

      return NextResponse.json({
        success: true,
        deposits,
        count: deposits.length,
        fallback: true,
      });
    } catch (rpcErr) {
      console.error("[Explorer Deposits API] RPC fallback also failed:", rpcErr);
      return NextResponse.json(
        { success: false, error: "Failed to fetch explorer deposits" },
        { status: 500 },
      );
    }
  }
}
