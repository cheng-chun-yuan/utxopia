import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import {
  buildCommitmentTreeFromChain,
  getMerkleProofFromTree,
  DEVNET_CONFIG,
  initPoseidon,
  parseCommitmentTreeData,
  bytesToBigint,
  type CommitmentTreeIndex,
} from "@aegis/sdk";
import { getHeliusConnection } from "@/lib/helius-server";
import { getTreeProofFromBackend } from "@/lib/api/tree";

export const runtime = "nodejs";

// =============================================================================
// Poseidon init
// =============================================================================

let poseidonInitialized = false;
let poseidonInitPromise: Promise<void> | null = null;

async function ensurePoseidonInit(): Promise<void> {
  if (poseidonInitialized) return;
  if (poseidonInitPromise) return poseidonInitPromise;
  poseidonInitPromise = initPoseidon().then(() => {
    poseidonInitialized = true;
    console.log("[Merkle Proof API] Poseidon initialized");
  });
  return poseidonInitPromise;
}

// =============================================================================
// Tree cache — avoid rebuilding on every proof request (fallback only)
// =============================================================================

const CACHE_TTL_MS = 30_000; // 30 seconds

let cachedTree: CommitmentTreeIndex | null = null;
let cachedOnChainRoot: string | null = null;
let cachedNextIndex: number | null = null;
let cacheTimestamp = 0;
let cacheBuildPromise: Promise<void> | null = null;

async function getTreeAndRoot(): Promise<{
  tree: CommitmentTreeIndex;
  onChainRoot: string;
}> {
  const now = Date.now();

  // Return cached if fresh
  if (cachedTree && cachedOnChainRoot && now - cacheTimestamp < CACHE_TTL_MS) {
    return { tree: cachedTree, onChainRoot: cachedOnChainRoot };
  }

  // Deduplicate concurrent builds
  if (cacheBuildPromise) {
    await cacheBuildPromise;
    if (cachedTree && cachedOnChainRoot) {
      return { tree: cachedTree, onChainRoot: cachedOnChainRoot };
    }
  }

  cacheBuildPromise = (async () => {
    const connection = getHeliusConnection("devnet");
    const commitmentTreePda = new PublicKey(DEVNET_CONFIG.commitmentTreePda);

    // Fetch on-chain tree state (root + nextIndex) in one RPC call
    const treeAccountInfo = await connection.getAccountInfo(commitmentTreePda);

    let maxLeafIndex: number | undefined;
    let rootHex: string;

    if (treeAccountInfo) {
      const treeState = parseCommitmentTreeData(new Uint8Array(treeAccountInfo.data));
      maxLeafIndex = Number(treeState.nextIndex);
      rootHex = bytesToBigint(treeState.currentRoot).toString(16).padStart(64, "0");

      // Skip rebuild if nextIndex hasn't changed
      if (cachedTree && cachedNextIndex === maxLeafIndex && cachedOnChainRoot) {
        cacheTimestamp = now;
        cacheBuildPromise = null;
        return;
      }
    } else {
      rootHex = "0".repeat(64);
    }

    // Build tree from chain
    const tree = await buildCommitmentTreeFromChain(
      {
        getProgramAccounts: async (programId, config) => {
          const filters = config?.filters
            ?.map((f: { memcmp?: { offset: number; bytes: string }; dataSize?: number }) => {
              if (f.memcmp) return { memcmp: { offset: f.memcmp.offset, bytes: f.memcmp.bytes } };
              if (f.dataSize !== undefined) return { dataSize: f.dataSize };
              return null;
            })
            .filter((f): f is NonNullable<typeof f> => f !== null);

          const accounts = await connection.getProgramAccounts(
            new PublicKey(programId),
            { filters }
          );
          return accounts.map((acc) => ({
            pubkey: acc.pubkey.toBase58(),
            account: { data: acc.account.data },
          }));
        },
      },
      DEVNET_CONFIG.aegisProgramId,
      maxLeafIndex !== undefined ? { maxLeafIndex } : undefined
    );

    console.log(`[Merkle Proof API] Tree built: ${tree.size()} leaves, root: ${rootHex.slice(0, 16)}...`);

    cachedTree = tree;
    cachedOnChainRoot = rootHex;
    cachedNextIndex = maxLeafIndex ?? null;
    cacheTimestamp = Date.now();
    cacheBuildPromise = null;
  })();

  await cacheBuildPromise;

  if (!cachedTree || !cachedOnChainRoot) {
    throw new Error("Failed to build commitment tree");
  }

  return { tree: cachedTree, onChainRoot: cachedOnChainRoot };
}

// =============================================================================
// Handler
// =============================================================================

/**
 * GET /api/merkle/proof?commitment=xxx
 *
 * Fast path: tries backend's cached tree first (~1ms).
 * Fallback: rebuilds from on-chain data if backend is unavailable (~2-5s).
 */
export async function GET(request: NextRequest) {
  try {
    const commitment = request.nextUrl.searchParams.get("commitment");

    if (!commitment) {
      return NextResponse.json(
        { success: false, error: "Missing commitment parameter" },
        { status: 400 }
      );
    }

    // Parse commitment to normalize hex
    let commitmentHex: string;
    try {
      if (commitment.startsWith("0x")) {
        commitmentHex = commitment.slice(2);
      } else if (/^[0-9a-fA-F]+$/.test(commitment) && commitment.length >= 32) {
        commitmentHex = commitment;
      } else {
        // Decimal — convert to hex
        commitmentHex = BigInt(commitment).toString(16).padStart(64, "0");
      }
    } catch {
      return NextResponse.json(
        { success: false, error: "Invalid commitment format. Use hex (0x...) or decimal." },
        { status: 400 }
      );
    }

    // =========================================================================
    // Fast path: try backend's cached tree first
    // =========================================================================
    const backendResult = await getTreeProofFromBackend(commitmentHex);

    if (backendResult?.success) {
      console.log(`[Merkle Proof API] Fast path: proof from backend for leaf ${backendResult.leaf_index}`);
      return NextResponse.json({
        success: true,
        commitment: commitmentHex,
        leafIndex: String(backendResult.leaf_index),
        root: backendResult.root,
        computedRoot: backendResult.root,
        siblings: backendResult.siblings,
        indices: backendResult.indices,
        source: "backend",
      });
    }

    // =========================================================================
    // Fallback: rebuild from on-chain data (trustless)
    // =========================================================================
    console.log("[Merkle Proof API] Backend unavailable, falling back to on-chain rebuild");

    await ensurePoseidonInit();

    let commitmentBigInt: bigint;
    try {
      commitmentBigInt = BigInt("0x" + commitmentHex);
    } catch {
      return NextResponse.json(
        { success: false, error: "Invalid commitment hex" },
        { status: 400 }
      );
    }

    const start = Date.now();
    const { tree, onChainRoot } = await getTreeAndRoot();
    const fetchMs = Date.now() - start;

    // Get proof
    const proof = getMerkleProofFromTree(tree, commitmentBigInt);

    if (!proof) {
      const treeData = tree.export();
      return NextResponse.json(
        {
          success: false,
          error: "Commitment not found in on-chain tree",
          treeSize: tree.size(),
          lookingFor: commitmentBigInt.toString(16).padStart(64, "0"),
          firstTreeCommitments: treeData.commitments.slice(0, 5).map(([hex]) => hex),
        },
        { status: 404 }
      );
    }

    console.log(`[Merkle Proof API] Fallback: proof for leaf ${proof.leafIndex} in ${fetchMs}ms (${fetchMs < 100 ? "cached" : "rebuilt"})`);

    return NextResponse.json({
      success: true,
      commitment,
      leafIndex: proof.leafIndex.toString(),
      root: onChainRoot,
      computedRoot: proof.root.toString(16).padStart(64, "0"),
      siblings: proof.siblings.map((s) => s.toString(16).padStart(64, "0")),
      indices: proof.indices,
      source: "on-chain",
    });
  } catch (error) {
    console.error("[Merkle Proof API] Error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to get Merkle proof",
      },
      { status: 500 }
    );
  }
}
