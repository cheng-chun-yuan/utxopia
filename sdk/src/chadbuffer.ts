/**
 * ChadBuffer Client
 *
 * Helper functions to upload Bitcoin transaction data to ChadBuffer
 * for SPV verification on Solana.
 *
 * Networks: Bitcoin Testnet3, Solana Devnet
 *
 * Reference: https://github.com/deanmlittle/chadbuffer
 */

import {
  address,
  getProgramDerivedAddress,
  generateKeyPairSigner,
  createKeyPairSignerFromBytes,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  getSignatureFromTransaction,
  sendAndConfirmTransactionFactory,
  AccountRole,
  type Address,
  type KeyPairSigner,
  type Rpc,
  type RpcSubscriptions,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";

/** Instruction type for v2 */
interface Instruction {
  programAddress: Address;
  accounts: Array<{ address: Address; role: (typeof AccountRole)[keyof typeof AccountRole] }>;
  data: Uint8Array;
}

// ChadBuffer Program ID (deployed to devnet 2025-01-30)
export const CHADBUFFER_PROGRAM_ID: Address = address(
  "C5RpjtTMFXKVZCtXSzKXD4CDNTaWBg3dVeMfYvjZYHDF"
);

// System Program ID
const SYSTEM_PROGRAM_ID: Address = address("11111111111111111111111111111111");

// Buffer authority size (32 bytes)
export const AUTHORITY_SIZE = 32;

// Solana transaction limit
export const SOLANA_TX_SIZE_LIMIT = 1232;

/**
 * ChadBuffer Write TX overhead breakdown:
 * - Signature: 64 bytes
 * - Message header: 3 bytes
 * - 2 account metas (payer + buffer): 66 bytes (33 each)
 * - Instruction header: 4 bytes
 * - Discriminator: 1 byte
 * - u24 offset: 3 bytes
 * Total fixed overhead: ~141 bytes (using 176 for safety margin)
 */
const WRITE_TX_OVERHEAD = 176;

/**
 * Maximum data bytes per ChadBuffer Write transaction
 * Dynamically calculated from TX limit minus overhead
 */
export const MAX_DATA_PER_WRITE = SOLANA_TX_SIZE_LIMIT - WRITE_TX_OVERHEAD;

/**
 * ChadBuffer instruction discriminators
 * See: https://github.com/deanmlittle/chadbuffer/blob/main/src/lib.rs
 */
enum ChadBufferInstruction {
  Create = 0,  // Init buffer with initial data
  Assign = 1,  // Transfer authority
  Write = 2,   // Write at offset (u24 offset + data)
  Close = 3,   // Close buffer and reclaim lamports
}

/**
 * Create instruction data for ChadBuffer Init (discriminator 0)
 * Format: discriminator(1) + data
 */
function createInitInstructionData(data: Uint8Array): Buffer {
  const buffer = Buffer.alloc(1 + data.length);
  buffer.writeUInt8(ChadBufferInstruction.Create, 0);
  buffer.set(data, 1);
  return buffer;
}

/**
 * Create instruction data for ChadBuffer Write (discriminator 2)
 * Format: discriminator(1) + u24_offset(3) + data
 */
function createWriteInstructionData(offset: number, data: Uint8Array): Buffer {
  const buffer = Buffer.alloc(1 + 3 + data.length);
  buffer.writeUInt8(ChadBufferInstruction.Write, 0);
  // u24 offset (little-endian)
  buffer.writeUInt8(offset & 0xff, 1);
  buffer.writeUInt8((offset >> 8) & 0xff, 2);
  buffer.writeUInt8((offset >> 16) & 0xff, 3);
  buffer.set(data, 4);
  return buffer;
}

/**
 * Create instruction data for ChadBuffer Close (discriminator 3)
 * Format: discriminator(1) only
 */
function createCloseInstructionData(): Buffer {
  return Buffer.from([ChadBufferInstruction.Close]);
}

/**
 * Create instruction data for ChadBuffer (legacy helper)
 * @deprecated Use specific instruction data functions
 */
function createInstructionData(
  instruction: ChadBufferInstruction,
  data?: Uint8Array
): Buffer {
  if (instruction === ChadBufferInstruction.Create && data) {
    return createInitInstructionData(data);
  }
  if (instruction === ChadBufferInstruction.Close) {
    return createCloseInstructionData();
  }
  // Fallback for other cases
  if (data) {
    const buffer = Buffer.alloc(1 + data.length);
    buffer.writeUInt8(instruction, 0);
    buffer.set(data, 1);
    return buffer;
  }
  return Buffer.from([instruction]);
}

/**
 * Upload raw Bitcoin transaction to ChadBuffer
 *
 * @param rpc - Solana RPC client
 * @param rpcSubscriptions - Solana RPC subscriptions client
 * @param payer - Transaction fee payer (KeyPairSigner)
 * @param rawTx - Raw Bitcoin transaction bytes
 * @param seed - Optional seed for buffer keypair derivation
 * @returns Buffer address
 */
export async function uploadTransactionToBuffer(
  rpc: Rpc<SolanaRpcApi>,
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>,
  payer: KeyPairSigner,
  rawTx: Uint8Array,
  seed?: Uint8Array
): Promise<Address> {
  // Generate buffer keypair
  const bufferKeypair = seed
    ? await createKeyPairSignerFromBytes(seed.slice(0, 64).length === 64 ? seed.slice(0, 64) : padTo64Bytes(seed.slice(0, 32)))
    : await generateKeyPairSigner();

  // Calculate space: authority (32) + data
  const space = AUTHORITY_SIZE + rawTx.length;
  const rentExemption = await rpc.getMinimumBalanceForRentExemption(BigInt(space)).send();

  // Split data into chunks using dynamic MAX_DATA_PER_WRITE
  const chunks = splitIntoChunks(rawTx, MAX_DATA_PER_WRITE);

  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

  // TX 1: CreateAccount only (no data yet)
  const createAccountIx = getCreateAccountInstruction({
    payer,
    newAccount: bufferKeypair,
    lamports: rentExemption,
    space: BigInt(space),
    programAddress: CHADBUFFER_PROGRAM_ID,
  });

  const { value: blockhash1 } = await rpc.getLatestBlockhash().send();
  const tx1 = pipe(
    createTransactionMessage({ version: 0 }),
    (msg) => setTransactionMessageFeePayer(payer.address, msg),
    (msg) => setTransactionMessageLifetimeUsingBlockhash(blockhash1, msg),
    (msg) => appendTransactionMessageInstruction(createAccountIx, msg)
  );
  await sendAndConfirm(await signTransactionMessageWithSigners(tx1) as any, { commitment: "confirmed" });

  // TX 2: ChadBuffer Init with first chunk
  const initIx = {
    programAddress: CHADBUFFER_PROGRAM_ID,
    accounts: [
      { address: payer.address, role: AccountRole.WRITABLE_SIGNER, signer: payer },
      { address: bufferKeypair.address, role: AccountRole.WRITABLE },
    ],
    data: createInitInstructionData(chunks[0]),
  };

  const { value: blockhash2 } = await rpc.getLatestBlockhash().send();
  const tx2 = pipe(
    createTransactionMessage({ version: 0 }),
    (msg) => setTransactionMessageFeePayer(payer.address, msg),
    (msg) => setTransactionMessageLifetimeUsingBlockhash(blockhash2, msg),
    (msg) => appendTransactionMessageInstruction(initIx as any, msg)
  );
  await sendAndConfirm(await signTransactionMessageWithSigners(tx2) as any, { commitment: "confirmed" });

  // TX 3+: Write remaining chunks
  let offset = chunks[0].length;
  for (let i = 1; i < chunks.length; i++) {
    const writeIx = {
      programAddress: CHADBUFFER_PROGRAM_ID,
      accounts: [
        { address: payer.address, role: AccountRole.WRITABLE_SIGNER, signer: payer },
        { address: bufferKeypair.address, role: AccountRole.WRITABLE },
      ],
      data: createWriteInstructionData(offset, chunks[i]),
    };
    offset += chunks[i].length;

    const { value: blockhash } = await rpc.getLatestBlockhash().send();
    const tx = pipe(
      createTransactionMessage({ version: 0 }),
      (msg) => setTransactionMessageFeePayer(payer.address, msg),
      (msg) => setTransactionMessageLifetimeUsingBlockhash(blockhash, msg),
      (msg) => appendTransactionMessageInstruction(writeIx as any, msg)
    );
    await sendAndConfirm(await signTransactionMessageWithSigners(tx) as any, { commitment: "confirmed" });
  }

  console.log(`Buffer created: ${bufferKeypair.address}`);
  console.log(`Transaction size: ${rawTx.length} bytes`);
  console.log(`Chunks uploaded: ${chunks.length}`);

  return bufferKeypair.address;
}

/**
 * Helper to pad a 32-byte seed to 64 bytes for createKeyPairSignerFromBytes
 */
function padTo64Bytes(seed32: Uint8Array): Uint8Array {
  const padded = new Uint8Array(64);
  padded.set(seed32, 0);
  return padded;
}

/**
 * Close buffer and reclaim rent
 */
export async function closeBuffer(
  rpc: Rpc<SolanaRpcApi>,
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>,
  payer: KeyPairSigner,
  bufferAddress: Address,
  recipient?: Address
): Promise<string> {
  // ChadBuffer Close instruction (expects exactly 2 accounts: signer + buffer)
  // Lamports go back to signer automatically
  const closeIx = {
    programAddress: CHADBUFFER_PROGRAM_ID,
    accounts: [
      { address: payer.address, role: AccountRole.WRITABLE_SIGNER, signer: payer },
      { address: bufferAddress, role: AccountRole.WRITABLE },
    ],
    data: createCloseInstructionData(),
  };

  // Get blockhash
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  // Build transaction message
  const txMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (msg) => setTransactionMessageFeePayer(payer.address, msg),
    (msg) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, msg),
    (msg) => appendTransactionMessageInstruction(closeIx as any, msg)
  );

  const signedTx = await signTransactionMessageWithSigners(txMessage);

  // Send and confirm
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await sendAndConfirm(signedTx as any, { commitment: "confirmed" });

  // Return the signature as string
  return getSignatureFromTransaction(signedTx);
}

/**
 * Read buffer data
 */
export async function readBufferData(
  rpc: Rpc<SolanaRpcApi>,
  bufferAddress: Address
): Promise<{ authority: Address; data: Uint8Array }> {
  const accountInfo = await rpc.getAccountInfo(bufferAddress, { encoding: "base64" }).send();
  if (!accountInfo.value) {
    throw new Error("Buffer account not found");
  }

  // Decode base64 data
  const rawData = Buffer.from(accountInfo.value.data[0], "base64");
  const authorityBytes = rawData.slice(0, AUTHORITY_SIZE);
  const data = new Uint8Array(rawData.slice(AUTHORITY_SIZE));

  // Convert authority bytes to Address
  const authority = address(bs58Encode(authorityBytes));

  return { authority, data };
}

/**
 * Simple base58 encoding for addresses
 */
function bs58Encode(bytes: Uint8Array | Buffer): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const byteArray = bytes instanceof Buffer ? new Uint8Array(bytes) : bytes;

  let num = BigInt(0);
  for (let i = 0; i < byteArray.length; i++) {
    num = num * BigInt(256) + BigInt(byteArray[i]);
  }

  let result = "";
  while (num > BigInt(0)) {
    result = ALPHABET[Number(num % BigInt(58))] + result;
    num = num / BigInt(58);
  }

  // Add leading zeros
  for (let i = 0; i < byteArray.length; i++) {
    if (byteArray[i] === 0) {
      result = "1" + result;
    } else {
      break;
    }
  }

  return result || "1";
}

/**
 * Split data into equal-sized chunks
 */
function splitIntoChunks(data: Uint8Array, chunkSize: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += chunkSize) {
    chunks.push(data.slice(i, Math.min(i + chunkSize, data.length)));
  }
  return chunks;
}

/**
 * Fetch raw Bitcoin transaction from Esplora/Blockstream API
 */
export async function fetchRawTransaction(
  txid: string,
  network: "mainnet" | "testnet" = "testnet"
): Promise<Uint8Array> {
  const baseUrl =
    network === "testnet"
      ? "https://blockstream.info/testnet/api"
      : "https://blockstream.info/api";

  const response = await fetch(`${baseUrl}/tx/${txid}/raw`);
  if (!response.ok) {
    throw new Error(`Failed to fetch transaction: ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Fetch merkle proof from Esplora/Blockstream API
 */
export async function fetchMerkleProof(
  txid: string,
  network: "mainnet" | "testnet" = "testnet"
): Promise<{
  blockHeight: number;
  merkleProof: Uint8Array[];
  txIndex: number;
}> {
  const baseUrl =
    network === "testnet"
      ? "https://blockstream.info/testnet/api"
      : "https://blockstream.info/api";

  const response = await fetch(`${baseUrl}/tx/${txid}/merkle-proof`);
  if (!response.ok) {
    throw new Error(`Failed to fetch merkle proof: ${response.statusText}`);
  }

  const data = (await response.json()) as {
    merkle: string[];
    block_height: number;
    pos: number;
  };

  // Parse merkle proof
  const merkleProof = data.merkle.map((hash: string) => {
    const bytes = hexToBytes(hash);
    // Reverse for internal byte order
    bytes.reverse();
    return bytes;
  });

  return {
    blockHeight: data.block_height,
    merkleProof,
    txIndex: data.pos,
  };
}

/**
 * Convert hex string to Uint8Array
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

/**
 * Convert Uint8Array to hex string
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Build merkle proof data for on-chain verification
 *
 * Layout:
 * - txid: [u8; 32]
 * - num_siblings: u8
 * - siblings: [[u8; 32]; num_siblings]
 * - tx_index: u32 (little-endian)
 *
 * @param txidBytes - 32-byte txid (already reversed for internal byte order)
 * @param merkleProof - Array of 32-byte sibling hashes
 * @param txIndex - Transaction index in block
 * @returns Merkle proof data as Uint8Array
 */
export function buildMerkleProof(
  txidBytes: Uint8Array,
  merkleProof: Uint8Array[],
  txIndex: number
): Uint8Array {
  if (txidBytes.length !== 32) {
    throw new Error("txid must be 32 bytes");
  }

  const numSiblings = merkleProof.length;
  // txid (32) + num_siblings (1) + siblings (32 * n) + tx_index (4)
  const totalSize = 32 + 1 + numSiblings * 32 + 4;
  const data = new Uint8Array(totalSize);

  let offset = 0;

  // txid
  data.set(txidBytes, offset);
  offset += 32;

  // num_siblings
  data[offset++] = numSiblings;

  // siblings
  for (const sibling of merkleProof) {
    if (sibling.length !== 32) {
      throw new Error("Each sibling must be 32 bytes");
    }
    data.set(sibling, offset);
    offset += 32;
  }

  // tx_index (u32 little-endian)
  const indexView = new DataView(data.buffer, offset, 4);
  indexView.setUint32(0, txIndex, true);

  return data;
}

/**
 * Complete flow: Fetch tx, upload to buffer, return verification data
 */
export async function prepareVerifyDeposit(
  rpc: Rpc<SolanaRpcApi>,
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>,
  payer: KeyPairSigner,
  txid: string,
  network: "mainnet" | "testnet" = "testnet"
): Promise<{
  bufferAddress: Address;
  transactionSize: number;
  merkleProof: Uint8Array[];
  blockHeight: number;
  txIndex: number;
  txidBytes: Uint8Array;
}> {
  console.log(`Preparing verification for txid: ${txid}`);

  // Fetch raw transaction
  console.log("Fetching raw transaction...");
  const rawTx = await fetchRawTransaction(txid, network);
  console.log(`Raw tx size: ${rawTx.length} bytes`);

  // Fetch merkle proof
  console.log("Fetching merkle proof...");
  const { blockHeight, merkleProof, txIndex } = await fetchMerkleProof(
    txid,
    network
  );
  console.log(`Block height: ${blockHeight}, tx index: ${txIndex}`);

  // Upload to ChadBuffer
  console.log("Uploading to ChadBuffer...");
  const bufferAddress = await uploadTransactionToBuffer(
    rpc,
    rpcSubscriptions,
    payer,
    rawTx
  );

  // Convert txid to bytes (reversed)
  const txidBytes = hexToBytes(txid);
  txidBytes.reverse();

  return {
    bufferAddress,
    transactionSize: rawTx.length,
    merkleProof,
    blockHeight,
    txIndex,
    txidBytes,
  };
}

// =============================================================================
// Proof Upload Utilities
// =============================================================================

/**
 * Check if a proof needs buffer mode (too large for inline)
 *
 * @param proofBytes - Proof data
 * @param availableSpace - Available space in transaction (default: use buffer for any proof > 900 bytes)
 */
export function needsBuffer(proofBytes: Uint8Array, availableSpace: number = 900): boolean {
  return proofBytes.length > availableSpace;
}

/**
 * Result of uploading a proof to buffer
 */
export interface ProofUploadResult {
  /** Buffer account address */
  bufferAddress: Address;
  /** Whether buffer was used (false = inline) */
  usedBuffer: boolean;
  /** Number of chunks uploaded */
  chunksUploaded: number;
  /** Total proof size */
  proofSize: number;
}

/**
 * Upload proof to ChadBuffer if needed
 *
 * Automatically determines if buffer mode is needed based on proof size.
 * Returns buffer address for buffer mode, or null for inline mode.
 *
 * @param rpc - Solana RPC client
 * @param rpcSubscriptions - Solana RPC subscriptions client
 * @param payer - Transaction fee payer
 * @param proofBytes - Raw proof bytes
 * @returns Upload result with buffer address (or null if inline)
 */
export async function uploadProofToBuffer(
  rpc: Rpc<SolanaRpcApi>,
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>,
  payer: KeyPairSigner,
  proofBytes: Uint8Array
): Promise<ProofUploadResult> {
  if (!needsBuffer(proofBytes)) {
    return {
      bufferAddress: null as unknown as Address,
      usedBuffer: false,
      chunksUploaded: 0,
      proofSize: proofBytes.length,
    };
  }

  const bufferAddress = await uploadTransactionToBuffer(
    rpc,
    rpcSubscriptions,
    payer,
    proofBytes
  );

  const chunks = Math.ceil(proofBytes.length / MAX_DATA_PER_WRITE);

  return {
    bufferAddress,
    usedBuffer: true,
    chunksUploaded: chunks,
    proofSize: proofBytes.length,
  };
}

/**
 * Helper to determine proof source mode
 */
export function getProofSource(proofBytes: Uint8Array): "inline" | "buffer" {
  return needsBuffer(proofBytes) ? "buffer" : "inline";
}

/**
 * Calculate required number of transactions for a proof upload
 *
 * @param proofSize - Size of proof in bytes
 * @param useBuffer - Force buffer mode (default: true for proofs > MAX_DATA_PER_WRITE)
 */
export function calculateUploadTransactions(proofSize: number, useBuffer: boolean = true): number {
  if (!useBuffer) {
    return 0; // Inline mode
  }
  // TX 1: CreateAccount
  // TX 2: Init with first chunk
  // TX 3+: Write remaining chunks
  const chunks = Math.ceil(proofSize / MAX_DATA_PER_WRITE);
  return 1 + chunks; // CreateAccount + Init + (chunks-1) writes = 1 + chunks
}
