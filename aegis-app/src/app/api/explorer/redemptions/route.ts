/**
 * GET /api/explorer/redemptions
 *
 * Server-side join of on-chain RedemptionRequest PDAs + backend tracking data.
 * Returns enriched redemption records with BTC txids, timestamps, and error info.
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
    // Fetch on-chain PDAs and backend tracking data in parallel
    const [redemptions, trackingResp] = await Promise.all([
      fetchExplorerRedemptions(
        createServerRpc(),
        DEVNET_CONFIG.aegisProgramId,
      ),
      fetch(`${BACKEND_URL}/api/redemption/tracking`).catch(() => null),
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

    // Join PDA data with tracking data
    const serialized = redemptions.map((r) => {
      const tracking = trackingMap.get(r.pubkey);
      const trackingTime = tracking?.created_at ?? 0;
      const slotTime = r.processingSlot > 0 ? (slotTimeMap.get(r.processingSlot) ?? 0) : 0;
      return {
        pubkey: r.pubkey,
        requestId: r.requestId.toString(),
        amountSats: r.amountSats.toString(),
        status: r.status,
        requester: r.requester,
        btcScript: r.btcScript,
        // Enriched from backend tracking
        btcTxid: tracking?.btc_txid ?? null,
        localStatus: tracking?.local_status ?? null,
        createdAt: trackingTime || slotTime,
        updatedAt: tracking?.last_updated ?? 0,
        retryCount: tracking?.retry_count ?? 0,
        trackerError: tracking?.error ?? null,
      };
    });

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
