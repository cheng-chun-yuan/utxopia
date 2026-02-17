import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import {
  buildCommitmentTreeFromChain,
  getMerkleProofFromTree,
  DEVNET_CONFIG,
  initPoseidon,
  parseCommitmentTreeData,
  bytesToBigint,
} from "@zvault/sdk";
import { getHeliusConnection } from "@/lib/helius-server";

export const runtime = "nodejs";

// Poseidon initialization state
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

/**
 * GET /api/merkle/proof?commitment=xxx
 *
 * Get Merkle proof for a commitment.
 * Fetches tree directly from on-chain (like SDK tests do).
 * Returns siblings and indices for circom circuit input.
 */
export async function GET(request: NextRequest) {
  try {
    const commitment = request.nextUrl.searchParams.get("commitment");

    if (!commitment) {
      return NextResponse.json(
        {
          success: false,
          error: "Missing commitment parameter",
        },
        { status: 400 }
      );
    }

    // Parse commitment as hex or decimal
    let commitmentBigInt: bigint;
    try {
      if (commitment.startsWith("0x")) {
        commitmentBigInt = BigInt(commitment);
      } else if (/^[0-9a-fA-F]+$/.test(commitment) && commitment.length >= 32) {
        // Hex without 0x prefix
        commitmentBigInt = BigInt("0x" + commitment);
      } else {
        // Decimal
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

    // Ensure Poseidon is initialized
    await ensurePoseidonInit();

    // Debug: Log the commitment being looked up
    console.log("[Merkle Proof API] Looking up commitment:");
    console.log("[Merkle Proof API]   Input hex:", commitment);
    console.log("[Merkle Proof API]   As bigint:", commitmentBigInt.toString());
    console.log("[Merkle Proof API]   Normalized hex:", commitmentBigInt.toString(16).padStart(64, "0"));

    // Fetch tree directly from on-chain (same as SDK tests)
    console.log("[Merkle Proof API] Building tree from on-chain...");
    const connection = getHeliusConnection("devnet");

    const tree = await buildCommitmentTreeFromChain(
      {
        getProgramAccounts: async (programId, config) => {
          // Build filters array, filtering out undefined values
          const filters = config?.filters
            ?.map((f: { memcmp?: { offset: number; bytes: string }; dataSize?: number }) => {
              if (f.memcmp) {
                return { memcmp: { offset: f.memcmp.offset, bytes: f.memcmp.bytes } };
              }
              if (f.dataSize !== undefined) {
                return { dataSize: f.dataSize };
              }
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
      DEVNET_CONFIG.zvaultProgramId
    );

    console.log(`[Merkle Proof API] Tree built with ${tree.size()} commitments`);

    // Debug: Log first few commitments in tree for comparison
    const treeData = tree.export();
    const firstFewCommitments = treeData.commitments.slice(0, 5);
    console.log("[Merkle Proof API] First few tree commitments (hex):");
    for (const [hex, entry] of firstFewCommitments) {
      console.log(`  [${entry.index}]: ${hex}`);
    }
    console.log("[Merkle Proof API] Looking for:", commitmentBigInt.toString(16).padStart(64, "0"));

    // Get proof for commitment
    const proof = getMerkleProofFromTree(tree, commitmentBigInt);

    if (!proof) {
      return NextResponse.json(
        {
          success: false,
          error: "Commitment not found in on-chain tree",
          treeSize: tree.size(),
          lookingFor: commitmentBigInt.toString(16).padStart(64, "0"),
          firstTreeCommitments: firstFewCommitments.map(([hex]) => hex),
        },
        { status: 404 }
      );
    }

    console.log(`[Merkle Proof API] Found commitment at leaf index ${proof.leafIndex}`);

    // CRITICAL: Fetch the actual on-chain root from the commitment tree account
    // The locally computed root may differ from the on-chain root
    const commitmentTreePda = new PublicKey(DEVNET_CONFIG.commitmentTreePda);
    const treeAccountInfo = await connection.getAccountInfo(commitmentTreePda);

    let onChainRoot: string;
    if (treeAccountInfo) {
      const treeState = parseCommitmentTreeData(new Uint8Array(treeAccountInfo.data));
      onChainRoot = bytesToBigint(treeState.currentRoot).toString(16).padStart(64, "0");
      console.log(`[Merkle Proof API] On-chain root: ${onChainRoot.slice(0, 16)}...`);
      console.log(`[Merkle Proof API] Computed root: ${proof.root.toString(16).padStart(64, "0").slice(0, 16)}...`);
      console.log(`[Merkle Proof API] Roots match: ${onChainRoot === proof.root.toString(16).padStart(64, "0")}`);
    } else {
      // Fallback to computed root if account fetch fails
      console.warn("[Merkle Proof API] Could not fetch on-chain tree, using computed root");
      onChainRoot = proof.root.toString(16).padStart(64, "0");
    }

    return NextResponse.json({
      success: true,
      commitment: commitment,
      leafIndex: proof.leafIndex.toString(),
      root: onChainRoot,  // Use on-chain root, not computed root
      computedRoot: proof.root.toString(16).padStart(64, "0"),  // Include computed for debugging
      siblings: proof.siblings.map((s) => s.toString(16).padStart(64, "0")),
      indices: proof.indices,
    });
  } catch (error) {
    console.error("[Merkle Proof API] Error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to get Merkle proof",
      },
      { status: 500 }
    );
  }
}
