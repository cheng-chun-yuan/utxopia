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

export const runtime = "nodejs";

// Load relayer keypair from environment variable
function getRelayerKeypair(): Keypair | null {
  if (!process.env.RELAYER_KEYPAIR) {
    console.error("[Init API] RELAYER_KEYPAIR env variable not set");
    return null;
  }

  try {
    const secretKey = JSON.parse(process.env.RELAYER_KEYPAIR);
    return Keypair.fromSecretKey(Uint8Array.from(secretKey));
  } catch (error) {
    console.error("[Init API] Failed to parse RELAYER_KEYPAIR:", error);
    return null;
  }
}

import { DEVNET_CONFIG } from "@zvault/sdk";

// zVault Program ID from SDK (single source of truth)
const PROGRAM_ID = new PublicKey(DEVNET_CONFIG.zvaultProgramId);

// Bitcoin testnet genesis block hash (in internal byte order / little-endian)
// Block 0 display: 000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943
// Reversed for internal storage to match how Bitcoin stores hashes in raw headers
const TESTNET_GENESIS_HASH = Buffer.from(
  "43497fd7f826957108f4a30fd9cec3aeba79972084e90ead01ea330900000000",
  "hex"
);

// Network identifiers
const NETWORK_TESTNET = 1;

// Compute Anchor instruction discriminator
function getAnchorDiscriminator(instructionName: string): Buffer {
  const hash = createHash("sha256")
    .update(`global:${instructionName}`)
    .digest();
  return hash.slice(0, 8);
}

// Derive light client PDA (v2 for correct byte order)
function deriveLightClientPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("btc_light_client_v2")],
    PROGRAM_ID
  );
}

export async function POST(request: NextRequest) {
  try {
    console.log("[Init API] Initializing Bitcoin light client (Anchor)...");

    // Get relayer keypair
    const relayer = getRelayerKeypair();
    if (!relayer) {
      return NextResponse.json(
        { success: false, error: "Relayer keypair not configured" },
        { status: 500 }
      );
    }

    // Connect to Solana
    const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";
    const connection = new Connection(rpcUrl, "confirmed");

    console.log("[Init API] Relayer:", relayer.publicKey.toBase58());
    console.log("[Init API] Program:", PROGRAM_ID.toBase58());

    // Check if light client already exists
    const [lightClientPDA] = deriveLightClientPDA();
    console.log("[Init API] Light Client PDA:", lightClientPDA.toBase58());

    const existingAccount = await connection.getAccountInfo(lightClientPDA);
    if (existingAccount) {
      console.log("[Init API] Light client already initialized");
      return NextResponse.json({
        success: true,
        already_exists: true,
        light_client_pda: lightClientPDA.toBase58(),
        message: "Light client already initialized",
      });
    }

    // Check relayer balance
    const balance = await connection.getBalance(relayer.publicKey);
    console.log("[Init API] Relayer balance:", balance / 1e9, "SOL");

    if (balance < 0.01 * 1e9) {
      return NextResponse.json(
        {
          success: false,
          error: `Insufficient balance. Relayer has ${balance / 1e9} SOL, need at least 0.01 SOL`,
          relayer_address: relayer.publicKey.toBase58(),
        },
        { status: 400 }
      );
    }

    // Build Anchor init_light_client instruction
    // Discriminator: first 8 bytes of sha256("global:init_light_client")
    const discriminator = getAnchorDiscriminator("init_light_client");

    // Instruction data: discriminator(8) + genesis_hash(32) + network(1)
    const instructionData = Buffer.alloc(8 + 32 + 1);
    discriminator.copy(instructionData, 0);
    TESTNET_GENESIS_HASH.copy(instructionData, 8);
    instructionData.writeUInt8(NETWORK_TESTNET, 40);

    console.log("[Init API] Discriminator:", discriminator.toString("hex"));
    console.log("[Init API] Genesis hash:", TESTNET_GENESIS_HASH.toString("hex"));

    // Accounts for Anchor init_light_client (check the Accounts struct)
    const initIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: lightClientPDA, isSigner: false, isWritable: true },
        { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
        { pubkey: new PublicKey("11111111111111111111111111111111"), isSigner: false, isWritable: false },
      ],
      data: instructionData,
    });

    // Build and send transaction
    const tx = new Transaction().add(initIx);

    try {
      const signature = await sendAndConfirmTransaction(connection, tx, [relayer], {
        commitment: "confirmed",
      });

      console.log("[Init API] Light client initialized:", signature);

      return NextResponse.json({
        success: true,
        light_client_pda: lightClientPDA.toBase58(),
        solana_tx_signature: signature,
        message: "Bitcoin light client initialized for testnet",
      });
    } catch (txError: unknown) {
      console.error("[Init API] Transaction failed:", txError);

      const errorMessage = txError instanceof Error ? txError.message : "Transaction failed";

      return NextResponse.json(
        {
          success: false,
          error: errorMessage,
          light_client_pda: lightClientPDA.toBase58(),
        },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error("[Init API] Error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 }
    );
  }
}
