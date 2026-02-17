import { NextRequest, NextResponse } from "next/server";
import { checkSyncStatus, syncFromOnChain, getTreeStatus } from "@/lib/commitment-index";

export const runtime = "nodejs";

/**
 * POST /api/merkle/sync
 *
 * Sync local commitment tree index from on-chain stealth announcements.
 * Fetches all stealth announcements and rebuilds the local merkle tree.
 */
export async function POST(request: NextRequest) {
  try {
    // Check if already synced
    const beforeStatus = await checkSyncStatus();

    if (beforeStatus.synced) {
      return NextResponse.json({
        success: true,
        message: "Already synced",
        localRoot: beforeStatus.localRoot,
        onChainRoot: beforeStatus.onChainRoot,
        localSize: beforeStatus.localSize,
        onChainNextIndex: beforeStatus.onChainNextIndex.toString(),
        synced: true,
      });
    }

    // Perform sync from on-chain stealth announcements
    console.log("[Merkle Sync API] Starting sync from on-chain...");
    const syncResult = await syncFromOnChain();

    // Check status after sync
    const afterStatus = getTreeStatus();

    return NextResponse.json({
      success: true,
      message: `Synced ${syncResult.synced} commitments from on-chain`,
      synced: syncResult.synced,
      skipped: syncResult.skipped,
      localRoot: afterStatus.root,
      localSize: afterStatus.size,
    });
  } catch (error) {
    console.error("[Merkle Sync API] Error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to sync with on-chain state",
      },
      { status: 500 }
    );
  }
}
