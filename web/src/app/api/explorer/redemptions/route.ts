/**
 * GET /api/explorer/redemptions
 *
 * Server-side join of:
 * 1. On-chain RedemptionRequest PDAs (active: Pending/Processing/Failed)
 * 2. Backend consolidated data (tracking + requested/processing/completed events)
 */

import { NextResponse } from "next/server";
import type { RpcClient } from "@privacy-coin/sdk";
// Lazy imports to avoid build-time codec validation errors from @solana/kit
const getPrivacyCoinSDK = () => import("@privacy-coin/sdk");
const getSolanaKit = () => import("@solana/kit");

import { getHeliusRpcUrl } from "@/lib/helius-server";

const RPC_URL = getHeliusRpcUrl();

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

async function createServerRpc(): Promise<RpcClient> {
  const { createSolanaRpc } = await getSolanaKit();
  const rpc = createSolanaRpc(RPC_URL);
  return {
    async getProgramAccounts(programId, config) {
      const filters: unknown[] = [];
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
        .getProgramAccounts(
          programId as Parameters<typeof rpc.getProgramAccounts>[0],
          { encoding: "base64", filters } as Parameters<typeof rpc.getProgramAccounts>[1],
        )
        .send();
      return (accounts as Array<{ pubkey: string; account: { data: string } }>).map((acc) => ({
        pubkey: String(acc.pubkey),
        account: { data: acc.account.data },
      }));
    },
  };
}

export async function GET() {
  try {
    const { getConfig, fetchExplorerRedemptions } = await getPrivacyCoinSDK();

    // Fetch all sources in parallel: PDA scan + consolidated backend + pool state + transfers
    const [redemptions, allResp, poolStateResp, transfersResp] = await Promise.all([
      createServerRpc().then(rpc => fetchExplorerRedemptions(
        rpc,
        getConfig().privacyCoinProgramId,
      )).catch((e) => {
        console.warn("[Redemptions] PDA scan failed:", e.message);
        return [];
      }),
      fetch(`${BACKEND_URL}/api/redemption/all`).catch(() => null),
      fetch(`${BACKEND_URL}/api/relayer/meta`).catch(() => null),
      fetch(`${BACKEND_URL}/api/transfers`).catch(() => null),
    ]);

    // Parse fee config from backend relayer meta
    let feeConfig = { bps: 30, base: 2000 }; // defaults
    if (poolStateResp?.ok) {
      try {
        const metaData = await poolStateResp.json();
        if (metaData) {
          feeConfig = {
            bps: metaData.service_fee_bps ?? 30,
            base: metaData.service_fee_base ?? 2000,
          };
        }
      } catch { /* use defaults */ }
    }

    // Parse consolidated backend response
    const trackingMap = new Map<string, TrackingEntry>();
    let completedEntries: CompletedEntry[] = [];
    let requestedEntries: RequestedEntry[] = [];
    let processingEntries: ProcessingEntry[] = [];

    if (allResp?.ok) {
      try {
        const allData = await allResp.json();
        for (const entry of (allData.tracking ?? []) as TrackingEntry[]) {
          trackingMap.set(entry.pda_address, entry);
        }
        completedEntries = allData.completed ?? [];
        requestedEntries = allData.requested ?? [];
        processingEntries = allData.processing ?? [];
      } catch {
        // Backend unavailable — continue with PDA-only data
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

    // Index events by request_id for tx signature lookup
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

    // Build tracking lookup by request_id (no heuristic matching)
    const trackingByReqId = new Map<string, TrackingEntry>();
    for (const t of trackingMap.values()) {
      if (t.request_id != null) {
        trackingByReqId.set(t.request_id.toString(), t);
      }
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

    // Add requested redemptions that don't have PDA or completed entry
    // Determine status by request_id lookup only (no heuristic matching)
    const POOL_ADDRESS = process.env.POOL_BTC_ADDRESS || "tb1pksj664hdqkzvw2tlfvqshnevxt2qdutk47p9z964dkcsxazmf0vsjas4n4";
    const ESPLORA = process.env.ESPLORA_URL || "https://mempool.space/testnet4/api";
    let poolTxCache: Array<{ txid: string; outputs: Array<{ script: string; value: number }> }> | null = null;

    async function findBtcTxByScript(btcScript: string): Promise<string | null> {
      try {
        if (!poolTxCache) {
          const resp = await fetch(`${ESPLORA}/address/${POOL_ADDRESS}/txs`, { signal: AbortSignal.timeout(5000) });
          if (!resp.ok) return null;
          const txs: Array<{ txid: string; vout: Array<{ scriptpubkey: string; value: number }> }> = await resp.json();
          poolTxCache = txs.map((tx) => ({
            txid: tx.txid,
            outputs: tx.vout.map((o) => ({ script: o.scriptpubkey, value: o.value })),
          }));
        }
        for (const tx of poolTxCache) {
          if (tx.outputs.some((o) => o.script === btcScript)) {
            return tx.txid;
          }
        }
      } catch { /* ignore */ }
      return null;
    }

    const knownRequestIds = new Set(serialized.map((r) => r.requestId));
    const onChainPdaRequestIds = new Set(
      redemptions.map((r) => r.requestId?.toString()).filter(Boolean)
    );

    for (const req of requestedEntries) {
      const rid = req.request_id.toString();
      if (knownRequestIds.has(rid)) continue;

      // Look up tracking by request_id only (no heuristic matching by requester+amount)
      const tracking = trackingByReqId.get(rid);

      const hasProcessingEvent = processingByReqId.has(rid);
      const hasOnChainPda = onChainPdaRequestIds.has(rid);
      const isRecent = req.block_time && (Date.now() / 1000 - req.block_time) < 3600;

      let status = hasOnChainPda || isRecent ? "Pending" : "Cancelled";
      let localStatus = hasOnChainPda || isRecent ? "Pending" : "Cancelled";
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

    // Deduplicate by requestTxSignature — multi-output redeems from the same tx
    // get merged into one entry with summed amounts
    const byTxSig = new Map<string, typeof serialized[0]>();
    const deduplicated: typeof serialized = [];
    for (const r of serialized) {
      const txSig = r.requestTxSignature;
      if (!txSig) {
        deduplicated.push(r);
        continue;
      }
      const existing = byTxSig.get(txSig);
      if (existing) {
        // Merge: sum amounts, keep the more advanced status
        const existingAmt = BigInt(existing.amountSats || "0");
        const thisAmt = BigInt(r.amountSats || "0");
        existing.amountSats = (existingAmt + thisAmt).toString();
        if (existing.serviceFee && r.serviceFee) {
          existing.serviceFee = (BigInt(existing.serviceFee) + BigInt(r.serviceFee)).toString();
        }
      } else {
        byTxSig.set(txSig, r);
        deduplicated.push(r);
      }
    }

    // Sort by time descending (newest first)
    deduplicated.sort((a, b) => b.createdAt - a.createdAt);

    return NextResponse.json({
      success: true,
      redemptions: deduplicated,
      count: deduplicated.length,
    });
  } catch (err) {
    console.error("[Explorer Redemptions API] Error:", err);
    return NextResponse.json(
      { success: false, error: "Failed to fetch redemptions" },
      { status: 500 },
    );
  }
}
