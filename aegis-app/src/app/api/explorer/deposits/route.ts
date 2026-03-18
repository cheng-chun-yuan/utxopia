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
  token_id?: string | null; // Token ID hex (32 bytes, from on-chain event)
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
  btcDepositAmountSats: number | null;
  /** Instruction discriminator: 1=BTC SPV deposit, 13=demo, 29=SPL shield */
  instructionDisc: number | null;
  /** Token ID hex (from on-chain event, identifies which token) */
  tokenId: string | null;
  /** Resolved token symbol (BTC, SOL, USDC, USDT) */
  tokenSymbol: string | null;
}

/**
 * Build a tokenId → symbol map by computing Poseidon(mint) for all known mints.
 * Uses the same logic as the SDK computeTokenId.
 */
async function buildTokenIdMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const { computeTokenId, initPoseidon } = await import("@aegis/sdk");
    const { PublicKey } = await import("@solana/web3.js");
    await initPoseidon();

    // Known mints from env + defaults
    const mints: { symbol: string; mint: string }[] = [];

    // zkBTC
    const zkbtcMint = process.env.NEXT_PUBLIC_ZKBTC_MINT || process.env.AEGIS_ZKBTC_MINT;
    if (zkbtcMint) mints.push({ symbol: "BTC", mint: zkbtcMint });

    // wSOL (NATIVE_MINT_2022)
    mints.push({ symbol: "SOL", mint: "9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP" });

    // Test mints from localnet-state.json (if available)
    try {
      const fs = await import("fs");
      const path = await import("path");
      const statePath = path.join(process.cwd(), "..", "scripts", "e2e", "localnet-state.json");
      if (fs.existsSync(statePath)) {
        const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
        if (state.tUsdcMint) mints.push({ symbol: "USDC", mint: state.tUsdcMint });
        if (state.tWsolMint) mints.push({ symbol: "SOL", mint: state.tWsolMint });
      }
    } catch { /* ignore */ }

    for (const { symbol, mint } of mints) {
      try {
        const mintBytes = new PublicKey(mint).toBytes();
        const tokenId = computeTokenId(mintBytes);
        const hex = tokenId.toString(16).padStart(64, "0");
        map.set(hex, symbol);
      } catch { /* skip invalid mints */ }
    }
  } catch (err) {
    console.error("[Explorer] Failed to build tokenId map:", err);
  }
  return map;
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
    const tokenIdMap = await buildTokenIdMap();

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
        // - Demo: is_verified=false, no btc_txid, same token_id as BTC (zkBTC)
        // - SPL shield: is_verified=false, no btc_txid, DIFFERENT token_id (tUSDC, wSOL, etc.)
        const isBtc = a.is_verified && !!a.btc_deposit_txid;
        // Demo and BTC deposits share the same zkBTC token_id; SPL shields have unique token_ids
        // If we see a non-BTC deposit with a non-zkBTC token_id, it's an SPL shield
        const zkbtcTokenIdPrefix = announcements.find(x => x.is_verified)?.token_id?.slice(0, 8);
        const hasDifferentToken = a.token_id && zkbtcTokenIdPrefix && !a.token_id.startsWith(zkbtcTokenIdPrefix);
        const isDemo = !isBtc && !hasDifferentToken;
        const leafTime = leafTimestamps.get(a.leaf_index) ?? 0;
        const timestamp = a.block_time || leafTime || (tracker?.created_at ?? 0);

        // For verified deposits without tracker data, infer completed status
        const isVerifiedNoTracker = !tracker && a.is_verified;

        // Detect instruction type:
        // - is_verified + has btc_deposit_txid = real BTC SPV (disc=1)
        // - !is_verified + no btc data + small amounts = demo (disc=13)
        // - !is_verified + large amounts or has token_id ≠ zkBTC = SPL shield (disc=29)
        const isBtcDeposit = a.is_verified && !!a.btc_deposit_txid;
        const isSplShield = !isBtcDeposit && !isDemo && a.token_id;
        const disc = isBtcDeposit ? 1 : isSplShield ? 29 : 13;

        return {
          txSignature: a.tx_signature,
          commitment: a.commitment,
          amountSats: decodeLeU64(a.encrypted_amount),
          leafIndex: a.leaf_index,
          timestamp,
          slot: a.slot,
          ephemeralPub: a.ephemeral_pub,
          status: tracker?.status ?? (isVerifiedNoTracker ? "claimed" : "claimed"),
          btcTxid: tracker?.btc_txid ?? a.btc_deposit_txid ?? null,
          sweepTxid: tracker?.sweep_txid ?? a.btc_sweep_txid ?? null,
          solanaTx: tracker?.solana_tx ?? a.tx_signature,
          confirmations: tracker?.confirmations ?? 0,
          sweepConfirmations: tracker?.sweep_confirmations ?? 0,
          sweepFeeSats: tracker?.sweep_fee_sats ?? null,
          mintedSats: isVerifiedNoTracker ? decodeLeU64(a.encrypted_amount) : (tracker?.minted_sats ?? null),
          taprootAddress: tracker?.taproot_address ?? null,
          trackerError: tracker?.error ?? null,
          isDemo,
          btcDepositAmountSats: tracker?.amount_sats ?? a.btc_deposit_amount_sats ?? null,
          instructionDisc: disc,
          tokenId: a.token_id ?? null,
          tokenSymbol: a.token_id ? (tokenIdMap.get(a.token_id) ?? null) : null,
        };
      });

    // Track which btcTxids are already represented from announcements
    const matchedBtcTxids = new Set<string>();
    for (const d of deposits) {
      if (d.btcTxid) matchedBtcTxids.add(d.btcTxid);
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
        amountSats: tracker.amount_sats ?? 0,
        leafIndex: tracker.leaf_index ?? -1,
        timestamp: tracker.created_at ?? 0,
        slot: 0,
        ephemeralPub: tracker.ephemeral_pub,
        status: tracker.status,
        btcTxid: tracker.btc_txid ?? null,
        sweepTxid: tracker.sweep_txid ?? null,
        solanaTx: tracker.solana_tx ?? null,
        confirmations: tracker.confirmations ?? 0,
        sweepConfirmations: tracker.sweep_confirmations ?? 0,
        sweepFeeSats: tracker.sweep_fee_sats ?? null,
        mintedSats: tracker.minted_sats ?? null,
        taprootAddress: tracker.taproot_address ?? null,
        trackerError: tracker.error ?? null,
        isDemo: false,
        btcDepositAmountSats: tracker.amount_sats ?? null,
        instructionDisc: 1, // tracker deposits are always real BTC
        tokenId: null,
        tokenSymbol: "BTC",
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

      // disc=13 is add_demo_stealth, disc=1 is verify_stealth_deposit (real BTC)
      const DEMO_DISC = 13;
      const VERIFY_DISC = 1;

      for (const tx of txMetas) {
        const isDemo = tx.instructionDisc === DEMO_DISC;
        const isVerified = tx.instructionDisc === VERIFY_DISC;
        for (const ann of tx.announcements) {
          deposits.push({
            txSignature: tx.signature,
            commitment: ann.commitment,
            amountSats: decodeLeU64(ann.encryptedAmount),
            leafIndex: ann.leafIndex,
            timestamp: tx.blockTime,
            slot: tx.slot,
            ephemeralPub: ann.ephemeralPub,
            status: isVerified ? "claimed" : isDemo ? "claimed" : null,
            btcTxid: null,
            sweepTxid: null,
            solanaTx: tx.signature,
            confirmations: 0,
            sweepConfirmations: 0,
            sweepFeeSats: null,
            mintedSats: isVerified ? decodeLeU64(ann.encryptedAmount) : null,
            taprootAddress: null,
            trackerError: null,
            isDemo,
            btcDepositAmountSats: null,
            instructionDisc: tx.instructionDisc,
            tokenId: null,
            tokenSymbol: null,
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
