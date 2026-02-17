import { NextRequest, NextResponse } from "next/server";
import { addCommitmentToIndex } from "@/lib/commitment-index";

export const runtime = "nodejs";

/**
 * POST /api/merkle/commitment
 *
 * Add a commitment to the local index.
 *
 * Request body:
 * {
 *   "commitment": "abc123...",  // hex string (with or without 0x)
 *   "amount": 100000            // amount in satoshis (number or string)
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "leafIndex": 42,
 *   "root": "def456..."
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { commitment, amount } = body;

    if (!commitment) {
      return NextResponse.json(
        {
          success: false,
          error: "Missing commitment field",
        },
        { status: 400 }
      );
    }

    if (amount === undefined || amount === null) {
      return NextResponse.json(
        {
          success: false,
          error: "Missing amount field",
        },
        { status: 400 }
      );
    }

    // Parse commitment
    let commitmentBigInt: bigint;
    try {
      if (typeof commitment === "string") {
        if (commitment.startsWith("0x")) {
          commitmentBigInt = BigInt(commitment);
        } else if (
          /^[0-9a-fA-F]+$/.test(commitment) &&
          commitment.length >= 32
        ) {
          commitmentBigInt = BigInt("0x" + commitment);
        } else {
          commitmentBigInt = BigInt(commitment);
        }
      } else {
        commitmentBigInt = BigInt(commitment);
      }
    } catch {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid commitment format. Use hex (0x...) or decimal.",
        },
        { status: 400 }
      );
    }

    // Parse amount
    let amountBigInt: bigint;
    try {
      amountBigInt = BigInt(amount);
    } catch {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid amount format. Use number or string.",
        },
        { status: 400 }
      );
    }

    // Add to index
    const result = await addCommitmentToIndex(commitmentBigInt, amountBigInt);

    return NextResponse.json({
      success: true,
      leafIndex: result.leafIndex.toString(),
      root: result.root.toString(16).padStart(64, "0"),
    });
  } catch (error) {
    console.error("[Merkle Commitment API] Error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to add commitment",
      },
      { status: 500 }
    );
  }
}
