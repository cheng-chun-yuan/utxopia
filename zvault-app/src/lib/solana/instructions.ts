/**
 * Solana Transaction Builders for zVault
 *
 * Hybrid architecture:
 * - Transaction builders use @solana/web3.js (wallet adapter compatibility)
 * - Read-only utilities use @solana/kit (modern, efficient)
 *
 * All instruction data building and PDA derivation comes from @zvault/sdk.
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
} from "@zvault/sdk";

// Re-export for consumers
export { INSTRUCTION_DISCRIMINATORS, bigintTo32Bytes, hexToBytes, bytesToHex };

// =============================================================================
// Constants - All from SDK config
// =============================================================================

/** zVault Program ID */
export const ZVAULT_PROGRAM_ID = new PublicKey(DEVNET_CONFIG.zvaultProgramId);

/** BTC Relay Program ID */
export const BTC_RELAY_PROGRAM_ID = new PublicKey(DEVNET_CONFIG.btcRelayProgramId);

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
  programId: PublicKey = ZVAULT_PROGRAM_ID
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
  programId: PublicKey = ZVAULT_PROGRAM_ID
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
  programId: PublicKey = ZVAULT_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.NULLIFIER), nullifierHash],
    programId
  );
}

/**
 * Derive Deposit Record PDA
 */
export function deriveDepositRecordPDA(
  txidBytes: Uint8Array,
  programId: PublicKey = ZVAULT_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.DEPOSIT), txidBytes],
    programId
  );
}

/**
 * Derive Light Client PDA
 */
export function deriveLightClientPDA(
  programId: PublicKey = BTC_RELAY_PROGRAM_ID
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
  programId: PublicKey = BTC_RELAY_PROGRAM_ID
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
  programId: PublicKey = ZVAULT_PROGRAM_ID
): PublicKey {
  const [poolState] = derivePoolStatePDA(programId);
  return getAssociatedTokenAddressSync(
    ZBTC_MINT_ADDRESS,
    poolState,
    true,
    TOKEN_2022_PROGRAM_ID
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

  // Encode BTC address as UTF-8 bytes for on-chain storage
  const btcAddressBytes = new TextEncoder().encode(btcAddress);
  const instructionData = sdkBuildRedemptionRequestInstructionData(amountSats, btcAddressBytes);

  const instruction = new TransactionInstruction({
    programId: ZVAULT_PROGRAM_ID,
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
    ZVAULT_PROGRAM_ID.toBase58(),
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
const AUTHORITY_SIZE = 32;

/** Max data per write tx (conservative to fit in tx size limit) */
const MAX_DATA_PER_WRITE = 950;

/**
 * Create ChadBuffer CREATE instruction
 */
function createChadBufferCreateIx(
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
function createChadBufferWriteIx(
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

