/**
 * Proof Relay API
 *
 * Well-organized backend API that handles ZK proof relay for privacy-preserving transactions.
 *
 * Flow:
 * 1. Client generates ZK proof locally (privacy preserved)
 * 2. Client sends proof + params to this API
 * 3. Backend uploads proof to ChadBuffer (handles chunking)
 * 4. Backend submits transaction with buffer reference
 * 5. Backend closes buffer and reclaims rent
 *
 * This approach matches the proven E2E test implementation.
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
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import {
  DEVNET_CONFIG,
  INSTRUCTION_DISCRIMINATORS,
  hexToBytes,
  deriveStealthAnnouncementPDA,
  bytesToBigint,
  bigintToBytes,
  BN254_FIELD_PRIME,
} from "@zvault/sdk";

// Import PDA functions from instructions.ts (single source of truth)
import {
  ZVAULT_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ZBTC_MINT_ADDRESS,
  GROTH16_VERIFIER_PROGRAM_ID,
  derivePoolStatePDA,
  deriveCommitmentTreePDA,
  deriveNullifierPDA,
  derivePoolVaultATA,
} from "@/lib/solana/instructions";

// =============================================================================
// Configuration (matching E2E test)
// =============================================================================

/** ChadBuffer Program ID */
const CHADBUFFER_PROGRAM_ID = new PublicKey(DEVNET_CONFIG.chadbufferProgramId);

/** ChadBuffer instruction discriminators */
const CHADBUFFER = {
  INIT: 0,
  WRITE: 2,
  CLOSE: 3,
} as const;

/** Buffer authority size (first 32 bytes) */
const AUTHORITY_SIZE = 32;

/** Max chunk size for ChadBuffer write (matching E2E test) */
const MAX_CHUNK_SIZE = 950;

/** First chunk size (smaller to fit with create account ix) */
const FIRST_CHUNK_SIZE = 800;

/** Instruction discriminators */
const SPEND_PARTIAL_PUBLIC = INSTRUCTION_DISCRIMINATORS.SPEND_PARTIAL_PUBLIC;
const SPEND_SPLIT = INSTRUCTION_DISCRIMINATORS.SPEND_SPLIT;


/** Groth16 verifier instruction discriminators */
const VERIFY_FROM_BUFFER = 3;

/** Instructions sysvar address */
const INSTRUCTIONS_SYSVAR = new PublicKey("Sysvar1nstructions1111111111111111111111111");

// =============================================================================
// Types
// =============================================================================

/** Base fields required for all relay requests */
interface RelayRequestBase {
  type: "spend_partial_public" | "spend_split";
  proof: string; // hex-encoded proof bytes
  root: string; // hex-encoded merkle root (32 bytes)
  nullifierHash: string; // hex-encoded nullifier hash (32 bytes)
  vkHash: string; // hex-encoded VK hash (32 bytes)
}

/** Spend Partial Public request - transfers part to public, rest as change */
interface SpendPartialPublicRequest extends RelayRequestBase {
  type: "spend_partial_public";
  publicAmount: string; // satoshis as string
  changeCommitment: string; // hex-encoded (32 bytes)
  recipient: string; // Solana address (base58)
  changeEphemeralPubX: string; // hex-encoded (32 bytes) - stealth announcement
  changeEncryptedAmountWithSign: string; // hex-encoded (32 bytes) - stealth announcement
}

/** Spend Split request - creates two private outputs */
interface SpendSplitRequest extends RelayRequestBase {
  type: "spend_split";
  outputCommitment1: string; // hex-encoded (32 bytes)
  outputCommitment2: string; // hex-encoded (32 bytes)
  output1EphemeralPubX: string; // hex-encoded (32 bytes)
  output1EncryptedAmountWithSign: string; // hex-encoded (32 bytes)
  output2EphemeralPubX: string; // hex-encoded (32 bytes)
  output2EncryptedAmountWithSign: string; // hex-encoded (32 bytes)
}

type RelayRequest = SpendPartialPublicRequest | SpendSplitRequest;

/** Successful relay response */
interface RelaySuccessResponse {
  success: true;
  signature: string;
  bufferAddress: string;
}

/** Failed relay response */
interface RelayErrorResponse {
  success: false;
  error: string;
}

type RelayResponse = RelaySuccessResponse | RelayErrorResponse;

// =============================================================================
// Helpers
// =============================================================================

/** Load relayer keypair from environment */
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

/** Validate required hex fields (32 bytes = 64 hex chars) */
function validateHexField(value: string | undefined, name: string): Uint8Array {
  if (!value) {
    throw new Error(`Missing required field: ${name}`);
  }
  const bytes = hexToBytes(value);
  if (bytes.length !== 32) {
    throw new Error(`Invalid ${name}: expected 32 bytes, got ${bytes.length}`);
  }
  return bytes;
}

// =============================================================================
// ChadBuffer Operations (matching E2E test)
// =============================================================================

/**
 * Upload proof to ChadBuffer using proven E2E approach
 *
 * @param connection Solana connection
 * @param relayer Relayer keypair
 * @param proof Proof bytes to upload
 * @returns Buffer public key
 */
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

  // ChadBuffer INIT: [payer (signer), buffer (signer)]
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

  console.log(`[Relay] Buffer created with ${firstChunkSize} bytes`);

  // TX 2+: Write remaining chunks
  let dataOffset = firstChunkSize;
  let chunkCount = 1;

  while (dataOffset < proof.length) {
    const chunkSize = Math.min(MAX_CHUNK_SIZE, proof.length - dataOffset);
    const chunk = proof.slice(dataOffset, dataOffset + chunkSize);

    // Offset includes AUTHORITY_SIZE (matching E2E test)
    const bufferOffset = AUTHORITY_SIZE + dataOffset;

    // ChadBuffer WRITE: disc(1) + u24_offset(3) + data
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

/**
 * Close ChadBuffer and reclaim rent
 */
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
// Transaction Builders
// =============================================================================

/**
 * Build VERIFY_FROM_BUFFER instruction for the Groth16 verifier
 *
 * This instruction is called BEFORE the zVault instruction in the same transaction.
 * zVault then uses instruction introspection to verify this instruction ran.
 *
 * Format: [discriminator(1)] [pi_count(4)] [public_inputs(N*32)] [vk_hash(32)]
 */
function buildVerifyFromBufferIx(
  bufferPubkey: PublicKey,
  publicInputs: Uint8Array[],
  vkHashBytes: Uint8Array
): TransactionInstruction {
  const piCount = publicInputs.length;
  const totalSize = 1 + 4 + (piCount * 32) + 32;
  const data = Buffer.alloc(totalSize);

  let offset = 0;
  data[offset++] = VERIFY_FROM_BUFFER;

  // Public inputs count (little-endian)
  data.writeUInt32LE(piCount, offset);
  offset += 4;

  // Public inputs
  for (const pi of publicInputs) {
    Buffer.from(pi).copy(data, offset);
    offset += 32;
  }

  // VK hash
  Buffer.from(vkHashBytes).copy(data, offset);

  return new TransactionInstruction({
    programId: GROTH16_VERIFIER_PROGRAM_ID,
    keys: [
      { pubkey: bufferPubkey, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Build public inputs array for spend_partial_public
 * Order: [root, nullifier_hash, public_amount, change_commitment, recipient, ephemeral_pub_x, encrypted_amount_with_sign]
 *
 * IMPORTANT: Recipient must be reduced modulo BN254_FIELD_PRIME to match what the prover uses.
 * The circom circuit represents public keys as field elements, which are always < BN254_FIELD_PRIME.
 */
function buildPartialPublicInputs(params: {
  rootBytes: Uint8Array;
  nullifierHashBytes: Uint8Array;
  publicAmount: bigint;
  changeCommitmentBytes: Uint8Array;
  recipientPubkey: PublicKey;
  changeEphemeralPubXBytes: Uint8Array;
  changeEncryptedAmountWithSignBytes: Uint8Array;
}): Uint8Array[] {
  // Encode amount as 32-byte field element (big-endian)
  const amountBytes = new Uint8Array(32);
  const amountBigEndian = params.publicAmount.toString(16).padStart(16, '0');
  for (let i = 0; i < 8; i++) {
    amountBytes[24 + i] = parseInt(amountBigEndian.slice(i * 2, i * 2 + 2), 16);
  }

  // Reduce recipient modulo BN254_FIELD_PRIME to match circuit's field element representation
  // This is critical: the prover reduces the recipient the same way in api.ts
  const recipientRaw = new Uint8Array(params.recipientPubkey.toBuffer());
  const recipientReduced = bytesToBigint(recipientRaw) % BN254_FIELD_PRIME;
  const recipientBytes = bigintToBytes(recipientReduced);

  return [
    params.rootBytes,
    params.nullifierHashBytes,
    amountBytes,
    params.changeCommitmentBytes,
    recipientBytes,
    params.changeEphemeralPubXBytes,
    params.changeEncryptedAmountWithSignBytes,
  ];
}

/**
 * Build public inputs array for spend_split
 * Order: [root, nullifier_hash, out1, out2, eph1_x, enc1, eph2_x, enc2]
 */
function buildSplitPublicInputs(params: {
  rootBytes: Uint8Array;
  nullifierHashBytes: Uint8Array;
  output1Bytes: Uint8Array;
  output2Bytes: Uint8Array;
  output1EphBytes: Uint8Array;
  output1EncBytes: Uint8Array;
  output2EphBytes: Uint8Array;
  output2EncBytes: Uint8Array;
}): Uint8Array[] {
  return [
    params.rootBytes,
    params.nullifierHashBytes,
    params.output1Bytes,
    params.output2Bytes,
    params.output1EphBytes,
    params.output1EncBytes,
    params.output2EphBytes,
    params.output2EncBytes,
  ];
}

/**
 * Build spend_partial_public instruction
 */
async function buildSpendPartialPublicIx(
  relayer: Keypair,
  bufferPubkey: PublicKey,
  params: {
    rootBytes: Uint8Array;
    nullifierHashBytes: Uint8Array;
    publicAmount: bigint;
    changeCommitmentBytes: Uint8Array;
    recipientPubkey: PublicKey;
    vkHashBytes: Uint8Array;
    changeEphemeralPubXBytes: Uint8Array;
    changeEncryptedAmountWithSignBytes: Uint8Array;
  }
): Promise<{ instructions: TransactionInstruction[]; recipientAta: PublicKey }> {
  const instructions: TransactionInstruction[] = [];

  // Build accounts
  const [poolState] = derivePoolStatePDA();
  const [commitmentTree] = deriveCommitmentTreePDA();
  const [nullifierPDA] = deriveNullifierPDA(params.nullifierHashBytes);
  const poolVault = derivePoolVaultATA();
  const recipientAta = getAssociatedTokenAddressSync(
    ZBTC_MINT_ADDRESS,
    params.recipientPubkey,
    false,
    TOKEN_2022_PROGRAM_ID
  );

  // Derive stealth announcement PDA for change output
  // On-chain uses ephemeral pub X (bytes 1-32 of compressed pub), not commitment
  const [stealthAnnouncementChange] = await deriveStealthAnnouncementPDA(
    params.changeEphemeralPubXBytes
  );

  // Build instruction data
  // Format: disc(1) + root(32) + nullifier(32) + amount(8) + change(32) + recipient(32) + vk(32) + ephPubX(32) + encAmount(32)
  const ixData = Buffer.alloc(1 + 32 + 32 + 8 + 32 + 32 + 32 + 32 + 32);
  let offset = 0;
  ixData[offset++] = SPEND_PARTIAL_PUBLIC;
  Buffer.from(params.rootBytes).copy(ixData, offset); offset += 32;
  Buffer.from(params.nullifierHashBytes).copy(ixData, offset); offset += 32;
  ixData.writeBigUInt64LE(params.publicAmount, offset); offset += 8;
  Buffer.from(params.changeCommitmentBytes).copy(ixData, offset); offset += 32;
  params.recipientPubkey.toBuffer().copy(ixData, offset); offset += 32;
  Buffer.from(params.vkHashBytes).copy(ixData, offset); offset += 32;
  Buffer.from(params.changeEphemeralPubXBytes).copy(ixData, offset); offset += 32;
  Buffer.from(params.changeEncryptedAmountWithSignBytes).copy(ixData, offset);

  instructions.push(
    new TransactionInstruction({
      programId: ZVAULT_PROGRAM_ID,
      keys: [
        { pubkey: poolState, isSigner: false, isWritable: true },
        { pubkey: commitmentTree, isSigner: false, isWritable: true },
        { pubkey: nullifierPDA, isSigner: false, isWritable: true },
        { pubkey: ZBTC_MINT_ADDRESS, isSigner: false, isWritable: true },
        { pubkey: poolVault, isSigner: false, isWritable: true },
        { pubkey: recipientAta, isSigner: false, isWritable: true },
        { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: GROTH16_VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: new PublicKey(stealthAnnouncementChange), isSigner: false, isWritable: true },
        { pubkey: bufferPubkey, isSigner: false, isWritable: false },
        { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
      ],
      data: ixData,
    })
  );

  return { instructions, recipientAta };
}

/**
 * Build spend_split instruction
 */
async function buildSpendSplitIx(
  relayer: Keypair,
  bufferPubkey: PublicKey,
  params: {
    rootBytes: Uint8Array;
    nullifierHashBytes: Uint8Array;
    output1Bytes: Uint8Array;
    output2Bytes: Uint8Array;
    vkHashBytes: Uint8Array;
    output1EphBytes: Uint8Array;
    output1EncBytes: Uint8Array;
    output2EphBytes: Uint8Array;
    output2EncBytes: Uint8Array;
  }
): Promise<TransactionInstruction[]> {
  // Build accounts
  const [poolState] = derivePoolStatePDA();
  const [commitmentTree] = deriveCommitmentTreePDA();
  const [nullifierPDA] = deriveNullifierPDA(params.nullifierHashBytes);

  // Derive stealth announcement PDAs using ephemeral pub X (not commitment)
  // On-chain uses ephemeral pub X (bytes 1-32 of compressed pub) as PDA seed
  const [stealthAnnouncement1] = await deriveStealthAnnouncementPDA(params.output1EphBytes);
  const [stealthAnnouncement2] = await deriveStealthAnnouncementPDA(params.output2EphBytes);

  // Build instruction data
  // Format: disc(1) + root(32) + nullifier(32) + out1(32) + out2(32) + vk(32) + eph1(32) + enc1(32) + eph2(32) + enc2(32)
  const ixData = Buffer.alloc(1 + 32 + 32 + 32 + 32 + 32 + 32 + 32 + 32 + 32);
  let offset = 0;
  ixData[offset++] = SPEND_SPLIT;
  Buffer.from(params.rootBytes).copy(ixData, offset); offset += 32;
  Buffer.from(params.nullifierHashBytes).copy(ixData, offset); offset += 32;
  Buffer.from(params.output1Bytes).copy(ixData, offset); offset += 32;
  Buffer.from(params.output2Bytes).copy(ixData, offset); offset += 32;
  Buffer.from(params.vkHashBytes).copy(ixData, offset); offset += 32;
  Buffer.from(params.output1EphBytes).copy(ixData, offset); offset += 32;
  Buffer.from(params.output1EncBytes).copy(ixData, offset); offset += 32;
  Buffer.from(params.output2EphBytes).copy(ixData, offset); offset += 32;
  Buffer.from(params.output2EncBytes).copy(ixData, offset);

  return [
    new TransactionInstruction({
      programId: ZVAULT_PROGRAM_ID,
      keys: [
        { pubkey: poolState, isSigner: false, isWritable: true },
        { pubkey: commitmentTree, isSigner: false, isWritable: true },
        { pubkey: nullifierPDA, isSigner: false, isWritable: true },
        { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: GROTH16_VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: new PublicKey(stealthAnnouncement1), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(stealthAnnouncement2), isSigner: false, isWritable: true },
        { pubkey: bufferPubkey, isSigner: false, isWritable: false },
        { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
      ],
      data: ixData,
    }),
  ];
}

// =============================================================================
// Main Handler
// =============================================================================

export async function POST(request: NextRequest): Promise<NextResponse<RelayResponse>> {
  const startTime = Date.now();

  try {
    const body: RelayRequest = await request.json();

    // Validate common fields
    if (!body.type || !body.proof || !body.root || !body.nullifierHash || !body.vkHash) {
      return NextResponse.json(
        { success: false, error: "Missing required fields: type, proof, root, nullifierHash, vkHash" },
        { status: 400 }
      );
    }

    console.log(`[Relay] Processing ${body.type} request...`);

    // Setup connection and relayer
    const connection = new Connection(
      process.env.NEXT_PUBLIC_SOLANA_RPC || "https://api.devnet.solana.com",
      "confirmed"
    );
    const relayer = getRelayerKeypair();

    // Parse common fields
    const proofBytes = hexToBytes(body.proof);
    const rootBytes = validateHexField(body.root, "root");
    const nullifierHashBytes = validateHexField(body.nullifierHash, "nullifierHash");
    const vkHashBytes = validateHexField(body.vkHash, "vkHash");

    console.log(`[Relay] Proof size: ${proofBytes.length} bytes`);

    // Step 1: Upload proof to ChadBuffer
    const { bufferPubkey } = await uploadProofToBuffer(connection, relayer, proofBytes);

    // Step 2: Build and submit transaction
    const instructions: TransactionInstruction[] = [];
    let recipientAta: PublicKey | null = null;

    // Add compute budget for ZK verification
    instructions.push(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })
    );

    if (body.type === "spend_partial_public") {
      // Validate spend_partial_public fields
      if (!body.publicAmount || !body.changeCommitment || !body.recipient) {
        return NextResponse.json(
          { success: false, error: "Missing spend_partial_public fields: publicAmount, changeCommitment, recipient" },
          { status: 400 }
        );
      }
      if (!body.changeEphemeralPubX || !body.changeEncryptedAmountWithSign) {
        return NextResponse.json(
          { success: false, error: "Missing stealth fields: changeEphemeralPubX, changeEncryptedAmountWithSign" },
          { status: 400 }
        );
      }

      const changeCommitmentBytes = validateHexField(body.changeCommitment, "changeCommitment");
      const changeEphemeralPubXBytes = validateHexField(body.changeEphemeralPubX, "changeEphemeralPubX");
      const changeEncryptedAmountWithSignBytes = validateHexField(body.changeEncryptedAmountWithSign, "changeEncryptedAmountWithSign");
      const recipientPubkey = new PublicKey(body.recipient);
      const publicAmount = BigInt(body.publicAmount);

      // Build public inputs for verifier
      const publicInputs = buildPartialPublicInputs({
        rootBytes,
        nullifierHashBytes,
        publicAmount,
        changeCommitmentBytes,
        recipientPubkey,
        changeEphemeralPubXBytes,
        changeEncryptedAmountWithSignBytes,
      });

      // Add verifier instruction FIRST (required for SkipVerification)
      instructions.push(buildVerifyFromBufferIx(bufferPubkey, publicInputs, vkHashBytes));

      const result = await buildSpendPartialPublicIx(relayer, bufferPubkey, {
        rootBytes,
        nullifierHashBytes,
        publicAmount,
        changeCommitmentBytes,
        recipientPubkey,
        vkHashBytes,
        changeEphemeralPubXBytes,
        changeEncryptedAmountWithSignBytes,
      });

      recipientAta = result.recipientAta;

      // Create recipient ATA if needed
      const recipientAtaInfo = await connection.getAccountInfo(recipientAta);
      if (!recipientAtaInfo) {
        console.log("[Relay] Creating recipient ATA...");
        instructions.push(
          createAssociatedTokenAccountInstruction(
            relayer.publicKey,
            recipientAta,
            new PublicKey(body.recipient),
            ZBTC_MINT_ADDRESS,
            TOKEN_2022_PROGRAM_ID
          )
        );
      }

      instructions.push(...result.instructions);
    } else if (body.type === "spend_split") {
      // Validate spend_split fields
      if (!body.outputCommitment1 || !body.outputCommitment2) {
        return NextResponse.json(
          { success: false, error: "Missing spend_split fields: outputCommitment1, outputCommitment2" },
          { status: 400 }
        );
      }
      if (!body.output1EphemeralPubX || !body.output1EncryptedAmountWithSign ||
          !body.output2EphemeralPubX || !body.output2EncryptedAmountWithSign) {
        return NextResponse.json(
          { success: false, error: "Missing stealth fields for split outputs" },
          { status: 400 }
        );
      }

      const output1Bytes = validateHexField(body.outputCommitment1, "outputCommitment1");
      const output2Bytes = validateHexField(body.outputCommitment2, "outputCommitment2");
      const output1EphBytes = validateHexField(body.output1EphemeralPubX, "output1EphemeralPubX");
      const output1EncBytes = validateHexField(body.output1EncryptedAmountWithSign, "output1EncryptedAmountWithSign");
      const output2EphBytes = validateHexField(body.output2EphemeralPubX, "output2EphemeralPubX");
      const output2EncBytes = validateHexField(body.output2EncryptedAmountWithSign, "output2EncryptedAmountWithSign");

      // Build public inputs for verifier
      const publicInputs = buildSplitPublicInputs({
        rootBytes,
        nullifierHashBytes,
        output1Bytes,
        output2Bytes,
        output1EphBytes,
        output1EncBytes,
        output2EphBytes,
        output2EncBytes,
      });

      // Add verifier instruction FIRST (required for SkipVerification)
      instructions.push(buildVerifyFromBufferIx(bufferPubkey, publicInputs, vkHashBytes));

      const splitIx = await buildSpendSplitIx(relayer, bufferPubkey, {
        rootBytes,
        nullifierHashBytes,
        output1Bytes,
        output2Bytes,
        vkHashBytes,
        output1EphBytes,
        output1EncBytes,
        output2EphBytes,
        output2EncBytes,
      });

      instructions.push(...splitIx);
    } else {
      return NextResponse.json(
        { success: false, error: `Unknown type: ${(body as any).type}` },
        { status: 400 }
      );
    }

    // Submit transaction
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
