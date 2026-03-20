import { NextRequest, NextResponse } from "next/server";
import {
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { getConfig, hexToBytes } from "@aegis/sdk";
import { buildAddDemoStealthTransaction } from "@/lib/solana/demo-instructions";
import {
  AEGIS_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ZKBTC_MINT_ADDRESS,
  derivePoolStatePDA,
  deriveCommitmentTreePDA,
  derivePoolVaultATA,
} from "@/lib/solana/instructions";
import { getHeliusConnection } from "@/lib/helius-server";
import { syncFromOnChain } from "@/lib/commitment-index";

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
  // Origin check is enforced by middleware.ts
  try {
    const config = getConfig();
    if (config.network === "mainnet") {
      return NextResponse.json({ error: "Demo endpoint disabled on mainnet" }, { status: 403 });
    }

    const body = await request.json();
    const { ephemeralPub, npk, amount } = body;

    // Amount cap: max 100,000 sats (0.001 BTC)
    const MAX_DEMO_SATS = 100_000;
    if (Number(amount) > MAX_DEMO_SATS) {
      return NextResponse.json({ error: `Demo amount exceeds maximum (${MAX_DEMO_SATS} sats)` }, { status: 400 });
    }

    // Validate params
    if (!isValidHex(ephemeralPub, 64)) {
      return NextResponse.json(
        { success: false, error: "Invalid ephemeralPub. Must be 64 valid hex characters (32 bytes Ed25519)" },
        { status: 400 }
      );
    }
    if (!isValidHex(npk, 64)) {
      return NextResponse.json(
        { success: false, error: "Invalid npk. Must be 64 valid hex characters (32 bytes)" },
        { status: 400 }
      );
    }
    // Validate npk is within BN254 field (required for Poseidon commitment)
    const BN254_FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    const npkBigInt = BigInt("0x" + npk);
    if (npkBigInt >= BN254_FIELD_PRIME) {
      return NextResponse.json(
        { success: false, error: "Invalid npk. Value exceeds BN254 field modulus (not a valid ZK field element)" },
        { status: 400 }
      );
    }

    // Amount is required (satoshis)
    if (amount === undefined || amount === null || Number(amount) <= 0) {
      return NextResponse.json(
        { success: false, error: "Missing or invalid amount field (must be positive satoshis)" },
        { status: 400 }
      );
    }

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

    // =========================================================================
    // Pre-flight account validation (diagnose "invalid account data" errors)
    // =========================================================================
    const [poolState] = derivePoolStatePDA();
    const [commitmentTree] = deriveCommitmentTreePDA();
    const poolVault = derivePoolVaultATA();

    // Fetch account info for all required accounts
    const [poolInfo, treeInfo, mintInfo, vaultInfo] = await Promise.all([
      connection.getAccountInfo(poolState),
      connection.getAccountInfo(commitmentTree),
      connection.getAccountInfo(ZKBTC_MINT_ADDRESS),
      connection.getAccountInfo(poolVault),
    ]);

    // Validate pool state exists and is owned by Aegis program
    if (!poolInfo) {
      return NextResponse.json(
        { success: false, error: "Pool state not initialized. Run initialization script first." },
        { status: 500 }
      );
    }
    if (!poolInfo.owner.equals(AEGIS_PROGRAM_ID)) {
      return NextResponse.json(
        { success: false, error: `Pool state has wrong owner. Expected ${AEGIS_PROGRAM_ID.toBase58()}, got ${poolInfo.owner.toBase58()}` },
        { status: 500 }
      );
    }

    // Validate commitment tree exists and is owned by Aegis program
    if (!treeInfo) {
      return NextResponse.json(
        { success: false, error: "Commitment tree not initialized. Run initialization script first." },
        { status: 500 }
      );
    }
    if (!treeInfo.owner.equals(AEGIS_PROGRAM_ID)) {
      return NextResponse.json(
        { success: false, error: `Commitment tree has wrong owner. Expected ${AEGIS_PROGRAM_ID.toBase58()}, got ${treeInfo.owner.toBase58()}` },
        { status: 500 }
      );
    }

    // Validate zkBTC mint exists and is owned by Token-2022
    if (!mintInfo) {
      return NextResponse.json(
        { success: false, error: "zkBTC mint not created. Run initialization script first." },
        { status: 500 }
      );
    }
    if (!mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      return NextResponse.json(
        { success: false, error: `zkBTC mint has wrong owner. Expected Token-2022 (${TOKEN_2022_PROGRAM_ID.toBase58()}), got ${mintInfo.owner.toBase58()}` },
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

    if (!poolAuthority.equals(admin.publicKey)) {
      return NextResponse.json(
        {
          success: false,
          error: `Admin keypair does not match pool authority. Pool authority: ${poolAuthority.toBase58()}, Admin: ${admin.publicKey.toBase58()}. Update ADMIN_KEYPAIR env var or re-initialize pool.`
        },
        { status: 403 }
      );
    }

    // Build demo deposit transaction (npk-based, commitment computed on-chain)
    const ephemeralPubBytes = hexToBytes(ephemeralPub);
    const npkBytes = hexToBytes(npk);
    const amountSats = BigInt(amount);
    const tx = await buildAddDemoStealthTransaction(connection, {
      payer: admin.publicKey,
      ephemeralPub: ephemeralPubBytes,
      npk: npkBytes,
      amountSats,
    });

    // Sign and send transaction with admin keypair
    try {
      const signature = await sendAndConfirmTransaction(connection, tx, [admin], {
        commitment: "confirmed",
      });

      // Sync local index from on-chain AFTER transaction confirms
      try {
        await syncFromOnChain();
      } catch {
        // Sync failure is non-fatal — backend indexer will catch up
      }

      return NextResponse.json({
        success: true,
        type: "demo_deposit",
        signature,
        message: "Demo deposit added on-chain (npk-based, commitment computed on-chain)",
      });
    } catch (txError: unknown) {
      // Log full error server-side for debugging, but don't expose to client
      console.error("[Demo API] Transaction failed:", txError);

      const txErrorMessage = txError instanceof Error ? txError.message : "Transaction processing failed";
      return NextResponse.json(
        {
          success: false,
          error: process.env.NODE_ENV === "development"
            ? txErrorMessage
            : "Transaction processing failed. Please try again.",
        },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error("[Demo API] Error:", error);
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
