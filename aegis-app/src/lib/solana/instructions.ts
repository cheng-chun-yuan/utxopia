/**
 * Solana Transaction Builders for Aegis
 *
 * Hybrid architecture:
 * - Transaction builders use @solana/web3.js (wallet adapter compatibility)
 * - Read-only utilities use @solana/kit (modern, efficient)
 *
 * All instruction data building and PDA derivation comes from @aegis/sdk.
 *
 * @module solana/instructions
 */

import {
  Connection,
  PublicKey,
  TransactionInstruction,
  Transaction,
  SystemProgram,
  Keypair,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { getPriorityFeeInstructions } from "@/lib/helius";
import { fetchAccountInfo } from "@/lib/adapters/connection-adapter";

// =============================================================================
// Re-export from SDK (single source of truth)
// =============================================================================

import {
  DEVNET_CONFIG,
  INSTRUCTION_DISCRIMINATORS,
  buildTransactInstructionData,
  buildRedemptionRequestInstructionData as sdkBuildRedemptionRequestInstructionData,
  PDA_SEEDS,
  bigintTo32Bytes,
  hexToBytes,
  bytesToHex,
} from "@aegis/sdk";

// Re-export for consumers
export { INSTRUCTION_DISCRIMINATORS, bigintTo32Bytes, hexToBytes, bytesToHex };

// =============================================================================
// Constants - All from SDK config
// =============================================================================

/** Aegis Program ID */
export const AEGIS_PROGRAM_ID = new PublicKey(DEVNET_CONFIG.aegisProgramId);

/** BTC Light Client Program ID */
export const BTC_LIGHT_CLIENT_PROGRAM_ID = new PublicKey(DEVNET_CONFIG.btcLightClientProgramId);

/** Token-2022 Program ID */
export const TOKEN_2022_PROGRAM_ID = new PublicKey(DEVNET_CONFIG.token2022ProgramId);

/** zBTC Mint Address */
export const ZBTC_MINT_ADDRESS = new PublicKey(DEVNET_CONFIG.zbtcMint);

/** Groth16 Verifier Program ID */
export const GROTH16_VERIFIER_PROGRAM_ID = new PublicKey(DEVNET_CONFIG.groth16VerifierProgramId);

// =============================================================================
// PDA Derivation (using SDK seeds)
// =============================================================================

/**
 * Derive Pool State PDA
 */
export function derivePoolStatePDA(
  programId: PublicKey = AEGIS_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.POOL_STATE)],
    programId
  );
}

/**
 * Derive Commitment Tree PDA
 */
export function deriveCommitmentTreePDA(
  programId: PublicKey = AEGIS_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.COMMITMENT_TREE)],
    programId
  );
}

/**
 * Derive Nullifier PDA
 */
export function deriveNullifierPDA(
  nullifierHash: Uint8Array,
  programId: PublicKey = AEGIS_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.NULLIFIER), nullifierHash],
    programId
  );
}

/**
 * Derive Deposit Stealth Announcement PDA (unified: ["stealth", txid])
 */
export function deriveDepositStealthPDA(
  txidBytes: Uint8Array,
  programId: PublicKey = AEGIS_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.STEALTH), txidBytes],
    programId
  );
}

/**
 * Derive Light Client PDA
 */
export function deriveLightClientPDA(
  programId: PublicKey = BTC_LIGHT_CLIENT_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.LIGHT_CLIENT)],
    programId
  );
}

/**
 * Derive Block Header PDA
 */
export function deriveBlockHeaderPDA(
  blockHeight: number,
  programId: PublicKey = BTC_LIGHT_CLIENT_PROGRAM_ID
): [PublicKey, number] {
  const heightBuffer = Buffer.alloc(8);
  heightBuffer.writeBigUInt64LE(BigInt(blockHeight));
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.BLOCK_HEADER), heightBuffer],
    programId
  );
}

/**
 * Get zBTC Mint address
 */
export function getzBTCMintAddress(): PublicKey {
  return ZBTC_MINT_ADDRESS;
}

/**
 * Derive Pool Vault ATA
 */
export function derivePoolVaultATA(
  programId: PublicKey = AEGIS_PROGRAM_ID
): PublicKey {
  const [poolState] = derivePoolStatePDA(programId);
  return getAssociatedTokenAddressSync(
    ZBTC_MINT_ADDRESS,
    poolState,
    true,
    TOKEN_2022_PROGRAM_ID
  );
}

/**
 * Derive VK Registry PDA for a JoinSplit variant
 * Seeds: ["vk_registry", &[n_inputs], &[n_outputs]]
 */
export function deriveVkRegistryPDA(
  nInputs: number,
  nOutputs: number,
  programId: PublicKey = AEGIS_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.VK_REGISTRY), new Uint8Array([nInputs]), new Uint8Array([nOutputs])],
    programId
  );
}

/**
 * Derive Redemption Request PDA
 * Seeds: ["redemption", user_pubkey(32), nonce_le(8)]
 */
export function deriveRedemptionRequestPDA(
  userPubkey: PublicKey,
  nonce: bigint,
  programId: PublicKey = AEGIS_PROGRAM_ID
): [PublicKey, number] {
  const nonceBytes = Buffer.alloc(8);
  nonceBytes.writeBigUInt64LE(nonce);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("redemption"), userPubkey.toBytes(), nonceBytes],
    programId
  );
}

/**
 * Derive Transfer Stealth Announcement PDA
 * Seeds: ["stealth", ephemeralPub(32)]
 */
export function deriveTransferStealthAnnouncementPDA(
  ephemeralPub: Uint8Array,
  programId: PublicKey = AEGIS_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.STEALTH), ephemeralPub],
    programId
  );
}

// =============================================================================
// Transaction Builders (with Helius priority fees)
// =============================================================================

export interface RedeemParams {
  userPubkey: PublicKey;
  userTokenAccount: PublicKey;
  amountSats: bigint;
  btcAddress: string;
}

/**
 * Build REQUEST_REDEMPTION transaction with Helius priority fees
 */
export async function buildRedeemTransaction(
  connection: Connection,
  params: RedeemParams
): Promise<Transaction> {
  const { userPubkey, userTokenAccount, amountSats, btcAddress } = params;

  const [poolState] = derivePoolStatePDA();

  // TODO: Convert bech32 btcAddress to raw scriptPubKey bytes (max 34 bytes)
  // For now, encode as UTF-8 (caller must pass raw scriptPubKey hex or short address)
  const btcAddressBytes = new TextEncoder().encode(btcAddress);
  const instructionData = sdkBuildRedemptionRequestInstructionData(amountSats, btcAddressBytes);

  const instruction = new TransactionInstruction({
    programId: AEGIS_PROGRAM_ID,
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: ZBTC_MINT_ADDRESS, isSigner: false, isWritable: true },
      { pubkey: userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: userPubkey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(instructionData),
  });

  const priorityFeeIxs = await getPriorityFeeInstructions([
    AEGIS_PROGRAM_ID.toBase58(),
  ]);

  const transaction = new Transaction();
  transaction.add(...priorityFeeIxs);
  transaction.add(instruction);
  transaction.feePayer = userPubkey;

  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;

  return transaction;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Get user's zBTC token account address
 */
export function getTokenAccountAddress(userPubkey: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(
    ZBTC_MINT_ADDRESS,
    userPubkey,
    false,
    TOKEN_2022_PROGRAM_ID
  );
}

/**
 * Check if a nullifier has been used (claimed).
 * Uses @solana/kit for efficient RPC reads.
 */
export async function isNullifierUsed(
  nullifierHash: Uint8Array
): Promise<boolean> {
  const [nullifierPDA] = deriveNullifierPDA(nullifierHash);
  try {
    const account = await fetchAccountInfo(nullifierPDA.toBase58());
    return account !== null;
  } catch {
    return false;
  }
}

/**
 * Get current Merkle root from commitment tree.
 * Uses @solana/kit for efficient RPC reads.
 */
export async function getMerkleRoot(): Promise<Uint8Array | null> {
  try {
    const account = await fetchAccountInfo(DEVNET_CONFIG.commitmentTreePda);
    if (!account) return null;
    // Root is at offset 8 (after discriminator), 32 bytes
    return account.data.slice(8, 40);
  } catch {
    return null;
  }
}

// =============================================================================
// Verify Instruction Builders
// =============================================================================

/**
 * Derive VerifiedTransaction PDA
 * Seeds: ["verified_tx", block_hash(32), txid(32)] under btc-light-client
 */
export function deriveVerifiedTransactionPDA(
  blockHash: Uint8Array,
  txid: Uint8Array,
  programId: PublicKey = BTC_LIGHT_CLIENT_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("verified_tx"), Buffer.from(blockHash), Buffer.from(txid)],
    programId
  );
}

/**
 * Build btc-light-client verify_transaction instruction data (disc=2)
 *
 * Layout (after disc byte):
 * txid(32) + block_hash(32) + tx_size(u32 LE) + merkle_proof(variable)
 *
 * Merkle proof sub-layout:
 * proof_txid(32) + path_bits(u32 LE) + path_len(u8) + tx_index(u32 LE) + siblings(32 * path_len)
 */
export function buildVerifyTransactionInstructionData(params: {
  txid: Uint8Array;        // 32 bytes, internal byte order
  blockHash: Uint8Array;   // 32 bytes
  txSize: number;          // raw tx size in ChadBuffer (after 32-byte authority)
  txIndex: number;
  merkleSiblings: Uint8Array[]; // each 32 bytes, internal byte order
  pathBits: number;        // bitmask of path direction
}): Buffer {
  const { txid, blockHash, txSize, txIndex, merkleSiblings, pathBits } = params;
  const pathLen = merkleSiblings.length;

  // disc(1) + txid(32) + blockHash(32) + txSize(4) + proofTxid(32) + pathBits(4) + pathLen(1) + txIndex(4) + siblings(32*N)
  const totalSize = 1 + 32 + 32 + 4 + 32 + 4 + 1 + 4 + 32 * pathLen;
  const buf = Buffer.alloc(totalSize);
  let offset = 0;

  buf[offset++] = 2; // discriminator
  Buffer.from(txid).copy(buf, offset); offset += 32;
  Buffer.from(blockHash).copy(buf, offset); offset += 32;
  buf.writeUInt32LE(txSize, offset); offset += 4;

  // Merkle proof sub-layout
  Buffer.from(txid).copy(buf, offset); offset += 32; // proof_txid = txid
  buf.writeUInt32LE(pathBits, offset); offset += 4;
  buf[offset++] = pathLen;
  buf.writeUInt32LE(txIndex, offset); offset += 4;
  for (const sibling of merkleSiblings) {
    Buffer.from(sibling).copy(buf, offset); offset += 32;
  }

  return buf;
}

/**
 * Build aegis verify_stealth_deposit instruction data (disc=1)
 *
 * Amount is extracted on-chain from the SPV-verified raw transaction.
 *
 * Layout: disc(1) + txid(32) + block_height(u64 LE)
 *         + tx_size(u32 LE) + ephemeral_pub(32) + npk(32) = 109 bytes
 */
export function buildVerifyStealthDepositInstructionData(params: {
  txid: Uint8Array;       // 32 bytes, internal byte order
  blockHeight: number;
  txSize: number;
  ephemeralPub: Uint8Array; // 32 bytes
  npk: Uint8Array;          // 32 bytes
}): Buffer {
  const buf = Buffer.alloc(109);
  let offset = 0;

  buf[offset++] = 1; // discriminator
  Buffer.from(params.txid).copy(buf, offset); offset += 32;
  buf.writeBigUInt64LE(BigInt(params.blockHeight), offset); offset += 8;
  buf.writeUInt32LE(params.txSize, offset); offset += 4;
  Buffer.from(params.ephemeralPub).copy(buf, offset); offset += 32;
  Buffer.from(params.npk).copy(buf, offset); offset += 32;

  return buf;
}

/**
 * Build verify_transaction TransactionInstruction
 */
export function buildVerifyTransactionInstruction(params: {
  payer: PublicKey;
  verifiedTxPDA: PublicKey;
  lightClientPDA: PublicKey;
  blockHeaderPDA: PublicKey;
  chadBuffer: PublicKey;
  instructionData: Buffer;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: BTC_LIGHT_CLIENT_PROGRAM_ID,
    keys: [
      { pubkey: params.verifiedTxPDA, isSigner: false, isWritable: true },
      { pubkey: params.lightClientPDA, isSigner: false, isWritable: false },
      { pubkey: params.blockHeaderPDA, isSigner: false, isWritable: false },
      { pubkey: params.chadBuffer, isSigner: false, isWritable: false },
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: params.instructionData,
  });
}

/**
 * Build verify_stealth_deposit TransactionInstruction (11 accounts)
 */
export function buildVerifyStealthDepositInstruction(params: {
  poolStatePDA: PublicKey;
  verifiedTxPDA: PublicKey;
  lightClientPDA: PublicKey;
  commitmentTreePDA: PublicKey;
  stealthAnnouncementPDA: PublicKey;
  chadBuffer: PublicKey;
  authority: PublicKey; // signer, must match pool.authority
  zbtcMint: PublicKey;
  poolVaultATA: PublicKey;
  instructionData: Buffer;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: AEGIS_PROGRAM_ID,
    keys: [
      { pubkey: params.poolStatePDA, isSigner: false, isWritable: true },
      { pubkey: params.verifiedTxPDA, isSigner: false, isWritable: false },
      { pubkey: params.lightClientPDA, isSigner: false, isWritable: false },
      { pubkey: params.commitmentTreePDA, isSigner: false, isWritable: true },
      { pubkey: params.stealthAnnouncementPDA, isSigner: false, isWritable: true },
      { pubkey: params.chadBuffer, isSigner: false, isWritable: false },
      { pubkey: params.authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: params.zbtcMint, isSigner: false, isWritable: true },
      { pubkey: params.poolVaultATA, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: params.instructionData,
  });
}

// =============================================================================
// ChadBuffer Support (for large proofs)
// =============================================================================

/** ChadBuffer Program ID */
export const CHADBUFFER_PROGRAM_ID = new PublicKey(DEVNET_CONFIG.chadbufferProgramId);

/** ChadBuffer instruction discriminators */
const CHADBUFFER_IX = {
  CREATE: 0,
  ASSIGN: 1,
  WRITE: 2,
  CLOSE: 3,
};

/** Authority size in buffer */
export const AUTHORITY_SIZE = 32;

/** Max data per write tx (conservative to fit in tx size limit) */
export const MAX_DATA_PER_WRITE = 950;

/**
 * Create ChadBuffer CREATE instruction
 */
export function createChadBufferCreateIx(
  bufferKeypair: Keypair,
  payer: PublicKey,
  initialData: Uint8Array
): TransactionInstruction {
  const data = Buffer.alloc(1 + initialData.length);
  data[0] = CHADBUFFER_IX.CREATE;
  data.set(initialData, 1);

  return new TransactionInstruction({
    programId: CHADBUFFER_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: bufferKeypair.publicKey, isSigner: true, isWritable: true },
    ],
    data,
  });
}

/**
 * Create ChadBuffer WRITE instruction
 */
export function createChadBufferWriteIx(
  buffer: PublicKey,
  payer: PublicKey,
  offset: number,
  chunkData: Uint8Array
): TransactionInstruction {
  const ixData = Buffer.alloc(4 + chunkData.length);
  ixData[0] = CHADBUFFER_IX.WRITE;
  // u24 offset (little-endian)
  ixData[1] = offset & 0xff;
  ixData[2] = (offset >> 8) & 0xff;
  ixData[3] = (offset >> 16) & 0xff;
  ixData.set(chunkData, 4);

  return new TransactionInstruction({
    programId: CHADBUFFER_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: buffer, isSigner: false, isWritable: true },
    ],
    data: ixData,
  });
}

/**
 * Create ChadBuffer CLOSE instruction
 */
export function createChadBufferCloseIx(
  buffer: PublicKey,
  payer: PublicKey
): TransactionInstruction {
  return new TransactionInstruction({
    programId: CHADBUFFER_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: buffer, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([CHADBUFFER_IX.CLOSE]),
  });
}

