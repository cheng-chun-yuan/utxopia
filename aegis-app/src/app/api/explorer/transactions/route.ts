/**
 * GET /api/explorer/transactions
 *
 * Proxy to backend /api/explorer/transactions.
 * Resolves token symbols server-side before returning.
 */

import { NextResponse } from "next/server";
import { getNetworkConfig } from "@/lib/network-config";
export const dynamic = "force-dynamic";

const BACKEND_URL = getNetworkConfig().backend.url || "http://localhost:3001";

export async function GET() {
  try {
    const resp = await fetch(`${BACKEND_URL}/api/explorer/transactions`, { cache: "no-store" });
    if (!resp.ok) {
      return NextResponse.json({ success: true, transactions: [], count: 0 });
    }

    const data = await resp.json();
    if (!data.success) {
      return NextResponse.json({ success: true, transactions: [], count: 0 });
    }

    // Resolve token symbols server-side
    try {
      const { buildTokenIdMap } = await import("@/lib/token-map");
      const tokenMap = await buildTokenIdMap();
      for (const tx of data.transactions ?? []) {
        if (tx.tokenId && !tx.tokenSymbol) {
          tx.tokenSymbol = tokenMap.get(tx.tokenId) ?? tokenMap.get(tx.tokenId?.toLowerCase()) ?? null;
        }
      }
    } catch { /* no symbols */ }

    return NextResponse.json(data);
  } catch (err) {
    console.error("[Explorer Transactions API] Error:", err);
    return NextResponse.json({ success: true, transactions: [], count: 0 });
  }
}
