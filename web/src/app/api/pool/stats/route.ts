import { NextRequest } from "next/server";
import { proxyToBackend } from "@/lib/api/backend-proxy";
import { detectNetworkFromRequest, getNetworkConfig, networkChain } from "@/lib/network-config";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const network = detectNetworkFromRequest(req);

  if (networkChain(network) === "sui") {
    const { fetchSuiExplorerStats } = await import("@/lib/sui/explorer");
    const stats = await fetchSuiExplorerStats(
      getNetworkConfig(network, { applyEnvOverrides: false }),
    );

    return Response.json({
      success: true,
      onChain: {
        totalShielded: stats.totalShielded.toString(),
        totalMinted: stats.totalShielded.toString(),
        totalBurned: "0",
        depositCount: stats.depositCount,
        treeNextIndex: stats.totalCommitments,
      },
      tokenTVL: stats.totalShielded > 0n
        ? [{ tokenId: "zkbtc", totalShielded: Number(stats.totalShielded) }]
        : [],
    });
  }

  return proxyToBackend(req, "/api/pool/stats");
}
