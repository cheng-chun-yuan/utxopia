import { NextRequest, NextResponse } from "next/server";
import {
  getTreeStatus,
  checkSyncStatus,
} from "@/lib/commitment-index";

export const runtime = "nodejs";

/**
 * GET /api/merkle/status
 *
 * Get commitment tree status including:
 * - Current local root
 * - Next index / tree size
 * - On-chain root (for sync verification)
 * - Sync status
 */
export async function GET(request: NextRequest) {
  try {
    const local = getTreeStatus();

    // Optionally check on-chain sync status
    const checkSync = request.nextUrl.searchParams.get("sync") === "true";

    if (checkSync) {
      try {
        const syncStatus = await checkSyncStatus();
        return NextResponse.json({
          success: true,
          root: syncStatus.localRoot,
          nextIndex: syncStatus.localSize,
          onChainRoot: syncStatus.onChainRoot,
          onChainNextIndex: syncStatus.onChainNextIndex.toString(),
          synced: syncStatus.synced,
        });
      } catch (syncError) {
        // Return local status with sync error
        return NextResponse.json({
          success: true,
          root: local.root,
          nextIndex: local.nextIndex,
          onChainRoot: null,
          synced: null,
          syncError:
            syncError instanceof Error
              ? syncError.message
              : "Failed to check on-chain state",
        });
      }
    }

    return NextResponse.json({
      success: true,
      root: local.root,
      nextIndex: local.nextIndex,
      size: local.size,
    });
  } catch (error) {
    console.error("[Merkle Status API] Error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to get tree status",
      },
      { status: 500 }
    );
  }
}
