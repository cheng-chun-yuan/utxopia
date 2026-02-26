/**
 * 07 — Real E2E Deposit Verification (Regtest + Localnet)
 *
 * Full lifecycle test:
 *   BTC tx creation → block mining → header relay sync → ChadBuffer upload
 *   → SPV merkle proof → on-chain verify_stealth_deposit → commitment insertion
 *
 * Requires:
 *   - solana-test-validator (port 8899, programs deployed)
 *   - bitcoind regtest Docker (port 18443)
 *   - Esplora proxy (port 3002)
 *   - Header relayer (syncing blocks to Solana)
 *
 * Run: TEST_MODE=local bun test tests/07-real-deposit-verify.test.ts --timeout 300000
 */

import { describe, it, expect, beforeAll } from "bun:test";
import {
  createTestContext,
  pollUntil,
  type TestContext,
  IS_LOCAL,
  ESPLORA_URL,
  SOLANA_RPC_URL,
} from "./setup";
import {
  bitcoinRpc,
  bootstrapRegtest,
  isRegtestAvailable,
  mineBlocks,
} from "./regtest";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

// =============================================================================
// Constants
// =============================================================================

const DEPOSIT_AMOUNT_BTC = 0.0001; // 10,000 sats
const DEPOSIT_AMOUNT_SATS = 10_000;

// BTC light client program ID (localnet)
const BTC_LIGHT_CLIENT_PROGRAM_ID = new PublicKey(
  "DjZLbYWW7xp1xeHbRtAjUi4jxMThsykC9srXgB1NiMFx"
);

// =============================================================================
// Helpers
// =============================================================================

/** Hex string to Uint8Array */
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.substring(i, i + 2), 16);
  }
  return bytes;
}

/** Uint8Array to hex string */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Strip segwit witness data from a raw transaction to get non-witness serialization.
 * This is required because Bitcoin txid = double_sha256(non-witness serialization).
 *
 * Segwit format: version(4) + 0x00 0x01 + inputs + outputs + witness + locktime(4)
 * Non-witness:   version(4) + inputs + outputs + locktime(4)
 */
function stripSegwitWitness(rawTxHex: string): Uint8Array {
  const raw = hexToBytes(rawTxHex);

  // Check for segwit marker (byte 4 = 0x00, byte 5 = 0x01)
  if (raw[4] !== 0x00 || raw[5] !== 0x01) {
    // Not segwit — return as-is
    return raw;
  }

  // Parse segwit transaction to strip marker/flag and witness
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  let offset = 0;

  // Version (4 bytes)
  const version = raw.slice(0, 4);
  offset = 4;

  // Skip marker (0x00) and flag (0x01)
  offset += 2;

  // Parse varint for input count
  const { value: inputCount, bytesRead: inputCountBytes } = readVarInt(
    raw,
    offset
  );
  const inputsStart = offset;

  // Skip all inputs
  offset += inputCountBytes;
  for (let i = 0; i < inputCount; i++) {
    offset += 32; // prev txid
    offset += 4; // prev vout
    const { value: scriptLen, bytesRead } = readVarInt(raw, offset);
    offset += bytesRead;
    offset += scriptLen; // scriptSig
    offset += 4; // sequence
  }

  // Parse varint for output count
  const { value: outputCount, bytesRead: outputCountBytes } = readVarInt(
    raw,
    offset
  );

  // Skip all outputs
  offset += outputCountBytes;
  for (let i = 0; i < outputCount; i++) {
    offset += 8; // value
    const { value: scriptLen, bytesRead } = readVarInt(raw, offset);
    offset += bytesRead;
    offset += scriptLen; // scriptPubKey
  }

  // Everything from inputsStart to here is the inputs+outputs section
  const inputsAndOutputs = raw.slice(inputsStart, offset);

  // Skip witness data (offset is now at witness section)
  // Locktime is the last 4 bytes of the raw tx
  const locktime = raw.slice(raw.length - 4);

  // Build non-witness serialization: version + inputs + outputs + locktime
  const result = new Uint8Array(4 + inputsAndOutputs.length + 4);
  result.set(version, 0);
  result.set(inputsAndOutputs, 4);
  result.set(locktime, 4 + inputsAndOutputs.length);

  return result;
}

/** Read a Bitcoin varint from buffer at offset */
function readVarInt(
  buf: Uint8Array,
  offset: number
): { value: number; bytesRead: number } {
  const first = buf[offset];
  if (first < 0xfd) {
    return { value: first, bytesRead: 1 };
  } else if (first === 0xfd) {
    const value = buf[offset + 1] | (buf[offset + 2] << 8);
    return { value, bytesRead: 3 };
  } else if (first === 0xfe) {
    const value =
      buf[offset + 1] |
      (buf[offset + 2] << 8) |
      (buf[offset + 3] << 16) |
      (buf[offset + 4] << 24);
    return { value: value >>> 0, bytesRead: 5 };
  } else {
    // 0xff — 8-byte value, but txs won't have this many inputs
    throw new Error("VarInt too large");
  }
}

/**
 * Build on-chain merkle proof format.
 *
 * On-chain layout:
 *   txid(32) + path_bits(u32 LE) + path_len(u8) + tx_index(u32 LE) + siblings(N*32)
 *
 * path_bits: bitmask where bit i = 0 means current hash is left child at level i
 *            This equals tx_index for standard Bitcoin merkle trees.
 * siblings: in internal byte order (reversed from display order).
 */
function buildOnChainMerkleProof(
  txidBytes: Uint8Array,
  siblings: Uint8Array[],
  txIndex: number
): Uint8Array {
  const pathLen = siblings.length;
  const totalSize = 32 + 4 + 1 + 4 + pathLen * 32;
  const data = new Uint8Array(totalSize);
  const view = new DataView(data.buffer);
  let offset = 0;

  // txid (32 bytes) — internal byte order
  data.set(txidBytes, offset);
  offset += 32;

  // path_bits (u32 LE) — equals tx_index
  view.setUint32(offset, txIndex, true);
  offset += 4;

  // path_len (u8)
  data[offset] = pathLen;
  offset += 1;

  // tx_index (u32 LE)
  view.setUint32(offset, txIndex, true);
  offset += 4;

  // siblings (N * 32 bytes) — internal byte order
  for (const sibling of siblings) {
    data.set(sibling, offset);
    offset += 32;
  }

  return data;
}

/**
 * Build verify_stealth_deposit instruction data.
 *
 * Layout: disc(1) + header(116) + merkle_proof(variable)
 *
 * Header (116 bytes):
 *   txid(32) + block_height(u64 LE) + amount_sats(u64 LE) + tx_size(u32 LE)
 *   + ephemeral_pub(32) + npk(32)
 */
function buildVerifyStealthDepositIxData(params: {
  txid: Uint8Array; // 32 bytes, reversed (internal byte order)
  blockHeight: number;
  amountSats: number;
  txSize: number;
  ephemeralPub: Uint8Array; // 32 bytes
  npk: Uint8Array; // 32 bytes
  merkleProofData: Uint8Array; // on-chain format
}): Uint8Array {
  const headerSize = 116;
  const totalSize = 1 + headerSize + params.merkleProofData.length;
  const data = new Uint8Array(totalSize);
  const view = new DataView(data.buffer);
  let offset = 0;

  // Discriminator = 1 (verify_stealth_deposit)
  data[offset] = 1;
  offset += 1;

  // txid (32 bytes)
  data.set(params.txid, offset);
  offset += 32;

  // block_height (u64 LE)
  view.setBigUint64(offset, BigInt(params.blockHeight), true);
  offset += 8;

  // amount_sats (u64 LE)
  view.setBigUint64(offset, BigInt(params.amountSats), true);
  offset += 8;

  // tx_size (u32 LE)
  view.setUint32(offset, params.txSize, true);
  offset += 4;

  // ephemeral_pub (32 bytes)
  data.set(params.ephemeralPub, offset);
  offset += 32;

  // npk (32 bytes)
  data.set(params.npk, offset);
  offset += 32;

  // merkle proof data (variable)
  data.set(params.merkleProofData, offset);

  return data;
}

/**
 * Create a BTC transaction with OP_RETURN using bitcoind's raw transaction API.
 * Returns the txid (display order) and raw hex.
 */
async function createDepositTx(
  taprootAddr: string,
  amountBtc: number,
  opReturnHex: string
): Promise<{ txid: string; rawHex: string }> {
  // Get a UTXO to spend from
  const utxos = await bitcoinRpc<any[]>("listunspent", [1, 9999999]);
  if (!utxos || utxos.length === 0) {
    throw new Error("No UTXOs available in wallet");
  }

  // Create raw tx: one output to taproot addr, one OP_RETURN
  const inputs = [{ txid: utxos[0].txid, vout: utxos[0].vout }];
  const outputs: Record<string, any>[] = [
    { [taprootAddr]: amountBtc },
    { data: opReturnHex },
  ];

  const rawTxUnfunded: string = await bitcoinRpc("createrawtransaction", [
    inputs,
    outputs,
  ]);

  // Fund the transaction (adds change output and sets proper fee)
  const funded = await bitcoinRpc<{ hex: string }>("fundrawtransaction", [
    rawTxUnfunded,
    { changePosition: 2 },
  ]);

  // Sign the transaction
  const signed = await bitcoinRpc<{ hex: string; complete: boolean }>(
    "signrawtransactionwithwallet",
    [funded.hex]
  );
  if (!signed.complete) {
    throw new Error("Transaction signing incomplete");
  }

  // Send the transaction
  const txid = await bitcoinRpc<string>("sendrawtransaction", [signed.hex]);

  return { txid, rawHex: signed.hex };
}

/**
 * Derive light client PDA using correct seed "btc_light_client"
 */
function deriveLightClientPda(
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("btc_light_client")],
    programId
  );
}

/**
 * Derive block header PDA (hash-based)
 * Seeds: ["block", blockHash(32)]
 */
function deriveBlockHeaderPda(
  programId: PublicKey,
  blockHash: Uint8Array
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("block"), Buffer.from(blockHash)],
    programId
  );
}

/**
 * Derive height index PDA
 * Seeds: ["height_index", height_le(8)]
 */
function deriveHeightIndexPda(
  programId: PublicKey,
  height: number
): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(height));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("height_index"), buf],
    programId
  );
}

/**
 * Compute block hash from raw header (double SHA256)
 */
async function computeBlockHash(rawHeader: Uint8Array): Promise<Uint8Array> {
  const { createHash } = await import("crypto");
  const h1 = createHash("sha256").update(rawHeader).digest();
  const h2 = createHash("sha256").update(h1).digest();
  return new Uint8Array(h2);
}

/**
 * Derive deposit record PDA
 */
function deriveDepositRecordPda(
  programId: PublicKey,
  txid: Uint8Array
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("deposit"), Buffer.from(txid)],
    programId
  );
}

/**
 * Read light client tip height from on-chain account
 */
async function getLightClientTipHeight(
  connection: Connection
): Promise<number> {
  const [lcPda] = deriveLightClientPda(BTC_LIGHT_CLIENT_PROGRAM_ID);
  const info = await connection.getAccountInfo(lcPda);
  if (!info || !info.data) return 0;

  // tip_height is at offset: 1+1+1+1+4 + 32+32+32+32 = 136 bytes
  // (discriminator(1) + bump(1) + paused(1) + network(1) + padding(4) + authority(32) + genesis_hash(32) + tip_hash(32) + total_chainwork(32))
  // then tip_height is 8 bytes LE
  const tipOffset = 1 + 1 + 1 + 1 + 4 + 32 + 32 + 32 + 32;
  const tipHeight = info.data.readBigUInt64LE(tipOffset);
  return Number(tipHeight);
}

// =============================================================================
// Direct header submission to btc-light-client program
// =============================================================================

/**
 * Read the light client's current tip hash (internal byte order)
 */
async function getLightClientTipHash(
  connection: Connection
): Promise<Uint8Array> {
  const [lcPda] = deriveLightClientPda(BTC_LIGHT_CLIENT_PROGRAM_ID);
  const info = await connection.getAccountInfo(lcPda);
  if (!info || !info.data) return new Uint8Array(32);
  // tip_hash is at offset 72 (after disc:1 + bump:1 + paused:1 + network:1 + padding:4 + authority:32 = 40, then genesis_hash:32 = 72)
  return new Uint8Array(info.data.slice(72, 104));
}

/**
 * Submit block headers directly to the btc-light-client program via extend_blockchain.
 * Sends batches of 2+ headers at a time.
 */
async function submitBlockHeaders(
  connection: Connection,
  payer: Keypair,
  fromHeight: number,
  toHeight: number
): Promise<void> {
  const [lightClientPda] = deriveLightClientPda(BTC_LIGHT_CLIENT_PROGRAM_ID);
  const BATCH_SIZE = 5;

  let height = fromHeight;
  while (height <= toHeight) {
    // Get parent block hash (on-chain tip hash)
    const parentHash = await getLightClientTipHash(connection);

    // Collect batch of raw headers
    const rawHeaders: Uint8Array[] = [];
    const batchEnd = Math.min(height + BATCH_SIZE - 1, toHeight);
    // Need at least 2 headers for extend_blockchain
    const effectiveEnd = Math.max(batchEnd, height + 1);

    for (let h = height; h <= effectiveEnd && h <= toHeight + 1; h++) {
      // If we'd go past toHeight, we still need at least 2 to submit
      if (h > toHeight && rawHeaders.length >= 2) break;
      const bHash = await bitcoinRpc<string>("getblockhash", [h]);
      const rawHeaderHex = await bitcoinRpc<string>("getblockheader", [bHash, false]);
      rawHeaders.push(hexToBytes(rawHeaderHex));
    }

    if (rawHeaders.length < 2) {
      // Can't submit fewer than 2 headers; submit individually would require
      // mining another block. For tests, mine one more block.
      console.log(`  Only ${rawHeaders.length} header available, need 2+ for batch. Mining extra block...`);
      await mineBlocks(1);
      const bHash = await bitcoinRpc<string>("getblockhash", [toHeight + 1]);
      const rawHeaderHex = await bitcoinRpc<string>("getblockheader", [bHash, false]);
      rawHeaders.push(hexToBytes(rawHeaderHex));
    }

    const n = rawHeaders.length;
    const parentHeight = BigInt(height - 1);

    // Build extend_blockchain instruction
    // Format: disc(1) + num_headers(1) + N*80 bytes
    const ixData = Buffer.alloc(1 + 1 + n * 80);
    ixData.writeUInt8(1, 0); // EXTEND_BLOCKCHAIN discriminator
    ixData.writeUInt8(n, 1);
    for (let i = 0; i < n; i++) {
      Buffer.from(rawHeaders[i]).copy(ixData, 2 + i * 80);
    }

    // Derive parent BlockHeader PDA
    const [parentPda] = deriveBlockHeaderPda(BTC_LIGHT_CLIENT_PROGRAM_ID, parentHash);

    // Derive BlockHeader + HeightIndex PDAs
    const keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [
      { pubkey: lightClientPda, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: parentPda, isSigner: false, isWritable: false },
    ];

    // Add BlockHeader PDAs
    for (let i = 0; i < n; i++) {
      const hash = await computeBlockHash(rawHeaders[i]);
      const [bhPda] = deriveBlockHeaderPda(BTC_LIGHT_CLIENT_PROGRAM_ID, hash);
      keys.push({ pubkey: bhPda, isSigner: false, isWritable: true });
    }

    // Add HeightIndex PDAs
    for (let i = 0; i < n; i++) {
      const h = height + i;
      const [hiPda] = deriveHeightIndexPda(BTC_LIGHT_CLIENT_PROGRAM_ID, h);
      keys.push({ pubkey: hiPda, isSigner: false, isWritable: true });
    }

    const ix = new TransactionInstruction({
      programId: BTC_LIGHT_CLIENT_PROGRAM_ID,
      keys,
      data: ixData,
    });

    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([payer]);

    try {
      const sig = await connection.sendTransaction(tx);
      await connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        "confirmed"
      );
      console.log(`  Submitted batch ${height}-${height + n - 1}: ${sig}`);
    } catch (err: any) {
      console.error(`  Failed to submit batch at ${height}: ${err.message}`);
      if (err.transactionLogs) {
        console.error(`  Logs: ${JSON.stringify(err.transactionLogs)}`);
      }
      throw err;
    }

    if (height % 5 === 0 || height === toHeight) {
      console.log(`  Submitted header ${height}/${toHeight}`);
    }
  }
}

// =============================================================================
// ChadBuffer upload using @solana/web3.js (legacy, simpler for tests)
// =============================================================================

const CHADBUFFER_PROGRAM_ID = new PublicKey(
  "6VrJmWbhN9WbEkg87JizunVMpL6CHKGVmzWCf3o3LRgy"
);

/**
 * Upload raw tx data to a ChadBuffer account.
 * Returns the buffer public key.
 */
async function uploadToChadBufferSimple(
  connection: Connection,
  payer: import("@solana/web3.js").Keypair,
  rawTxData: Uint8Array
): Promise<PublicKey> {
  const { Keypair: SolKeypair } = await import("@solana/web3.js");
  const bufferKeypair = SolKeypair.generate();
  const space = 32 + rawTxData.length; // authority(32) + data

  const rentExemption =
    await connection.getMinimumBalanceForRentExemption(space);

  // Step 1: Create account
  const createIx = SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: bufferKeypair.publicKey,
    lamports: rentExemption,
    space,
    programId: CHADBUFFER_PROGRAM_ID,
  });

  {
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [createIx],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([payer, bufferKeypair]);
    const sig = await connection.sendTransaction(tx);
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed"
    );
  }

  // Step 2: ChadBuffer Init with first chunk (max ~1056 bytes per tx)
  const MAX_CHUNK = 900;
  const firstChunk = rawTxData.slice(0, MAX_CHUNK);

  // Init instruction: disc(1) = 0 + data
  const initData = new Uint8Array(1 + firstChunk.length);
  initData[0] = 0; // Create discriminator
  initData.set(firstChunk, 1);

  const initIx = new TransactionInstruction({
    programId: CHADBUFFER_PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: bufferKeypair.publicKey, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(initData),
  });

  {
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [initIx],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([payer]);
    const sig = await connection.sendTransaction(tx);
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed"
    );
  }

  // Step 3: Write remaining chunks
  let offset = firstChunk.length;
  while (offset < rawTxData.length) {
    const chunk = rawTxData.slice(offset, offset + MAX_CHUNK);

    // Write instruction: disc(1) = 2 + u24_offset(3) + data
    const writeData = new Uint8Array(1 + 3 + chunk.length);
    writeData[0] = 2; // Write discriminator
    writeData[1] = offset & 0xff;
    writeData[2] = (offset >> 8) & 0xff;
    writeData[3] = (offset >> 16) & 0xff;
    writeData.set(chunk, 4);

    const writeIx = new TransactionInstruction({
      programId: CHADBUFFER_PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: bufferKeypair.publicKey, isSigner: false, isWritable: true },
      ],
      data: Buffer.from(writeData),
    });

    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [writeIx],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([payer]);
    const sig = await connection.sendTransaction(tx);
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed"
    );
    offset += chunk.length;
  }

  console.log(
    `  ChadBuffer uploaded: ${bufferKeypair.publicKey.toBase58()} (${rawTxData.length} bytes)`
  );
  return bufferKeypair.publicKey;
}

// =============================================================================
// Test Suite
// =============================================================================

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

describe("Real E2E Deposit Verification", () => {
  // Shared state across test steps
  let depositAddress: string;
  let depositTxid: string;
  let depositRawHex: string;
  let npk: Uint8Array;
  let ephemeralPub: Uint8Array;
  let blockHeight: number;
  let zvaultProgramId: PublicKey;

  it("0. prerequisites — regtest and localnet available", async () => {
    if (!IS_LOCAL) {
      console.log("  Skipping — requires TEST_MODE=local");
      return;
    }

    const regtestReady = await isRegtestAvailable();
    expect(regtestReady).toBe(true);
    await bootstrapRegtest();

    // Check Solana validator
    const connection = new Connection(SOLANA_RPC_URL, "confirmed");
    const slot = await connection.getSlot();
    expect(slot).toBeGreaterThan(0);
    console.log(`  Regtest OK, Solana slot: ${slot}`);

    // Check light client exists
    const tipHeight = await getLightClientTipHeight(connection);
    console.log(`  Light client tip height: ${tipHeight}`);
    expect(tipHeight).toBeGreaterThan(0);
  });

  it("1. generate deposit address with npk + OP_RETURN", async () => {
    if (!IS_LOCAL) return;

    const {
      createNonInteractiveDeposit,
      deriveKeysFromSeed,
      createStealthMetaAddress,
      initPoseidon,
    } = await import("@zvault/sdk");
    await initPoseidon();

    // Generate keys from random seed
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const keys = deriveKeysFromSeed(seed);
    const meta = createStealthMetaAddress(keys);

    const groupPubKeyHex = ctx.groupPubKey || ctx.config.groupPubKey;
    expect(groupPubKeyHex).toBeTruthy();
    expect(groupPubKeyHex).not.toBe("0".repeat(64));

    const groupPubKey = hexToBytes(groupPubKeyHex);
    const deposit = await createNonInteractiveDeposit(
      meta,
      groupPubKey,
      "regtest"
    );

    depositAddress = deposit.btcAddress;
    npk = deposit.npk;
    ephemeralPub = deposit.ephemeralPub;

    expect(depositAddress).toMatch(/^bcrt1p/);
    expect(npk.length).toBe(32);
    expect(ephemeralPub.length).toBe(32);

    console.log(`  Deposit address: ${depositAddress}`);
    console.log(`  NPK: ${bytesToHex(npk).slice(0, 16)}...`);
    console.log(`  Ephemeral: ${bytesToHex(ephemeralPub).slice(0, 16)}...`);
  });

  it("2. create BTC transaction with OP_RETURN and mine", async () => {
    if (!IS_LOCAL || !depositAddress) return;

    // Build OP_RETURN payload: ephemeralPub(32) + npk(32) = 64 bytes
    const opReturnHex = bytesToHex(ephemeralPub) + bytesToHex(npk);
    expect(opReturnHex.length).toBe(128); // 64 bytes * 2

    const result = await createDepositTx(
      depositAddress,
      DEPOSIT_AMOUNT_BTC,
      opReturnHex
    );
    depositTxid = result.txid;
    depositRawHex = result.rawHex;

    console.log(`  Deposit txid: ${depositTxid}`);
    console.log(`  Raw tx hex length: ${depositRawHex.length}`);

    // Mine blocks so the header relayer can pick them up
    const blockHashes = await mineBlocks(6);
    console.log(`  Mined 6 blocks, last: ${blockHashes[blockHashes.length - 1]}`);

    // Fetch the block height of our transaction
    const txStatus = await (
      await fetch(`${ESPLORA_URL}/tx/${depositTxid}/status`)
    ).json();
    expect(txStatus.confirmed).toBe(true);
    blockHeight = txStatus.block_height;
    console.log(`  Tx confirmed at block height: ${blockHeight}`);
  });

  it("3. submit block headers directly to btc-light-client", async () => {
    if (!IS_LOCAL || !depositTxid) return;

    const connection = new Connection(SOLANA_RPC_URL, "confirmed");

    // Get current light client tip
    const currentTip = await getLightClientTipHeight(connection);
    console.log(`  Current light client tip: ${currentTip}`);
    console.log(`  Need to reach block: ${blockHeight}`);

    // Submit missing headers directly (faster than waiting for relayer)
    if (currentTip < blockHeight) {
      const fromHeight = currentTip + 1;
      console.log(`  Submitting headers ${fromHeight} → ${blockHeight}...`);
      await submitBlockHeaders(connection, ctx.payer, fromHeight, blockHeight);
    }

    // Verify tip is now at or above our block
    const newTip = await getLightClientTipHeight(connection);
    expect(newTip).toBeGreaterThanOrEqual(blockHeight);
    console.log(`  Light client tip: ${newTip}`);

    // Verify the HeightIndex PDA exists at this height
    const [heightIndexPda] = deriveHeightIndexPda(
      BTC_LIGHT_CLIENT_PROGRAM_ID,
      blockHeight
    );
    const hiInfo = await connection.getAccountInfo(heightIndexPda);
    expect(hiInfo).not.toBeNull();
    console.log(`  HeightIndex PDA exists: ${heightIndexPda.toBase58()}`);
  });

  it("4. upload non-witness tx to ChadBuffer and verify deposit on-chain", async () => {
    if (!IS_LOCAL || !depositTxid) return;

    const connection = new Connection(SOLANA_RPC_URL, "confirmed");
    zvaultProgramId = new PublicKey(ctx.config.zvaultProgramId);

    // ---- Fetch raw tx and strip witness data ----
    const rawTxHex = await (
      await fetch(`${ESPLORA_URL}/tx/${depositTxid}/hex`)
    ).text();
    const nonWitnessTx = stripSegwitWitness(rawTxHex);
    console.log(
      `  Raw tx: ${rawTxHex.length / 2} bytes, non-witness: ${nonWitnessTx.length} bytes`
    );

    // Verify: double_sha256(non-witness) should match txid (reversed)
    const { createHash } = await import("crypto");
    const hash1 = createHash("sha256").update(nonWitnessTx).digest();
    const hash2 = createHash("sha256").update(hash1).digest();
    const computedTxid = bytesToHex(new Uint8Array(hash2).reverse());
    expect(computedTxid).toBe(depositTxid);
    console.log(`  Txid verification: OK`);

    // ---- Upload to ChadBuffer ----
    const bufferPubkey = await uploadToChadBufferSimple(
      connection,
      ctx.payer,
      nonWitnessTx
    );

    // ---- Fetch merkle proof from Esplora proxy ----
    const merkleResp = await (
      await fetch(`${ESPLORA_URL}/tx/${depositTxid}/merkle-proof`)
    ).json();
    const { merkle: siblingHexes, pos: txIndex } = merkleResp as {
      merkle: string[];
      pos: number;
      block_height: number;
    };
    console.log(
      `  Merkle proof: ${siblingHexes.length} siblings, tx_index: ${txIndex}`
    );

    // Convert siblings from display order hex to internal byte order
    const siblings = siblingHexes.map((hex: string) => {
      const bytes = hexToBytes(hex);
      bytes.reverse(); // display → internal byte order
      return bytes;
    });

    // Build txid in internal byte order (reversed from display)
    // On-chain compares compute_tx_hash(raw_tx) directly with ix_data.txid
    const txidInternal = hexToBytes(depositTxid);
    txidInternal.reverse();

    // ---- Build on-chain merkle proof ----
    const merkleProofData = buildOnChainMerkleProof(
      txidInternal,
      siblings,
      txIndex
    );

    // ---- Build verify_stealth_deposit instruction ----
    const ixData = buildVerifyStealthDepositIxData({
      txid: txidInternal,
      blockHeight,
      amountSats: DEPOSIT_AMOUNT_SATS,
      txSize: nonWitnessTx.length,
      ephemeralPub,
      npk,
      merkleProofData,
    });

    // ---- Derive all 11 account PDAs ----
    const poolStatePda = new PublicKey(ctx.config.poolStatePda);
    const [lightClientPda] = deriveLightClientPda(BTC_LIGHT_CLIENT_PROGRAM_ID);

    // Get block hash for this height from HeightIndex PDA
    const [hiPda] = deriveHeightIndexPda(BTC_LIGHT_CLIENT_PROGRAM_ID, blockHeight);
    const hiAccount = await connection.getAccountInfo(hiPda);
    if (!hiAccount) throw new Error(`HeightIndex not found at height ${blockHeight}`);
    // HeightIndex layout: disc(1) + bump(1) + padding(6) + block_hash(32) + height(8) = 48
    const blockHashFromHi = new Uint8Array(hiAccount.data.slice(8, 40));

    const [blockHeaderPda] = deriveBlockHeaderPda(
      BTC_LIGHT_CLIENT_PROGRAM_ID,
      blockHashFromHi
    );
    const commitmentTreePda = new PublicKey(ctx.config.commitmentTreePda);
    const [depositRecordPda] = deriveDepositRecordPda(
      zvaultProgramId,
      txidInternal
    );
    const zbtcMint = new PublicKey(ctx.config.zbtcMint);
    const poolVault = new PublicKey(ctx.config.poolVault);
    const TOKEN_2022_PROGRAM = new PublicKey(
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
    );

    console.log(`  Pool state: ${poolStatePda.toBase58()}`);
    console.log(`  Light client: ${lightClientPda.toBase58()}`);
    console.log(`  Block header: ${blockHeaderPda.toBase58()}`);
    console.log(`  Commitment tree: ${commitmentTreePda.toBase58()}`);
    console.log(`  Deposit record: ${depositRecordPda.toBase58()}`);
    console.log(`  ChadBuffer: ${bufferPubkey.toBase58()}`);

    // ---- Build and send transaction ----
    const ix = new TransactionInstruction({
      programId: zvaultProgramId,
      keys: [
        { pubkey: poolStatePda, isSigner: false, isWritable: true },
        { pubkey: lightClientPda, isSigner: false, isWritable: false },
        { pubkey: blockHeaderPda, isSigner: false, isWritable: false },
        { pubkey: commitmentTreePda, isSigner: false, isWritable: true },
        { pubkey: depositRecordPda, isSigner: false, isWritable: true },
        { pubkey: bufferPubkey, isSigner: false, isWritable: false },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: zbtcMint, isSigner: false, isWritable: true },
        { pubkey: poolVault, isSigner: false, isWritable: true },
        { pubkey: TOKEN_2022_PROGRAM, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(ixData),
    });

    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: ctx.payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([ctx.payer]);

    console.log(`  Sending verify_stealth_deposit tx...`);
    const sig = await connection.sendTransaction(tx, {
      skipPreflight: false,
    });
    console.log(`  Tx signature: ${sig}`);

    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed"
    );
    console.log(`  Transaction confirmed!`);

    // ---- Verify: deposit record PDA exists ----
    const depositInfo = await connection.getAccountInfo(depositRecordPda);
    expect(depositInfo).not.toBeNull();
    expect(depositInfo!.data.length).toBeGreaterThanOrEqual(200);
    console.log(
      `  Deposit record created: ${depositRecordPda.toBase58()} (${depositInfo!.data.length} bytes)`
    );

    // Verify deposit record fields
    const drData = depositInfo!.data;
    // discriminator should be 0x02
    expect(drData[0]).toBe(0x02);
    // minted should be 1
    expect(drData[1]).toBe(1);
    // commitment starts at offset 8 (disc:1 + minted:1 + padding:6)
    const commitmentBytes = drData.slice(8, 40);
    expect(commitmentBytes.some((b: number) => b !== 0)).toBe(true);
    console.log(
      `  Commitment: ${bytesToHex(new Uint8Array(commitmentBytes)).slice(0, 16)}...`
    );

    // npk starts at offset 168 (based on struct layout)
    const storedNpk = drData.slice(168, 200);
    expect(Buffer.from(storedNpk)).toEqual(Buffer.from(npk));
    console.log(`  Stored NPK matches: OK`);

    console.log(`\n  === DEPOSIT VERIFICATION COMPLETE ===`);
    console.log(`  Txid: ${depositTxid}`);
    console.log(`  Block: ${blockHeight}`);
    console.log(`  Amount: ${DEPOSIT_AMOUNT_SATS} sats`);
    console.log(`  Deposit PDA: ${depositRecordPda.toBase58()}`);
  });
});
