/**
 * GET /api/explorer/transactions
 *
 * Tries backend /api/explorer/transactions first.
 * Falls back to combining /api/explorer/deposits + /api/transfers
 * so pending BTC deposits (tracker-only) always appear.
 */

import { NextResponse } from "next/server";
import { getBackendUrl } from "@/lib/api/constants";
export const dynamic = "force-dynamic";

const BACKEND_URL = getBackendUrl();

interface ExplorerTx {
  txSignature?: string;
  tokenId?: string;
  tokenSymbol?: string | null;
  timestamp?: number;
  [key: string]: unknown;
}

async function fetchFromBackendUnified(): Promise<ExplorerTx[] | null> {
  try {
    const resp = await fetch(`${BACKEND_URL}/api/explorer/transactions`, { cache: "no-store" });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.success) return null;
    return data.transactions ?? [];
  } catch {
    return null;
  }
}

/** Fallback: combine deposits + transfers from separate endpoints */
async function fetchCombined(origin: string): Promise<ExplorerTx[]> {
  const [depositsResp, transfersResp] = await Promise.all([
    fetch(`${origin}/api/explorer/deposits`, { cache: "no-store" }).catch(() => null),
    fetch(`${origin}/api/transfers`, { cache: "no-store" }).catch(() => null),
  ]);

  const deposits: ExplorerTx[] = depositsResp?.ok
    ? ((await depositsResp.json()).transactions ?? [])
    : [];
  const transfers: ExplorerTx[] = transfersResp?.ok
    ? ((await transfersResp.json()).transactions ?? [])
    : [];

  const all = [...deposits, ...transfers];
  all.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  return all;
}

export async function GET(request: Request) {
  try {
    // Try unified backend endpoint first
    let transactions = await fetchFromBackendUnified();

    // Fallback: combine deposits (includes tracker-only) + transfers
    if (!transactions) {
      const origin = new URL(request.url).origin;
      transactions = await fetchCombined(origin);
    }

    // Resolve token symbols server-side
    try {
      const { buildTokenIdMap } = await import("@/lib/token-map");
      const tokenMap = await buildTokenIdMap();
      for (const tx of transactions) {
        if (tx.tokenId && !tx.tokenSymbol) {
          tx.tokenSymbol = tokenMap.get(tx.tokenId) ?? tokenMap.get(tx.tokenId?.toLowerCase()) ?? null;
        }
      }
    } catch { /* no symbols */ }

    return NextResponse.json({ success: true, transactions, count: transactions.length });
  } catch (err) {
    console.error("[Explorer Transactions API] Error:", err);
    return NextResponse.json({ success: true, transactions: [], count: 0 });
  }
}
