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
  getConfig,
  fetchExplorerRedemptions,
  type RpcClient,
} from "@aegis/sdk";
import { createSolanaRpc } from "@solana/kit";

const RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
  process.env.SOLANA_RPC_URL ||
  "https://api.devnet.solana.com";

import { getBackendUrl } from "@/lib/api/constants";
export const dynamic = "force-dynamic";

const BACKEND_URL = getBackendUrl();

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
  simulated: boolean;
}

interface CompletedEntry {
  requester: string;
  amount_sats: number;
  actual_received: number;
  service_fee: number;
  request_id: number;
  btc_txid: string;
  btc_script: string;
  tx_signature: string;
  slot: number;
  block_time: number;
  burn_amount: number;
  protocol_revenue: number;
}

interface RequestedEntry {
  requester: string;
  amount_sats: number;
  request_id: number;
  service_fee_base: number;
  service_fee_bps: number;
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
    // Fetch all sources in parallel (including pool state for fee config + transfers for in/out counts)
    const [redemptions, trackingResp, completedResp, requestedResp, processingResp, poolStateResp, transfersResp] = await Promise.all([
      fetchExplorerRedemptions(
        createServerRpc(),
        getConfig().aegisProgramId,
      ),
      fetch(`${BACKEND_URL}/api/redemption/tracking`).catch(() => null),
      fetch(`${BACKEND_URL}/api/redemption/completed`).catch(() => null),
      fetch(`${BACKEND_URL}/api/redemption/requested`).catch(() => null),
      fetch(`${BACKEND_URL}/api/redemption/processing`).catch(() => null),
      fetch(`${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/solana/pool-state`).catch(() => null),
      fetch(`${BACKEND_URL}/api/transfers`).catch(() => null),
    ]);

    // Parse pool state for fee config
    let feeConfig = { bps: 30, base: 2000 }; // defaults
    if (poolStateResp?.ok) {
      try {
        const poolData = await poolStateResp.json();
        if (poolData.success && poolData.state) {
          feeConfig = {
            bps: poolData.state.serviceFeeBps ?? 30,
            base: Number(poolData.state.serviceFeeBase ?? "2000"),
          };
        }
      } catch { /* use defaults */ }
    }

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

    // Parse transfer data for input/output counts (keyed by tx_signature)
    const transferCountMap = new Map<string, { inputCount: number; outputCount: number }>();
    if (transfersResp?.ok) {
      try {
        const transfersData = await transfersResp.json();
        for (const t of transfersData.transfers ?? []) {
          if (t.tx_signature) {
            transferCountMap.set(t.tx_signature, {
              inputCount: t.input_count ?? 1,
              outputCount: t.output_count ?? 1,
            });
          }
        }
      } catch { /* ignore */ }
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
      actualReceived: string | null;
      requestTxSignature: string | null;
      processingTxSignature: string | null;
      completeTxSignature: string | null;
      simulated: boolean;
      serviceFee: string | null;
      serviceFeeBps: number;
      serviceFeeBase: number;
      burnAmount: string | null;
      protocolRevenue: string | null;
      inputCount: number;
      outputCount: number;
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
        actualReceived: completedByReqId.get(reqId)?.actual_received?.toString() ?? null,
        requestTxSignature: requestedByReqId.get(reqId)?.tx_signature ?? null,
        processingTxSignature: processingByReqId.get(reqId)?.tx_signature ?? null,
        completeTxSignature: completedByReqId.get(reqId)?.tx_signature ?? null,
        simulated: tracking?.simulated ?? false,
        serviceFee: r.serviceFee.toString(),
        serviceFeeBps: feeConfig.bps,
        serviceFeeBase: feeConfig.base,
        burnAmount: completedByReqId.get(reqId)?.burn_amount?.toString() ?? null,
        protocolRevenue: completedByReqId.get(reqId)?.protocol_revenue?.toString() ?? null,
        ...(transferCountMap.get(requestedByReqId.get(reqId)?.tx_signature ?? "") ?? { inputCount: 1, outputCount: 1 }),
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
        actualReceived: c.actual_received?.toString() ?? c.amount_sats.toString(),
        requestTxSignature: requestedByReqId.get(rid)?.tx_signature ?? null,
        processingTxSignature: processingByReqId.get(rid)?.tx_signature ?? null,
        completeTxSignature: c.tx_signature,
        simulated: false, // completed on-chain = real
        serviceFee: c.service_fee.toString(),
        serviceFeeBps: feeConfig.bps,
        serviceFeeBase: feeConfig.base,
        burnAmount: c.burn_amount?.toString() ?? null,
        protocolRevenue: c.protocol_revenue?.toString() ?? null,
        ...(transferCountMap.get(requestedByReqId.get(rid)?.tx_signature ?? "") ?? { inputCount: 1, outputCount: 1 }),
      });
    }

    // Try to recover BTC txids for orphaned redemptions by scanning pool wallet txs.
    // This handles the case where backend restarted and lost tracking state.
    const POOL_ADDRESS = process.env.POOL_BTC_ADDRESS || "tb1pksj664hdqkzvw2tlfvqshnevxt2qdutk47p9z964dkcsxazmf0vsjas4n4";
    const ESPLORA = process.env.ESPLORA_URL || "https://mempool.space/testnet4/api";
    let poolTxCache: Array<{ txid: string; outputs: Array<{ script: string; value: number }> }> | null = null;

    async function findBtcTxByScript(btcScript: string): Promise<string | null> {
      try {
        if (!poolTxCache) {
          const resp = await fetch(`${ESPLORA}/address/${POOL_ADDRESS}/txs`, { signal: AbortSignal.timeout(5000) });
          if (!resp.ok) return null;
          const txs: any[] = await resp.json();
          poolTxCache = txs.map((tx: any) => ({
            txid: tx.txid,
            outputs: tx.vout.map((o: any) => ({ script: o.scriptpubkey, value: o.value })),
          }));
        }
        // Find tx with an output matching the btc_script
        for (const tx of poolTxCache) {
          if (tx.outputs.some((o) => o.script === btcScript)) {
            return tx.txid;
          }
        }
      } catch { /* ignore */ }
      return null;
    }

    // Add requested redemptions from on-chain events for any that don't have
    // a PDA or completed entry. Check tracking data to determine real status:
    // - Has tracking with BTC txid → AwaitingConfirmation (BTC sent, waiting for SPV)
    // - Has tracking without BTC txid → Processing (backend is working on it)
    // - Has processing event → scan pool wallet for matching BTC tx
    // - No tracking, no completion → Cancelled (PDA closed without completion)
    const knownRequestIds = new Set(serialized.map((r) => r.requestId));
    for (const req of requestedEntries) {
      const rid = req.request_id.toString();
      if (knownRequestIds.has(rid)) continue; // already present

      // Check if backend has tracking data for this redemption
      const trackingEntries = [...trackingMap.values()];
      const tracking = trackingEntries.find(
        (t) => t.request_id?.toString() === rid || (t.requester === req.requester && t.amount_sats === req.amount_sats)
      );

      // Check if a processing event exists (BTC was likely sent)
      const hasProcessingEvent = processingByReqId.has(rid);

      let status = "Cancelled";
      let localStatus = "Cancelled";
      let btcTxid: string | null = null;

      if (tracking) {
        btcTxid = tracking.btc_txid ?? null;
        localStatus = tracking.local_status;
        if (tracking.local_status === "Completed" || tracking.local_status === "completed") {
          status = "Completed";
        } else if (tracking.btc_txid) {
          status = "AwaitingConfirmation";
        } else {
          status = "Processing";
        }
      } else if (hasProcessingEvent) {
        // Processing event exists but no tracking — backend likely restarted
        // and lost state. Try to find the BTC tx by scanning pool wallet.
        btcTxid = await findBtcTxByScript(req.btc_script);
        status = btcTxid ? "AwaitingConfirmation" : "AwaitingConfirmation";
        localStatus = btcTxid ? "AwaitingConfirmation" : "Processing";
      }

      serialized.push({
        pubkey: "",
        requestId: rid,
        amountSats: req.amount_sats.toString(),
        status,
        requester: req.requester,
        btcScript: req.btc_script,
        btcTxid,
        localStatus,
        createdAt: tracking?.created_at ?? req.block_time,
        updatedAt: tracking?.last_updated ?? req.block_time,
        retryCount: tracking?.retry_count ?? 0,
        trackerError: tracking?.error ?? null,
        actualReceived: null,
        requestTxSignature: req.tx_signature,
        processingTxSignature: processingByReqId.get(rid)?.tx_signature ?? null,
        completeTxSignature: null,
        simulated: tracking?.simulated ?? false,
        serviceFee: null,
        serviceFeeBps: req.service_fee_bps || feeConfig.bps,
        serviceFeeBase: req.service_fee_base || feeConfig.base,
        burnAmount: null,
        protocolRevenue: null,
        ...(transferCountMap.get(req.tx_signature) ?? { inputCount: 1, outputCount: 1 }),
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
