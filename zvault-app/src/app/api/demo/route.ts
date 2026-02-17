import { NextRequest, NextResponse } from "next/server";
import {
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { hexToBytes } from "@zvault/sdk";
import { buildAddDemoStealthTransaction } from "@/lib/solana/demo-instructions";
import {
  ZVAULT_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ZBTC_MINT_ADDRESS,
  derivePoolStatePDA,
  deriveCommitmentTreePDA,
  derivePoolVaultATA,
} from "@/lib/solana/instructions";
import { getHeliusConnection, isHeliusConfigured } from "@/lib/helius-server";
import { addCommitmentToIndex, syncFromOnChain } from "@/lib/commitment-index";

export const runtime = "nodejs";

// Load admin keypair from environment variable
// Demo instructions require admin signature to add mock deposits
function getAdminKeypair(): Keypair | null {
  if (!process.env.ADMIN_KEYPAIR) {
    console.error("[Demo API] ADMIN_KEYPAIR env variable not set");
    return null;
  }

  try {
    const secretKey = JSON.parse(process.env.ADMIN_KEYPAIR);
    return Keypair.fromSecretKey(Uint8Array.from(secretKey));
  } catch {
    // Don't log error details - could expose key format information
    console.error("[Demo API] Failed to parse ADMIN_KEYPAIR");
    return null;
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { type, ephemeralPub, commitment, encryptedAmount, amount } = body;

    // For demo mode, both public and stealth use stealth deposits
    // Public transfer (SPEND_PARTIAL_PUBLIC) requires ZK proofs in production
    if (type === "public") {
      console.log("[Demo API] Public mode - using stealth deposit for demo");
      // In demo mode, fall through to stealth handling
    }

    // Validate stealth mode params with proper hex validation
    if (!isValidHex(ephemeralPub, 66)) {
      return NextResponse.json(
        { success: false, error: "Invalid ephemeralPub. Must be 66 valid hex characters (33 bytes)" },
        { status: 400 }
      );
    }
    if (!isValidHex(commitment, 64)) {
      return NextResponse.json(
        { success: false, error: "Invalid commitment. Must be 64 valid hex characters (32 bytes)" },
        { status: 400 }
      );
    }
    // Validate commitment is within BN254 field (required for ZK circuits)
    const BN254_FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    const commitmentBigInt = BigInt("0x" + commitment);
    if (commitmentBigInt >= BN254_FIELD_PRIME) {
      return NextResponse.json(
        { success: false, error: "Invalid commitment. Value exceeds BN254 field modulus (not a valid ZK field element)" },
        { status: 400 }
      );
    }
    if (!isValidHex(encryptedAmount, 16)) {
      return NextResponse.json(
        { success: false, error: "Invalid encryptedAmount. Must be 16 valid hex characters (8 bytes)" },
        { status: 400 }
      );
    }

    // Amount is required for adding to the local merkle tree index
    if (amount === undefined || amount === null) {
      return NextResponse.json(
        { success: false, error: "Missing amount field (required for merkle tree indexing)" },
        { status: 400 }
      );
    }

    console.log("[Demo API] Processing stealth deposit...");

    // Get admin keypair (required for demo instructions)
    const admin = getAdminKeypair();
    if (!admin) {
      return NextResponse.json(
        { success: false, error: "Admin not configured. Set ADMIN_KEYPAIR env variable." },
        { status: 500 }
      );
    }

    // Connect to Solana via Helius
    const connection = getHeliusConnection("devnet");
    console.log("[Demo API] Using Helius:", isHeliusConfigured());
    console.log("[Demo API] Admin:", admin.publicKey.toBase58());

    // =========================================================================
    // Pre-flight account validation (diagnose "invalid account data" errors)
    // =========================================================================
    const [poolState] = derivePoolStatePDA();
    const [commitmentTree] = deriveCommitmentTreePDA();
    const poolVault = derivePoolVaultATA();

    console.log("[Demo API] Checking required accounts...");
    console.log("[Demo API] Pool State PDA:", poolState.toBase58());
    console.log("[Demo API] Commitment Tree PDA:", commitmentTree.toBase58());
    console.log("[Demo API] zBTC Mint:", ZBTC_MINT_ADDRESS.toBase58());
    console.log("[Demo API] Pool Vault ATA:", poolVault.toBase58());

    // Fetch account info for all required accounts
    const [poolInfo, treeInfo, mintInfo, vaultInfo] = await Promise.all([
      connection.getAccountInfo(poolState),
      connection.getAccountInfo(commitmentTree),
      connection.getAccountInfo(ZBTC_MINT_ADDRESS),
      connection.getAccountInfo(poolVault),
    ]);

    console.log("[Demo API] Pool exists:", !!poolInfo);
    console.log("[Demo API] Pool owner:", poolInfo?.owner.toBase58() || "N/A");
    console.log("[Demo API] Tree exists:", !!treeInfo);
    console.log("[Demo API] Tree owner:", treeInfo?.owner.toBase58() || "N/A");
    console.log("[Demo API] Mint exists:", !!mintInfo);
    console.log("[Demo API] Mint owner:", mintInfo?.owner.toBase58() || "N/A");
    console.log("[Demo API] Vault exists:", !!vaultInfo);
    console.log("[Demo API] Vault owner:", vaultInfo?.owner.toBase58() || "N/A");

    // Validate pool state exists and is owned by zVault program
    if (!poolInfo) {
      return NextResponse.json(
        { success: false, error: "Pool state not initialized. Run initialization script first." },
        { status: 500 }
      );
    }
    if (!poolInfo.owner.equals(ZVAULT_PROGRAM_ID)) {
      return NextResponse.json(
        { success: false, error: `Pool state has wrong owner. Expected ${ZVAULT_PROGRAM_ID.toBase58()}, got ${poolInfo.owner.toBase58()}` },
        { status: 500 }
      );
    }

    // Validate commitment tree exists and is owned by zVault program
    if (!treeInfo) {
      return NextResponse.json(
        { success: false, error: "Commitment tree not initialized. Run initialization script first." },
        { status: 500 }
      );
    }
    if (!treeInfo.owner.equals(ZVAULT_PROGRAM_ID)) {
      return NextResponse.json(
        { success: false, error: `Commitment tree has wrong owner. Expected ${ZVAULT_PROGRAM_ID.toBase58()}, got ${treeInfo.owner.toBase58()}` },
        { status: 500 }
      );
    }

    // Validate zBTC mint exists and is owned by Token-2022
    if (!mintInfo) {
      return NextResponse.json(
        { success: false, error: "zBTC mint not created. Run initialization script first." },
        { status: 500 }
      );
    }
    if (!mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      return NextResponse.json(
        { success: false, error: `zBTC mint has wrong owner. Expected Token-2022 (${TOKEN_2022_PROGRAM_ID.toBase58()}), got ${mintInfo.owner.toBase58()}` },
        { status: 500 }
      );
    }

    // Validate pool vault exists and is owned by Token-2022
    if (!vaultInfo) {
      return NextResponse.json(
        { success: false, error: "Pool vault ATA not created. Run initialization script first." },
        { status: 500 }
      );
    }
    if (!vaultInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      return NextResponse.json(
        { success: false, error: `Pool vault has wrong owner. Expected Token-2022 (${TOKEN_2022_PROGRAM_ID.toBase58()}), got ${vaultInfo.owner.toBase58()}` },
        { status: 500 }
      );
    }

    // Check pool authority matches admin keypair
    // Pool state layout: discriminator(4 bytes) + authority(32 bytes)
    const poolAuthority = new PublicKey(poolInfo.data.slice(4, 36));
    console.log("[Demo API] Pool Authority:", poolAuthority.toBase58());
    console.log("[Demo API] Admin Pubkey:", admin.publicKey.toBase58());
    console.log("[Demo API] Authority Match:", poolAuthority.equals(admin.publicKey));

    if (!poolAuthority.equals(admin.publicKey)) {
      return NextResponse.json(
        {
          success: false,
          error: `Admin keypair does not match pool authority. Pool authority: ${poolAuthority.toBase58()}, Admin: ${admin.publicKey.toBase58()}. Update ADMIN_KEYPAIR env var or re-initialize pool.`
        },
        { status: 403 }
      );
    }

    console.log("[Demo API] All pre-flight checks passed!");

    // Build stealth transaction
    const ephemeralPubBytes = hexToBytes(ephemeralPub);
    const commitmentBytes = hexToBytes(commitment);
    const encryptedAmountBytes = hexToBytes(encryptedAmount);
    const tx = await buildAddDemoStealthTransaction(connection, {
      payer: admin.publicKey,
      ephemeralPub: ephemeralPubBytes,
      commitment: commitmentBytes,
      encryptedAmount: encryptedAmountBytes,
    });

    // Sign and send transaction with admin keypair
    try {
      const signature = await sendAndConfirmTransaction(connection, tx, [admin], {
        commitment: "confirmed",
      });

      console.log("[Demo API] Transaction confirmed:", signature);

      // Sync local index from on-chain AFTER transaction confirms
      // This ensures local index includes the new commitment with correct leaf index
      let leafIndex: string | undefined;
      try {
        console.log("[Demo API] Syncing local index from on-chain...");
        const syncResult = await syncFromOnChain();
        console.log("[Demo API] Synced", syncResult.synced, "commitments, root:", syncResult.root.slice(0, 16) + "...");

        // The new commitment should now be in the synced index
        // Find its leaf index from the sync
        leafIndex = (syncResult.synced - 1).toString();
      } catch (syncError) {
        console.warn("[Demo API] Sync failed:", syncError);
        // Fallback: try to add manually
        try {
          const commitmentBigInt = BigInt("0x" + commitment);
          const amountBigInt = BigInt(amount);
          const indexResult = await addCommitmentToIndex(commitmentBigInt, amountBigInt);
          leafIndex = indexResult.leafIndex.toString();
          console.log("[Demo API] Added to local index manually, leafIndex:", leafIndex);
        } catch (indexError) {
          console.warn("[Demo API] Failed to add to local index:", indexError);
        }
      }

      return NextResponse.json({
        success: true,
        type: type || "stealth",
        signature,
        message: "Demo stealth deposit added on-chain",
      });
    } catch (txError: unknown) {
      // Log full error server-side for debugging, but don't expose to client
      console.error("[Demo API] Transaction failed:", txError);

      // Return generic error message to avoid leaking implementation details
      return NextResponse.json(
        { success: false, error: "Transaction processing failed. Please try again." },
        { status: 500 }
      );
    }
  } catch (error) {
    // Log full error server-side for debugging
    console.error("[Demo API] Error:", error);
    console.error("[Demo API] Error stack:", error instanceof Error ? error.stack : "no stack");

    // Return error message for debugging (in dev mode)
    const errorMessage = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json(
      {
        success: false,
        error: process.env.NODE_ENV === "development" ? errorMessage : "Internal server error",
      },
      { status: 500 }
    );
  }
}

/**
 * Validate hex string format
 */
function isValidHex(hex: string, expectedLength: number): boolean {
  if (typeof hex !== "string" || hex.length !== expectedLength) {
    return false;
  }
  return /^[0-9a-fA-F]+$/.test(hex);
}
