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
import { address } from "@solana/kit";
import { getPriorityFeeInstructions } from "@/lib/helius";
import { fetchAccountInfo } from "@/lib/adapters/connection-adapter";

// =============================================================================
// Re-export from SDK (single source of truth)
// =============================================================================

import {
  DEVNET_CONFIG,
  INSTRUCTION_DISCRIMINATORS,
  // Instruction data builders
  buildClaimInstructionData as sdkBuildClaimInstructionData,
  buildSplitInstructionData as sdkBuildSplitInstructionData,
  buildSpendPartialPublicInstructionData as sdkBuildSpendPartialPublicInstructionData,
  buildRedemptionRequestInstructionData as sdkBuildRedemptionRequestInstructionData,
  // PDA helpers
  PDA_SEEDS,
  // Utilities
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
 * Derive zBTC Mint PDA (returns SDK config address)
 * @deprecated Use getzBTCMintAddress() instead
 */
export function derivezBTCMintPDA(
  _programId: PublicKey = ZVAULT_PROGRAM_ID
): [PublicKey, number] {
  return [ZBTC_MINT_ADDRESS, 0];
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

export interface ClaimParams {
  userPubkey: PublicKey;
  zkProof: Uint8Array;
  nullifierHash: Uint8Array;
  merkleRoot: Uint8Array;
  amountSats: bigint;
  userTokenAccount: PublicKey;
  vkHash: Uint8Array;
}

/**
 * Build CLAIM transaction with Helius priority fees
 */
export async function buildClaimTransaction(
  connection: Connection,
  params: ClaimParams
): Promise<Transaction> {
  const {
    userPubkey,
    zkProof,
    nullifierHash,
    merkleRoot,
    amountSats,
    userTokenAccount,
    vkHash,
  } = params;

  const [poolState] = derivePoolStatePDA();
  const [commitmentTree] = deriveCommitmentTreePDA();
  const [nullifierPDA] = deriveNullifierPDA(nullifierHash);
  const poolVault = derivePoolVaultATA();

  // Use SDK instruction data builder
  const instructionData = sdkBuildClaimInstructionData({
    proofBytes: zkProof,
    root: merkleRoot,
    nullifierHash,
    amountSats,
    recipient: address(userPubkey.toBase58()),
    vkHash,
  });

  const instruction = new TransactionInstruction({
    programId: ZVAULT_PROGRAM_ID,
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: commitmentTree, isSigner: false, isWritable: false },
      { pubkey: nullifierPDA, isSigner: false, isWritable: true },
      { pubkey: ZBTC_MINT_ADDRESS, isSigner: false, isWritable: true },
      { pubkey: poolVault, isSigner: false, isWritable: true },
      { pubkey: userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: userPubkey, isSigner: true, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: GROTH16_VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(instructionData),
  });

  // Helius priority fees for better tx landing
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

export interface SplitParams {
  userPubkey: PublicKey;
  zkProof: Uint8Array;
  inputNullifierHash: Uint8Array;
  outputCommitment1: Uint8Array;
  outputCommitment2: Uint8Array;
  merkleRoot: Uint8Array;
  vkHash: Uint8Array;
  /** Output 1 stealth: ephemeral pubkey x-coordinate */
  output1EphemeralPubX: Uint8Array;
  /** Output 1 stealth: encrypted amount with y_sign */
  output1EncryptedAmountWithSign: Uint8Array;
  /** Output 2 stealth: ephemeral pubkey x-coordinate */
  output2EphemeralPubX: Uint8Array;
  /** Output 2 stealth: encrypted amount with y_sign */
  output2EncryptedAmountWithSign: Uint8Array;
}

/**
 * Build SPLIT transaction with Helius priority fees
 */
export async function buildSplitTransaction(
  connection: Connection,
  params: SplitParams
): Promise<Transaction> {
  const {
    userPubkey,
    zkProof,
    inputNullifierHash,
    outputCommitment1,
    outputCommitment2,
    merkleRoot,
    vkHash,
    output1EphemeralPubX,
    output1EncryptedAmountWithSign,
    output2EphemeralPubX,
    output2EncryptedAmountWithSign,
  } = params;

  const [poolState] = derivePoolStatePDA();
  const [commitmentTree] = deriveCommitmentTreePDA();
  const [nullifierPDA] = deriveNullifierPDA(inputNullifierHash);

  // Use SDK instruction data builder (inline proof)
  const instructionData = sdkBuildSplitInstructionData({
    proofBytes: zkProof,
    root: merkleRoot,
    nullifierHash: inputNullifierHash,
    outputCommitment1,
    outputCommitment2,
    vkHash,
    output1EphemeralPubX,
    output1EncryptedAmountWithSign,
    output2EphemeralPubX,
    output2EncryptedAmountWithSign,
  });

  const instruction = new TransactionInstruction({
    programId: ZVAULT_PROGRAM_ID,
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: commitmentTree, isSigner: false, isWritable: true },
      { pubkey: nullifierPDA, isSigner: false, isWritable: true },
      { pubkey: userPubkey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
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

export interface SpendPartialPublicParams {
  userPubkey: PublicKey;
  zkProof: Uint8Array;
  merkleRoot: Uint8Array;
  nullifierHash: Uint8Array;
  publicAmount: bigint;
  changeCommitment: Uint8Array;
  recipient: PublicKey;
  recipientTokenAccount: PublicKey;
  vkHash: Uint8Array;
  /** Change stealth output: ephemeral pubkey x-coordinate */
  changeEphemeralPubX: Uint8Array;
  /** Change stealth output: encrypted amount with y_sign */
  changeEncryptedAmountWithSign: Uint8Array;
}

/**
 * Build SPEND_PARTIAL_PUBLIC transaction with Helius priority fees
 */
export async function buildSpendPartialPublicTransaction(
  connection: Connection,
  params: SpendPartialPublicParams
): Promise<Transaction> {
  const {
    userPubkey,
    zkProof,
    merkleRoot,
    nullifierHash,
    publicAmount,
    changeCommitment,
    recipient,
    recipientTokenAccount,
    vkHash,
    changeEphemeralPubX,
    changeEncryptedAmountWithSign,
  } = params;

  const [poolState] = derivePoolStatePDA();
  const [commitmentTree] = deriveCommitmentTreePDA();
  const [nullifierPDA] = deriveNullifierPDA(nullifierHash);
  const poolVault = derivePoolVaultATA();

  // Use SDK instruction data builder
  const instructionData = sdkBuildSpendPartialPublicInstructionData({
    proofBytes: zkProof,
    root: merkleRoot,
    nullifierHash,
    publicAmountSats: publicAmount,
    changeCommitment,
    recipient: address(recipient.toBase58()),
    vkHash,
    changeEphemeralPubX,
    changeEncryptedAmountWithSign,
  });

  const instruction = new TransactionInstruction({
    programId: ZVAULT_PROGRAM_ID,
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: commitmentTree, isSigner: false, isWritable: true },
      { pubkey: nullifierPDA, isSigner: false, isWritable: true },
      { pubkey: ZBTC_MINT_ADDRESS, isSigner: false, isWritable: true },
      { pubkey: poolVault, isSigner: false, isWritable: true },
      { pubkey: recipientTokenAccount, isSigner: false, isWritable: true },
      { pubkey: userPubkey, isSigner: true, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: GROTH16_VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
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

  // Use SDK instruction data builder
  const instructionData = sdkBuildRedemptionRequestInstructionData(amountSats, btcAddress);

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

export interface SpendPartialPublicWithBufferResult {
  /** Transaction to create and initialize buffer with first chunk */
  createBufferTx: Transaction;
  /** Additional write transactions (may be empty if proof fits in first chunk) */
  writeTxs: Transaction[];
  /** The main spend transaction using buffer reference */
  spendTx: Transaction;
  /** Buffer keypair (user needs to sign buffer creation) */
  bufferKeypair: Keypair;
  /** Transaction to close buffer and reclaim rent (call after spend confirms) */
  closeBufferTx: Transaction;
}

/**
 * Build SPEND_PARTIAL_PUBLIC transactions using ChadBuffer for large proofs.
 *
 * Returns multiple transactions that must be signed and sent in order:
 * 1. createBufferTx - Creates buffer and writes first chunk
 * 2. writeTxs[] - Additional writes (if needed)
 * 3. spendTx - The actual spend instruction using buffer
 * 4. closeBufferTx - Close buffer to reclaim rent (optional, after spend confirms)
 */
export async function buildSpendPartialPublicWithBuffer(
  connection: Connection,
  params: SpendPartialPublicParams
): Promise<SpendPartialPublicWithBufferResult> {
  const {
    userPubkey,
    zkProof,
    merkleRoot,
    nullifierHash,
    publicAmount,
    changeCommitment,
    recipient,
    recipientTokenAccount,
    vkHash,
    changeEphemeralPubX,
    changeEncryptedAmountWithSign,
  } = params;

  // Generate buffer keypair
  const bufferKeypair = Keypair.generate();
  const bufferSize = AUTHORITY_SIZE + zkProof.length;

  // Calculate rent
  const rentExemption = await connection.getMinimumBalanceForRentExemption(bufferSize);

  // Split proof into chunks
  const firstChunkSize = Math.min(800, zkProof.length); // Conservative first chunk
  const firstChunk = zkProof.slice(0, firstChunkSize);
  const remainingData = zkProof.slice(firstChunkSize);

  // Get priority fees
  const priorityFeeIxs = await getPriorityFeeInstructions([
    ZVAULT_PROGRAM_ID.toBase58(),
  ]);

  // Create buffer transaction
  const createAccountIx = SystemProgram.createAccount({
    fromPubkey: userPubkey,
    newAccountPubkey: bufferKeypair.publicKey,
    lamports: rentExemption,
    space: bufferSize,
    programId: CHADBUFFER_PROGRAM_ID,
  });

  const initIx = createChadBufferCreateIx(bufferKeypair, userPubkey, firstChunk);

  const createBufferTx = new Transaction();
  createBufferTx.add(...priorityFeeIxs);
  createBufferTx.add(createAccountIx);
  createBufferTx.add(initIx);
  createBufferTx.feePayer = userPubkey;

  // Write transactions for remaining chunks
  const writeTxs: Transaction[] = [];
  let offset = firstChunkSize;

  while (offset < zkProof.length) {
    const chunkSize = Math.min(MAX_DATA_PER_WRITE, zkProof.length - offset);
    const chunk = zkProof.slice(offset, offset + chunkSize);

    const writeIx = createChadBufferWriteIx(
      bufferKeypair.publicKey,
      userPubkey,
      offset, // Offset is relative to data portion, not including AUTHORITY_SIZE
      chunk
    );

    const writeTx = new Transaction();
    writeTx.add(...priorityFeeIxs);
    writeTx.add(writeIx);
    writeTx.feePayer = userPubkey;

    writeTxs.push(writeTx);
    offset += chunkSize;
  }

  // Build spend transaction with buffer reference
  const [poolState] = derivePoolStatePDA();
  const [commitmentTree] = deriveCommitmentTreePDA();
  const [nullifierPDA] = deriveNullifierPDA(nullifierHash);
  const poolVault = derivePoolVaultATA();

  // Use SDK instruction data builder
  const instructionData = sdkBuildSpendPartialPublicInstructionData({
    proofBytes: zkProof,
    root: merkleRoot,
    nullifierHash,
    publicAmountSats: publicAmount,
    changeCommitment,
    recipient: address(recipient.toBase58()),
    vkHash,
    changeEphemeralPubX,
    changeEncryptedAmountWithSign,
  });

  const spendInstruction = new TransactionInstruction({
    programId: ZVAULT_PROGRAM_ID,
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: commitmentTree, isSigner: false, isWritable: true },
      { pubkey: nullifierPDA, isSigner: false, isWritable: true },
      { pubkey: ZBTC_MINT_ADDRESS, isSigner: false, isWritable: true },
      { pubkey: poolVault, isSigner: false, isWritable: true },
      { pubkey: recipientTokenAccount, isSigner: false, isWritable: true },
      { pubkey: userPubkey, isSigner: true, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: GROTH16_VERIFIER_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: bufferKeypair.publicKey, isSigner: false, isWritable: false }, // Buffer account
    ],
    data: Buffer.from(instructionData),
  });

  const spendTx = new Transaction();
  spendTx.add(...priorityFeeIxs);
  spendTx.add(spendInstruction);
  spendTx.feePayer = userPubkey;

  // Close buffer transaction
  const closeIx = createChadBufferCloseIx(bufferKeypair.publicKey, userPubkey);
  const closeBufferTx = new Transaction();
  closeBufferTx.add(...priorityFeeIxs);
  closeBufferTx.add(closeIx);
  closeBufferTx.feePayer = userPubkey;

  // Set blockhashes
  const { blockhash } = await connection.getLatestBlockhash();
  createBufferTx.recentBlockhash = blockhash;
  writeTxs.forEach(tx => { tx.recentBlockhash = blockhash; });
  spendTx.recentBlockhash = blockhash;
  closeBufferTx.recentBlockhash = blockhash;

  return {
    createBufferTx,
    writeTxs,
    spendTx,
    bufferKeypair,
    closeBufferTx,
  };
}
