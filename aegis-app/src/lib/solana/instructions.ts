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
  getConfig,
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

/** Aegis Program ID (dynamic — reads from SDK config) */
export const getAegisProgramId = () => new PublicKey(getConfig().aegisProgramId);
export let AEGIS_PROGRAM_ID: PublicKey;
try { AEGIS_PROGRAM_ID = new PublicKey(getConfig().aegisProgramId); } catch { console.warn("[instructions] AEGIS_PROGRAM_ID failed to init at build time — using default"); AEGIS_PROGRAM_ID = PublicKey.default; }

/** BTC Light Client Program ID */
export let BTC_LIGHT_CLIENT_PROGRAM_ID: PublicKey;
try { BTC_LIGHT_CLIENT_PROGRAM_ID = new PublicKey(getConfig().btcLightClientProgramId); } catch { console.warn("[instructions] BTC_LIGHT_CLIENT_PROGRAM_ID failed to init at build time — using default"); BTC_LIGHT_CLIENT_PROGRAM_ID = PublicKey.default; }

/** Token-2022 Program ID */
export let TOKEN_2022_PROGRAM_ID: PublicKey;
try { TOKEN_2022_PROGRAM_ID = new PublicKey(getConfig().token2022ProgramId); } catch { console.warn("[instructions] TOKEN_2022_PROGRAM_ID failed to init at build time — using default"); TOKEN_2022_PROGRAM_ID = PublicKey.default; }

/** zkBTC Mint Address */
export const getZkbtcMintAddress = () => new PublicKey(getConfig().zkbtcMint);
export let ZKBTC_MINT_ADDRESS: PublicKey;
try { ZKBTC_MINT_ADDRESS = new PublicKey(getConfig().zkbtcMint); } catch { console.warn("[instructions] ZKBTC_MINT_ADDRESS failed to init at build time — using default"); ZKBTC_MINT_ADDRESS = PublicKey.default; }

/** Groth16 Verifier Program ID */
export let GROTH16_VERIFIER_PROGRAM_ID: PublicKey;
try { GROTH16_VERIFIER_PROGRAM_ID = new PublicKey(getConfig().groth16VerifierProgramId); } catch { console.warn("[instructions] GROTH16_VERIFIER_PROGRAM_ID failed to init at build time — using default"); GROTH16_VERIFIER_PROGRAM_ID = PublicKey.default; }

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
 * Get zkBTC Mint address
 */
export function getzkBTCMintAddress(): PublicKey {
  return ZKBTC_MINT_ADDRESS;
}

/**
 * Derive Pool Vault ATA
 */
export function derivePoolVaultATA(
  programId: PublicKey = AEGIS_PROGRAM_ID
): PublicKey {
  const [poolState] = derivePoolStatePDA(programId);
  return getAssociatedTokenAddressSync(
    ZKBTC_MINT_ADDRESS,
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
  const nonceBytes = new Uint8Array(8);
  const view = new DataView(nonceBytes.buffer);
  view.setBigUint64(0, nonce, true);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("redemption"), userPubkey.toBytes(), nonceBytes],
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
  const { userPubkey, amountSats, btcAddress } = params;

  const [poolState] = derivePoolStatePDA();

  // TODO: Convert bech32 btcAddress to raw scriptPubKey bytes (max 34 bytes)
  const btcAddressBytes = new TextEncoder().encode(btcAddress);
  const requestNonce = BigInt(Date.now());
  const [commitmentTree] = deriveCommitmentTreePDA();
  const nullifierHash = new Uint8Array(32); // demo mode
  const [nullifierPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.NULLIFIER), Buffer.from(nullifierHash)],
    AEGIS_PROGRAM_ID,
  );
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(requestNonce);
  const [redemptionPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("redemption"), userPubkey.toBuffer(), nonceBuf],
    AEGIS_PROGRAM_ID,
  );
  const [tokenConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_config"), ZKBTC_MINT_ADDRESS.toBuffer()],
    AEGIS_PROGRAM_ID,
  );

  const instructionData = sdkBuildRedemptionRequestInstructionData({
    proofHash: new Uint8Array(32),
    merkleRoot: new Uint8Array(32),
    nullifierHash,
    amountSats,
    vkHash: new Uint8Array(32),
    btcScript: btcAddressBytes,
    requestNonce,
  });

  const instruction = new TransactionInstruction({
    programId: AEGIS_PROGRAM_ID,
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: commitmentTree, isSigner: false, isWritable: false },
      { pubkey: nullifierPDA, isSigner: false, isWritable: true },
      { pubkey: redemptionPDA, isSigner: false, isWritable: true },
      { pubkey: userPubkey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenConfig, isSigner: false, isWritable: true },
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
 * Get user's zkBTC token account address
 */
export function getTokenAccountAddress(userPubkey: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(
    ZKBTC_MINT_ADDRESS,
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
    const account = await fetchAccountInfo(getConfig().commitmentTreePda);
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
 * npk + ephemeral_pub are extracted ON-CHAIN from the deposit TX OP_RETURN.
 * Amount is extracted from the SPV-verified sweep TX.
 *
 * Layout: disc(1) + sweep_txid(32) + block_height(u64 LE)
 *         + sweep_tx_size(u32 LE) + deposit_tx_size(u32 LE) + deposit_txid(32) = 81 bytes
 */
export function buildVerifyStealthDepositInstructionData(params: {
  sweepTxid: Uint8Array;      // 32 bytes, internal byte order
  blockHeight: number;
  sweepTxSize: number;
  depositTxSize: number;
  depositTxid: Uint8Array;    // 32 bytes, internal byte order
}): Buffer {
  const buf = Buffer.alloc(81);
  let offset = 0;

  buf[offset++] = 1; // discriminator
  Buffer.from(params.sweepTxid).copy(buf, offset); offset += 32;
  buf.writeBigUInt64LE(BigInt(params.blockHeight), offset); offset += 8;
  buf.writeUInt32LE(params.sweepTxSize, offset); offset += 4;
  buf.writeUInt32LE(params.depositTxSize, offset); offset += 4;
  Buffer.from(params.depositTxid).copy(buf, offset); offset += 32;

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
 * Build verify_stealth_deposit TransactionInstruction (12 accounts)
 *
 * Stealth announcement is emitted as sol_log_data event (no PDA account needed).
 * Account 11 is the deposit_receipt PDA (prevents duplicate verification).
 */
export function buildVerifyStealthDepositInstruction(params: {
  poolStatePDA: PublicKey;
  verifiedTxPDA: PublicKey;
  lightClientPDA: PublicKey;
  commitmentTreePDA: PublicKey;
  sweepTxBuffer: PublicKey;
  authority: PublicKey; // signer, must match pool.authority
  zkbtcMint: PublicKey;
  poolVaultATA: PublicKey;
  depositTxBuffer: PublicKey;
  depositReceiptPDA: PublicKey;
  instructionData: Buffer;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: AEGIS_PROGRAM_ID,
    keys: [
      { pubkey: params.poolStatePDA, isSigner: false, isWritable: true },
      { pubkey: params.verifiedTxPDA, isSigner: false, isWritable: false },
      { pubkey: params.lightClientPDA, isSigner: false, isWritable: false },
      { pubkey: params.commitmentTreePDA, isSigner: false, isWritable: true },
      { pubkey: params.sweepTxBuffer, isSigner: false, isWritable: false },
      { pubkey: params.authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: params.zkbtcMint, isSigner: false, isWritable: true },
      { pubkey: params.poolVaultATA, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: params.depositTxBuffer, isSigner: false, isWritable: false },
      { pubkey: params.depositReceiptPDA, isSigner: false, isWritable: true },
    ],
    data: params.instructionData,
  });
}

/**
 * Derive Deposit Receipt PDA
 * Seeds: ["deposit_receipt", deposit_txid(32)]
 */
export function deriveDepositReceiptPDA(
  depositTxid: Uint8Array,
  programId: PublicKey = AEGIS_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("deposit_receipt"), Buffer.from(depositTxid)],
    programId
  );
}

// =============================================================================
// ChadBuffer Support (for large proofs)
// =============================================================================

/** ChadBuffer Program ID */
export let CHADBUFFER_PROGRAM_ID: PublicKey;
try { CHADBUFFER_PROGRAM_ID = new PublicKey(getConfig().chadbufferProgramId); } catch { console.warn("[instructions] CHADBUFFER_PROGRAM_ID failed to init at build time — using default"); CHADBUFFER_PROGRAM_ID = PublicKey.default; }

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

