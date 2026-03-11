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

const BACKEND_URL = process.env.TRACKER_API_URL || "http://localhost:3001";

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

export interface ExplorerDeposit {
  txSignature: string;
  commitment: string;
  amountSats: number;
  leafIndex: number;
  timestamp: number;
  slot: number;
  ephemeralPub?: string;
  // Tracker data (null for demo deposits)
  status: string | null;
  btcTxid: string | null;
  sweepTxid: string | null;
  solanaTx: string | null;
  confirmations: number;
  sweepConfirmations: number;
  sweepFeeSats: number | null;
  mintedSats: number | null;
  taprootAddress: string | null;
  trackerError: string | null;
  isDemo: boolean;
  btcDepositAmountSats: number | null; // Original BTC deposit amount (before sweep fee)
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
    const deposits: ExplorerDeposit[] = announcements
      .filter((a) => a.announcement_type === 0)
      .map((a) => {
        // Match tracker by solana_tx only (leaf_index can collide after tree reset)
        const tracker = trackerBySolTx.get(a.tx_signature);
        // A deposit is demo if there's no tracker AND it's not SPV-verified.
        const isDemo = !tracker && !a.is_verified;
        const leafTime = leafTimestamps.get(a.leaf_index) ?? 0;
        const timestamp = a.block_time || leafTime || (tracker?.created_at ?? 0);

        // For verified deposits without tracker data, infer completed status
        const isVerifiedNoTracker = !tracker && a.is_verified;

        return {
          txSignature: a.tx_signature,
          commitment: a.commitment,
          amountSats: decodeLeU64(a.encrypted_amount),
          leafIndex: a.leaf_index,
          timestamp,
          slot: a.slot,
          ephemeralPub: a.ephemeral_pub,
          status: tracker?.status ?? (isVerifiedNoTracker ? "claimed" : null),
          btcTxid: tracker?.btc_txid ?? a.btc_deposit_txid ?? null,
          sweepTxid: tracker?.sweep_txid ?? a.btc_sweep_txid ?? null,
          solanaTx: tracker?.solana_tx ?? (isVerifiedNoTracker ? a.tx_signature : null),
          confirmations: tracker?.confirmations ?? 0,
          sweepConfirmations: tracker?.sweep_confirmations ?? 0,
          sweepFeeSats: tracker?.sweep_fee_sats ?? null,
          mintedSats: isVerifiedNoTracker ? decodeLeU64(a.encrypted_amount) : (tracker?.minted_sats ?? null),
          taprootAddress: tracker?.taproot_address ?? null,
          trackerError: tracker?.error ?? null,
          isDemo,
          btcDepositAmountSats: tracker?.amount_sats ?? a.btc_deposit_amount_sats ?? null,
        };
      })
      .sort((a, b) => b.leafIndex - a.leafIndex);

    return NextResponse.json({ success: true, deposits, count: deposits.length });
  } catch (err) {
    console.error("[Explorer Deposits API] Backend unavailable, trying RPC fallback:", err);

    try {
      const txMetas = await fetchAnnouncementsFromRpc(0); // type=0 = deposits
      const deposits: ExplorerDeposit[] = [];

      for (const tx of txMetas) {
        for (const ann of tx.announcements) {
          deposits.push({
            txSignature: tx.signature,
            commitment: ann.commitment,
            amountSats: decodeLeU64(ann.encryptedAmount),
            leafIndex: ann.leafIndex,
            timestamp: tx.blockTime,
            slot: tx.slot,
            ephemeralPub: ann.ephemeralPub,
            status: null,
            btcTxid: null,
            sweepTxid: null,
            solanaTx: tx.signature,
            confirmations: 0,
            sweepConfirmations: 0,
            sweepFeeSats: null,
            mintedSats: null,
            taprootAddress: null,
            trackerError: null,
            isDemo: false,
            btcDepositAmountSats: null,
          });
        }
      }

      deposits.sort((a, b) => b.leafIndex - a.leafIndex);

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
