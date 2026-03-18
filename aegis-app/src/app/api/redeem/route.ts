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
  getConfig,
  INSTRUCTION_DISCRIMINATORS,
  hexToBytes,
  PDA_SEEDS,
} from "@aegis/sdk";

import {
  AEGIS_PROGRAM_ID,
  ZKBTC_MINT_ADDRESS,
  derivePoolStatePDA,
  deriveCommitmentTreePDA,
  deriveNullifierPDA,
} from "@/lib/solana/instructions";

// =============================================================================
// Configuration
// =============================================================================

const STEALTH_DATA_PER_OUTPUT = 40;
const CHADBUFFER_PROGRAM_ID = new PublicKey(getConfig().chadbufferProgramId);
const CHADBUFFER = { INIT: 0, WRITE: 2, CLOSE: 3 } as const;
const AUTHORITY_SIZE = 32;
const MAX_CHUNK_SIZE = 950;
const FIRST_CHUNK_SIZE = 800;

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
// ChadBuffer Operations
// =============================================================================

async function uploadProofToBuffer(
  connection: Connection,
  relayer: Keypair,
  proof: Uint8Array
): Promise<{ bufferPubkey: PublicKey; bufferKeypair: Keypair }> {
  const bufferKeypair = Keypair.generate();
  const bufferSize = AUTHORITY_SIZE + proof.length;
  const rentExemption = await connection.getMinimumBalanceForRentExemption(bufferSize);

  const firstChunkSize = Math.min(FIRST_CHUNK_SIZE, proof.length);
  const firstChunk = proof.slice(0, firstChunkSize);

  const createAccountIx = SystemProgram.createAccount({
    fromPubkey: relayer.publicKey,
    newAccountPubkey: bufferKeypair.publicKey,
    lamports: rentExemption,
    space: bufferSize,
    programId: CHADBUFFER_PROGRAM_ID,
  });

  const initData = Buffer.alloc(1 + firstChunk.length);
  initData[0] = CHADBUFFER.INIT;
  Buffer.from(firstChunk).copy(initData, 1);

  const initIx = new TransactionInstruction({
    programId: CHADBUFFER_PROGRAM_ID,
    keys: [
      { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
      { pubkey: bufferKeypair.publicKey, isSigner: true, isWritable: true },
    ],
    data: initData,
  });

  const { blockhash } = await connection.getLatestBlockhash();
  const tx = new Transaction();
  tx.add(createAccountIx, initIx);
  tx.feePayer = relayer.publicKey;
  tx.recentBlockhash = blockhash;

  await sendAndConfirmTransaction(connection, tx, [relayer, bufferKeypair], {
    commitment: "confirmed",
  });

  let dataOffset = firstChunkSize;
  while (dataOffset < proof.length) {
    const chunkSize = Math.min(MAX_CHUNK_SIZE, proof.length - dataOffset);
    const chunk = proof.slice(dataOffset, dataOffset + chunkSize);
    const bufferOffset = AUTHORITY_SIZE + dataOffset;

    const writeData = Buffer.alloc(4 + chunk.length);
    writeData[0] = CHADBUFFER.WRITE;
    writeData[1] = bufferOffset & 0xff;
    writeData[2] = (bufferOffset >> 8) & 0xff;
    writeData[3] = (bufferOffset >> 16) & 0xff;
    Buffer.from(chunk).copy(writeData, 4);

    const writeIx = new TransactionInstruction({
      programId: CHADBUFFER_PROGRAM_ID,
      keys: [
        { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
        { pubkey: bufferKeypair.publicKey, isSigner: false, isWritable: true },
      ],
      data: writeData,
    });

    const { blockhash: wbh } = await connection.getLatestBlockhash();
    const writeTx = new Transaction();
    writeTx.add(writeIx);
    writeTx.feePayer = relayer.publicKey;
    writeTx.recentBlockhash = wbh;

    await sendAndConfirmTransaction(connection, writeTx, [relayer], {
      commitment: "confirmed",
    });
    dataOffset += chunkSize;
  }

  console.log(`[Redeem] Uploaded proof to buffer (${proof.length} bytes)`);
  return { bufferPubkey: bufferKeypair.publicKey, bufferKeypair };
}

async function closeBuffer(
  connection: Connection,
  relayer: Keypair,
  bufferPubkey: PublicKey
): Promise<void> {
  const closeIx = new TransactionInstruction({
    programId: CHADBUFFER_PROGRAM_ID,
    keys: [
      { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
      { pubkey: bufferPubkey, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([CHADBUFFER.CLOSE]),
  });

  const { blockhash } = await connection.getLatestBlockhash();
  const closeTx = new Transaction();
  closeTx.add(closeIx);
  closeTx.feePayer = relayer.publicKey;
  closeTx.recentBlockhash = blockhash;

  await sendAndConfirmTransaction(connection, closeTx, [relayer], {
    commitment: "confirmed",
  });
  console.log("[Redeem] Buffer closed, rent reclaimed");
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
    const [vkRegistryPDA] = deriveVkRegistryPDA(nInputs, nOutputs);
    const [poolState] = derivePoolStatePDA();
    const [commitmentTree] = deriveCommitmentTreePDA();
    const [redemptionRequestPDA] = deriveRedemptionRequestPDA(relayer.publicKey, requestNonceBigint);
    // TokenConfig PDA for zkBTC (redeem is BTC-only)
    const [tokenConfigPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_config"), ZKBTC_MINT_ADDRESS.toBuffer()],
      AEGIS_PROGRAM_ID
    );

    // Step 1: Upload proof to ChadBuffer
    const { bufferPubkey } = await uploadProofToBuffer(connection, relayer, proofBytes);

    // Step 2: Build redeem instruction data — proof_source=1 (buffer mode), no inline proof
    const totalSize =
      1 + // discriminator
      3 + // nInputs + nOutputs + proof_source
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

    ixData[offset++] = 16; // Legacy REDEEM discriminator — TODO: migrate to request_redemption flow
    ixData[offset++] = nInputs;
    ixData[offset++] = nOutputs;
    ixData[offset++] = 1; // proof_source = 1 (buffer)

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

    // Build accounts: pool, tree, vk, user, system, token_config, nullifiers..., redemption, buffer
    const keys = [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: commitmentTree, isSigner: false, isWritable: true },
      { pubkey: vkRegistryPDA, isSigner: false, isWritable: false },
      { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenConfigPDA, isSigner: false, isWritable: false },
    ];

    for (const nullifierPDA of nullifierPDAs) {
      keys.push({ pubkey: nullifierPDA, isSigner: false, isWritable: true });
    }

    // No stealth announcement PDAs — emitted as events now

    keys.push({ pubkey: redemptionRequestPDA, isSigner: false, isWritable: true });
    keys.push({ pubkey: bufferPubkey, isSigner: false, isWritable: false });

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

    // Simulate first to capture logs on failure
    console.log(`[Redeem] Simulating transaction (ixData ${ixData.length} bytes, ${keys.length} accounts)...`);
    const simResult = await connection.simulateTransaction(tx);
    if (simResult.value.err) {
      console.error("[Redeem] Simulation failed:", JSON.stringify(simResult.value.err));
      console.error("[Redeem] Logs:", simResult.value.logs);
      console.error("[Redeem] Units consumed:", simResult.value.unitsConsumed);
      return NextResponse.json(
        {
          success: false,
          error: `Simulation failed: ${JSON.stringify(simResult.value.err)}`,
          logs: simResult.value.logs,
          unitsConsumed: simResult.value.unitsConsumed,
        },
        { status: 400 }
      );
    }

    const signature = await sendAndConfirmTransaction(connection, tx, [relayer], {
      commitment: "confirmed",
    });

    // Step 3: Close buffer and reclaim rent
    try {
      await closeBuffer(connection, relayer, bufferPubkey);
    } catch (closeErr) {
      console.warn("[Redeem] Failed to close buffer (non-critical):", closeErr);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[Redeem] Complete in ${duration}s: ${signature}`);

    return NextResponse.json({
      success: true,
      signature,
    });
  } catch (error) {
    console.error("[Redeem] Error:", error);
    // Extract logs from SendTransactionError if available
    const logs = (error as any)?.logs ?? (error as any)?.transactionError?.logs ?? null;
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        logs,
      },
      { status: 500 }
    );
  }
}
