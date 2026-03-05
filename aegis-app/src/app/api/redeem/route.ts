/**
 * Proof Relay API — Redeem (JoinSplit → BTC withdrawal)
 *
 * Same as /api/unshield but instead of SPL token transfer, creates a
 * RedemptionRequest PDA for BTC withdrawal via FROST signing pipeline.
 *
 * @module api/redeem
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
  INSTRUCTION_DISCRIMINATORS,
  hexToBytes,
  PDA_SEEDS,
} from "@aegis/sdk";

import {
  AEGIS_PROGRAM_ID,
  derivePoolStatePDA,
  deriveCommitmentTreePDA,
  deriveNullifierPDA,
} from "@/lib/solana/instructions";

// =============================================================================
// Configuration
// =============================================================================

const STEALTH_DATA_PER_OUTPUT = 40;

// =============================================================================
// Types
// =============================================================================

interface RedeemRelayRequest {
  nInputs: number;
  nOutputs: number;
  proof: string;
  merkleRoot: string;
  boundParamsHash: string;
  nullifiers: string[];
  commitmentsOut: string[];
  /** Stealth data for tree outputs only (n_outputs - 1 entries) */
  stealthData: string[];
  /** Redeem amount in satoshis */
  redeemAmount: string;
  /** Bitcoin scriptPubKey (hex) */
  btcScript: string;
  /** Request nonce */
  requestNonce: string;
}

// =============================================================================
// Helpers
// =============================================================================

function getRelayerKeypair(): Keypair {
  const keypairJson = process.env.RELAYER_KEYPAIR;
  if (!keypairJson) {
    throw new Error("RELAYER_KEYPAIR not configured");
  }
  try {
    const secretKey = JSON.parse(keypairJson);
    return Keypair.fromSecretKey(Uint8Array.from(secretKey));
  } catch {
    throw new Error("Failed to parse RELAYER_KEYPAIR");
  }
}

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

function deriveStealthAnnouncementPDA(
  seed: Uint8Array,
  programId: PublicKey = AEGIS_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.STEALTH), seed],
    programId
  );
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

function deriveRedemptionRequestPDA(
  user: PublicKey,
  nonce: bigint,
  programId: PublicKey = AEGIS_PROGRAM_ID
): [PublicKey, number] {
  const nonceBytes = new Uint8Array(8);
  const view = new DataView(nonceBytes.buffer);
  view.setBigUint64(0, nonce, true);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("redemption"), user.toBuffer(), nonceBytes],
    programId
  );
}

// =============================================================================
// Main Handler
// =============================================================================

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  try {
    const body: RedeemRelayRequest = await request.json();

    const {
      nInputs, nOutputs, proof, merkleRoot, boundParamsHash,
      nullifiers, commitmentsOut, stealthData,
      redeemAmount, btcScript, requestNonce,
    } = body;

    if (
      nInputs == null || nOutputs == null || !proof || !merkleRoot ||
      !boundParamsHash || !nullifiers || !commitmentsOut || !stealthData ||
      !redeemAmount || !btcScript || !requestNonce
    ) {
      return NextResponse.json(
        { success: false, error: "Missing required fields" },
        { status: 400 }
      );
    }

    if (nOutputs < 1) {
      return NextResponse.json(
        { success: false, error: "nOutputs must be at least 1 (the redeem output)" },
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

    console.log(`[Redeem] Processing JoinSplit(${nInputs}x${nOutputs}) redeem request...`);

    const connection = new Connection(
      process.env.NEXT_PUBLIC_SOLANA_RPC || "https://api.devnet.solana.com",
      "confirmed"
    );
    const relayer = getRelayerKeypair();

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

    const btcScriptBytes = hexToBytes(btcScript);
    if (btcScriptBytes.length === 0 || btcScriptBytes.length > 34) {
      return NextResponse.json(
        { success: false, error: `BTC script must be 1-34 bytes, got ${btcScriptBytes.length}` },
        { status: 400 }
      );
    }

    const redeemAmountBigint = BigInt(redeemAmount);
    const requestNonceBigint = BigInt(requestNonce);

    // Derive PDAs
    const nullifierPDAs = nullifierBytes.map((n) => deriveNullifierPDA(n)[0]);
    const stealthAnnouncementPDAs = stealthDataBytes.map((sd) => {
      const ephemeralPub = sd.slice(0, 32);
      return deriveStealthAnnouncementPDA(ephemeralPub)[0];
    });

    const [vkRegistryPDA] = deriveVkRegistryPDA(nInputs, nOutputs);
    const [poolState] = derivePoolStatePDA();
    const [commitmentTree] = deriveCommitmentTreePDA();
    const [redemptionRequestPDA] = deriveRedemptionRequestPDA(relayer.publicKey, requestNonceBigint);

    // Build redeem instruction data (variable btc_script length)
    const totalSize =
      1 + // discriminator
      2 + // nInputs + nOutputs
      256 + // proof
      32 + // merkleRoot
      32 + // boundParamsHash
      nInputs * 32 + // nullifiers
      nOutputs * 32 + // commitments (all, including redeem)
      nTreeOutputs * STEALTH_DATA_PER_OUTPUT + // stealth data (tree outputs only)
      8 + // redeem_amount
      1 + // btc_script_len
      btcScriptBytes.length + // btc_script (variable!)
      8; // request_nonce

    const ixData = Buffer.alloc(totalSize);
    let offset = 0;

    ixData[offset++] = INSTRUCTION_DISCRIMINATORS.REDEEM;
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

    // Redeem amount (u64 LE)
    const amountBuf = Buffer.alloc(8);
    amountBuf.writeBigUInt64LE(redeemAmountBigint);
    amountBuf.copy(ixData, offset);
    offset += 8;

    // BTC script (variable length)
    ixData[offset++] = btcScriptBytes.length;
    Buffer.from(btcScriptBytes).copy(ixData, offset);
    offset += btcScriptBytes.length;

    // Request nonce (u64 LE)
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(requestNonceBigint);
    nonceBuf.copy(ixData, offset);

    // Build accounts
    const keys = [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: commitmentTree, isSigner: false, isWritable: true },
      { pubkey: vkRegistryPDA, isSigner: false, isWritable: false },
      { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];

    for (const nullifierPDA of nullifierPDAs) {
      keys.push({ pubkey: nullifierPDA, isSigner: false, isWritable: true });
    }

    for (const stealthPDA of stealthAnnouncementPDAs) {
      keys.push({ pubkey: stealthPDA, isSigner: false, isWritable: true });
    }

    keys.push({ pubkey: redemptionRequestPDA, isSigner: false, isWritable: true });

    const redeemIx = new TransactionInstruction({
      programId: AEGIS_PROGRAM_ID,
      keys,
      data: ixData,
    });

    // Submit transaction
    const tx = new Transaction();
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      redeemIx
    );

    console.log("[Redeem] Submitting transaction...");
    const { blockhash } = await connection.getLatestBlockhash();
    tx.feePayer = relayer.publicKey;
    tx.recentBlockhash = blockhash;

    const signature = await sendAndConfirmTransaction(connection, tx, [relayer], {
      commitment: "confirmed",
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[Redeem] Complete in ${duration}s: ${signature}`);

    return NextResponse.json({
      success: true,
      signature,
    });
  } catch (error) {
    console.error("[Redeem] Error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
