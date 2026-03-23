/**
 * Verify API — On-chain SPV deposit verification
 *
 * Triggers btc-light-client verify_transaction + aegis verify_stealth_deposit
 * for a confirmed BTC sweep transaction.
 *
 * Flow:
 * 1. Fetch raw tx hex from mempool.space
 * 2. Upload raw tx to ChadBuffer
 * 3. Build verify_transaction instruction (btc-light-client)
 * 4. Build verify_stealth_deposit instruction (aegis)
 * 5. Submit both in one Solana transaction
 * 6. Close buffer and reclaim rent
 *
 * @module api/verify
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
  hexToBytes,
} from "@aegis/sdk";

import {
  AEGIS_PROGRAM_ID,
  BTC_LIGHT_CLIENT_PROGRAM_ID,
  CHADBUFFER_PROGRAM_ID,
  ZKBTC_MINT_ADDRESS,
  AUTHORITY_SIZE,
  derivePoolStatePDA,
  deriveCommitmentTreePDA,
  deriveLightClientPDA,
  derivePoolVaultATA,
  deriveVerifiedTransactionPDA,
  buildVerifyTransactionInstructionData,
  buildVerifyStealthDepositInstructionData,
  buildVerifyTransactionInstruction,
  buildVerifyStealthDepositInstruction,
  deriveDepositReceiptPDA,
} from "@/lib/solana/instructions";

import { getRelayerKeypair } from "@/lib/server/relayer";

import {
  getBlockHeaderByHeight,
  getMerkleProof,
} from "@/lib/spv/mempool";

import {
  reverseBytes,
} from "@/lib/spv/mempool";
import { hexToBytes as spvHexToBytes } from "@aegis/sdk";

import {
  buildMerkleProofPath,
} from "@/lib/spv/verify";
export const dynamic = "force-dynamic";

// =============================================================================
// Types
// =============================================================================

interface VerifyRequest {
  sweepTxid: string;      // hex display order
  depositTxid: string;    // hex display order (original deposit tx)
  blockHeight: number;
}

interface VerifySuccessResponse {
  success: true;
  signature: string;
  leafIndex?: number;
}

interface VerifyErrorResponse {
  success: false;
  error: string;
}

type VerifyResponse = VerifySuccessResponse | VerifyErrorResponse;

// =============================================================================
// ChadBuffer constants
// =============================================================================

const CHADBUFFER_INIT = 0;
const CHADBUFFER_WRITE = 2;
const CHADBUFFER_CLOSE = 3;
const MAX_CHUNK_SIZE = 950;
const FIRST_CHUNK_SIZE = 800;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Strip SegWit witness data from a raw transaction.
 * Returns the non-witness serialization (version + inputs + outputs + locktime)
 * whose double-SHA256 equals the txid.
 *
 * If the tx is not SegWit (no marker/flag bytes), returns the original bytes.
 */
function stripWitness(raw: Uint8Array): Uint8Array {
  // SegWit marker = 0x00, flag = 0x01 at bytes [4..6]
  if (raw.length < 6 || raw[4] !== 0x00 || raw[5] !== 0x01) {
    return raw; // not SegWit
  }

  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const result: number[] = [];

  // Version (4 bytes)
  result.push(raw[0], raw[1], raw[2], raw[3]);

  // Skip marker (0x00) and flag (0x01) — start parsing at offset 6
  let offset = 6;

  // Read a compact size (varint)
  function readVarInt(): number {
    const first = raw[offset++];
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      const val = view.getUint16(offset, true);
      offset += 2;
      return val;
    }
    if (first === 0xfe) {
      const val = view.getUint32(offset, true);
      offset += 4;
      return val;
    }
    // 0xff — 8 byte, but unlikely for tx counts
    const lo = view.getUint32(offset, true);
    offset += 8;
    return lo;
  }

  function pushVarInt(n: number) {
    if (n < 0xfd) {
      result.push(n);
    } else if (n <= 0xffff) {
      result.push(0xfd, n & 0xff, (n >> 8) & 0xff);
    } else {
      result.push(0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
    }
  }

  // Inputs
  const inputCount = readVarInt();
  pushVarInt(inputCount);
  for (let i = 0; i < inputCount; i++) {
    // prevout hash (32) + index (4)
    for (let j = 0; j < 36; j++) result.push(raw[offset++]);
    // scriptSig
    const scriptLen = readVarInt();
    pushVarInt(scriptLen);
    for (let j = 0; j < scriptLen; j++) result.push(raw[offset++]);
    // sequence (4)
    for (let j = 0; j < 4; j++) result.push(raw[offset++]);
  }

  // Outputs
  const outputCount = readVarInt();
  pushVarInt(outputCount);
  for (let i = 0; i < outputCount; i++) {
    // value (8)
    for (let j = 0; j < 8; j++) result.push(raw[offset++]);
    // scriptPubKey
    const scriptLen = readVarInt();
    pushVarInt(scriptLen);
    for (let j = 0; j < scriptLen; j++) result.push(raw[offset++]);
  }

  // Skip witness data — jump to locktime (last 4 bytes)
  const locktime = raw.slice(raw.length - 4);
  result.push(locktime[0], locktime[1], locktime[2], locktime[3]);

  return new Uint8Array(result);
}

/**
 * Fetch raw transaction hex from mempool.space
 */
async function fetchRawTxHex(txid: string, network: string = "testnet"): Promise<string> {
  const baseUrl = network === "mainnet"
    ? "https://mempool.space/api"
    : `https://mempool.space/${network}/api`;
  const resp = await fetch(`${baseUrl}/tx/${txid}/hex`);
  if (!resp.ok) {
    throw new Error(`Failed to fetch raw tx: ${resp.status} ${resp.statusText}`);
  }
  return resp.text();
}

/**
 * Upload data to ChadBuffer (reusable for any data, not just proofs)
 */
async function uploadDataToBuffer(
  connection: Connection,
  relayer: Keypair,
  data: Uint8Array
): Promise<{ bufferPubkey: PublicKey; bufferKeypair: Keypair }> {
  const bufferKeypair = Keypair.generate();
  const bufferSize = AUTHORITY_SIZE + data.length;
  const rentExemption = await connection.getMinimumBalanceForRentExemption(bufferSize);

  console.log(`[Verify] Creating buffer for ${data.length} bytes...`);

  // TX 1: Create account + init with first chunk
  const firstChunkSize = Math.min(FIRST_CHUNK_SIZE, data.length);
  const firstChunk = data.slice(0, firstChunkSize);

  const createAccountIx = SystemProgram.createAccount({
    fromPubkey: relayer.publicKey,
    newAccountPubkey: bufferKeypair.publicKey,
    lamports: rentExemption,
    space: bufferSize,
    programId: CHADBUFFER_PROGRAM_ID,
  });

  const initData = Buffer.alloc(1 + firstChunk.length);
  initData[0] = CHADBUFFER_INIT;
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

  while (dataOffset < data.length) {
    const chunkSize = Math.min(MAX_CHUNK_SIZE, data.length - dataOffset);
    const chunk = data.slice(dataOffset, dataOffset + chunkSize);
    const bufferOffset = AUTHORITY_SIZE + dataOffset;

    const writeData = Buffer.alloc(4 + chunk.length);
    writeData[0] = CHADBUFFER_WRITE;
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
  }

  console.log(`[Verify] Buffer upload complete (${data.length} bytes)`);
  return { bufferPubkey: bufferKeypair.publicKey, bufferKeypair };
}

/**
 * Close a ChadBuffer to reclaim rent
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
    data: Buffer.from([CHADBUFFER_CLOSE]),
  });

  const { blockhash } = await connection.getLatestBlockhash();
  const closeTx = new Transaction();
  closeTx.add(closeIx);
  closeTx.feePayer = relayer.publicKey;
  closeTx.recentBlockhash = blockhash;

  await sendAndConfirmTransaction(connection, closeTx, [relayer], {
    commitment: "confirmed",
  });

  console.log("[Verify] Buffer closed, rent reclaimed");
}

// =============================================================================
// Main Handler
// =============================================================================

export async function POST(request: NextRequest): Promise<NextResponse<VerifyResponse>> {
  const startTime = Date.now();

  try {
    const body: VerifyRequest = await request.json();
    const { sweepTxid, depositTxid, blockHeight } = body;

    if (!sweepTxid || !depositTxid || !blockHeight) {
      return NextResponse.json(
        { success: false, error: "Missing required fields (sweepTxid, depositTxid, blockHeight)" },
        { status: 400 }
      );
    }

    console.log(`[Verify] Processing deposit verification for sweep: ${sweepTxid}, deposit: ${depositTxid}`);

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
    const network = (process.env.NEXT_PUBLIC_BTC_NETWORK || "testnet") as "mainnet" | "testnet" | "testnet4" | "signet" | "regtest";

    // 1. Fetch raw tx hex from mempool.space and strip SegWit witness data
    console.log("[Verify] Fetching raw transactions...");
    const [sweepRawHex, depositRawHex] = await Promise.all([
      fetchRawTxHex(sweepTxid, network),
      fetchRawTxHex(depositTxid, network),
    ]);
    const sweepFullBytes = hexToBytes(sweepRawHex);
    const depositFullBytes = hexToBytes(depositRawHex);
    const sweepRawBytes = stripWitness(sweepFullBytes);
    const depositRawBytes = stripWitness(depositFullBytes);
    console.log(`[Verify] Sweep: ${sweepFullBytes.length}→${sweepRawBytes.length} bytes, Deposit: ${depositFullBytes.length}→${depositRawBytes.length} bytes`);

    // 2. Fetch Merkle proof from mempool.space
    console.log("[Verify] Fetching Merkle proof...");
    const merkleProof = await getMerkleProof(sweepTxid, network);

    // 3. Fetch block header to get block hash
    console.log("[Verify] Fetching block header...");
    const blockHeader = await getBlockHeaderByHeight(blockHeight, network);

    // Convert txids and block hash to internal byte order (reversed)
    const sweepTxidInternal = reverseBytes(spvHexToBytes(sweepTxid));
    const depositTxidInternal = reverseBytes(spvHexToBytes(depositTxid));
    const blockHashInternal = reverseBytes(spvHexToBytes(blockHeader.hash));

    // 4. Upload raw txs to ChadBuffer accounts
    const [sweepBuffer, depositBuffer] = await Promise.all([
      uploadDataToBuffer(connection, relayer, sweepRawBytes),
      uploadDataToBuffer(connection, relayer, depositRawBytes),
    ]);

    // 5. Derive all PDAs
    const [poolStatePDA] = derivePoolStatePDA();
    const [commitmentTreePDA] = deriveCommitmentTreePDA();
    const [lightClientPDA] = deriveLightClientPDA();
    const poolVaultATA = derivePoolVaultATA();
    const [depositReceiptPDA] = deriveDepositReceiptPDA(depositTxidInternal);

    // Block header PDA: derive from block hash
    const blockHeaderPDA = PublicKey.findProgramAddressSync(
      [Buffer.from("block"), Buffer.from(blockHashInternal)],
      BTC_LIGHT_CLIENT_PROGRAM_ID
    )[0];

    const [verifiedTxPDA] = deriveVerifiedTransactionPDA(blockHashInternal, sweepTxidInternal);

    // 6. Build merkle proof data for verify_transaction
    const merkleSiblings = merkleProof.merkleProof.map((hash) =>
      reverseBytes(spvHexToBytes(hash))
    );
    const pathBits = buildPathBits(merkleProof.txIndex, merkleSiblings.length);

    const verifyTxData = buildVerifyTransactionInstructionData({
      txid: sweepTxidInternal,
      blockHash: blockHashInternal,
      txSize: sweepRawBytes.length,
      txIndex: merkleProof.txIndex,
      merkleSiblings,
      pathBits,
    });

    const verifyTxIx = buildVerifyTransactionInstruction({
      payer: relayer.publicKey,
      verifiedTxPDA,
      lightClientPDA,
      blockHeaderPDA,
      chadBuffer: sweepBuffer.bufferPubkey,
      instructionData: verifyTxData,
    });

    // 7. Build verify_stealth_deposit instruction
    const verifyDepositData = buildVerifyStealthDepositInstructionData({
      sweepTxid: sweepTxidInternal,
      blockHeight,
      sweepTxSize: sweepRawBytes.length,
      depositTxSize: depositRawBytes.length,
      depositTxid: depositTxidInternal,
    });

    const verifyDepositIx = buildVerifyStealthDepositInstruction({
      poolStatePDA,
      verifiedTxPDA,
      lightClientPDA,
      commitmentTreePDA,
      sweepTxBuffer: sweepBuffer.bufferPubkey,
      authority: relayer.publicKey,
      zkbtcMint: ZKBTC_MINT_ADDRESS,
      poolVaultATA,
      depositTxBuffer: depositBuffer.bufferPubkey,
      depositReceiptPDA,
      instructionData: verifyDepositData,
    });

    // 8. Submit both instructions in one transaction
    console.log("[Verify] Submitting verification transaction...");

    const { blockhash } = await connection.getLatestBlockhash();
    const tx = new Transaction();
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      verifyTxIx,
      verifyDepositIx
    );
    tx.feePayer = relayer.publicKey;
    tx.recentBlockhash = blockhash;

    const signature = await sendAndConfirmTransaction(connection, tx, [relayer], {
      commitment: "confirmed",
    });

    console.log(`[Verify] Transaction confirmed: ${signature}`);

    // 9. Close buffers
    try {
      await Promise.all([
        closeBuffer(connection, relayer, sweepBuffer.bufferPubkey),
        closeBuffer(connection, relayer, depositBuffer.bufferPubkey),
      ]);
    } catch (closeErr) {
      console.warn("[Verify] Failed to close buffer (non-critical):", closeErr);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[Verify] Complete in ${duration}s`);

    return NextResponse.json({
      success: true,
      signature,
    });
  } catch (error) {
    console.error("[Verify] Error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

/**
 * Build path_bits bitmask from tx_index.
 * Bit i = 1 means the sibling is on the LEFT at level i (i.e., current node is on the right).
 */
function buildPathBits(txIndex: number, depth: number): number {
  let bits = 0;
  let index = txIndex;
  for (let i = 0; i < depth; i++) {
    if ((index & 1) === 1) {
      bits |= 1 << i;
    }
    index = index >> 1;
  }
  return bits;
}
