#!/usr/bin/env bun
/**
 * Redemption Lifecycle Integration Test (Bitcoin regtest)
 *
 * Tests the full escrow-based redemption lifecycle on localnet:
 *   Test 1: Happy path — request → mark_processing → complete (real SPV via regtest)
 *   Test 2: Cancel path — request → cancel (re-mints commitment)
 *   Test 3: Error — cancel after mark_processing (expect failure)
 *   Test 4: Error — mark_processing by non-authority (expect failure)
 *
 * Prerequisites:
 *   1. bun run setup:localnet (starts validator + Docker regtest + deploys)
 *   2. bun run scripts/test-redemption-lifecycle.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  createOpReturnTx,
  mineBlocks,
  getNewAddress,
  waitForTxIndexed,
  fetchBlockHeader,
  fetchMerkleProof,
  fetchRawTx,
  fetchTxStatus,
  serializeMerkleProof,
  stripWitnessData,
} from "./regtest-helpers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// Configuration
// =============================================================================

const NETWORK = process.env.NETWORK || "localnet";
const RPC_URL = process.env.RPC_URL || (NETWORK === "devnet" ? "https://api.devnet.solana.com" : "http://127.0.0.1:8899");

interface LocalnetConfig {
  programs: {
    zVault: string;
    btcLightClient: string;
    chadbuffer: string;
  };
  accounts: {
    poolState: string;
    commitmentTree: string;
    zkbtcMint: string;
    poolVault: string;
    authority: string;
  };
  btcLightClient: {
    pda: string;
    startHeight: string;
    startHash: string;
  };
}

function loadConfig(): LocalnetConfig {
  const configFile = NETWORK === "devnet" ? ".devnet-config.json" : ".localnet-config.json";
  const configPath = path.join(__dirname, "..", configFile);
  return JSON.parse(fs.readFileSync(configPath, "utf-8"));
}

const config = loadConfig();
const PROGRAM_ID = new PublicKey(config.programs.zVault);
const BTC_LIGHT_CLIENT_ID = new PublicKey(config.programs.btcLightClient);
const CHADBUFFER_ID = new PublicKey(config.programs.chadbuffer);

// =============================================================================
// Constants
// =============================================================================

// Instruction discriminators (must match lib.rs)
const Disc = {
  MARK_PROCESSING: 2,
  CANCEL_REDEMPTION: 3,
  REQUEST_REDEMPTION: 5,
  COMPLETE_REDEMPTION: 6,
} as const;

// BTC Relay discriminators
const BTCRelayDisc = {
  SUBMIT_HEADER: 1,
} as const;

// Account discriminators
const AccDisc = {
  POOL_STATE: 0x01,
  REDEMPTION_REQUEST: 0x04,
  COMMITMENT_TREE: 0x05,
} as const;

// PDA seeds
const Seeds = {
  POOL_STATE: "pool_state",
  COMMITMENT_TREE: "commitment_tree",
  NULLIFIER: "nullifier",
  REDEMPTION: "redemption",
  BTC_LIGHT_CLIENT: "btc_light_client",
  BLOCK_HEADER: "block_header",
};

// ChadBuffer header size (authority pubkey)
const BUFFER_HEADER_SIZE = 32;

// =============================================================================
// Types
// =============================================================================

interface TestResult {
  name: string;
  passed: boolean;
  message: string;
}

interface PoolSnapshot {
  totalShielded: bigint;
  pendingRedemptions: bigint;
  totalBurned: bigint;
  totalMinted: bigint;
}

interface RedemptionSnapshot {
  status: number;
  requester: PublicKey;
  amountSats: bigint;
  btcAddressLen: number;
}

// =============================================================================
// PDA Derivations
// =============================================================================

function derivePoolStatePDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(Seeds.POOL_STATE)],
    PROGRAM_ID
  );
}

function deriveCommitmentTreePDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(Seeds.COMMITMENT_TREE)],
    PROGRAM_ID
  );
}

function deriveNullifierPDA(nullifierHash: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(Seeds.NULLIFIER), Buffer.from(nullifierHash)],
    PROGRAM_ID
  );
}

function deriveRedemptionPDA(
  user: PublicKey,
  nonce: bigint
): [PublicKey, number] {
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(nonce);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(Seeds.REDEMPTION), user.toBuffer(), nonceBuf],
    PROGRAM_ID
  );
}

function deriveLightClientPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(Seeds.BTC_LIGHT_CLIENT)],
    BTC_LIGHT_CLIENT_ID
  );
}

function deriveBlockHeaderPDA(height: bigint): [PublicKey, number] {
  const heightBuf = Buffer.alloc(8);
  heightBuf.writeBigUInt64LE(height);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(Seeds.BLOCK_HEADER), heightBuf],
    BTC_LIGHT_CLIENT_ID
  );
}

// =============================================================================
// Account Parsers
// =============================================================================

function parsePoolState(data: Buffer): PoolSnapshot | null {
  if (data.length < 268 || data[0] !== AccDisc.POOL_STATE) return null;
  return {
    totalMinted: data.readBigUInt64LE(140),
    totalBurned: data.readBigUInt64LE(148),
    pendingRedemptions: data.readBigUInt64LE(156),
    totalShielded: data.readBigUInt64LE(188),
  };
}

function parseRedemptionRequest(data: Buffer): RedemptionSnapshot | null {
  if (data.length < 118 || data[0] !== AccDisc.REDEMPTION_REQUEST) return null;
  return {
    status: data[1],
    requester: new PublicKey(data.subarray(16, 48)),
    amountSats: data.readBigUInt64LE(48),
    btcAddressLen: data[2],
  };
}

function parseCommitmentTreeNextIndex(data: Buffer): bigint | null {
  if (data.length < 48 || data[0] !== AccDisc.COMMITMENT_TREE) return null;
  return data.readBigUInt64LE(40);
}

// =============================================================================
// Instruction Builders
// =============================================================================

/**
 * request_redemption (disc=5)
 * Accounts: pool_state(w), commitment_tree(r), nullifier_record(w), redemption_request(w), user(s,w), system_program
 * Data: disc(1) + proof_hash(32) + merkle_root(32) + nullifier_hash(32) + amount(8)
 *       + vk_hash(32) + btc_addr_len(1) + btc_addr(var) + nonce(8)
 */
function buildRequestRedemptionIx(
  poolState: PublicKey,
  commitmentTree: PublicKey,
  nullifierRecord: PublicKey,
  redemptionRequest: PublicKey,
  user: PublicKey,
  params: {
    proofHash: Uint8Array;
    merkleRoot: Uint8Array;
    nullifierHash: Uint8Array;
    amountSats: bigint;
    vkHash: Uint8Array;
    btcAddress: string;
    nonce: bigint;
  }
): TransactionInstruction {
  const btcAddrBytes = Buffer.from(params.btcAddress, "utf-8");
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(params.nonce);

  // Layout: disc(1) + proof_hash(32) + merkle_root(32) + nullifier_hash(32) + amount(8) + vk_hash(32) + addr_len(1) + addr(var) + nonce(8)
  const dataLen = 1 + 32 + 32 + 32 + 8 + 32 + 1 + btcAddrBytes.length + 8;
  const data = Buffer.alloc(dataLen);
  let off = 0;

  data[off++] = Disc.REQUEST_REDEMPTION;
  Buffer.from(params.proofHash).copy(data, off);
  off += 32;
  Buffer.from(params.merkleRoot).copy(data, off);
  off += 32;
  Buffer.from(params.nullifierHash).copy(data, off);
  off += 32;
  data.writeBigUInt64LE(params.amountSats, off);
  off += 8;
  Buffer.from(params.vkHash).copy(data, off);
  off += 32;
  data[off++] = btcAddrBytes.length;
  btcAddrBytes.copy(data, off);
  off += btcAddrBytes.length;
  nonceBuf.copy(data, off);

  return new TransactionInstruction({
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: commitmentTree, isSigner: false, isWritable: false },
      { pubkey: nullifierRecord, isSigner: false, isWritable: true },
      { pubkey: redemptionRequest, isSigner: false, isWritable: true },
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

/**
 * mark_processing (disc=2)
 * Accounts: pool_state(w), redemption_request(w), authority(s)
 * Data: disc(1) only
 */
function buildMarkProcessingIx(
  poolState: PublicKey,
  redemptionRequest: PublicKey,
  authority: PublicKey
): TransactionInstruction {
  return new TransactionInstruction({
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: redemptionRequest, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data: Buffer.from([Disc.MARK_PROCESSING]),
  });
}

/**
 * cancel_redemption (disc=3)
 * Accounts: user(s), pool_state(w), redemption_request(w), commitment_tree(w), system_program
 * Data: disc(1) + npk(32)
 */
function buildCancelRedemptionIx(
  user: PublicKey,
  poolState: PublicKey,
  redemptionRequest: PublicKey,
  commitmentTree: PublicKey,
  npk: Uint8Array
): TransactionInstruction {
  const data = Buffer.alloc(33);
  data[0] = Disc.CANCEL_REDEMPTION;
  Buffer.from(npk).copy(data, 1);

  return new TransactionInstruction({
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: redemptionRequest, isSigner: false, isWritable: true },
      { pubkey: commitmentTree, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

/**
 * submit_header (btc-relay disc=1)
 * Accounts: light_client(w), block_header_pda(w), submitter(s,w), system_program
 * Data: disc(1) + raw_header(80) + block_height(8)
 */
function buildSubmitHeaderIx(
  lightClient: PublicKey,
  blockHeaderPda: PublicKey,
  submitter: PublicKey,
  rawHeader: Uint8Array,
  blockHeight: bigint
): TransactionInstruction {
  const data = Buffer.alloc(89);
  data[0] = BTCRelayDisc.SUBMIT_HEADER;
  Buffer.from(rawHeader).copy(data, 1);
  data.writeBigUInt64LE(blockHeight, 81);

  return new TransactionInstruction({
    keys: [
      { pubkey: lightClient, isSigner: false, isWritable: true },
      { pubkey: blockHeaderPda, isSigner: false, isWritable: true },
      { pubkey: submitter, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: BTC_LIGHT_CLIENT_ID,
    data,
  });
}

/**
 * complete_redemption (disc=6)
 * Accounts: pool_state(w), redemption_request(w), authority(s), rent_recipient(w),
 *           light_client(r), block_header(r), tx_buffer(r), zbtc_mint(w), pool_vault(w), token_2022
 * Data: disc(1) + btc_txid(32) + block_height(8) + tx_size(4) + TxMerkleProof
 *
 * TxMerkleProof for single-tx block: txid(32) + path_bits(4) + path_len(1) + tx_index(4)
 */
function buildCompleteRedemptionIx(
  poolState: PublicKey,
  redemptionRequest: PublicKey,
  authority: PublicKey,
  rentRecipient: PublicKey,
  lightClient: PublicKey,
  blockHeader: PublicKey,
  txBuffer: PublicKey,
  zbtcMint: PublicKey,
  poolVault: PublicKey,
  params: {
    btcTxid: Uint8Array;
    blockHeight: bigint;
    txSize: number;
    merkleProofData: Buffer; // Pre-serialized merkle proof
  }
): TransactionInstruction {
  const merkleProof = params.merkleProofData;
  const dataLen = 1 + 32 + 8 + 4 + merkleProof.length;
  const data = Buffer.alloc(dataLen);
  let off = 0;

  data[off++] = Disc.COMPLETE_REDEMPTION;
  Buffer.from(params.btcTxid).copy(data, off);
  off += 32;
  data.writeBigUInt64LE(params.blockHeight, off);
  off += 8;
  data.writeUInt32LE(params.txSize, off);
  off += 4;

  merkleProof.copy(data, off);

  return new TransactionInstruction({
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: redemptionRequest, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: rentRecipient, isSigner: false, isWritable: true },
      { pubkey: lightClient, isSigner: false, isWritable: false },
      { pubkey: blockHeader, isSigner: false, isWritable: false },
      { pubkey: txBuffer, isSigner: false, isWritable: false },
      { pubkey: zbtcMint, isSigner: false, isWritable: true },
      { pubkey: poolVault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

// =============================================================================
// Helpers
// =============================================================================

async function ensureFunded(
  connection: Connection,
  pubkey: PublicKey,
  amount = 2 * LAMPORTS_PER_SOL
) {
  const balance = await connection.getBalance(pubkey);
  if (balance < LAMPORTS_PER_SOL) {
    const sig = await connection.requestAirdrop(pubkey, amount);
    await connection.confirmTransaction(sig);
  }
}

async function sendTx(
  connection: Connection,
  ixs: TransactionInstruction | TransactionInstruction[],
  signers: Keypair[]
): Promise<string> {
  const tx = new Transaction();
  if (Array.isArray(ixs)) {
    for (const ix of ixs) tx.add(ix);
  } else {
    tx.add(ixs);
  }
  return await sendAndConfirmTransaction(connection, tx, signers, {
    commitment: "confirmed",
  });
}

async function getPoolSnapshot(
  connection: Connection
): Promise<PoolSnapshot | null> {
  const [poolState] = derivePoolStatePDA();
  const info = await connection.getAccountInfo(poolState);
  if (!info) return null;
  return parsePoolState(Buffer.from(info.data));
}

async function getRedemptionSnapshot(
  connection: Connection,
  pda: PublicKey
): Promise<RedemptionSnapshot | null> {
  const info = await connection.getAccountInfo(pda);
  if (!info) return null;
  return parseRedemptionRequest(Buffer.from(info.data));
}

async function getCommitmentTreeNextIndex(
  connection: Connection
): Promise<bigint | null> {
  const [tree] = deriveCommitmentTreePDA();
  const info = await connection.getAccountInfo(tree);
  if (!info) return null;
  return parseCommitmentTreeNextIndex(Buffer.from(info.data));
}

async function getMerkleRoot(connection: Connection): Promise<Buffer | null> {
  const [tree] = deriveCommitmentTreePDA();
  const info = await connection.getAccountInfo(tree);
  if (!info) return null;
  // current_root at offset 8, 32 bytes
  return Buffer.from(info.data.subarray(8, 40));
}

/**
 * Upload raw tx data to a ChadBuffer account.
 *
 * ChadBuffer layout: authority(32 bytes) + raw_data
 * Instructions:
 *   - Create: SystemProgram.createAccount with owner = ChadBuffer program
 *   - Init (disc=0): disc(1) + first_chunk — sets authority to payer, writes initial data
 *   - Write (disc=2): disc(1) + offset_u24(3) + chunk — appends data at offset
 */
async function createTxBufferAccount(
  connection: Connection,
  payer: Keypair,
  rawTx: Uint8Array
): Promise<Keypair> {
  const bufferKeypair = Keypair.generate();
  const space = BUFFER_HEADER_SIZE + rawTx.length;
  const lamports = await connection.getMinimumBalanceForRentExemption(space);

  // Step 1: Create account owned by ChadBuffer
  const createIx = SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: bufferKeypair.publicKey,
    lamports,
    space,
    programId: CHADBUFFER_ID,
  });
  await sendTx(connection, createIx, [payer, bufferKeypair]);

  // Step 2: Init with first chunk (disc=0)
  const MAX_CHUNK = 900;
  const firstChunk = rawTx.slice(0, MAX_CHUNK);

  const initData = new Uint8Array(1 + firstChunk.length);
  initData[0] = 0; // Init discriminator
  initData.set(firstChunk, 1);

  const initIx = new TransactionInstruction({
    programId: CHADBUFFER_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: bufferKeypair.publicKey, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(initData),
  });
  await sendTx(connection, initIx, [payer]);

  // Step 3: Write remaining chunks (disc=2)
  let offset = firstChunk.length;
  while (offset < rawTx.length) {
    const chunk = rawTx.slice(offset, offset + MAX_CHUNK);

    const writeData = new Uint8Array(1 + 3 + chunk.length);
    writeData[0] = 2; // Write discriminator
    writeData[1] = offset & 0xff;
    writeData[2] = (offset >> 8) & 0xff;
    writeData[3] = (offset >> 16) & 0xff;
    writeData.set(chunk, 4);

    const writeIx = new TransactionInstruction({
      programId: CHADBUFFER_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: bufferKeypair.publicKey, isSigner: false, isWritable: true },
      ],
      data: Buffer.from(writeData),
    });
    await sendTx(connection, writeIx, [payer]);
    offset += chunk.length;
  }

  return bufferKeypair;
}

/**
 * Generate random 32 bytes (for nullifier hash, proof hash, etc.)
 */
function randomBytes32(): Uint8Array {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytes;
}

// =============================================================================
// Test Cases
// =============================================================================

async function testHappyPath(
  connection: Connection,
  authority: Keypair
): Promise<TestResult> {
  const testName = "Test 1: Happy path — request → mark_processing → complete";

  try {
    const [poolState] = derivePoolStatePDA();
    const [commitmentTree] = deriveCommitmentTreePDA();
    const [lightClient] = deriveLightClientPDA();

    // ---- Snapshot before ----
    const poolBefore = await getPoolSnapshot(connection);
    if (!poolBefore) return { name: testName, passed: false, message: "Pool not initialized" };

    const merkleRoot = await getMerkleRoot(connection);
    if (!merkleRoot) return { name: testName, passed: false, message: "No merkle root" };

    // ---- Step 1: request_redemption ----
    const amountSats = 10_000n;
    const nonce = BigInt(Date.now());
    const nullifierHash = randomBytes32();
    const proofHash = randomBytes32();
    const vkHash = new Uint8Array(32); // all zeros = demo mode

    const [nullifierPda] = deriveNullifierPDA(nullifierHash);
    const [redemptionPda] = deriveRedemptionPDA(authority.publicKey, nonce);

    const requestIx = buildRequestRedemptionIx(
      poolState,
      commitmentTree,
      nullifierPda,
      redemptionPda,
      authority.publicKey,
      {
        proofHash,
        merkleRoot: new Uint8Array(merkleRoot),
        nullifierHash,
        amountSats,
        vkHash,
        btcAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
        nonce,
      }
    );

    await sendTx(connection, requestIx, [authority]);

    // Verify PDA created with status=Pending (0)
    const redemption1 = await getRedemptionSnapshot(connection, redemptionPda);
    if (!redemption1) return { name: testName, passed: false, message: "RedemptionRequest not created" };
    if (redemption1.status !== 0)
      return { name: testName, passed: false, message: `Expected status=0 (Pending), got ${redemption1.status}` };
    if (redemption1.amountSats !== amountSats)
      return { name: testName, passed: false, message: `Amount mismatch: ${redemption1.amountSats} vs ${amountSats}` };

    // Verify pool state updated
    const poolAfterRequest = await getPoolSnapshot(connection);
    if (!poolAfterRequest)
      return { name: testName, passed: false, message: "Pool state missing after request" };
    if (poolAfterRequest.pendingRedemptions !== poolBefore.pendingRedemptions + 1n)
      return { name: testName, passed: false, message: `pending_redemptions: ${poolAfterRequest.pendingRedemptions} vs expected ${poolBefore.pendingRedemptions + 1n}` };
    if (poolAfterRequest.totalShielded !== poolBefore.totalShielded - amountSats)
      return { name: testName, passed: false, message: `total_shielded: ${poolAfterRequest.totalShielded} vs expected ${poolBefore.totalShielded - amountSats}` };

    // ---- Step 2: mark_processing ----
    const markIx = buildMarkProcessingIx(poolState, redemptionPda, authority.publicKey);
    await sendTx(connection, markIx, [authority]);

    const redemption2 = await getRedemptionSnapshot(connection, redemptionPda);
    if (!redemption2) return { name: testName, passed: false, message: "RedemptionRequest missing after mark" };
    if (redemption2.status !== 1)
      return { name: testName, passed: false, message: `Expected status=1 (Processing), got ${redemption2.status}` };

    // ---- Step 3: SPV setup + complete_redemption (real regtest) ----
    const ESPLORA_URL = process.env.BITCOIN_API_URL || "http://localhost:3000/regtest/api";

    // Create a real BTC transaction on regtest
    const poolAddr = getNewAddress("bech32");
    const btcTxid = createOpReturnTx(poolAddr, Number(amountSats), "00".repeat(64));
    mineBlocks(1);
    await waitForTxIndexed(btcTxid, ESPLORA_URL);

    // Fetch tx status and block data
    const txStatusResult = await fetchTxStatus(btcTxid, ESPLORA_URL);
    if (!txStatusResult.confirmed || !txStatusResult.block_hash || !txStatusResult.block_height)
      return { name: testName, passed: false, message: "Regtest tx not confirmed" };

    // Fetch raw header and raw tx
    const rawHeader = await fetchBlockHeader(txStatusResult.block_hash, ESPLORA_URL);
    const rawTxBuf = await fetchRawTx(btcTxid, ESPLORA_URL);
    const strippedTx = stripWitnessData(rawTxBuf);

    // Compute txid in internal byte order
    const txidBytesInternal = Buffer.from(btcTxid, "hex");
    txidBytesInternal.reverse();
    const txid = new Uint8Array(txidBytesInternal);

    // Fetch merkle proof
    const esploraProof = await fetchMerkleProof(btcTxid, ESPLORA_URL);
    const merkleProofData = serializeMerkleProof(btcTxid, esploraProof);

    const newHeight = BigInt(txStatusResult.block_height);

    // Submit block header to btc-relay
    const [blockHeaderPda] = deriveBlockHeaderPDA(newHeight);
    const submitIx = buildSubmitHeaderIx(
      lightClient,
      blockHeaderPda,
      authority.publicKey,
      new Uint8Array(rawHeader),
      newHeight
    );
    await sendTx(connection, submitIx, [authority]);

    // Create tx buffer account with witness-stripped raw tx data
    const bufferKeypair = await createTxBufferAccount(
      connection,
      authority,
      new Uint8Array(strippedTx)
    );

    // Now complete the redemption
    const zkbtcMint = new PublicKey(config.accounts.zkbtcMint);
    const poolVault = new PublicKey(config.accounts.poolVault);

    const completeIx = buildCompleteRedemptionIx(
      poolState,
      redemptionPda,
      authority.publicKey,
      authority.publicKey, // rent_recipient
      lightClient,
      blockHeaderPda,
      bufferKeypair.publicKey,
      zkbtcMint,
      poolVault,
      {
        btcTxid: txid,
        blockHeight: newHeight,
        txSize: strippedTx.length,
        merkleProofData,
      }
    );

    await sendTx(connection, completeIx, [authority]);

    // Verify: PDA closed
    const redemption3 = await getRedemptionSnapshot(connection, redemptionPda);
    if (redemption3 !== null)
      return { name: testName, passed: false, message: "RedemptionRequest should be closed" };

    // Verify: pool state updated
    const poolAfterComplete = await getPoolSnapshot(connection);
    if (!poolAfterComplete)
      return { name: testName, passed: false, message: "Pool state missing after complete" };
    if (poolAfterComplete.totalBurned !== poolBefore.totalBurned + amountSats)
      return { name: testName, passed: false, message: `total_burned: ${poolAfterComplete.totalBurned} vs expected ${poolBefore.totalBurned + amountSats}` };
    if (poolAfterComplete.pendingRedemptions !== poolBefore.pendingRedemptions)
      return { name: testName, passed: false, message: `pending_redemptions not restored: ${poolAfterComplete.pendingRedemptions}` };

    return {
      name: testName,
      passed: true,
      message: `request→mark→complete OK. burned=${poolAfterComplete.totalBurned}, pending=${poolAfterComplete.pendingRedemptions}`,
    };
  } catch (err: any) {
    return { name: testName, passed: false, message: err.message?.slice(0, 300) || String(err) };
  }
}

async function testCancelPath(
  connection: Connection,
  authority: Keypair
): Promise<TestResult> {
  const testName = "Test 2: Cancel path — request → cancel (re-mints commitment)";

  try {
    const [poolState] = derivePoolStatePDA();
    const [commitmentTree] = deriveCommitmentTreePDA();

    const poolBefore = await getPoolSnapshot(connection);
    if (!poolBefore) return { name: testName, passed: false, message: "Pool not initialized" };

    const treeIndexBefore = await getCommitmentTreeNextIndex(connection);
    if (treeIndexBefore === null) return { name: testName, passed: false, message: "Tree not initialized" };

    const merkleRoot = await getMerkleRoot(connection);
    if (!merkleRoot) return { name: testName, passed: false, message: "No merkle root" };

    // ---- request_redemption ----
    const amountSats = 10_000n;
    const nonce = BigInt(Date.now()) + 100n; // different nonce
    const nullifierHash = randomBytes32();

    const [nullifierPda] = deriveNullifierPDA(nullifierHash);
    const [redemptionPda] = deriveRedemptionPDA(authority.publicKey, nonce);

    const requestIx = buildRequestRedemptionIx(
      poolState,
      commitmentTree,
      nullifierPda,
      redemptionPda,
      authority.publicKey,
      {
        proofHash: randomBytes32(),
        merkleRoot: new Uint8Array(merkleRoot),
        nullifierHash,
        amountSats,
        vkHash: new Uint8Array(32),
        btcAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
        nonce,
      }
    );
    await sendTx(connection, requestIx, [authority]);

    // ---- cancel_redemption ----
    const npk = randomBytes32(); // random npk for re-minted commitment

    const cancelIx = buildCancelRedemptionIx(
      authority.publicKey,
      poolState,
      redemptionPda,
      commitmentTree,
      npk
    );
    await sendTx(connection, cancelIx, [authority]);

    // Verify: PDA closed
    const redemption = await getRedemptionSnapshot(connection, redemptionPda);
    if (redemption !== null)
      return { name: testName, passed: false, message: "RedemptionRequest should be closed after cancel" };

    // Verify: pool total_shielded restored
    const poolAfter = await getPoolSnapshot(connection);
    if (!poolAfter) return { name: testName, passed: false, message: "Pool missing after cancel" };
    if (poolAfter.totalShielded !== poolBefore.totalShielded)
      return { name: testName, passed: false, message: `total_shielded not restored: ${poolAfter.totalShielded} vs ${poolBefore.totalShielded}` };
    if (poolAfter.pendingRedemptions !== poolBefore.pendingRedemptions)
      return { name: testName, passed: false, message: `pending_redemptions not restored: ${poolAfter.pendingRedemptions}` };

    // Verify: commitment tree nextIndex incremented (new commitment added)
    const treeIndexAfter = await getCommitmentTreeNextIndex(connection);
    if (treeIndexAfter !== treeIndexBefore + 1n)
      return { name: testName, passed: false, message: `Tree index: ${treeIndexAfter} vs expected ${treeIndexBefore + 1n}` };

    return {
      name: testName,
      passed: true,
      message: `cancel OK. shielded restored=${poolAfter.totalShielded}, tree index=${treeIndexAfter}`,
    };
  } catch (err: any) {
    return { name: testName, passed: false, message: err.message?.slice(0, 300) || String(err) };
  }
}

async function testCancelAfterProcessing(
  connection: Connection,
  authority: Keypair
): Promise<TestResult> {
  const testName = "Test 3: Error — cancel after mark_processing (expect 6031)";

  try {
    const [poolState] = derivePoolStatePDA();
    const [commitmentTree] = deriveCommitmentTreePDA();

    const merkleRoot = await getMerkleRoot(connection);
    if (!merkleRoot) return { name: testName, passed: false, message: "No merkle root" };

    // ---- request_redemption ----
    const amountSats = 10_000n;
    const nonce = BigInt(Date.now()) + 200n;
    const nullifierHash = randomBytes32();

    const [nullifierPda] = deriveNullifierPDA(nullifierHash);
    const [redemptionPda] = deriveRedemptionPDA(authority.publicKey, nonce);

    const requestIx = buildRequestRedemptionIx(
      poolState,
      commitmentTree,
      nullifierPda,
      redemptionPda,
      authority.publicKey,
      {
        proofHash: randomBytes32(),
        merkleRoot: new Uint8Array(merkleRoot),
        nullifierHash,
        amountSats,
        vkHash: new Uint8Array(32),
        btcAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
        nonce,
      }
    );
    await sendTx(connection, requestIx, [authority]);

    // ---- mark_processing ----
    const markIx = buildMarkProcessingIx(poolState, redemptionPda, authority.publicKey);
    await sendTx(connection, markIx, [authority]);

    // ---- cancel_redemption → should FAIL ----
    const cancelIx = buildCancelRedemptionIx(
      authority.publicKey,
      poolState,
      redemptionPda,
      commitmentTree,
      randomBytes32()
    );

    try {
      await sendTx(connection, cancelIx, [authority]);
      return { name: testName, passed: false, message: "Cancel should have failed but succeeded" };
    } catch (cancelErr: any) {
      const msg = cancelErr.message || "";
      // Error 6031 = RedemptionCancelNotAllowed (0x1797 hex = 6031)
      if (msg.includes("6031") || msg.includes("0x1797") || msg.includes("custom program error")) {
        return { name: testName, passed: true, message: "Correctly rejected cancel after mark_processing" };
      }
      return { name: testName, passed: true, message: `Rejected with: ${msg.slice(0, 100)}` };
    }
  } catch (err: any) {
    return { name: testName, passed: false, message: err.message?.slice(0, 300) || String(err) };
  }
}

/**
 * Test unauthorized mark_processing.
 * Creates its own Pending redemption, then tries mark_processing with wrong signer.
 */
async function testUnauthorizedMarkProcessing(
  connection: Connection,
  authority: Keypair,
  nonAuthority: Keypair
): Promise<TestResult> {
  const testName = "Test 3: Error — mark_processing by non-authority (expect 6011)";

  try {
    const [poolState] = derivePoolStatePDA();
    const [commitmentTree] = deriveCommitmentTreePDA();

    const merkleRoot = await getMerkleRoot(connection);
    if (!merkleRoot) return { name: testName, passed: false, message: "No merkle root" };

    // ---- request_redemption (creates a Pending PDA) ----
    const amountSats = 10_000n;
    const nonce = BigInt(Date.now()) + 300n;
    const nullifierHash = randomBytes32();

    const [nullifierPda] = deriveNullifierPDA(nullifierHash);
    const [redemptionPda] = deriveRedemptionPDA(authority.publicKey, nonce);

    const requestIx = buildRequestRedemptionIx(
      poolState,
      commitmentTree,
      nullifierPda,
      redemptionPda,
      authority.publicKey,
      {
        proofHash: randomBytes32(),
        merkleRoot: new Uint8Array(merkleRoot),
        nullifierHash,
        amountSats,
        vkHash: new Uint8Array(32),
        btcAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
        nonce,
      }
    );
    await sendTx(connection, requestIx, [authority]);

    // ---- mark_processing by nonAuthority → should FAIL ----
    const markIx = buildMarkProcessingIx(poolState, redemptionPda, nonAuthority.publicKey);

    try {
      await sendTx(connection, markIx, [nonAuthority]);
      return { name: testName, passed: false, message: "Should have rejected non-authority" };
    } catch (markErr: any) {
      const msg = markErr.message || "";
      // Error 6011 = Unauthorized (0x177B hex = 6011)
      if (msg.includes("6011") || msg.includes("0x177b") || msg.includes("custom program error")) {
        return { name: testName, passed: true, message: "Correctly rejected non-authority mark_processing" };
      }
      return { name: testName, passed: true, message: `Rejected with: ${msg.slice(0, 100)}` };
    }
  } catch (err: any) {
    return { name: testName, passed: false, message: err.message?.slice(0, 300) || String(err) };
  }
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log("============================================================");
  console.log("zVault Redemption Lifecycle Integration Test");
  console.log("============================================================");
  console.log(`RPC:         ${RPC_URL}`);
  console.log(`zVault:      ${PROGRAM_ID.toBase58()}`);
  console.log(`BTC Relay:   ${BTC_LIGHT_CLIENT_ID.toBase58()}`);

  const connection = new Connection(RPC_URL, "confirmed");

  // Load authority keypair
  let keypairPath = process.env.KEYPAIR || "";
  if (!keypairPath) {
    try {
      const { execSync } = await import("child_process");
      const out = execSync("solana config get", { encoding: "utf-8" });
      const match = out.match(/Keypair Path:\s*(.+)/);
      if (match) keypairPath = match[1].trim();
    } catch {}
  }
  if (!keypairPath) keypairPath = `${process.env.HOME}/.config/solana/id.json`;

  const authority = fs.existsSync(keypairPath)
    ? Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8")))
      )
    : Keypair.generate();

  const nonAuthority = Keypair.generate();

  console.log(`\nAuthority:   ${authority.publicKey.toBase58().slice(0, 20)}...`);
  console.log(`NonAuth:     ${nonAuthority.publicKey.toBase58().slice(0, 20)}...`);

  // Fund accounts
  console.log("\nFunding accounts...");
  await ensureFunded(connection, authority.publicKey, 10 * LAMPORTS_PER_SOL);
  await ensureFunded(connection, nonAuthority.publicKey);

  // Pre-flight: check pool is initialized and has shielded balance
  const poolCheck = await getPoolSnapshot(connection);
  if (!poolCheck) {
    console.error("\nError: Pool not initialized. Run deploy-localnet.ts first.");
    process.exit(1);
  }
  console.log(`\nPool state: shielded=${poolCheck.totalShielded}, pending=${poolCheck.pendingRedemptions}, burned=${poolCheck.totalBurned}`);

  if (poolCheck.totalShielded < 10_000n) {
    console.error(`\nError: Insufficient shielded balance (${poolCheck.totalShielded}). Need >= 10000.`);
    console.error("Re-run deploy-localnet.ts to add demo notes.");
    process.exit(1);
  }

  const results: TestResult[] = [];

  // Run cancel path first — it restores shielded balance, so later tests
  // still have funds even if the pool starts with only one demo note (10k sats).

  // ---- Test 1: Cancel path (net zero — balance restored) ----
  console.log(`\n${"=".repeat(60)}`);
  console.log("TEST 1: Cancel path (request → cancel)");
  console.log("=".repeat(60));
  results.push(await testCancelPath(connection, authority));

  // ---- Test 2: Error tests (leave redemptions locked, -10k each) ----
  console.log(`\n${"=".repeat(60)}`);
  console.log("TEST 2: Cancel after mark_processing (expect error)");
  console.log("=".repeat(60));
  results.push(await testCancelAfterProcessing(connection, authority));

  console.log(`\n${"=".repeat(60)}`);
  console.log("TEST 3: Unauthorized mark_processing (expect error)");
  console.log("=".repeat(60));
  results.push(await testUnauthorizedMarkProcessing(connection, authority, nonAuthority));

  // ---- Test 4: Happy path (burns -10k permanently) ----
  console.log(`\n${"=".repeat(60)}`);
  console.log("TEST 4: Happy path (request → mark → complete)");
  console.log("=".repeat(60));
  results.push(await testHappyPath(connection, authority));

  // ---- Results ----
  console.log(`\n${"=".repeat(60)}`);
  console.log("RESULTS");
  console.log("=".repeat(60));

  let passed = 0;
  let failed = 0;

  for (const r of results) {
    const icon = r.passed ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(`${icon} ${r.name}`);
    console.log(`    ${r.message}`);
    if (r.passed) passed++;
    else failed++;
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Summary: ${passed} passed, ${failed} failed, ${results.length} total`);
  console.log("=".repeat(60));

  // Final pool state
  const poolFinal = await getPoolSnapshot(connection);
  if (poolFinal) {
    console.log(`\nFinal pool: shielded=${poolFinal.totalShielded}, pending=${poolFinal.pendingRedemptions}, burned=${poolFinal.totalBurned}`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
