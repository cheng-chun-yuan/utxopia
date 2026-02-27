/**
 * Solana submission client for Bitcoin block headers
 *
 * Hash-based PDAs, batch header submission via extend_blockchain.
 */

import {
  Connection,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { createHash } from 'crypto';

// PDA seeds (must match the btc-light-client Pinocchio program)
const LIGHT_CLIENT_SEED = Buffer.from('btc_light_client');
const BLOCK_SEED = Buffer.from('block');
const HEIGHT_INDEX_SEED = Buffer.from('height_index');

// Account discriminators
const BTC_LIGHT_CLIENT_DISCRIMINATOR: number = 0x06;
const BLOCK_HEADER_DISCRIMINATOR = 0x07;
const HEIGHT_INDEX_DISCRIMINATOR = 0x09;

// Instruction discriminators
const INITIALIZE_DISC: number = 0;
const EXTEND_BLOCKCHAIN_DISC: number = 1;
const VERIFY_TRANSACTION_DISC: number = 2;
const REINITIALIZE_DISC: number = 4;

/**
 * Derive the light client PDA
 */
export function deriveLightClientPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([LIGHT_CLIENT_SEED], programId);
}

/**
 * Derive block header PDA for a specific block hash
 * Seeds: ["block", block_hash(32)]
 */
export function deriveBlockHeaderPda(
  programId: PublicKey,
  blockHash: Uint8Array
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [BLOCK_SEED, Buffer.from(blockHash)],
    programId
  );
}

/**
 * Derive HeightIndex PDA for a specific height
 * Seeds: ["height_index", height_le(8)]
 */
export function deriveHeightIndexPda(
  programId: PublicKey,
  height: bigint
): [PublicKey, number] {
  const heightBuffer = Buffer.alloc(8);
  heightBuffer.writeBigUInt64LE(height);
  return PublicKey.findProgramAddressSync(
    [HEIGHT_INDEX_SEED, heightBuffer],
    programId
  );
}

/**
 * Compute double SHA-256 of raw block header (80 bytes) → block hash
 */
export function computeBlockHash(rawHeader: Uint8Array): Uint8Array {
  const first = createHash('sha256').update(rawHeader).digest();
  const second = createHash('sha256').update(first).digest();
  return new Uint8Array(second);
}

/**
 * LightClientState structure (Pinocchio layout: 232 bytes)
 */
export interface LightClientState {
  bump: number;
  paused: boolean;
  network: number;
  authority: Uint8Array;
  genesisHash: Uint8Array;
  tipHash: Uint8Array;
  tipHeight: bigint;
  finalizedHeight: bigint;
  headerCount: bigint;
  lastUpdate: bigint;
}

/**
 * Parse LightClientState account data
 */
export function parseLightClientState(data: Buffer): LightClientState {
  const bump = data.readUInt8(1);
  const paused = data.readUInt8(2) !== 0;
  const network = data.readUInt8(3);
  const authority = new Uint8Array(data.subarray(8, 40));
  const genesisHash = new Uint8Array(data.subarray(40, 72));
  const tipHash = new Uint8Array(data.subarray(72, 104));
  const tipHeight = data.readBigUInt64LE(136);
  const finalizedHeight = data.readBigUInt64LE(144);
  const headerCount = data.readBigUInt64LE(152);
  const lastUpdate = data.readBigInt64LE(160);

  return {
    bump,
    paused,
    network,
    authority,
    genesisHash,
    tipHash,
    tipHeight,
    finalizedHeight,
    headerCount,
    lastUpdate,
  };
}

/**
 * Get on-chain light client state
 */
export async function getLightClientState(
  connection: Connection,
  programId: PublicKey
): Promise<LightClientState | null> {
  const [lightClientPda] = deriveLightClientPda(programId);

  const accountInfo = await connection.getAccountInfo(lightClientPda);
  if (!accountInfo) {
    return null;
  }

  if (accountInfo.data[0] !== BTC_LIGHT_CLIENT_DISCRIMINATOR) {
    throw new Error(`Invalid light client account discriminator: expected 0x${BTC_LIGHT_CLIENT_DISCRIMINATOR.toString(16)}, got 0x${accountInfo.data[0].toString(16)}`);
  }

  return parseLightClientState(accountInfo.data);
}

/**
 * Get the on-chain tip height (returns startBlockHeight - 1 if not initialized)
 */
export async function getLightClientTipHeight(
  connection: Connection,
  programId: PublicKey,
  startBlockHeight: bigint
): Promise<bigint> {
  const state = await getLightClientState(connection, programId);
  if (!state) {
    return startBlockHeight - 1n;
  }
  return state.tipHeight;
}

/**
 * Get the block hash from a HeightIndex PDA at a given height
 */
export async function getBlockHashAtHeight(
  connection: Connection,
  programId: PublicKey,
  height: bigint
): Promise<Uint8Array | null> {
  const [heightIndexPda] = deriveHeightIndexPda(programId, height);
  const accountInfo = await connection.getAccountInfo(heightIndexPda);
  if (!accountInfo) return null;
  if (accountInfo.data[0] !== HEIGHT_INDEX_DISCRIMINATOR) return null;
  // HeightIndex layout: disc(1) + bump(1) + padding(6) + block_hash(32) + height(8)
  return new Uint8Array(accountInfo.data.subarray(8, 40));
}

/**
 * Build initialize instruction
 *
 * Accounts:
 *   0. [writable] BitcoinLightClient PDA
 *   1. [signer, writable] Payer
 *   2. [] System program
 *   3. [writable] HeightIndex PDA
 *   4. [writable] BlockHeader PDA
 */
export function buildInitializeInstruction(
  programId: PublicKey,
  lightClientPda: PublicKey,
  payer: PublicKey,
  startHeight: bigint,
  startBlockHash: Uint8Array,
  network: number
): TransactionInstruction {
  const data = Buffer.alloc(1 + 8 + 32 + 1);
  data.writeUInt8(INITIALIZE_DISC, 0);
  data.writeBigUInt64LE(startHeight, 1);
  Buffer.from(startBlockHash).copy(data, 9);
  data.writeUInt8(network, 41);

  const [heightIndexPda] = deriveHeightIndexPda(programId, startHeight);
  const [blockHeaderPda] = deriveBlockHeaderPda(programId, startBlockHash);

  return new TransactionInstruction({
    keys: [
      { pubkey: lightClientPda, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: heightIndexPda, isSigner: false, isWritable: true },
      { pubkey: blockHeaderPda, isSigner: false, isWritable: true },
    ],
    programId,
    data,
  });
}

/**
 * Initialize the light client
 */
export async function initializeLightClient(
  connection: Connection,
  programId: PublicKey,
  payer: Keypair,
  startHeight: bigint,
  startBlockHash: Uint8Array,
  network: number
): Promise<string> {
  const [lightClientPda] = deriveLightClientPda(programId);

  const instruction = buildInitializeInstruction(
    programId,
    lightClientPda,
    payer.publicKey,
    startHeight,
    startBlockHash,
    network
  );

  const transaction = new Transaction().add(instruction);
  return await sendAndConfirmTransaction(connection, transaction, [payer]);
}

/**
 * Build extend_blockchain instruction
 *
 * Instruction data:
 *   [0]            disc (1)
 *   [1]            num_headers (u8)
 *   [2..2+N*80]    raw_headers (N × 80 bytes)
 *
 * Accounts:
 *   0. [writable]           BitcoinLightClient PDA
 *   1. [signer, writable]   Submitter
 *   2. []                   System program
 *   3. []                   Parent BlockHeader PDA
 *   4..4+N-1   [writable]   BlockHeader PDAs
 *   4+N..4+2N-1 [writable]  HeightIndex PDAs
 */
export function buildExtendBlockchainInstruction(
  programId: PublicKey,
  lightClientPda: PublicKey,
  submitter: PublicKey,
  parentBlockHash: Uint8Array,
  rawHeaders: Uint8Array[],
  parentHeight: bigint,
): TransactionInstruction {
  const n = rawHeaders.length;
  if (n < 2 || n > 10) {
    throw new Error(`Batch size must be 2-10, got ${n}`);
  }

  // Build instruction data: disc(1) + num_headers(1) + N*80 bytes
  const data = Buffer.alloc(1 + 1 + n * 80);
  data.writeUInt8(EXTEND_BLOCKCHAIN_DISC, 0);
  data.writeUInt8(n, 1);
  for (let i = 0; i < n; i++) {
    Buffer.from(rawHeaders[i]).copy(data, 2 + i * 80);
  }

  // Derive parent BlockHeader PDA
  const [parentPda] = deriveBlockHeaderPda(programId, parentBlockHash);

  // Derive BlockHeader + HeightIndex PDAs for each new header
  const blockHeaderKeys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
  const heightIndexKeys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];

  for (let i = 0; i < n; i++) {
    const hash = computeBlockHash(rawHeaders[i]);
    const height = parentHeight + BigInt(i + 1);

    const [bhPda] = deriveBlockHeaderPda(programId, hash);
    blockHeaderKeys.push({ pubkey: bhPda, isSigner: false, isWritable: true });

    const [hiPda] = deriveHeightIndexPda(programId, height);
    heightIndexKeys.push({ pubkey: hiPda, isSigner: false, isWritable: true });
  }

  return new TransactionInstruction({
    keys: [
      { pubkey: lightClientPda, isSigner: false, isWritable: true },
      { pubkey: submitter, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: parentPda, isSigner: false, isWritable: false },
      ...blockHeaderKeys,
      ...heightIndexKeys,
    ],
    programId,
    data,
  });
}

/**
 * Submit a batch of headers via extend_blockchain
 */
export async function extendBlockchain(
  connection: Connection,
  programId: PublicKey,
  submitter: Keypair,
  parentBlockHash: Uint8Array,
  rawHeaders: Uint8Array[],
  parentHeight: bigint,
): Promise<string> {
  const [lightClientPda] = deriveLightClientPda(programId);

  const instruction = buildExtendBlockchainInstruction(
    programId,
    lightClientPda,
    submitter.publicKey,
    parentBlockHash,
    rawHeaders,
    parentHeight,
  );

  // Each header creates 2 PDAs (BlockHeader + HeightIndex), so request more CUs
  const cuLimit = ComputeBudgetProgram.setComputeUnitLimit({
    units: 400_000,
  });
  const transaction = new Transaction().add(cuLimit, instruction);
  return await sendAndConfirmTransaction(connection, transaction, [submitter]);
}

/**
 * Build verify_transaction instruction (disc=2)
 *
 * Instruction data:
 *   [0]      disc
 *   [1-32]   txid (32)
 *   [33-64]  block_hash (32)
 *   [65-68]  tx_size (u32 LE)
 *   [69+]    merkle_proof
 */
export function buildVerifyTransactionInstruction(
  programId: PublicKey,
  verifiedTxPda: PublicKey,
  lightClientPda: PublicKey,
  blockHeaderPda: PublicKey,
  txBufferAccount: PublicKey,
  payer: PublicKey,
  txid: Uint8Array,
  blockHash: Uint8Array,
  txSize: number,
  merkleProofTxid: Uint8Array,
  pathBits: number,
  pathLen: number,
  txIndex: number,
  siblings: Uint8Array[],
): TransactionInstruction {
  const proofDataLen = 32 + 4 + 1 + 4 + (siblings.length * 32);
  const data = Buffer.alloc(1 + 32 + 32 + 4 + proofDataLen);
  let offset = 0;

  // Discriminator
  data.writeUInt8(VERIFY_TRANSACTION_DISC, offset);
  offset += 1;

  // txid (32)
  Buffer.from(txid).copy(data, offset);
  offset += 32;

  // block_hash (32)
  Buffer.from(blockHash).copy(data, offset);
  offset += 32;

  // tx_size (u32 LE)
  data.writeUInt32LE(txSize, offset);
  offset += 4;

  // Merkle proof: txid(32)
  Buffer.from(merkleProofTxid).copy(data, offset);
  offset += 32;

  // path_bits (u32 LE)
  data.writeUInt32LE(pathBits, offset);
  offset += 4;

  // path_len (u8)
  data.writeUInt8(pathLen, offset);
  offset += 1;

  // tx_index (u32 LE)
  data.writeUInt32LE(txIndex, offset);
  offset += 4;

  // siblings
  for (const sibling of siblings) {
    Buffer.from(sibling).copy(data, offset);
    offset += 32;
  }

  return new TransactionInstruction({
    keys: [
      { pubkey: verifiedTxPda, isSigner: false, isWritable: true },
      { pubkey: lightClientPda, isSigner: false, isWritable: false },
      { pubkey: blockHeaderPda, isSigner: false, isWritable: false },
      { pubkey: txBufferAccount, isSigner: false, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

// PDA seed for VerifiedTransaction
const VERIFIED_TX_SEED = Buffer.from('verified_tx');

/**
 * Derive VerifiedTransaction PDA
 * Seeds: ["verified_tx", blockHash(32), txid(32)]
 */
export function deriveVerifiedTransactionPda(
  programId: PublicKey,
  blockHash: Uint8Array,
  txid: Uint8Array
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [VERIFIED_TX_SEED, Buffer.from(blockHash), Buffer.from(txid)],
    programId
  );
}

/**
 * Helper to convert hex string to Uint8Array
 */
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Helper to convert Uint8Array to hex string
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
