/**
 * GET /api/explorer/redemptions
 *
 * Server-side join of:
 * 1. On-chain RedemptionRequest PDAs (active: Pending/Processing/Failed)
 * 2. Backend tracking data (enrichment: BTC txids, status, errors)
 * 3. On-chain completion events via /api/redemption/completed (completed redemptions
 *    whose PDAs are closed — reconstructed purely from indexed on-chain events)
 */

import { NextResponse } from "next/server";
import {
  DEVNET_CONFIG,
  fetchExplorerRedemptions,
  type RpcClient,
} from "@aegis/sdk";
import { createSolanaRpc } from "@solana/kit";

const RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
  process.env.SOLANA_RPC_URL ||
  "https://api.devnet.solana.com";

const BACKEND_URL = process.env.TRACKER_API_URL || "http://localhost:3001";

interface TrackingEntry {
  pda_address: string;
  btc_txid: string | null;
  local_status: string;
  retry_count: number;
  created_at: number;
  last_updated: number;
  error: string | null;
  requester: string | null;
  amount_sats: number | null;
  btc_script: string | null;
  request_id: number | null;
}

interface CompletedEntry {
  requester: string;
  amount_sats: number;
  request_id: number;
  btc_txid: string;
  btc_script: string;
  tx_signature: string;
  slot: number;
  block_time: number;
}

interface RequestedEntry {
  requester: string;
  amount_sats: number;
  request_id: number;
  btc_script: string;
  tx_signature: string;
  slot: number;
  block_time: number;
}

interface ProcessingEntry {
  requester: string;
  amount_sats: number;
  request_id: number;
  processing_slot: number;
  tx_signature: string;
  slot: number;
  block_time: number;
}

function createServerRpc(): RpcClient {
  const rpc = createSolanaRpc(RPC_URL);
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
        .getProgramAccounts(programId as any, {
          encoding: "base64",
          filters,
        })
        .send();
      return (accounts as any[]).map((acc: any) => ({
        pubkey: String(acc.pubkey),
        account: { data: acc.account.data },
      }));
    },
  };
}

export async function GET() {
  try {
    // Fetch all 3 sources in parallel
    const [redemptions, trackingResp, completedResp, requestedResp, processingResp] = await Promise.all([
      fetchExplorerRedemptions(
        createServerRpc(),
        DEVNET_CONFIG.aegisProgramId,
      ),
      fetch(`${BACKEND_URL}/api/redemption/tracking`).catch(() => null),
      fetch(`${BACKEND_URL}/api/redemption/completed`).catch(() => null),
      fetch(`${BACKEND_URL}/api/redemption/requested`).catch(() => null),
      fetch(`${BACKEND_URL}/api/redemption/processing`).catch(() => null),
    ]);

    // Parse tracking data (keyed by PDA address)
    const trackingMap = new Map<string, TrackingEntry>();
    if (trackingResp?.ok) {
      try {
        const trackingData = await trackingResp.json();
        const entries: TrackingEntry[] = trackingData.tracking ?? [];
        for (const entry of entries) {
          trackingMap.set(entry.pda_address, entry);
        }
      } catch {
        // Ignore parse errors — tracking data is optional enrichment
      }
    }

    // Parse completed redemptions from on-chain events (backend-independent source)
    let completedEntries: CompletedEntry[] = [];
    if (completedResp?.ok) {
      try {
        const completedData = await completedResp.json();
        completedEntries = completedData.redemptions ?? [];
      } catch {
        // Ignore parse errors
      }
    }

    // Parse requested redemptions from on-chain events (fallback for missing PDAs)
    let requestedEntries: RequestedEntry[] = [];
    if (requestedResp?.ok) {
      try {
        const requestedData = await requestedResp.json();
        requestedEntries = requestedData.redemptions ?? [];
      } catch {
        // Ignore parse errors
      }
    }

    // Parse processing redemptions from on-chain events (0x0A mark_processing)
    let processingEntries: ProcessingEntry[] = [];
    if (processingResp?.ok) {
      try {
        const processingData = await processingResp.json();
        processingEntries = processingData.redemptions ?? [];
      } catch {
        // Ignore parse errors
      }
    }

    // Fetch blockTime for PDAs with a processingSlot but no tracking timestamp
    const slotsNeedingTime = redemptions
      .filter((r) => r.processingSlot > 0 && !trackingMap.has(r.pubkey))
      .map((r) => r.processingSlot);

    const slotTimeMap = new Map<number, number>();
    if (slotsNeedingTime.length > 0) {
      const uniqueSlots = [...new Set(slotsNeedingTime)];
      await Promise.all(
        uniqueSlots.map(async (slot) => {
          try {
            const resp = await fetch(RPC_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0", id: 1,
                method: "getBlockTime",
                params: [slot],
              }),
              signal: AbortSignal.timeout(5000),
            });
            const json = await resp.json();
            if (json.result) slotTimeMap.set(slot, json.result);
          } catch { /* ignore */ }
        }),
      );
    }

    // Index requested/completed events by request_id for tx signature lookup
    const requestedByReqId = new Map<string, RequestedEntry>();
    for (const req of requestedEntries) {
      requestedByReqId.set(req.request_id.toString(), req);
    }
    const completedByReqId = new Map<string, CompletedEntry>();
    for (const c of completedEntries) {
      completedByReqId.set(c.request_id.toString(), c);
    }
    const processingByReqId = new Map<string, ProcessingEntry>();
    for (const p of processingEntries) {
      processingByReqId.set(p.request_id.toString(), p);
    }

    // Join PDA data with tracking data (active redemptions)
    const serialized: Array<{
      pubkey: string;
      requestId: string;
      amountSats: string;
      status: string;
      requester: string;
      btcScript: string;
      btcTxid: string | null;
      localStatus: string | null;
      createdAt: number;
      updatedAt: number;
      retryCount: number;
      trackerError: string | null;
      requestTxSignature: string | null;
      processingTxSignature: string | null;
      completeTxSignature: string | null;
    }> = redemptions.map((r) => {
      const tracking = trackingMap.get(r.pubkey);
      const trackingTime = tracking?.created_at ?? 0;
      const slotTime = r.processingSlot > 0 ? (slotTimeMap.get(r.processingSlot) ?? 0) : 0;
      const reqId = r.requestId.toString();
      return {
        pubkey: r.pubkey,
        requestId: reqId,
        amountSats: r.amountSats.toString(),
        status: r.status,
        requester: r.requester,
        btcScript: r.btcScript,
        btcTxid: tracking?.btc_txid ?? null,
        localStatus: tracking?.local_status ?? null,
        createdAt: trackingTime || slotTime,
        updatedAt: tracking?.last_updated ?? 0,
        retryCount: tracking?.retry_count ?? 0,
        trackerError: tracking?.error ?? null,
        requestTxSignature: requestedByReqId.get(reqId)?.tx_signature ?? null,
        processingTxSignature: processingByReqId.get(reqId)?.tx_signature ?? null,
        completeTxSignature: completedByReqId.get(reqId)?.tx_signature ?? null,
      };
    });

    // Add completed redemptions from on-chain events (PDAs are closed, data from indexed events)
    const activeRequestIds = new Set(redemptions.map((r) => r.requestId.toString()));
    for (const c of completedEntries) {
      const rid = c.request_id.toString();
      if (activeRequestIds.has(rid)) continue; // still has PDA, skip
      serialized.push({
        pubkey: "", // PDA is closed
        requestId: rid,
        amountSats: c.amount_sats.toString(),
        status: "Completed",
        requester: c.requester,
        btcScript: c.btc_script,
        btcTxid: c.btc_txid,
        localStatus: "Completed",
        createdAt: c.block_time,
        updatedAt: c.block_time,
        retryCount: 0,
        trackerError: null,
        requestTxSignature: requestedByReqId.get(rid)?.tx_signature ?? null,
        processingTxSignature: processingByReqId.get(rid)?.tx_signature ?? null,
        completeTxSignature: c.tx_signature,
      });
    }

    // Add requested redemptions from on-chain events for any that don't have
    // a PDA or completed entry (e.g., PDA closed by cancel but event exists)
    const knownRequestIds = new Set(serialized.map((r) => r.requestId));
    for (const req of requestedEntries) {
      const rid = req.request_id.toString();
      if (knownRequestIds.has(rid)) continue; // already present
      serialized.push({
        pubkey: "",
        requestId: rid,
        amountSats: req.amount_sats.toString(),
        status: "Cancelled", // PDA gone + not completed = cancelled
        requester: req.requester,
        btcScript: req.btc_script,
        btcTxid: null,
        localStatus: "Cancelled",
        createdAt: req.block_time,
        updatedAt: req.block_time,
        retryCount: 0,
        trackerError: null,
        requestTxSignature: req.tx_signature,
        processingTxSignature: processingByReqId.get(rid)?.tx_signature ?? null,
        completeTxSignature: null,
      });
    }

    // Sort by time descending (newest first)
    serialized.sort((a, b) => b.createdAt - a.createdAt);

    return NextResponse.json({
      success: true,
      redemptions: serialized,
      count: serialized.length,
    });
  } catch (err) {
    console.error("[Explorer Redemptions API] Error:", err);
    return NextResponse.json(
      { success: false, error: "Failed to fetch redemptions" },
      { status: 500 },
    );
  }
}
