/**
 * Shared Test Helpers
 *
 * Common utilities used by both test-user-flows.ts and test-redemption-lifecycle.ts:
 *   - PDA derivation functions
 *   - On-chain state parsers
 *   - ChadBuffer upload
 *   - Instruction builders (submit_header, request_redemption)
 *   - Authority keypair loading
 *   - Shared constants
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import { execSync } from "child_process";

// =============================================================================
// Constants
// =============================================================================

export const BUFFER_HEADER_SIZE = 32; // ChadBuffer authority pubkey

export const Seeds = {
  POOL_STATE: "pool_state",
  COMMITMENT_TREE: "commitment_tree",
  VK_REGISTRY: "vk_registry",
  NULLIFIER: "nullifier",
  STEALTH_ANNOUNCEMENT: "stealth",
  REDEMPTION: "redemption",
  DEPOSIT: "deposit",
  BTC_LIGHT_CLIENT: "btc_light_client",
  BLOCK_HEADER: "block_header",
} as const;

export const BTCRelayDisc = {
  SUBMIT_HEADER: 1,
  RESET_TIP: 2,
} as const;

// =============================================================================
// PDA Derivations
// =============================================================================

export function derivePoolStatePDA(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(Seeds.POOL_STATE)],
    programId,
  );
}

export function deriveCommitmentTreePDA(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(Seeds.COMMITMENT_TREE)],
    programId,
  );
}

export function deriveVkRegistryPDA(programId: PublicKey, nInputs: number, nOutputs: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(Seeds.VK_REGISTRY), Buffer.from([nInputs]), Buffer.from([nOutputs])],
    programId,
  );
}

export function deriveNullifierPDA(programId: PublicKey, nullifierHash: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(Seeds.NULLIFIER), Buffer.from(nullifierHash)],
    programId,
  );
}

export function deriveStealthAnnouncementPDA(programId: PublicKey, ephemeralPub: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(Seeds.STEALTH_ANNOUNCEMENT), Buffer.from(ephemeralPub)],
    programId,
  );
}

export function deriveRedemptionPDA(programId: PublicKey, user: PublicKey, nonce: bigint): [PublicKey, number] {
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(nonce);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(Seeds.REDEMPTION), user.toBuffer(), nonceBuf],
    programId,
  );
}

export function deriveDepositRecordPDA(programId: PublicKey, txid: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(Seeds.DEPOSIT), Buffer.from(txid)],
    programId,
  );
}

export function deriveLightClientPDA(btcLightClientId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(Seeds.BTC_LIGHT_CLIENT)],
    btcLightClientId,
  );
}

export function deriveBlockHeaderPDA(btcLightClientId: PublicKey, height: bigint): [PublicKey, number] {
  const heightBuf = Buffer.alloc(8);
  heightBuf.writeBigUInt64LE(height);
  return PublicKey.findProgramAddressSync(
    [Buffer.from(Seeds.BLOCK_HEADER), heightBuf],
    btcLightClientId,
  );
}

// =============================================================================
// On-chain State Parsers
// =============================================================================

export const TREE_DEPTH = 16;

export function parseCommitmentTree(data: Buffer) {
  if (data.length < 100 || data[0] !== 0x05) return null;
  return {
    discriminator: data[0],
    bump: data[1],
    currentRoot: data.subarray(8, 40),
    nextIndex: data.readBigUInt64LE(40),
    frontier: data.subarray(48, 48 + TREE_DEPTH * 32),
  };
}

export function parseCommitmentTreeNextIndex(data: Buffer): bigint | null {
  if (data.length < 48 || data[0] !== 0x05) return null;
  return data.readBigUInt64LE(40);
}

export interface PoolSnapshot {
  totalMinted: bigint;
  totalBurned: bigint;
  pendingRedemptions: bigint;
  totalShielded: bigint;
}

export function parsePoolState(data: Buffer): PoolSnapshot | null {
  if (data.length < 268 || data[0] !== 0x01) return null;
  return {
    totalMinted: data.readBigUInt64LE(140),
    totalBurned: data.readBigUInt64LE(148),
    pendingRedemptions: data.readBigUInt64LE(156),
    totalShielded: data.readBigUInt64LE(188),
  };
}

export interface RedemptionSnapshot {
  status: number;
  requester: PublicKey;
  amountSats: bigint;
  btcAddressLen: number;
}

export function parseRedemptionRequest(data: Buffer): RedemptionSnapshot | null {
  if (data.length < 118 || data[0] !== 0x04) return null;
  return {
    status: data[1],
    requester: new PublicKey(data.subarray(16, 48)),
    amountSats: data.readBigUInt64LE(48),
    btcAddressLen: data[2],
  };
}

export function parseLightClientTipHeight(data: Buffer): bigint | null {
  if (data.length < 144 || data[0] !== 0x06) return null;
  return data.readBigUInt64LE(136);
}

// =============================================================================
// ChadBuffer Account Creation
// =============================================================================

export async function createTxBufferAccount(
  connection: Connection,
  payer: Keypair,
  rawTx: Uint8Array,
  chadbufferId: PublicKey,
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
    programId: chadbufferId,
  });
  const createTx = new Transaction().add(createIx);
  await sendAndConfirmTransaction(connection, createTx, [payer, bufferKeypair], { commitment: "confirmed" });

  // Step 2: Init with first chunk (disc=0)
  const MAX_CHUNK = 900;
  const firstChunk = rawTx.slice(0, MAX_CHUNK);
  const initData = new Uint8Array(1 + firstChunk.length);
  initData[0] = 0; // Init discriminator
  initData.set(firstChunk, 1);

  const initIx = new TransactionInstruction({
    programId: chadbufferId,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: bufferKeypair.publicKey, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(initData),
  });
  const initTx = new Transaction().add(initIx);
  await sendAndConfirmTransaction(connection, initTx, [payer], { commitment: "confirmed" });

  // Step 3: Write remaining chunks (disc=2) if needed
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
      programId: chadbufferId,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: bufferKeypair.publicKey, isSigner: false, isWritable: true },
      ],
      data: Buffer.from(writeData),
    });
    const writeTx = new Transaction().add(writeIx);
    await sendAndConfirmTransaction(connection, writeTx, [payer], { commitment: "confirmed" });
    offset += chunk.length;
  }

  return bufferKeypair;
}

// =============================================================================
// Instruction Builders
// =============================================================================

/**
 * Submit block header to BTC relay (disc=1)
 * Data: disc(1) + raw_header(80) + block_height(8)
 */
export function buildSubmitHeaderIx(
  lightClient: PublicKey,
  blockHeaderPda: PublicKey,
  submitter: PublicKey,
  rawHeader: Uint8Array,
  blockHeight: bigint,
  btcLightClientId: PublicKey,
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
    programId: btcLightClientId,
    data,
  });
}

/**
 * Reset light client tip (disc=2)
 * Data: disc(1) + new_tip_height(8 LE) + new_tip_hash(32)
 * Accounts: light_client (writable), authority (signer)
 */
export function buildResetTipIx(
  lightClient: PublicKey,
  authority: PublicKey,
  newTipHeight: bigint,
  newTipHash: Uint8Array,
  btcLightClientId: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(41);
  data[0] = BTCRelayDisc.RESET_TIP;
  data.writeBigUInt64LE(newTipHeight, 1);
  Buffer.from(newTipHash).copy(data, 9);

  return new TransactionInstruction({
    keys: [
      { pubkey: lightClient, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    programId: btcLightClientId,
    data,
  });
}

/**
 * request_redemption (disc=5)
 */
export function buildRequestRedemptionIx(
  programId: PublicKey,
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
  },
): TransactionInstruction {
  const btcAddrBytes = Buffer.from(params.btcAddress, "utf-8");
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(params.nonce);

  const dataLen = 1 + 32 + 32 + 32 + 8 + 32 + 1 + btcAddrBytes.length + 8;
  const data = Buffer.alloc(dataLen);
  let off = 0;

  data[off++] = 5; // REQUEST_REDEMPTION
  Buffer.from(params.proofHash).copy(data, off); off += 32;
  Buffer.from(params.merkleRoot).copy(data, off); off += 32;
  Buffer.from(params.nullifierHash).copy(data, off); off += 32;
  data.writeBigUInt64LE(params.amountSats, off); off += 8;
  Buffer.from(params.vkHash).copy(data, off); off += 32;
  data[off++] = btcAddrBytes.length;
  btcAddrBytes.copy(data, off); off += btcAddrBytes.length;
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
    programId,
    data,
  });
}

// =============================================================================
// Authority Keypair Loading
// =============================================================================

export function loadAuthorityKeypair(): Keypair {
  let keypairPath = process.env.KEYPAIR || "";
  if (!keypairPath) {
    try {
      const configOut = execSync("solana config get", { encoding: "utf-8" });
      const match = configOut.match(/Keypair Path:\s*(.+)/);
      if (match) keypairPath = match[1].trim();
    } catch {}
  }
  if (!keypairPath) keypairPath = `${process.env.HOME}/.config/solana/id.json`;
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8"))),
  );
}
