import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";
import { hexToBytes, DEVNET_CONFIG } from "@aegis/sdk";

export const runtime = "nodejs";

const BTC_LIGHT_CLIENT_ID = new PublicKey(DEVNET_CONFIG.btcLightClientProgramId);

function deriveBlockHeaderPDA(blockHash: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("block"), Buffer.from(blockHash)],
    BTC_LIGHT_CLIENT_ID
  );
}

function computeBlockHash(rawHeader: Uint8Array): Uint8Array {
  const h1 = createHash("sha256").update(rawHeader).digest();
  const h2 = createHash("sha256").update(h1).digest();
  return new Uint8Array(h2);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { block_height, block_hash, raw_header } = body;

    if (!block_height || !block_hash || !raw_header) {
      return NextResponse.json(
        { success: false, error: "Missing required fields" },
        { status: 400 }
      );
    }

    if (raw_header.length !== 160) {
      return NextResponse.json(
        { success: false, error: "Invalid raw header length (expected 160 hex chars)" },
        { status: 400 }
      );
    }

    const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";
    const connection = new Connection(rpcUrl, "confirmed");

    // Check if header already exists on-chain
    const rawHeaderBytes = hexToBytes(raw_header);
    const blockHashBytes = computeBlockHash(rawHeaderBytes);
    const [headerPDA] = deriveBlockHeaderPDA(blockHashBytes);
    const existingHeader = await connection.getAccountInfo(headerPDA);

    if (existingHeader) {
      return NextResponse.json({
        success: true,
        block_height,
        block_hash,
        already_exists: true,
        message: "Block header already exists on-chain",
      });
    }

    // extend_blockchain requires min 2 headers per batch + parent anchor PDA.
    // Use the backend header-relayer service for batch submission.
    return NextResponse.json(
      {
        success: false,
        block_height,
        block_hash,
        error: "Single-header submission is no longer supported. Use the header relayer service for batch submission (extend_blockchain requires min 2 headers).",
      },
      { status: 501 }
    );
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
