import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { getNetworkConfig } from "@/lib/network-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const owner = request.nextUrl.searchParams.get("owner");

  if (!owner) {
    return NextResponse.json(
      { error: "Missing owner public key" },
      { status: 400 }
    );
  }

  try {
    const ownerPubkey = new PublicKey(owner);
    const { solana, tokens } = getNetworkConfig();

    const rpcResponse = await fetch(solana.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenAccountsByOwner",
        params: [
          ownerPubkey.toBase58(),
          { mint: tokens.zkbtcMint },
          { encoding: "jsonParsed", commitment: "confirmed" },
        ],
      }),
      cache: "no-store",
    });

    if (!rpcResponse.ok) {
      return NextResponse.json(
        { error: `RPC request failed with ${rpcResponse.status}` },
        { status: 502 }
      );
    }

    const result = await rpcResponse.json();
    const accounts = result?.result?.value ?? [];
    let total = 0n;

    for (const account of accounts) {
      const amount = account?.account?.data?.parsed?.info?.tokenAmount?.amount;
      if (typeof amount === "string") {
        total += BigInt(amount);
      }
    }

    return NextResponse.json({ amount: total.toString() });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to fetch public balance",
      },
      { status: 500 }
    );
  }
}
