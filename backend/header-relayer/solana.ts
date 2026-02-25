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
// PDA seeds (must match the btc-light-client Pinocchio program)
const LIGHT_CLIENT_SEED = Buffer.from('btc_light_client');
const BLOCK_SEED = Buffer.from('block_header');

// Account discriminator for BitcoinLightClient (Pinocchio: single byte, not Anchor SHA256)
const BTC_LIGHT_CLIENT_DISCRIMINATOR: number = 0x06;

// Instruction discriminators (Pinocchio: single byte)
const INITIALIZE_DISC: number = 0;
const SUBMIT_HEADER_DISC: number = 1;
const RESET_TIP_DISC: number = 2;

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
 * LightClientState structure (Pinocchio layout: 232 bytes)
 *
 * Offsets:
 *   0: discriminator (u8 = 0x06)
 *   1: bump (u8)
 *   2: paused (u8)
 *   3: network (u8)
 *   4-7: _padding (4 bytes)
 *   8-39: authority (32 bytes)
 *  40-71: genesis_hash (32 bytes)
 *  72-103: tip_hash (32 bytes)
 * 104-135: total_chainwork (32 bytes)
 * 136-143: tip_height (u64 LE)
 * 144-151: finalized_height (u64 LE)
 * 152-159: header_count (u64 LE)
 * 160-167: last_update (i64 LE)
 * 168-231: _reserved (64 bytes)
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
  // Byte 0: discriminator (already verified)
  const bump = data.readUInt8(1);
  const paused = data.readUInt8(2) !== 0;
  const network = data.readUInt8(3);
  // 4-7: padding
  const authority = new Uint8Array(data.subarray(8, 40));
  const genesisHash = new Uint8Array(data.subarray(40, 72));
  const tipHash = new Uint8Array(data.subarray(72, 104));
  // 104-135: total_chainwork (skip)
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

  // Verify discriminator (single byte for Pinocchio)
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
  // Instruction data: discriminator (1) + start_height (8) + start_block_hash (32) + network (1) = 42 bytes
  const data = Buffer.alloc(1 + 8 + 32 + 1);

  // Write discriminator (single byte for Pinocchio)
  data.writeUInt8(INITIALIZE_DISC, 0);

  // Write start_height (u64 LE)
  data.writeBigUInt64LE(startHeight, 1);

  // Write start_block_hash (32 bytes)
  Buffer.from(startBlockHash).copy(data, 9);

  // Write network (u8)
  data.writeUInt8(network, 41);

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
  // Instruction data: discriminator (1) + raw_header (80) + height (8) = 89 bytes
  const data = Buffer.alloc(1 + 80 + 8);

  // Write discriminator (single byte for Pinocchio)
  data.writeUInt8(SUBMIT_HEADER_DISC, 0);

  // Write raw_header (80 bytes)
  Buffer.from(rawHeader).copy(data, 1);

  // Write height (u64 LE)
  data.writeBigUInt64LE(height, 81);

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
 * Build reset_tip instruction
 */
export function buildResetTipInstruction(
  programId: PublicKey,
  lightClientPda: PublicKey,
  authority: PublicKey,
  newTipHeight: bigint,
  newTipHash: Uint8Array
): TransactionInstruction {
  // Instruction data: discriminator (1) + new_tip_height (8) + new_tip_hash (32) = 41 bytes
  const data = Buffer.alloc(1 + 8 + 32);

  data.writeUInt8(RESET_TIP_DISC, 0);
  data.writeBigUInt64LE(newTipHeight, 1);
  Buffer.from(newTipHash).copy(data, 9);

  return new TransactionInstruction({
    keys: [
      { pubkey: lightClientPda, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    programId,
    data,
  });
}

/**
 * Reset the light client tip to a new block hash and height
 */
export async function resetTip(
  connection: Connection,
  programId: PublicKey,
  authority: Keypair,
  newTipHeight: bigint,
  newTipHash: Uint8Array
): Promise<string> {
  const [lightClientPda] = deriveLightClientPda(programId);

  const instruction = buildResetTipInstruction(
    programId,
    lightClientPda,
    authority.publicKey,
    newTipHeight,
    newTipHash
  );

  const transaction = new Transaction().add(instruction);

  const signature = await sendAndConfirmTransaction(connection, transaction, [
    authority,
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
