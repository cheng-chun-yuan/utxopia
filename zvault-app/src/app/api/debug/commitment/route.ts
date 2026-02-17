import { NextRequest, NextResponse } from "next/server";
import { initPoseidon, poseidonHashSync } from "@zvault/sdk";

export const runtime = "nodejs";

/**
 * POST /api/debug/commitment - Log debug info from pay-flow
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    console.log("\n[Debug] ===== PAY FLOW DEBUG INFO =====");
    console.log("[Debug] Source:", body.source);
    console.log("[Debug] Leaf Index:", body.leafIndex);
    console.log("[Debug] Amount:", body.amount, "sats");
    console.log("[Debug] Stealth PrivKey:", body.stealthPrivKey?.slice(0, 16) + "...");
    console.log("[Debug] Derived PubKeyX:", body.derivedPubKeyX);
    console.log("[Debug] Scanned PubKeyX:", body.scannedPubKeyX);
    console.log("[Debug] PubKeyX Match:", body.derivedPubKeyX === body.scannedPubKeyX);
    console.log("[Debug] Derived Commitment:", body.derivedCommitment);
    console.log("[Debug] Stored Commitment: ", body.storedCommitment);
    console.log("[Debug] COMMITMENT MATCH:", body.match);
    console.log("[Debug] ===================================\n");

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

/**
 * Debug endpoint to verify commitment calculation
 *
 * GET /api/debug/commitment?pubKeyX=<hex>&amount=<number>&expected=<hex>
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const pubKeyXHex = searchParams.get("pubKeyX");
  const amountStr = searchParams.get("amount");
  const expectedHex = searchParams.get("expected");

  if (!pubKeyXHex || !amountStr) {
    return NextResponse.json({
      success: false,
      error: "Missing pubKeyX or amount parameter",
    }, { status: 400 });
  }

  try {
    await initPoseidon();

    // Parse inputs
    const pubKeyX = BigInt("0x" + pubKeyXHex.replace("0x", ""));
    const amount = BigInt(amountStr);

    // Compute commitment: Poseidon(pubKeyX, amount)
    const commitment = poseidonHashSync([pubKeyX, amount]);
    const commitmentHex = commitment.toString(16).padStart(64, "0");

    // Compare
    const match = expectedHex
      ? commitmentHex.toLowerCase() === expectedHex.toLowerCase().replace("0x", "")
      : null;

    console.log("[Debug Commitment] ===== COMMITMENT CHECK =====");
    console.log("[Debug Commitment] pubKeyX (hex):", pubKeyXHex);
    console.log("[Debug Commitment] pubKeyX (bigint):", pubKeyX.toString());
    console.log("[Debug Commitment] amount:", amount.toString());
    console.log("[Debug Commitment] computed commitment:", commitmentHex);
    if (expectedHex) {
      console.log("[Debug Commitment] expected commitment:", expectedHex);
      console.log("[Debug Commitment] MATCH:", match);
    }
    console.log("[Debug Commitment] =============================");

    return NextResponse.json({
      success: true,
      inputs: {
        pubKeyX: pubKeyXHex,
        pubKeyXBigint: pubKeyX.toString(),
        amount: amount.toString(),
      },
      computed: {
        commitment: commitmentHex,
        commitmentWithPrefix: "0x" + commitmentHex,
      },
      comparison: expectedHex ? {
        expected: expectedHex,
        match,
      } : null,
    });
  } catch (error) {
    console.error("[Debug Commitment] Error:", error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }, { status: 500 });
  }
}
