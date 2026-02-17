/**
 * Solana submission client for Bitcoin block headers
 *
 * Uses the btc-light-client program for simple, transparent header relay.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { createHash } from 'crypto';

// PDA seeds (must match the btc-light-client program)
const LIGHT_CLIENT_SEED = Buffer.from('light_client');
const BLOCK_SEED = Buffer.from('block');

// Account discriminator for LightClientState
const LIGHT_CLIENT_DISCRIMINATOR = createHash('sha256')
  .update('account:LightClientState')
  .digest()
  .subarray(0, 8);

// Instruction discriminators
const INITIALIZE_DISCRIMINATOR = createHash('sha256')
  .update('global:initialize')
  .digest()
  .subarray(0, 8);

const SUBMIT_HEADER_DISCRIMINATOR = createHash('sha256')
  .update('global:submit_header')
  .digest()
  .subarray(0, 8);

/**
 * Derive the light client PDA
 */
export function deriveLightClientPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([LIGHT_CLIENT_SEED], programId);
}

/**
 * Derive block header PDA for a specific height
 */
export function deriveBlockHeaderPda(
  programId: PublicKey,
  height: bigint
): [PublicKey, number] {
  const heightBuffer = Buffer.alloc(8);
  heightBuffer.writeBigUInt64LE(height);
  return PublicKey.findProgramAddressSync(
    [BLOCK_SEED, heightBuffer],
    programId
  );
}

/**
 * LightClientState structure
 */
export interface LightClientState {
  bump: number;
  tipHeight: bigint;
  tipHash: Uint8Array;
  startHeight: bigint;
  startHash: Uint8Array;
  finalizedHeight: bigint;
  headerCount: bigint;
  lastUpdate: bigint;
  network: number;
}

/**
 * Parse LightClientState account data
 */
export function parseLightClientState(data: Buffer): LightClientState {
  // Skip discriminator (8 bytes)
  let offset = 8;

  const bump = data.readUInt8(offset);
  offset += 1;

  const tipHeight = data.readBigUInt64LE(offset);
  offset += 8;

  const tipHash = new Uint8Array(data.subarray(offset, offset + 32));
  offset += 32;

  const startHeight = data.readBigUInt64LE(offset);
  offset += 8;

  const startHash = new Uint8Array(data.subarray(offset, offset + 32));
  offset += 32;

  const finalizedHeight = data.readBigUInt64LE(offset);
  offset += 8;

  const headerCount = data.readBigUInt64LE(offset);
  offset += 8;

  const lastUpdate = data.readBigInt64LE(offset);
  offset += 8;

  const network = data.readUInt8(offset);

  return {
    bump,
    tipHeight,
    tipHash,
    startHeight,
    startHash,
    finalizedHeight,
    headerCount,
    lastUpdate,
    network,
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

  // Verify discriminator
  const discriminator = accountInfo.data.subarray(0, 8);
  if (!discriminator.equals(LIGHT_CLIENT_DISCRIMINATOR)) {
    throw new Error('Invalid light client account discriminator');
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
 * Check if a block header already exists on-chain
 */
export async function blockHeaderExists(
  connection: Connection,
  programId: PublicKey,
  height: bigint
): Promise<boolean> {
  const [blockHeaderPda] = deriveBlockHeaderPda(programId, height);
  const accountInfo = await connection.getAccountInfo(blockHeaderPda);
  return accountInfo !== null;
}

/**
 * Build initialize instruction
 */
export function buildInitializeInstruction(
  programId: PublicKey,
  lightClientPda: PublicKey,
  payer: PublicKey,
  startHeight: bigint,
  startBlockHash: Uint8Array,
  network: number
): TransactionInstruction {
  // Instruction data: discriminator (8) + start_height (8) + start_block_hash (32) + network (1)
  const data = Buffer.alloc(8 + 8 + 32 + 1);

  // Write discriminator
  INITIALIZE_DISCRIMINATOR.copy(data, 0);

  // Write start_height (u64 LE)
  data.writeBigUInt64LE(startHeight, 8);

  // Write start_block_hash (32 bytes)
  Buffer.from(startBlockHash).copy(data, 16);

  // Write network (u8)
  data.writeUInt8(network, 48);

  return new TransactionInstruction({
    keys: [
      { pubkey: lightClientPda, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

/**
 * Build submit_header instruction
 */
export function buildSubmitHeaderInstruction(
  programId: PublicKey,
  lightClientPda: PublicKey,
  blockHeaderPda: PublicKey,
  submitter: PublicKey,
  rawHeader: Uint8Array,
  height: bigint
): TransactionInstruction {
  // Instruction data: discriminator (8) + raw_header (80) + height (8)
  const data = Buffer.alloc(8 + 80 + 8);

  // Write discriminator
  SUBMIT_HEADER_DISCRIMINATOR.copy(data, 0);

  // Write raw_header (80 bytes)
  Buffer.from(rawHeader).copy(data, 8);

  // Write height (u64 LE)
  data.writeBigUInt64LE(height, 88);

  return new TransactionInstruction({
    keys: [
      { pubkey: lightClientPda, isSigner: false, isWritable: true },
      { pubkey: blockHeaderPda, isSigner: false, isWritable: true },
      { pubkey: submitter, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
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

  const signature = await sendAndConfirmTransaction(connection, transaction, [
    payer,
  ]);

  return signature;
}

/**
 * Submit a Bitcoin block header to Solana
 */
export async function submitHeader(
  connection: Connection,
  programId: PublicKey,
  submitter: Keypair,
  rawHeader: Uint8Array,
  height: bigint
): Promise<string> {
  const [lightClientPda] = deriveLightClientPda(programId);
  const [blockHeaderPda] = deriveBlockHeaderPda(programId, height);

  const instruction = buildSubmitHeaderInstruction(
    programId,
    lightClientPda,
    blockHeaderPda,
    submitter.publicKey,
    rawHeader,
    height
  );

  const transaction = new Transaction().add(instruction);

  const signature = await sendAndConfirmTransaction(connection, transaction, [
    submitter,
  ]);

  return signature;
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
