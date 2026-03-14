#!/usr/bin/env bun
/**
 * Reusable Deposit Verification Script
 *
 * Verifies BTC deposits on-chain via SPV proof.
 * Automatically finds sweep TX, fetches merkle proof, uploads to ChadBuffer.
 *
 * Usage:
 *   bun run scripts/verify-deposits.ts <deposit_txid1> [deposit_txid2] ...
 *
 * Environment:
 *   KEYPAIR_PATH  — path to authority keypair (default: ~/.config/solana/johnny.json)
 *   RPC_URL       — Solana RPC (default: https://api.devnet.solana.com)
 */

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
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

// =============================================================================
// Configuration — update these for your deployment
// =============================================================================

const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const MEMPOOL_API = "https://mempool.space/testnet4/api";

const AEGIS_PROGRAM_ID = new PublicKey(
  process.env.AEGIS_PROGRAM_ID || "7JJeVjVCy1fZqCDWvf41R7LuTWirTjX7Tp6suC2WVUMQ"
);
const BTC_LIGHT_CLIENT_PROGRAM_ID = new PublicKey("Ho6UTeF8yFnRdCK15tSZtcJozvkDABJZWYxkgGyWAfyq");
const CHADBUFFER_PROGRAM_ID = new PublicKey("C5RpjtTMFXKVZCtXSzKXD4CDNTaWBg3dVeMfYvjZYHDF");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ZKBTC_MINT = new PublicKey(
  process.env.ZKBTC_MINT || "G5CHaLkWjdUxxmnrVqNLQ29K7PoNwJAzvVT11jjkdGKC"
);

const CHADBUFFER_INIT = 0;
const CHADBUFFER_WRITE = 2;
const CHADBUFFER_CLOSE = 3;
const AUTHORITY_SIZE = 32;
const FIRST_CHUNK_SIZE = 800;
const MAX_CHUNK_SIZE = 950;

// =============================================================================
// Helpers
// =============================================================================

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function reverseBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes).reverse();
}

function stripWitness(raw: Uint8Array): Uint8Array {
  if (raw.length < 6 || raw[4] !== 0x00 || raw[5] !== 0x01) return raw;

  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const result: number[] = [];
  result.push(raw[0], raw[1], raw[2], raw[3]);

  let offset = 6;
  function readVarInt(): number {
    const first = raw[offset++];
    if (first < 0xfd) return first;
    if (first === 0xfd) { const v = view.getUint16(offset, true); offset += 2; return v; }
    if (first === 0xfe) { const v = view.getUint32(offset, true); offset += 4; return v; }
    const lo = view.getUint32(offset, true); offset += 8; return lo;
  }
  function pushVarInt(n: number) {
    if (n < 0xfd) { result.push(n); }
    else if (n <= 0xffff) { result.push(0xfd, n & 0xff, (n >> 8) & 0xff); }
    else { result.push(0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff); }
  }

  const inputCount = readVarInt();
  pushVarInt(inputCount);
  for (let i = 0; i < inputCount; i++) {
    for (let j = 0; j < 36; j++) result.push(raw[offset++]);
    const sl = readVarInt(); pushVarInt(sl);
    for (let j = 0; j < sl; j++) result.push(raw[offset++]);
    for (let j = 0; j < 4; j++) result.push(raw[offset++]);
  }
  const outputCount = readVarInt();
  pushVarInt(outputCount);
  for (let i = 0; i < outputCount; i++) {
    for (let j = 0; j < 8; j++) result.push(raw[offset++]);
    const sl = readVarInt(); pushVarInt(sl);
    for (let j = 0; j < sl; j++) result.push(raw[offset++]);
  }
  const locktime = raw.slice(raw.length - 4);
  result.push(locktime[0], locktime[1], locktime[2], locktime[3]);
  return new Uint8Array(result);
}

function buildPathBits(txIndex: number, depth: number): number {
  let bits = 0, idx = txIndex;
  for (let i = 0; i < depth; i++) { if (idx & 1) bits |= 1 << i; idx >>= 1; }
  return bits;
}

function loadKeypair(keyPath: string): Keypair {
  const abs = keyPath.replace("~", process.env.HOME || "");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(abs, "utf-8"))));
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.text();
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// =============================================================================
// ChadBuffer upload
// =============================================================================

async function uploadToChadBuffer(
  connection: Connection,
  payer: Keypair,
  rawTx: Uint8Array,
): Promise<Keypair> {
  const bufferKeypair = Keypair.generate();
  const bufferSize = AUTHORITY_SIZE + rawTx.length;
  const rent = await connection.getMinimumBalanceForRentExemption(bufferSize);

  const firstChunkSize = Math.min(FIRST_CHUNK_SIZE, rawTx.length);
  const firstChunk = rawTx.slice(0, firstChunkSize);

  const createIx = SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: bufferKeypair.publicKey,
    lamports: rent,
    space: bufferSize,
    programId: CHADBUFFER_PROGRAM_ID,
  });

  const initData = Buffer.alloc(1 + firstChunk.length);
  initData[0] = CHADBUFFER_INIT;
  Buffer.from(firstChunk).copy(initData, 1);

  const initIx = new TransactionInstruction({
    programId: CHADBUFFER_PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: bufferKeypair.publicKey, isSigner: true, isWritable: true },
    ],
    data: initData,
  });

  const tx = new Transaction().add(createIx, initIx);
  await sendAndConfirmTransaction(connection, tx, [payer, bufferKeypair], { commitment: "confirmed" });

  // Write remaining chunks
  let dataOffset = firstChunkSize;
  while (dataOffset < rawTx.length) {
    const chunkSize = Math.min(MAX_CHUNK_SIZE, rawTx.length - dataOffset);
    const chunk = rawTx.slice(dataOffset, dataOffset + chunkSize);
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
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: bufferKeypair.publicKey, isSigner: false, isWritable: true },
      ],
      data: writeData,
    });

    const writeTx = new Transaction().add(writeIx);
    await sendAndConfirmTransaction(connection, writeTx, [payer], { commitment: "confirmed" });
    dataOffset += chunkSize;
  }

  return bufferKeypair;
}

async function closeChadBuffer(connection: Connection, payer: Keypair, buffer: PublicKey) {
  try {
    const closeIx = new TransactionInstruction({
      programId: CHADBUFFER_PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: buffer, isSigner: false, isWritable: true },
      ],
      data: Buffer.from([CHADBUFFER_CLOSE]),
    });
    const tx = new Transaction().add(closeIx);
    await sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });
  } catch (e: any) {
    console.warn("  Failed to close buffer (non-critical):", e.message?.slice(0, 80));
  }
}

// =============================================================================
// Verify a single deposit
// =============================================================================

async function verifyDeposit(
  connection: Connection,
  payer: Keypair,
  depositTxid: string,
) {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`Verifying deposit: ${depositTxid}`);
  console.log("=".repeat(70));

  // --- Step 1: Fetch deposit TX and find sweep ---
  console.log("\n[1/7] Fetching deposit TX info...");
  const depositTx = await fetchJson(`${MEMPOOL_API}/tx/${depositTxid}`);
  if (!depositTx.status?.confirmed) throw new Error("Deposit TX not confirmed");

  // Find sweep: output 0 of deposit should be spent by a sweep TX
  const outspends = await fetchJson(`${MEMPOOL_API}/tx/${depositTxid}/outspends`);
  if (!outspends[0]?.spent || !outspends[0]?.txid) {
    throw new Error("Deposit output 0 not yet spent (no sweep TX found)");
  }
  const sweepTxid = outspends[0].txid;
  console.log(`  Deposit block: ${depositTx.status.block_height}`);
  console.log(`  Sweep TX: ${sweepTxid}`);

  // --- Step 2: Fetch sweep TX info ---
  console.log("\n[2/7] Fetching sweep TX info...");
  const sweepTx = await fetchJson(`${MEMPOOL_API}/tx/${sweepTxid}`);
  if (!sweepTx.status?.confirmed) throw new Error("Sweep TX not confirmed");

  const sweepBlockHeight = sweepTx.status.block_height;
  const sweepBlockHash = sweepTx.status.block_hash;
  console.log(`  Sweep block: ${sweepBlockHeight} (${sweepBlockHash})`);

  // --- Step 3: Fetch merkle proof for sweep ---
  console.log("\n[3/7] Fetching merkle proof...");
  const merkleProof = await fetchJson(`${MEMPOOL_API}/tx/${sweepTxid}/merkle-proof`);
  console.log(`  Position: ${merkleProof.pos}, Depth: ${merkleProof.merkle.length}`);

  // --- Step 4: Fetch raw TXs and strip witness ---
  console.log("\n[4/7] Fetching raw transactions...");
  const sweepRawHex = await fetchText(`${MEMPOOL_API}/tx/${sweepTxid}/hex`);
  const depositRawHex = await fetchText(`${MEMPOOL_API}/tx/${depositTxid}/hex`);

  const sweepRaw = stripWitness(hexToBytes(sweepRawHex.trim()));
  const depositRaw = stripWitness(hexToBytes(depositRawHex.trim()));
  console.log(`  Sweep: ${sweepRaw.length} bytes (non-witness)`);
  console.log(`  Deposit: ${depositRaw.length} bytes (non-witness)`);

  // --- Step 5: Upload both to ChadBuffers ---
  console.log("\n[5/7] Uploading to ChadBuffers...");
  const sweepBuffer = await uploadToChadBuffer(connection, payer, sweepRaw);
  console.log(`  Sweep buffer: ${sweepBuffer.publicKey.toBase58()}`);

  const depositBuffer = await uploadToChadBuffer(connection, payer, depositRaw);
  console.log(`  Deposit buffer: ${depositBuffer.publicKey.toBase58()}`);

  // --- Step 6: Build & submit verify instructions ---
  console.log("\n[6/7] Submitting verification...");

  const sweepTxidInternal = reverseBytes(hexToBytes(sweepTxid));
  const depositTxidInternal = reverseBytes(hexToBytes(depositTxid));
  const blockHashInternal = reverseBytes(hexToBytes(sweepBlockHash));

  // Derive PDAs
  const [poolStatePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_state")], AEGIS_PROGRAM_ID
  );
  const [commitmentTreePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("commitment_tree")], AEGIS_PROGRAM_ID
  );
  const [lightClientPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("btc_light_client")], BTC_LIGHT_CLIENT_PROGRAM_ID
  );
  const [blockHeaderPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("block"), Buffer.from(blockHashInternal)], BTC_LIGHT_CLIENT_PROGRAM_ID
  );
  const [verifiedTxPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("verified_tx"), Buffer.from(blockHashInternal), Buffer.from(sweepTxidInternal)],
    BTC_LIGHT_CLIENT_PROGRAM_ID
  );
  const [depositReceiptPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("deposit_receipt"), Buffer.from(depositTxidInternal)], AEGIS_PROGRAM_ID
  );
  const poolVaultATA = getAssociatedTokenAddressSync(
    ZKBTC_MINT, poolStatePDA, true, TOKEN_2022_PROGRAM_ID
  );

  // Check if already verified
  const existingReceipt = await connection.getAccountInfo(depositReceiptPDA);
  if (existingReceipt) {
    console.log("  SKIPPED — already verified (deposit receipt PDA exists)");
    await closeChadBuffer(connection, payer, sweepBuffer.publicKey);
    await closeChadBuffer(connection, payer, depositBuffer.publicKey);
    return;
  }

  // Check if VerifiedTransaction PDA already exists (from previous run)
  const existingVT = await connection.getAccountInfo(verifiedTxPDA);

  // --- Build verify_transaction (btc-light-client, disc=2) ---
  const merkleSiblings = merkleProof.merkle.map((h: string) => reverseBytes(hexToBytes(h)));
  const pathBits = buildPathBits(merkleProof.pos, merkleSiblings.length);
  const pathLen = merkleSiblings.length;

  const verifyTxDataSize = 1 + 32 + 32 + 4 + 32 + 4 + 1 + 4 + 32 * pathLen;
  const verifyTxData = Buffer.alloc(verifyTxDataSize);
  let off = 0;
  verifyTxData[off++] = 2; // disc
  Buffer.from(sweepTxidInternal).copy(verifyTxData, off); off += 32;
  Buffer.from(blockHashInternal).copy(verifyTxData, off); off += 32;
  verifyTxData.writeUInt32LE(sweepRaw.length, off); off += 4;
  Buffer.from(sweepTxidInternal).copy(verifyTxData, off); off += 32;
  verifyTxData.writeUInt32LE(pathBits, off); off += 4;
  verifyTxData[off++] = pathLen;
  verifyTxData.writeUInt32LE(merkleProof.pos, off); off += 4;
  for (const sib of merkleSiblings) { Buffer.from(sib).copy(verifyTxData, off); off += 32; }

  const verifyTxIx = new TransactionInstruction({
    programId: BTC_LIGHT_CLIENT_PROGRAM_ID,
    keys: [
      { pubkey: verifiedTxPDA, isSigner: false, isWritable: true },
      { pubkey: lightClientPDA, isSigner: false, isWritable: false },
      { pubkey: blockHeaderPDA, isSigner: false, isWritable: false },
      { pubkey: sweepBuffer.publicKey, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: verifyTxData,
  });

  // --- Build verify_stealth_deposit (aegis, disc=1) ---
  // disc(1) + sweep_txid(32) + block_height(8) + sweep_tx_size(4) + deposit_tx_size(4) + deposit_txid(32) = 81
  const verifyDepositData = Buffer.alloc(81);
  let doff = 0;
  verifyDepositData[doff++] = 1; // disc
  Buffer.from(sweepTxidInternal).copy(verifyDepositData, doff); doff += 32;
  verifyDepositData.writeBigUInt64LE(BigInt(sweepBlockHeight), doff); doff += 8;
  verifyDepositData.writeUInt32LE(sweepRaw.length, doff); doff += 4;
  verifyDepositData.writeUInt32LE(depositRaw.length, doff); doff += 4;
  Buffer.from(depositTxidInternal).copy(verifyDepositData, doff); doff += 32;

  const verifyDepositIx = new TransactionInstruction({
    programId: AEGIS_PROGRAM_ID,
    keys: [
      { pubkey: poolStatePDA, isSigner: false, isWritable: true },          // 0
      { pubkey: verifiedTxPDA, isSigner: false, isWritable: false },        // 1
      { pubkey: lightClientPDA, isSigner: false, isWritable: false },       // 2
      { pubkey: commitmentTreePDA, isSigner: false, isWritable: true },     // 3
      { pubkey: sweepBuffer.publicKey, isSigner: false, isWritable: false },// 4
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },        // 5
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },// 6
      { pubkey: ZKBTC_MINT, isSigner: false, isWritable: true },            // 7
      { pubkey: poolVaultATA, isSigner: false, isWritable: true },          // 8
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },// 9
      { pubkey: depositBuffer.publicKey, isSigner: false, isWritable: false },// 10
      { pubkey: depositReceiptPDA, isSigner: false, isWritable: true },     // 11
    ],
    data: verifyDepositData,
  });

  // Build transaction
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
  );

  // Only add verify_transaction if PDA doesn't already exist
  if (!existingVT) {
    tx.add(verifyTxIx);
  } else {
    console.log("  VerifiedTransaction PDA already exists, skipping SPV step");
  }
  tx.add(verifyDepositIx);

  const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });
  console.log(`  ✓ Verified! Sig: ${sig}`);
  console.log(`  Explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`);

  // --- Step 7: Close ChadBuffers ---
  console.log("\n[7/7] Closing ChadBuffers...");
  await closeChadBuffer(connection, payer, sweepBuffer.publicKey);
  await closeChadBuffer(connection, payer, depositBuffer.publicKey);
  console.log("  Buffers closed, rent reclaimed");
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const txids = process.argv.slice(2).filter(a => !a.startsWith("-"));
  if (txids.length === 0) {
    console.log("Usage: bun run scripts/verify-deposits.ts <deposit_txid1> [deposit_txid2] ...");
    console.log("\nExample:");
    console.log("  bun run scripts/verify-deposits.ts 5628504ecfd2646d957fc0aec123e5085c4566f6d582f2b3bff3c8a61ceaa1f9");
    process.exit(1);
  }

  const keypairPath = process.env.KEYPAIR_PATH || "~/.config/solana/johnny.json";
  const payer = loadKeypair(keypairPath);
  const connection = new Connection(RPC_URL, "confirmed");

  console.log("Authority:", payer.publicKey.toBase58());
  console.log("Program:", AEGIS_PROGRAM_ID.toBase58());
  console.log("Mint:", ZKBTC_MINT.toBase58());

  const balance = await connection.getBalance(payer.publicKey);
  console.log("Balance:", (balance / 1e9).toFixed(4), "SOL");
  console.log(`\nVerifying ${txids.length} deposit(s)...`);

  let success = 0, skipped = 0, failed = 0;
  for (const txid of txids) {
    try {
      await verifyDeposit(connection, payer, txid);
      success++;
    } catch (e: any) {
      if (e.message?.includes("already verified")) {
        skipped++;
        console.log(`  SKIPPED: ${txid}`);
      } else {
        failed++;
        console.error(`  FAILED: ${txid} — ${e.message}`);
      }
    }
    // Small delay between verifications to avoid rate limits
    if (txids.indexOf(txid) < txids.length - 1) {
      await sleep(2000);
    }
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(`Done! ${success} verified, ${skipped} skipped, ${failed} failed`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
