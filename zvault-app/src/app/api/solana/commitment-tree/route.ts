import { NextResponse } from "next/server";
import { fetchAccountInfo, isHeliusConfigured } from "@/lib/helius-server";
import { DEVNET_CONFIG, parseCommitmentTreeData } from "@zvault/sdk";

export const runtime = "nodejs";

// Commitment tree PDA from SDK (single source of truth)
const COMMITMENT_TREE_ADDRESS = DEVNET_CONFIG.commitmentTreePda;

/**
 * GET /api/solana/commitment-tree
 *
 * Fetch commitment tree state from Solana using @solana/kit.
 * Returns current root, next index, and other state.
 */
export async function GET() {
  try {
    console.log("[CommitmentTree API] Fetching from:", COMMITMENT_TREE_ADDRESS);
    console.log("[CommitmentTree API] Using Helius:", isHeliusConfigured());

    const accountInfo = await fetchAccountInfo(COMMITMENT_TREE_ADDRESS, "devnet");

    if (!accountInfo) {
      return NextResponse.json(
        { success: false, error: "Commitment tree account not found" },
        { status: 404 }
      );
    }

    // Use SDK's parseCommitmentTreeData (handles validation + parsing)
    const parsed = parseCommitmentTreeData(accountInfo.data);

    const state = {
      discriminator: parsed.discriminator,
      bump: parsed.bump,
      currentRoot: Buffer.from(parsed.currentRoot).toString("hex"),
      nextIndex: parsed.nextIndex.toString(),
      rootHistoryIndex: parsed.rootHistoryIndex,
    };

    return NextResponse.json({
      success: true,
      helius: isHeliusConfigured(),
      address: COMMITMENT_TREE_ADDRESS,
      state,
    });
  } catch (error) {
    console.error("[CommitmentTree API] Error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to fetch commitment tree",
      },
      { status: 500 }
    );
  }
}
