/**
 * GET /api/explorer/deposits
 *
 * Server-side join of announcements (type=0) + deposit tracker data.
 * Returns a unified list so the client makes ONE fetch instead of many RPC calls.
 *
 * Timestamps use block_time from getTransaction RPC (real Solana block time),
 * falling back to created_at (on-chain Clock::get()) from leaf events.
 */

import { NextResponse } from "next/server";

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

    // Index tracker deposits by solana_tx for fast lookup
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
        const tracker = trackerBySolTx.get(a.tx_signature);
        const isDemo = !tracker;
        const leafTime = leafTimestamps.get(a.leaf_index) ?? 0;
        // block_time from announcement (getTransaction RPC), then leaf created_at, then tracker
        const timestamp = a.block_time || leafTime || (tracker?.created_at ?? 0);

        return {
          txSignature: a.tx_signature,
          commitment: a.commitment,
          amountSats: decodeLeU64(a.encrypted_amount),
          leafIndex: a.leaf_index,
          timestamp,
          slot: a.slot,
          ephemeralPub: a.ephemeral_pub,
          status: tracker?.status ?? null,
          btcTxid: tracker?.btc_txid ?? null,
          sweepTxid: tracker?.sweep_txid ?? null,
          solanaTx: tracker?.solana_tx ?? null,
          confirmations: tracker?.confirmations ?? 0,
          sweepConfirmations: tracker?.sweep_confirmations ?? 0,
          sweepFeeSats: tracker?.sweep_fee_sats ?? null,
          mintedSats: tracker?.minted_sats ?? null,
          taprootAddress: tracker?.taproot_address ?? null,
          trackerError: tracker?.error ?? null,
          isDemo,
        };
      })
      .sort((a, b) => b.leafIndex - a.leafIndex);

    return NextResponse.json({ success: true, deposits, count: deposits.length });
  } catch (err) {
    console.error("[Explorer Deposits API] Error:", err);
    return NextResponse.json(
      { success: false, error: "Failed to fetch explorer deposits" },
      { status: 500 },
    );
  }
}
