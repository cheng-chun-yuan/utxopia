/**
 * Proof Relay API — Public Unshield (zkBTC → SPL token)
 *
 * Handles relaying unshield transactions. Same as /api/relay but:
 * - Uses UNSHIELD discriminator (15) instead of TRANSACT (14)
 * - Passes extra accounts: zkbtc_mint, pool_vault, user_token_account, token_program
 * - Appends unshield_amount and unshield_address to instruction data
 * - Creates stealth announcements only for tree outputs (n_outputs - 1)
 *
 * @module api/unshield
 */

import { NextRequest, NextResponse } from "next/server";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getConfig,
  INSTRUCTION_DISCRIMINATORS,
  hexToBytes,
  PDA_SEEDS,
} from "@aegis/sdk";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import {
  AEGIS_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ZKBTC_MINT_ADDRESS,
  derivePoolStatePDA,
  deriveCommitmentTreePDA,
  deriveNullifierPDA,
  derivePoolVaultATA,
} from "@/lib/solana/instructions";

import { getRelayerKeypair } from "@/lib/server/relayer";
export const dynamic = "force-dynamic";

// =============================================================================
// Configuration
// =============================================================================

const STEALTH_DATA_PER_OUTPUT = 72; // ephemeral_pub(32) + encrypted_amount(8) + encrypted_token_id(32)

// =============================================================================
// Types
// =============================================================================

interface UnshieldRelayRequest {
  nInputs: number;
  nOutputs: number;
  proof: string;
  merkleRoot: string;
  boundParamsHash: string;
  nullifiers: string[];
  commitmentsOut: string[];
  /** Stealth data for tree outputs only (n_outputs - 1 entries) */
  stealthData: string[];
  /** Unshield amount in satoshis */
  unshieldAmount: string;
  /** Recipient Solana address (base58) */
  recipientAddress: string;
  /** Recipient token account (base58) */
  recipientTokenAccount: string;
}

// =============================================================================
// Helpers
// =============================================================================

function validateHexField(value: string | undefined, name: string, expectedBytes: number): Uint8Array {
  if (!value) {
    throw new Error(`Missing required field: ${name}`);
  }
  const bytes = hexToBytes(value);
  if (bytes.length !== expectedBytes) {
    throw new Error(`Invalid ${name}: expected ${expectedBytes} bytes, got ${bytes.length}`);
  }
  return bytes;
}

function deriveVkRegistryPDA(
  nInputs: number,
  nOutputs: number,
  programId: PublicKey = AEGIS_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(PDA_SEEDS.VK_REGISTRY),
      new Uint8Array([nInputs]),
      new Uint8Array([nOutputs]),
    ],
    programId
  );
}

// =============================================================================
// Main Handler
// =============================================================================

export async function POST(request: NextRequest) {
  // Origin check is enforced by middleware.ts
  const startTime = Date.now();

  try {
    const body: UnshieldRelayRequest = await request.json();

    const {
      nInputs, nOutputs, proof, merkleRoot, boundParamsHash,
      nullifiers, commitmentsOut, stealthData,
      unshieldAmount, recipientAddress, recipientTokenAccount,
    } = body;

    if (
      nInputs == null || nOutputs == null || !proof || !merkleRoot ||
      !boundParamsHash || !nullifiers || !commitmentsOut || !stealthData ||
      !unshieldAmount || !recipientAddress || !recipientTokenAccount
    ) {
      return NextResponse.json(
        { success: false, error: "Missing required fields" },
        { status: 400 }
      );
    }

    if (!Number.isInteger(nInputs) || !Number.isInteger(nOutputs) || nInputs < 1 || nOutputs < 1 || nInputs > 14 || nOutputs > 14) {
      return NextResponse.json({ success: false, error: "Invalid circuit dimensions" }, { status: 400 });
    }

    if (nOutputs < 1) {
      return NextResponse.json(
        { success: false, error: "nOutputs must be at least 1 (the unshield output)" },
        { status: 400 }
      );
    }

    const nTreeOutputs = nOutputs - 1;

    if (nullifiers.length !== nInputs) {
      return NextResponse.json(
        { success: false, error: `Expected ${nInputs} nullifiers, got ${nullifiers.length}` },
        { status: 400 }
      );
    }

    if (commitmentsOut.length !== nOutputs) {
      return NextResponse.json(
        { success: false, error: `Expected ${nOutputs} commitments, got ${commitmentsOut.length}` },
        { status: 400 }
      );
    }

    if (stealthData.length !== nTreeOutputs) {
      return NextResponse.json(
        { success: false, error: `Expected ${nTreeOutputs} stealth data entries, got ${stealthData.length}` },
        { status: 400 }
      );
    }

    console.log(`[Unshield] Processing JoinSplit(${nInputs}x${nOutputs}) unshield request...`);

    const relayer = getRelayerKeypair();
    if (!relayer) {
      return NextResponse.json(
        { success: false, error: "Relayer not configured — RELAYER_KEYPAIR env var is missing" },
        { status: 503 }
      );
    }

    const connection = new Connection(
      process.env.NEXT_PUBLIC_SOLANA_RPC || "https://api.devnet.solana.com",
      "confirmed"
    );

    // Parse fields
    const proofBytes = validateHexField(proof, "proof", 256);
    const merkleRootBytes = validateHexField(merkleRoot, "merkleRoot", 32);
    const boundParamsHashBytes = validateHexField(boundParamsHash, "boundParamsHash", 32);

    const nullifierBytes = nullifiers.map((n, i) =>
      validateHexField(n, `nullifiers[${i}]`, 32)
    );
    const commitmentBytes = commitmentsOut.map((c, i) =>
      validateHexField(c, `commitmentsOut[${i}]`, 32)
    );
    const stealthDataBytes = stealthData.map((s, i) =>
      validateHexField(s, `stealthData[${i}]`, STEALTH_DATA_PER_OUTPUT)
    );

    const recipientPubkey = new PublicKey(recipientAddress);
    const recipientTokenPubkey = new PublicKey(recipientTokenAccount);
    const unshieldAmountBigint = BigInt(unshieldAmount);

    // Derive PDAs
    const nullifierPDAs = nullifierBytes.map((n) => deriveNullifierPDA(n)[0]);
    const [vkRegistryPDA] = deriveVkRegistryPDA(nInputs, nOutputs);
    const [poolState] = derivePoolStatePDA();
    const [commitmentTree] = deriveCommitmentTreePDA();
    const poolVault = derivePoolVaultATA();

    // Build unshield instruction data
    const totalSize =
      1 + // discriminator
      2 + // nInputs + nOutputs
      256 + // proof
      32 + // merkleRoot
      32 + // boundParamsHash
      nInputs * 32 + // nullifiers
      nOutputs * 32 + // commitments (all, including unshield)
      nTreeOutputs * STEALTH_DATA_PER_OUTPUT + // stealth data (tree outputs only)
      8 + // unshield_amount
      32; // unshield_address

    const ixData = Buffer.alloc(totalSize);
    let offset = 0;

    ixData[offset++] = INSTRUCTION_DISCRIMINATORS.UNSHIELD;
    ixData[offset++] = nInputs;
    ixData[offset++] = nOutputs;

    Buffer.from(proofBytes).copy(ixData, offset);
    offset += 256;

    Buffer.from(merkleRootBytes).copy(ixData, offset);
    offset += 32;

    Buffer.from(boundParamsHashBytes).copy(ixData, offset);
    offset += 32;

    for (const nullifier of nullifierBytes) {
      Buffer.from(nullifier).copy(ixData, offset);
      offset += 32;
    }

    for (const commitment of commitmentBytes) {
      Buffer.from(commitment).copy(ixData, offset);
      offset += 32;
    }

    for (const sd of stealthDataBytes) {
      Buffer.from(sd).copy(ixData, offset, 0, STEALTH_DATA_PER_OUTPUT);
      offset += STEALTH_DATA_PER_OUTPUT;
    }

    // Unshield amount (u64 LE)
    const amountBuf = Buffer.alloc(8);
    amountBuf.writeBigUInt64LE(unshieldAmountBigint);
    amountBuf.copy(ixData, offset);
    offset += 8;

    // Unshield address (recipient pubkey, 32 bytes)
    recipientPubkey.toBuffer().copy(ixData, offset);

    // Build accounts
    const keys = [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: commitmentTree, isSigner: false, isWritable: true },
      { pubkey: vkRegistryPDA, isSigner: false, isWritable: false },
      { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ZKBTC_MINT_ADDRESS, isSigner: false, isWritable: true },
      { pubkey: poolVault, isSigner: false, isWritable: true },
      { pubkey: recipientTokenPubkey, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ];

    for (const nullifierPDA of nullifierPDAs) {
      keys.push({ pubkey: nullifierPDA, isSigner: false, isWritable: true });
    }

    // No stealth announcement PDAs — emitted as events now

    const unshieldIx = new TransactionInstruction({
      programId: AEGIS_PROGRAM_ID,
      keys,
      data: ixData,
    });

    // Ensure recipient token account exists — separate tx to avoid size limit
    const ataInfo = await connection.getAccountInfo(recipientTokenPubkey);
    if (!ataInfo) {
      console.log("[Unshield] Creating recipient ATA...");
      const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
        relayer.publicKey,       // payer
        recipientTokenPubkey,    // associated token account
        recipientPubkey,         // owner
        ZKBTC_MINT_ADDRESS,       // mint
        TOKEN_2022_PROGRAM_ID,   // token program
      );
      const ataTx = new Transaction().add(createAtaIx);
      const { blockhash: ataBlockhash } = await connection.getLatestBlockhash();
      ataTx.feePayer = relayer.publicKey;
      ataTx.recentBlockhash = ataBlockhash;
      await sendAndConfirmTransaction(connection, ataTx, [relayer], { commitment: "confirmed" });
      console.log("[Unshield] ATA created.");
    }

    // Submit unshield transaction
    const tx = new Transaction();
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      unshieldIx
    );

    console.log("[Unshield] Submitting transaction...");
    const { blockhash } = await connection.getLatestBlockhash();
    tx.feePayer = relayer.publicKey;
    tx.recentBlockhash = blockhash;

    const signature = await sendAndConfirmTransaction(connection, tx, [relayer], {
      commitment: "confirmed",
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[Unshield] Complete in ${duration}s: ${signature}`);

    return NextResponse.json({
      success: true,
      signature,
    });
  } catch (error) {
    console.error("[Unshield] Error:", error);
    return NextResponse.json(
      {
        success: false,
        error: process.env.NODE_ENV === "development" ? (error instanceof Error ? error.message : "Unknown error") : "Transaction failed",
      },
      { status: 500 }
    );
  }
}
