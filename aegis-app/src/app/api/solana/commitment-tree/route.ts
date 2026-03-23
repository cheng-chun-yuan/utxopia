import { NextResponse } from "next/server";
import { fetchAccountInfo, isHeliusConfigured } from "@/lib/helius-server";
const getAegisSDK = () => import("@aegis/sdk");
export const dynamic = "force-dynamic";

export const runtime = "nodejs";

/**
 * GET /api/solana/commitment-tree
 *
 * Fetch commitment tree state from Solana using @solana/kit.
 * Returns current root, next index, and other state.
 */
export async function GET() {
  const { getConfig, parseCommitmentTreeData } = await getAegisSDK();
  try {
    const accountInfo = await fetchAccountInfo(getConfig().commitmentTreePda, "devnet");

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
      address: getConfig().commitmentTreePda,
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
