/**
 * GET /api/transfers
 *
 * Proxy to backend /api/transfers. If backend returns 404 (older deployment),
 * falls back to building transfer data from:
 *  - Backend /api/announcements (always available) for outputs
 *  - Solana RPC getTransaction to detect nullifier PDAs (1-byte accounts
 *    created in the tx) + blockTime
 */

import { NextResponse } from "next/server";
import { fetchAnnouncementsFromRpc } from "@/lib/api/rpc-fallback";
import { getBackendUrl } from "@/lib/api/constants";
export const dynamic = "force-dynamic";

const BACKEND_URL = getBackendUrl();

function decodeLeU64(hex: string): number {
  try {
    const bytes = Uint8Array.from(hex.match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) ?? []);
    if (bytes.length < 8) return 0;
    const view = new DataView(bytes.buffer);
    return Number(view.getBigUint64(0, true));
  } catch { return 0; }
}
const RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
  process.env.SOLANA_RPC_URL ||
  "https://api.devnet.solana.com";

// Rent-exempt minimum for a 1-byte account (NullifierRecord = just discriminator)
// Calculated: (128 + 1) * 3480 * 2 = 897840 lamports
const RENT_EXEMPT_1_BYTE = 897840;
// Known accounts to exclude when detecting nullifier PDAs
const KNOWN_PROGRAMS = new Set([
  "11111111111111111111111111111111",       // System Program
  "ComputeBudget111111111111111111111111",   // Compute Budget
  "SysvarC1ock11111111111111111111111111",   // Clock Sysvar
]);

interface AnnouncementRow {
  leaf_index: number;
  announcement_type: number;
  commitment: string;
  tx_signature: string;
  slot: number;
  block_time?: number;
}

interface TransferItem {
  tx_signature: string;
  commitments: string[];
  leaf_indices: number[];
  nullifier_hashes: string[];
  nullifier_pdas: string[];
  output_count: number;
  input_count: number;
  timestamp: number;
  operation_type: number;
  instruction_disc?: number;
  transfer_type?: string;
}

interface TxResult {
  nullifierPdas: string[];
  blockTime: number;
}

/**
 * Fetch transaction from RPC, extract nullifier PDAs and blockTime.
 *
 * Nullifier PDAs are identified as accounts that were CREATED in this tx
 * (preBalance=0 → postBalance=RENT_EXEMPT_1_BYTE). These are the 1-byte
 * NullifierRecord PDAs created by the transact instruction.
 */
async function getTransactionData(signature: string): Promise<TxResult> {
  try {
    const resp = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: [
          signature,
          { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });

    const json = await resp.json();
    if (!json.result) return { nullifierPdas: [], blockTime: 0 };

    const result = json.result;
    const blockTime: number = result.blockTime ?? 0;

    // Extract account keys (handle both legacy and versioned tx format)
    const accountKeys: string[] = (
      result.transaction?.message?.accountKeys ?? []
    ).map((k: string | { pubkey: string }) =>
      typeof k === "string" ? k : k.pubkey,
    );

    const preBalances: number[] = result.meta?.preBalances ?? [];
    const postBalances: number[] = result.meta?.postBalances ?? [];

    // Find nullifier PDAs: accounts created in this tx with ~1-byte rent
    const nullifierPdas: string[] = [];
    for (let i = 0; i < accountKeys.length; i++) {
      const pre = preBalances[i] ?? 0;
      const post = postBalances[i] ?? 0;
      const key = accountKeys[i];

      // Newly created (pre=0), with rent for 1-byte data, not a known program
      if (
        pre === 0 &&
        post === RENT_EXEMPT_1_BYTE &&
        !KNOWN_PROGRAMS.has(key)
      ) {
        nullifierPdas.push(key);
      }
    }

    return { nullifierPdas, blockTime };
  } catch {
    return { nullifierPdas: [], blockTime: 0 };
  }
}

async function buildTransfersFromRpc(): Promise<Response> {
  try {
    const txMetas = await fetchAnnouncementsFromRpc(1); // type=1 = transfers

    const transfers: TransferItem[] = txMetas.map((tx) => {
      const sorted = tx.announcements.sort((a, b) => a.leafIndex - b.leafIndex);
      return {
        tx_signature: tx.signature,
        commitments: sorted.map((a) => a.commitment),
        leaf_indices: sorted.map((a) => a.leafIndex),
        nullifier_hashes: [],
        nullifier_pdas: tx.nullifierPdas,
        output_count: sorted.length,
        input_count: tx.nullifierPdas.length,
        timestamp: tx.blockTime,
        operation_type: 2,
        instruction_disc: 14,
      };
    });

    transfers.sort((a, b) => {
      const maxA = Math.max(...a.leaf_indices);
      const maxB = Math.max(...b.leaf_indices);
      return maxB - maxA;
    });

    return NextResponse.json({
      success: true,
      transfers,
      count: transfers.length,
      fallback: true,
    });
  } catch (rpcErr) {
    console.error("[Transfers API] RPC fallback also failed:", rpcErr);
    return NextResponse.json({ success: true, transfers: [], count: 0 });
  }
}

export async function GET() {
  try {
    // Try the dedicated backend /api/transfers endpoint first
    const resp = await fetch(`${BACKEND_URL}/api/transfers`, { cache: "no-store" });
    if (resp.ok) {
      const data = await resp.json();
      if (data.success && Array.isArray(data.transfers) && data.transfers.length > 0) {
        // Enrich: for unshield txs without token_id, look up from announcements
        const missingTokenIds = data.transfers.some((t: any) => !t.token_id && t.instruction_disc === 15);
        if (missingTokenIds) {
          try {
            const annResp = await fetch(`${BACKEND_URL}/api/announcements`, { cache: "no-store" });
            if (annResp.ok) {
              const annData = await annResp.json();
              // Build a map of all known token_ids from deposit announcements
              const tokenIdByAmount: Map<number, string> = new Map();
              for (const a of annData.announcements ?? []) {
                if (a.token_id && a.announcement_type === 0) {
                  const amount = decodeLeU64(a.encrypted_amount);
                  tokenIdByAmount.set(amount, a.token_id);
                }
              }
              // Match unshield amount to deposit amount's token_id
              for (const t of data.transfers) {
                if (!t.token_id && t.unshield_amount) {
                  t.token_id = tokenIdByAmount.get(t.unshield_amount) ?? null;
                }
              }
            }
          } catch { /* ignore enrichment failure */ }
        }
        // tokenSymbol resolved on frontend via token-map.ts
        return NextResponse.json(data);
      }
    }

    // Fallback: build from announcements + RPC
    console.log("[Transfers API] Fallback: building from announcements + RPC");

    let annResp: Response;
    try {
      annResp = await fetch(`${BACKEND_URL}/api/announcements`, { cache: "no-store" });
    } catch {
      annResp = new Response(null, { status: 503 });
    }
    if (!annResp.ok) {
      // Third tier: pure RPC fallback
      console.log("[Transfers API] Announcements also unavailable, trying RPC fallback");
      return buildTransfersFromRpc();
    }

    const annData = await annResp.json();
    const announcements: AnnouncementRow[] = annData.announcements ?? [];

    // Group type=1 (transfer) announcements by tx_signature
    const transferAnns = announcements.filter((a) => a.announcement_type === 1);
    const grouped = new Map<string, AnnouncementRow[]>();
    for (const a of transferAnns) {
      const existing = grouped.get(a.tx_signature) ?? [];
      existing.push(a);
      grouped.set(a.tx_signature, existing);
    }

    if (grouped.size === 0) {
      return NextResponse.json({ success: true, transfers: [], count: 0 });
    }

    // For each unique tx, fetch transaction data from RPC (parallel, batched)
    const txSignatures = Array.from(grouped.keys());
    const txDataMap = new Map<string, TxResult>();

    // Fetch in batches of 5 to avoid rate limiting
    for (let i = 0; i < txSignatures.length; i += 5) {
      const batch = txSignatures.slice(i, i + 5);
      const results = await Promise.all(
        batch.map((sig) => getTransactionData(sig)),
      );
      for (let j = 0; j < batch.length; j++) {
        txDataMap.set(batch[j], results[j]);
      }
    }

    // Build transfer items
    const transfers: TransferItem[] = [];
    for (const [txSig, anns] of grouped) {
      const sorted = anns.sort((a, b) => a.leaf_index - b.leaf_index);
      const txData = txDataMap.get(txSig);
      const nullifierPdas = txData?.nullifierPdas ?? [];
      const blockTime = txData?.blockTime ?? sorted[0]?.block_time ?? 0;

      transfers.push({
        tx_signature: txSig,
        commitments: sorted.map((a) => a.commitment),
        leaf_indices: sorted.map((a) => a.leaf_index),
        nullifier_hashes: [],
        nullifier_pdas: nullifierPdas,
        output_count: sorted.length,
        input_count: nullifierPdas.length,
        timestamp: blockTime,
        operation_type: 2, // fallback assumes transact (private send)
        instruction_disc: 14,
      });
    }

    // Sort by max leaf_index descending (newest first)
    transfers.sort((a, b) => {
      const maxA = Math.max(...a.leaf_indices);
      const maxB = Math.max(...b.leaf_indices);
      return maxB - maxA;
    });

    return NextResponse.json({
      success: true,
      transfers,
      count: transfers.length,
      fallback: true,
    });
  } catch (err) {
    console.error("[Transfers API] Error:", err);
    return NextResponse.json({ success: true, transfers: [], count: 0 });
  }
}
