/**
 * Regtest BTC faucet — stub route.
 *
 * Real implementation: call `sendtoaddress` on the regtest bitcoind container
 * (or shell out via esplora) and mine one block so the recipient sees a
 * confirmed UTXO. Tracked in TODOS.md → "Regtest faucet backend route".
 *
 * Until that lands this route refuses to send and returns a clear error so
 * the frontend can render an actionable hint instead of pretending to work.
 */

import { NextRequest, NextResponse } from "next/server";

const BTC_NETWORK = process.env.NEXT_PUBLIC_BTC_NETWORK ?? "";
const REGTEST_FAUCET_URL = process.env.REGTEST_FAUCET_URL;

interface DripBody {
  address?: string;
  amountSats?: number;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (BTC_NETWORK !== "regtest") {
    return NextResponse.json(
      { ok: false, error: `faucet only available on regtest; current network=${BTC_NETWORK || "unknown"}` },
      { status: 400 },
    );
  }

  let body: DripBody;
  try {
    body = (await req.json()) as DripBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const address = (body.address ?? "").trim();
  const amountSats = Number(body.amountSats ?? 0);
  if (!address.startsWith("bcrt1")) {
    return NextResponse.json({ ok: false, error: "address must be a regtest bech32 (bcrt1…)" }, { status: 400 });
  }
  if (!Number.isFinite(amountSats) || amountSats <= 0 || amountSats > 100_000_000) {
    return NextResponse.json({ ok: false, error: "amountSats must be 1..100_000_000" }, { status: 400 });
  }

  if (!REGTEST_FAUCET_URL) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "REGTEST_FAUCET_URL is not configured. Set it to the bitcoind regtest RPC " +
          "(or a small wrapper service that calls `sendtoaddress` and then `generatetoaddress 1 <miner>`). " +
          "See TODOS.md → 'Regtest faucet backend route'.",
      },
      { status: 501 },
    );
  }

  try {
    const upstream = await fetch(REGTEST_FAUCET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, amountSats }),
    });
    const json = (await upstream.json()) as { ok?: boolean; txid?: string; error?: string };
    if (!upstream.ok || !json.ok) {
      return NextResponse.json(
        { ok: false, error: json.error ?? `upstream HTTP ${upstream.status}` },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true, txid: json.txid ?? "" });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `upstream call failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }
}
