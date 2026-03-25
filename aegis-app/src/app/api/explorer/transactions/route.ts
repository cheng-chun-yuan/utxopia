/**
 * GET /api/explorer/transactions
 *
 * Single endpoint for ALL explorer transactions: shield, transfer, unshield, withdraw.
 * Merges deposits + transfers from backend into unified ExplorerTransaction[].
 */

import { NextResponse } from "next/server";
import { getNetworkConfig } from "@/lib/network-config";
export const dynamic = "force-dynamic";

const BACKEND_URL = getNetworkConfig().backend.url || "http://localhost:3001";

interface TxOutput {
  type: "commitment" | "unshield" | "withdraw";
  commitment?: string;
  leafIndex?: number;
  amount?: number;
  fee?: number;
  payout?: number;
  recipient?: string;
}

interface TxInput {
  nullifierHash?: string;
  nullifierPda?: string;
  grossAmount?: number;
  fee?: number;
  netAmount?: number;
  btcDepositTxid?: string;
  btcSweepTxid?: string;
}

interface ExplorerTransaction {
  txSignature: string;
  type: "shield" | "transfer" | "unshield" | "withdraw";
  tokenId: string | null;
  tokenSymbol: string | null;
  timestamp: number;
  status: string;
  inputs: TxInput[];
  outputs: TxOutput[];
  btcMeta?: any;
}

function transformTransfer(t: any, tokenMap: Map<string, string>): ExplorerTransaction {
  const tokenSymbol = t.token_symbol
    ?? (t.token_id ? (tokenMap.get(t.token_id) ?? tokenMap.get(t.token_id?.toLowerCase()) ?? null) : null);

  let type: ExplorerTransaction["type"] = "transfer";
  if (t.transfer_type === "redeem") type = "withdraw";
  else if (t.transfer_type === "unshield") type = "unshield";

  const nullHashes: string[] = t.nullifier_hashes ?? [];
  const nullPdas: string[] = t.nullifier_pdas ?? [];
  const inputs: TxInput[] = nullHashes.map((hash: string, i: number) => ({
    nullifierHash: hash,
    nullifierPda: nullPdas[i] ?? undefined,
  }));

  const outputs: TxOutput[] = [];

  // Commitment outputs
  const commitments: string[] = t.commitments ?? [];
  const leafIndices: number[] = t.leaf_indices ?? [];
  for (let i = 0; i < commitments.length; i++) {
    outputs.push({ type: "commitment", commitment: commitments[i], leafIndex: leafIndices[i] });
  }

  // Per-output unshield/withdraw from JSON array
  const perOutputs: any[] = t.unshield_outputs ?? [];
  if (perOutputs.length > 0) {
    for (const o of perOutputs) {
      outputs.push({
        type: o.type === "withdraw" ? "withdraw" : "unshield",
        amount: o.amount, fee: o.fee, payout: o.payout, recipient: o.recipient,
      });
    }
  } else if (t.unshield_amount != null && (type === "unshield" || type === "withdraw")) {
    outputs.push({
      type: type === "withdraw" ? "withdraw" : "unshield",
      amount: t.unshield_amount, fee: t.unshield_fee, payout: t.unshield_payout, recipient: t.unshield_recipient,
    });
  }

  return { txSignature: t.tx_signature, type, tokenId: t.token_id ?? null, tokenSymbol, timestamp: t.timestamp, status: t.status ?? "confirmed", inputs, outputs };
}

function decodeLeU64(hex: string): number {
  try {
    const bytes = Uint8Array.from(hex.match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) ?? []);
    if (bytes.length < 8) return 0;
    return Number(new DataView(bytes.buffer).getBigUint64(0, true));
  } catch { return 0; }
}

export async function GET() {
  try {
    // Resolve token symbols
    let tokenMap = new Map<string, string>();
    try {
      const { buildTokenIdMap } = await import("@/lib/token-map");
      tokenMap = await buildTokenIdMap();
    } catch { /* no symbols */ }

    // Fetch deposits + transfers in parallel from backend
    const [depositsResp, transfersResp] = await Promise.all([
      fetch(`${BACKEND_URL}/api/announcements`, { cache: "no-store" }).catch(() => null),
      fetch(`${BACKEND_URL}/api/transfers`, { cache: "no-store" }).catch(() => null),
    ]);

    const transactions: ExplorerTransaction[] = [];

    // Shield transactions from announcements (type=0 = deposits)
    if (depositsResp?.ok) {
      const annData = await depositsResp.json();
      for (const a of (annData.announcements ?? []).filter((a: any) => a.announcement_type === 0)) {
        const amount = decodeLeU64(a.encrypted_amount);
        const tokenId = a.token_id ?? null;
        const tokenSym = tokenId ? (tokenMap.get(tokenId) ?? tokenMap.get(tokenId?.toLowerCase()) ?? null) : null;

        transactions.push({
          txSignature: a.tx_signature,
          type: "shield",
          tokenId,
          tokenSymbol: tokenSym,
          timestamp: a.block_time || 0,
          status: "confirmed",
          inputs: [{
            grossAmount: a.btc_deposit_amount_sats ?? (a.deposit_gross_amount ?? undefined),
            fee: a.deposit_fee ?? undefined,
            netAmount: amount,
            btcDepositTxid: a.btc_deposit_txid ?? undefined,
            btcSweepTxid: a.btc_sweep_txid ?? undefined,
          }],
          outputs: [{
            type: "commitment",
            commitment: a.commitment,
            leafIndex: a.leaf_index,
            amount,
          }],
        });
      }
    }

    // Transfer/unshield/withdraw transactions
    if (transfersResp?.ok) {
      const data = await transfersResp.json();
      if (data.success && Array.isArray(data.transfers)) {
        for (const t of data.transfers) {
          transactions.push(transformTransfer(t, tokenMap));
        }
      }
    }

    // Sort by timestamp desc
    transactions.sort((a, b) => b.timestamp - a.timestamp);

    return NextResponse.json({ success: true, transactions, count: transactions.length });
  } catch (err) {
    console.error("[Explorer Transactions API] Error:", err);
    return NextResponse.json({ success: true, transactions: [], count: 0 });
  }
}
