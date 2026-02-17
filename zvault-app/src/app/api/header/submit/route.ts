import { NextRequest, NextResponse } from "next/server";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createHash } from "crypto";
import { hexToBytes } from "@zvault/sdk";

export const runtime = "nodejs";

// Compute Anchor instruction discriminator
function getAnchorDiscriminator(instructionName: string): Buffer {
  const hash = createHash("sha256")
    .update(`global:${instructionName}`)
    .digest();
  return hash.slice(0, 8);
}

// Load relayer keypair from environment variable
function getRelayerKeypair(): Keypair | null {
  if (!process.env.RELAYER_KEYPAIR) {
    console.error("[Header API] RELAYER_KEYPAIR env variable not set");
    return null;
  }

  try {
    const secretKey = JSON.parse(process.env.RELAYER_KEYPAIR);
    return Keypair.fromSecretKey(Uint8Array.from(secretKey));
  } catch (error) {
    console.error("[Header API] Failed to parse RELAYER_KEYPAIR:", error);
    return null;
  }
}

import { DEVNET_CONFIG } from "@zvault/sdk";

// zVault Program ID from SDK (single source of truth)
const PROGRAM_ID = new PublicKey(DEVNET_CONFIG.zvaultProgramId);

// Derive light client PDA (v2 for correct byte order)
function deriveLightClientPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("btc_light_client_v2")],
    PROGRAM_ID
  );
}

// Derive block header PDA
function deriveBlockHeaderPDA(blockHeight: number): [PublicKey, number] {
  const heightBuffer = Buffer.alloc(8);
  heightBuffer.writeBigUInt64LE(BigInt(blockHeight));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("block_header"), heightBuffer],
    PROGRAM_ID
  );
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const {
      block_height,
      block_hash,
      raw_header,
      prev_block_hash,
      merkle_root,
      timestamp,
      bits,
      nonce,
    } = body;

    // Validate required fields
    if (!block_height || !block_hash || !raw_header) {
      return NextResponse.json(
        { success: false, error: "Missing required fields" },
        { status: 400 }
      );
    }

    // Validate raw header length (80 bytes = 160 hex chars)
    if (raw_header.length !== 160) {
      return NextResponse.json(
        { success: false, error: "Invalid raw header length" },
        { status: 400 }
      );
    }

    console.log("[Header API] Submitting block header...");
    console.log("[Header API] Height:", block_height);
    console.log("[Header API] Hash:", block_hash);

    // Get relayer keypair
    const relayer = getRelayerKeypair();
    if (!relayer) {
      return NextResponse.json(
        { success: false, error: "Relayer keypair not configured. Set RELAYER_KEYPAIR env variable." },
        { status: 500 }
      );
    }

    // Connect to Solana
    const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";
    const connection = new Connection(rpcUrl, "confirmed");

    console.log("[Header API] Relayer:", relayer.publicKey.toBase58());

    // Check if header already exists
    const [headerPDA] = deriveBlockHeaderPDA(block_height);
    const existingHeader = await connection.getAccountInfo(headerPDA);

    if (existingHeader) {
      console.log("[Header API] Header already exists on-chain");
      return NextResponse.json({
        success: true,
        block_height,
        block_hash,
        already_exists: true,
        message: "Block header already exists on-chain",
      });
    }

    // Derive PDAs
    const [lightClientPDA] = deriveLightClientPDA();

    // Build submit_header instruction for Anchor program
    // Anchor discriminator: first 8 bytes of sha256("global:submit_header")
    // Data: discriminator(8) + raw_header(80) + height(u64, 8 bytes LE)
    const discriminator = getAnchorDiscriminator("submit_header");

    const rawHeaderBytes = hexToBytes(raw_header);

    // Build instruction data: discriminator(8) + raw_header(80) + height(8)
    const instructionData = Buffer.alloc(8 + 80 + 8);
    discriminator.copy(instructionData, 0);
    Buffer.from(rawHeaderBytes).copy(instructionData, 8);
    instructionData.writeBigUInt64LE(BigInt(block_height), 88);

    // Accounts for submit_header:
    // 0. Light client account (PDA, writable)
    // 1. Block header account (PDA, writable)
    // 2. Submitter (signer, writable - pays for storage)
    // 3. System program
    const submitIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: lightClientPDA, isSigner: false, isWritable: true },
        { pubkey: headerPDA, isSigner: false, isWritable: true },
        { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
        { pubkey: new PublicKey("11111111111111111111111111111111"), isSigner: false, isWritable: false },
      ],
      data: instructionData,
    });

    // Build and send transaction
    const tx = new Transaction().add(submitIx);

    try {
      const signature = await sendAndConfirmTransaction(connection, tx, [relayer], {
        commitment: "confirmed",
      });

      console.log("[Header API] Transaction confirmed:", signature);

      return NextResponse.json({
        success: true,
        block_height,
        block_hash,
        solana_tx_signature: signature,
        message: "Block header submitted to Solana",
      });
    } catch (txError: unknown) {
      console.error("[Header API] Transaction failed:", txError);

      // Return actual error - no demo fallback
      const errorMessage = txError instanceof Error ? txError.message : "Transaction failed";

      return NextResponse.json(
        {
          success: false,
          block_height,
          block_hash,
          error: errorMessage,
        },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error("[Header API] Error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 }
    );
  }
}
