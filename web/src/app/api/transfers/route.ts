/**
 * GET /api/transfers
 *
 * Returns all non-deposit transactions in a unified structure with typed
 * inputs[] and outputs[] arrays. Each output is one of:
 *   - "commitment" (shielded change)
 *   - "unshield" (SPL token to wallet)
 *   - "withdraw" (BTC redemption request)
 *
 * Data flow: backend /api/transfers → transform to ExplorerTransaction[]
 */

import { NextResponse } from "next/server";
import { getBackendUrl } from "@/lib/api/constants";
import { detectNetworkFromRequest } from "@/lib/network-config";
export const dynamic = "force-dynamic";

// =============================================================================
// Types — shared with frontend hooks
// =============================================================================

export interface TxOutput {
  type: "commitment" | "unshield" | "withdraw";
  // commitment fields
  commitment?: string;
  leafIndex?: number;
  // unshield/withdraw fields
  amount?: number;
  fee?: number;
  payout?: number;
  recipient?: string;
  // withdraw-only fields
  requestId?: string;
  btcScript?: string;
  btcTxid?: string;
  localStatus?: string;
}

export interface TxInput {
  nullifierHash?: string;
  nullifierPda?: string;
}

export interface ExplorerTransaction {
  txSignature: string;
  type: "transfer" | "unshield" | "withdraw";
  tokenId: string | null;
  tokenSymbol: string | null;
  timestamp: number;
  status: string;
  inputs: TxInput[];
  outputs: TxOutput[];
}

// =============================================================================
// Transform backend flat response → typed structure
// =============================================================================

interface BackendTransfer {
  token_symbol?: string;
  token_id?: string;
  transfer_type?: string;
  nullifier_hashes?: string[];
  nullifier_pdas?: string[];
  commitments?: string[];
  leaf_indices?: number[];
  unshield_outputs?: Array<{ type?: string; amount?: number; fee?: number; payout?: number; recipient?: string }>;
  unshield_amount?: number;
  unshield_fee?: number;
  unshield_payout?: number;
  unshield_recipient?: string;
  tx_signature: string;
  timestamp: number;
  status?: string;
  instruction_disc?: number;
}

function transformTransfer(t: BackendTransfer, tokenMap: Map<string, string>): ExplorerTransaction {
  const tokenSymbol = t.token_symbol
    ?? (t.token_id ? (tokenMap.get(t.token_id) ?? tokenMap.get(t.token_id?.toLowerCase()) ?? null) : null);

  // Determine tx type
  let type: ExplorerTransaction["type"] = "transfer";
  if (t.transfer_type === "redeem") type = "withdraw";
  else if (t.transfer_type === "unshield") type = "unshield";

  // Build inputs from nullifier arrays
  const nullHashes: string[] = t.nullifier_hashes ?? [];
  const nullPdas: string[] = t.nullifier_pdas ?? [];
  const inputs: TxInput[] = nullHashes.map((hash: string, i: number) => ({
    nullifierHash: hash,
    nullifierPda: nullPdas[i] ?? undefined,
  }));

  // Build outputs
  const outputs: TxOutput[] = [];

  // 1. Commitment outputs (shielded change from announcements)
  const commitments: string[] = t.commitments ?? [];
  const leafIndices: number[] = t.leaf_indices ?? [];
  for (let i = 0; i < commitments.length; i++) {
    outputs.push({
      type: "commitment",
      commitment: commitments[i],
      leafIndex: leafIndices[i],
    });
  }

  // 2. Unshield/withdraw outputs from per-output JSON array (multi-output support)
  const perOutputs = t.unshield_outputs ?? [];
  if (perOutputs.length > 0) {
    for (const o of perOutputs) {
      outputs.push({
        type: o.type === "withdraw" ? "withdraw" : "unshield",
        amount: o.amount,
        fee: o.fee,
        payout: o.payout,
        recipient: o.recipient,
      });
    }
  } else if (t.unshield_amount != null && (type === "unshield" || type === "withdraw")) {
    // Single-output from flat fields (older indexed data without per-output breakdown)
    outputs.push({
      type: type === "withdraw" ? "withdraw" : "unshield",
      amount: t.unshield_amount,
      fee: t.unshield_fee ?? undefined,
      payout: t.unshield_payout ?? undefined,
      recipient: t.unshield_recipient ?? undefined,
    });
  }

  return {
    txSignature: t.tx_signature,
    type,
    tokenId: t.token_id ?? null,
    tokenSymbol,
    timestamp: t.timestamp,
    status: t.status ?? "confirmed",
    inputs,
    outputs,
  };
}

// =============================================================================
// Route handler
// =============================================================================

export async function GET(request: Request) {
  try {
    const network = detectNetworkFromRequest(request);
    const backendUrl = getBackendUrl(network);
    const resp = await fetch(`${backendUrl}/api/transfers`, { cache: "no-store" });
    if (!resp.ok) {
      return NextResponse.json({ success: true, transactions: [], count: 0 });
    }

    const data = await resp.json();
    if (!data.success || !Array.isArray(data.transfers)) {
      return NextResponse.json({ success: true, transactions: [], count: 0 });
    }

    // Resolve token symbols server-side
    let tokenMap = new Map<string, string>();
    try {
      const { buildTokenIdMap } = await import("@/lib/token-map");
      tokenMap = await buildTokenIdMap();
    } catch { /* fallback: no symbols */ }

    // Enrich missing token_ids from announcements
    const missingTokenIds = data.transfers.some((t: BackendTransfer) => !t.token_id && t.instruction_disc === 15);
    if (missingTokenIds) {
      try {
        const annResp = await fetch(`${backendUrl}/api/announcements`, { cache: "no-store" });
        if (annResp.ok) {
          const annData = await annResp.json();
          const tokenIdByAmount = new Map<number, string>();
          for (const a of annData.announcements ?? []) {
            if (a.token_id && a.announcement_type === 0) {
              const bytes = Uint8Array.from(
                (a.encrypted_amount as string).match(/.{1,2}/g)?.map((b: string) => parseInt(b, 16)) ?? [],
              );
              if (bytes.length >= 8) {
                const view = new DataView(bytes.buffer);
                tokenIdByAmount.set(Number(view.getBigUint64(0, true)), a.token_id);
              }
            }
          }
          for (const t of data.transfers) {
            if (!t.token_id && t.unshield_amount) {
              t.token_id = tokenIdByAmount.get(t.unshield_amount) ?? null;
            }
          }
        }
      } catch { /* ignore */ }
    }

    const transactions: ExplorerTransaction[] = data.transfers.map(
      (t: BackendTransfer) => transformTransfer(t, tokenMap),
    );

    // Enrich withdraw outputs with redemption data (btcTxid, completion status)
    try {
      const redemptionResp = await fetch(`${backendUrl}/api/redemption/all`, { cache: "no-store" });
      if (redemptionResp.ok) {
        const rData = await redemptionResp.json();
        const trackingByReqTx = new Map<string, { btc_txid?: string; local_status?: string; amount_sats?: number }>();
        for (const t of (rData.tracking ?? []) as Array<{ request_id?: string; pda_address: string; btc_txid?: string; local_status?: string; amount_sats?: number }>) {
          if (t.request_id) trackingByReqTx.set(t.pda_address, t);
        }
        const completedByReqId = new Map<string, { request_id?: number }>();
        for (const c of (rData.completed ?? []) as Array<{ request_id?: number }>) {
          completedByReqId.set(c.request_id?.toString() ?? "", c);
        }

        // For each withdraw tx, enrich outputs with tracking/completion data
        for (const tx of transactions) {
          if (tx.type !== "withdraw") continue;
          for (const out of tx.outputs) {
            if (out.type !== "withdraw") continue;
            // Try to find tracking entry by matching amount + recipient
            for (const [, t] of trackingByReqTx) {
              if (t.amount_sats === out.amount) {
                out.btcTxid = t.btc_txid ?? undefined;
                out.localStatus = t.local_status ?? undefined;
                break;
              }
            }
          }
        }
      }
    } catch { /* ignore — enrichment is optional */ }

    return NextResponse.json({
      success: true,
      transactions,
      count: transactions.length,
    });
  } catch (err) {
    console.error("[Transfers API] Error:", err);
    return NextResponse.json({ success: true, transactions: [], count: 0 });
  }
}
