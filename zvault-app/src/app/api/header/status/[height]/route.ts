import { NextRequest, NextResponse } from "next/server";
import { getProgramDerivedAddress, address } from "@solana/kit";
import { fetchAccountInfo } from "@/lib/helius-server";
import { DEVNET_CONFIG } from "@zvault/sdk";

export const runtime = "nodejs";

// zVault Program ID from SDK (single source of truth)
const PROGRAM_ID = DEVNET_CONFIG.zvaultProgramId;

// Derive block header PDA using @solana/kit
async function deriveBlockHeaderPDA(blockHeight: number): Promise<string> {
  const heightBuffer = new Uint8Array(8);
  const view = new DataView(heightBuffer.buffer);
  view.setBigUint64(0, BigInt(blockHeight), true);

  const [pda] = await getProgramDerivedAddress({
    programAddress: address(PROGRAM_ID),
    seeds: [new TextEncoder().encode("block_header"), heightBuffer],
  });

  return pda;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ height: string }> }
) {
  try {
    const { height } = await params;

    // Validate input length to prevent DoS
    if (!height || height.length > 10) {
      return NextResponse.json(
        { exists: false, error: "Invalid block height" },
        { status: 400 }
      );
    }

    const blockHeight = parseInt(height, 10);

    // Validate block height range (0 to max reasonable Bitcoin block height)
    // Bitcoin block time ~10 min, so max ~50M blocks in 1000 years
    const MAX_BLOCK_HEIGHT = 100_000_000;
    if (isNaN(blockHeight) || blockHeight < 0 || blockHeight > MAX_BLOCK_HEIGHT) {
      return NextResponse.json(
        { exists: false, error: "Invalid block height" },
        { status: 400 }
      );
    }

    // Derive PDA and check if header exists using @solana/kit
    const headerPDA = await deriveBlockHeaderPDA(blockHeight);
    const accountInfo = await fetchAccountInfo(headerPDA, "devnet");

    if (accountInfo) {
      return NextResponse.json({
        exists: true,
        block_height: blockHeight,
        // Could parse account data here to get more info
      });
    }

    return NextResponse.json({
      exists: false,
      block_height: blockHeight,
    });
  } catch (error) {
    console.error("[Header Status API] Error:", error);
    return NextResponse.json(
      {
        exists: false,
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 }
    );
  }
}
