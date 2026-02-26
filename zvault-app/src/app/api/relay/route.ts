/**
 * Proof Relay API — JoinSplit TRANSACT
 *
 * Handles relaying JoinSplit(N,M) transactions for privacy-preserving transfers.
 *
 * Flow:
 * 1. Client generates JoinSplit proof locally (privacy preserved)
 * 2. Client sends proof + params to this API
 * 3. Backend uploads proof to ChadBuffer (handles chunking)
 * 4. Backend builds and submits TRANSACT instruction
 * 5. Backend closes buffer and reclaims rent
 *
 * @module api/relay
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
  DEVNET_CONFIG,
  INSTRUCTION_DISCRIMINATORS,
  hexToBytes,
  PDA_SEEDS,
} from "@zvault/sdk";

import {
  ZVAULT_PROGRAM_ID,
  derivePoolStatePDA,
  deriveCommitmentTreePDA,
  deriveNullifierPDA,
} from "@/lib/solana/instructions";

// =============================================================================
// Configuration
// =============================================================================

const CHADBUFFER_PROGRAM_ID = new PublicKey(DEVNET_CONFIG.chadbufferProgramId);

const CHADBUFFER = {
  INIT: 0,
  WRITE: 2,
  CLOSE: 3,
} as const;

const AUTHORITY_SIZE = 32;
const MAX_CHUNK_SIZE = 950;
const FIRST_CHUNK_SIZE = 800;

const STEALTH_DATA_PER_OUTPUT = 40; // ephemeral_pub(32) + encrypted_amount(8)

// =============================================================================
// Types
// =============================================================================

interface TransactRelayRequest {
  nInputs: number;
  nOutputs: number;
  proof: string; // hex-encoded proof (256 bytes)
  merkleRoot: string; // hex 32 bytes
  boundParamsHash: string; // hex 32 bytes
  nullifiers: string[]; // hex 32 bytes each
  commitmentsOut: string[]; // hex 32 bytes each
  stealthData: string[]; // hex 40 bytes each (ephemeralPub + encryptedAmount)
}

interface RelaySuccessResponse {
  success: true;
  signature: string;
  bufferAddress: string;
}

interface RelayErrorResponse {
  success: false;
  error: string;
}

type RelayResponse = RelaySuccessResponse | RelayErrorResponse;

// =============================================================================
// Helpers
// =============================================================================

function getRelayerKeypair(): Keypair {
  const keypairJson = process.env.RELAYER_KEYPAIR;
  if (!keypairJson) {
    throw new Error("RELAYER_KEYPAIR not configured. Set it in .env.local as JSON array.");
  }
  try {
    const secretKey = JSON.parse(keypairJson);
    return Keypair.fromSecretKey(Uint8Array.from(secretKey));
  } catch {
    throw new Error("Failed to parse RELAYER_KEYPAIR. Must be JSON array format.");
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
  programId: PublicKey = ZVAULT_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.STEALTH), seed],
    programId
  );
}

function deriveVkRegistryPDA(
  nInputs: number,
  nOutputs: number,
  programId: PublicKey = ZVAULT_PROGRAM_ID
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

  console.log(`[Relay] Creating buffer for ${proof.length} byte proof...`);

  // TX 1: Create account + init with first chunk
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

  const { blockhash: blockhash1 } = await connection.getLatestBlockhash();
  const tx1 = new Transaction();
  tx1.add(createAccountIx, initIx);
  tx1.feePayer = relayer.publicKey;
  tx1.recentBlockhash = blockhash1;

  await sendAndConfirmTransaction(connection, tx1, [relayer, bufferKeypair], {
    commitment: "confirmed",
  });

  // TX 2+: Write remaining chunks
  let dataOffset = firstChunkSize;
  let chunkCount = 1;

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

    const { blockhash } = await connection.getLatestBlockhash();
    const writeTx = new Transaction();
    writeTx.add(writeIx);
    writeTx.feePayer = relayer.publicKey;
    writeTx.recentBlockhash = blockhash;

    await sendAndConfirmTransaction(connection, writeTx, [relayer], {
      commitment: "confirmed",
    });

    dataOffset += chunkSize;
    chunkCount++;
  }

  console.log(`[Relay] Uploaded ${chunkCount} chunks (${proof.length} bytes total)`);
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

  console.log("[Relay] Buffer closed, rent reclaimed");
}

// =============================================================================
// TRANSACT Instruction Builder
// =============================================================================

function buildTransactIx(
  relayer: Keypair,
  params: {
    nInputs: number;
    nOutputs: number;
    proofBytes: Uint8Array;
    merkleRoot: Uint8Array;
    boundParamsHash: Uint8Array;
    nullifiers: Uint8Array[];
    commitmentsOut: Uint8Array[];
    stealthData: Uint8Array[];
    nullifierPDAs: PublicKey[];
    stealthAnnouncementPDAs: PublicKey[];
    vkRegistryPDA: PublicKey;
  }
): TransactionInstruction {
  const { nInputs, nOutputs } = params;

  // Build instruction data
  const totalSize =
    1 + // discriminator
    2 + // nInputs + nOutputs
    256 + // proof
    32 + // merkleRoot
    32 + // boundParamsHash
    nInputs * 32 + // nullifiers
    nOutputs * 32 + // commitments
    nOutputs * STEALTH_DATA_PER_OUTPUT; // stealth data

  const ixData = Buffer.alloc(totalSize);
  let offset = 0;

  ixData[offset++] = INSTRUCTION_DISCRIMINATORS.TRANSACT;
  ixData[offset++] = nInputs;
  ixData[offset++] = nOutputs;

  Buffer.from(params.proofBytes).copy(ixData, offset);
  offset += 256;

  Buffer.from(params.merkleRoot).copy(ixData, offset);
  offset += 32;

  Buffer.from(params.boundParamsHash).copy(ixData, offset);
  offset += 32;

  for (const nullifier of params.nullifiers) {
    Buffer.from(nullifier).copy(ixData, offset);
    offset += 32;
  }

  for (const commitment of params.commitmentsOut) {
    Buffer.from(commitment).copy(ixData, offset);
    offset += 32;
  }

  for (const sd of params.stealthData) {
    Buffer.from(sd).copy(ixData, offset, 0, STEALTH_DATA_PER_OUTPUT);
    offset += STEALTH_DATA_PER_OUTPUT;
  }

  // Build accounts: pool_state, commitment_tree, vk_registry, user, system_program, ...nullifiers, ...stealth
  const [poolState] = derivePoolStatePDA();
  const [commitmentTree] = deriveCommitmentTreePDA();

  const keys = [
    { pubkey: poolState, isSigner: false, isWritable: true },
    { pubkey: commitmentTree, isSigner: false, isWritable: true },
    { pubkey: params.vkRegistryPDA, isSigner: false, isWritable: false },
    { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  for (const nullifierPDA of params.nullifierPDAs) {
    keys.push({ pubkey: nullifierPDA, isSigner: false, isWritable: true });
  }

  for (const stealthPDA of params.stealthAnnouncementPDAs) {
    keys.push({ pubkey: stealthPDA, isSigner: false, isWritable: true });
  }

  return new TransactionInstruction({
    programId: ZVAULT_PROGRAM_ID,
    keys,
    data: ixData,
  });
}

// =============================================================================
// Main Handler
// =============================================================================

export async function POST(request: NextRequest): Promise<NextResponse<RelayResponse>> {
  const startTime = Date.now();

  try {
    const body: TransactRelayRequest = await request.json();

    // Validate required fields
    const { nInputs, nOutputs, proof, merkleRoot, boundParamsHash, nullifiers, commitmentsOut, stealthData } = body;

    if (
      nInputs == null || nOutputs == null || !proof || !merkleRoot ||
      !boundParamsHash || !nullifiers || !commitmentsOut || !stealthData
    ) {
      return NextResponse.json(
        { success: false, error: "Missing required fields" },
        { status: 400 }
      );
    }

    if (nullifiers.length !== nInputs) {
      return NextResponse.json(
        { success: false, error: `Expected ${nInputs} nullifiers, got ${nullifiers.length}` },
        { status: 400 }
      );
    }

    if (commitmentsOut.length !== nOutputs || stealthData.length !== nOutputs) {
      return NextResponse.json(
        { success: false, error: `Output count mismatch: expected ${nOutputs}` },
        { status: 400 }
      );
    }

    console.log(`[Relay] Processing JoinSplit(${nInputs}x${nOutputs}) request...`);

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

    // Derive PDAs
    const nullifierPDAs = nullifierBytes.map((n) => deriveNullifierPDA(n)[0]);

    // Stealth announcement PDAs use the ephemeral pub (first 32 bytes of stealth data)
    const stealthAnnouncementPDAs = stealthDataBytes.map((sd) => {
      const ephemeralPub = sd.slice(0, 32);
      return deriveStealthAnnouncementPDA(ephemeralPub)[0];
    });

    const [vkRegistryPDA] = deriveVkRegistryPDA(nInputs, nOutputs);

    // Step 1: Upload proof to ChadBuffer
    const { bufferPubkey } = await uploadProofToBuffer(connection, relayer, proofBytes);

    // Step 2: Build and submit transaction
    const instructions: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ];

    instructions.push(
      buildTransactIx(relayer, {
        nInputs,
        nOutputs,
        proofBytes,
        merkleRoot: merkleRootBytes,
        boundParamsHash: boundParamsHashBytes,
        nullifiers: nullifierBytes,
        commitmentsOut: commitmentBytes,
        stealthData: stealthDataBytes,
        nullifierPDAs,
        stealthAnnouncementPDAs,
        vkRegistryPDA,
      })
    );

    console.log("[Relay] Submitting transaction...");
    const { blockhash } = await connection.getLatestBlockhash();
    const tx = new Transaction();
    tx.add(...instructions);
    tx.feePayer = relayer.publicKey;
    tx.recentBlockhash = blockhash;

    const signature = await sendAndConfirmTransaction(connection, tx, [relayer], {
      commitment: "confirmed",
    });

    console.log(`[Relay] Transaction confirmed: ${signature}`);

    // Step 3: Close buffer and reclaim rent
    try {
      await closeBuffer(connection, relayer, bufferPubkey);
    } catch (closeErr) {
      console.warn("[Relay] Failed to close buffer (non-critical):", closeErr);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[Relay] Complete in ${duration}s`);

    return NextResponse.json({
      success: true,
      signature,
      bufferAddress: bufferPubkey.toBase58(),
    });
  } catch (error) {
    console.error("[Relay] Error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
