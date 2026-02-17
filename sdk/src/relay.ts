/**
 * Proof Relay Module
 *
 * Handles relaying ZK proofs via ChadBuffer for large proof support.
 * Used by backend relayer service to submit transactions on behalf of users.
 *
 * Flow:
 * 1. User generates proof client-side
 * 2. User sends proof + params to backend
 * 3. Backend uses this module to:
 *    a. Create ChadBuffer account
 *    b. Upload proof in chunks
 *    c. Build and submit transaction (buffer mode)
 *    d. Close ChadBuffer and reclaim rent
 *
 * @module relay
 */

import {
  address,
  getProgramDerivedAddress,
  generateKeyPairSigner,
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
import { getConfig, TOKEN_2022_PROGRAM_ID, ATA_PROGRAM_ID } from "./config";

/** Instruction type for @solana/kit v2 */
interface Instruction {
  programAddress: Address;
  accounts: Array<{
    address: Address;
    role: (typeof AccountRole)[keyof typeof AccountRole];
    signer?: KeyPairSigner;
  }>;
  data: Uint8Array;
}

// =============================================================================
// ATA Helpers (avoid @solana/spl-token dependency)
// =============================================================================

const TOKEN_2022_PROGRAM: Address = address(TOKEN_2022_PROGRAM_ID);
const ATA_PROGRAM: Address = address(ATA_PROGRAM_ID);
const SYSTEM_PROGRAM: Address = address("11111111111111111111111111111111");

async function getAssociatedTokenAddress(
  mint: Address,
  owner: Address,
  tokenProgram: Address = TOKEN_2022_PROGRAM
): Promise<Address> {
  const [ata] = await getProgramDerivedAddress({
    programAddress: ATA_PROGRAM,
    seeds: [
      getAddressBytes(owner),
      getAddressBytes(tokenProgram),
      getAddressBytes(mint),
    ],
  });
  return ata;
}

function createAssociatedTokenAccountInstruction(
  payer: KeyPairSigner,
  ata: Address,
  owner: Address,
  mint: Address,
  tokenProgram: Address = TOKEN_2022_PROGRAM
): Instruction {
  return {
    programAddress: ATA_PROGRAM,
    accounts: [
      { address: payer.address, role: AccountRole.WRITABLE_SIGNER, signer: payer },
      { address: ata, role: AccountRole.WRITABLE },
      { address: owner, role: AccountRole.READONLY },
      { address: mint, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: tokenProgram, role: AccountRole.READONLY },
    ],
    data: new Uint8Array([0]), // 0 = Create instruction
  };
}

// =============================================================================
// Address/Bytes Helpers
// =============================================================================

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function getAddressBytes(addr: Address): Uint8Array {
  return bs58Decode(addr.toString());
}

function bs58Decode(str: string): Uint8Array {
  let num = 0n;
  for (const char of str) {
    const idx = BASE58_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`Invalid base58 character: ${char}`);
    num = num * 58n + BigInt(idx);
  }

  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num % 256n));
    num = num / 256n;
  }

  // Handle leading zeros
  for (const char of str) {
    if (char === "1") {
      bytes.unshift(0);
    } else {
      break;
    }
  }

  return new Uint8Array(bytes);
}

function bs58Encode(bytes: Uint8Array): string {
  let num = 0n;
  for (const byte of bytes) {
    num = num * 256n + BigInt(byte);
  }

  let result = "";
  while (num > 0n) {
    result = BASE58_ALPHABET[Number(num % 58n)] + result;
    num = num / 58n;
  }

  // Handle leading zeros
  for (const byte of bytes) {
    if (byte === 0) {
      result = "1" + result;
    } else {
      break;
    }
  }

  return result || "1";
}

// =============================================================================
// Constants
// =============================================================================

/** Get ChadBuffer program ID from current config */
function getChadBufferProgramId(): Address {
  return address(getConfig().chadbufferProgramId);
}

/** ChadBuffer program ID (legacy export for backwards compatibility) */
export const CHADBUFFER_PROGRAM_ID: Address = address("CHADufvk3AGLCVG1Pk76xUHZJZjEAj1YLNCgDA1P4YX9");

/** ChadBuffer authority offset (first 32 bytes) */
const CHADBUFFER_AUTHORITY_SIZE = 32;

/**
 * Solana transaction size limit (raw bytes)
 */
const SOLANA_TX_SIZE_LIMIT = 1232;

/**
 * Calculate transaction overhead for ChadBuffer write (versioned v0 transaction)
 *
 * Structure:
 * - Signatures: 1 (compact-u16) + 64 = 65 bytes
 * - Message version: 1 byte
 * - Header: 3 bytes
 * - Account keys: 1 (compact-u16) + 3*32 = 97 bytes (payer, buffer, program)
 * - Recent blockhash: 32 bytes
 * - Instructions: 1 (compact-u16) + instruction
 *   - program_id_index: 1 byte
 *   - accounts: 1 (compact-u16) + 2 = 3 bytes
 *   - data length: 2 bytes (compact-u16 for >127 bytes)
 *   - data header: 1 (disc) + 3 (u24 offset) = 4 bytes
 * - Address lookup tables: 1 byte (empty count)
 *
 * Total fixed overhead: 65 + 1 + 3 + 97 + 32 + 1 + 1 + 3 + 2 + 4 + 1 = 210 bytes
 */
const CHADBUFFER_WRITE_TX_OVERHEAD = 210;

/**
 * Maximum chunk size for uploading
 * Calculated: 1232 - 210 = 1022 bytes max
 * Using 1020 for slight safety margin
 */
const MAX_CHUNK_SIZE = SOLANA_TX_SIZE_LIMIT - CHADBUFFER_WRITE_TX_OVERHEAD - 2; // 1020 bytes

/** ChadBuffer instruction discriminators (from ChadBuffer lib.rs) */
const CHADBUFFER_INIT = 0;    // Create/Init with initial data
const CHADBUFFER_ASSIGN = 1;  // Transfer authority
const CHADBUFFER_WRITE = 2;   // Write at offset
const CHADBUFFER_CLOSE = 3;   // Close buffer and reclaim lamports

/** zVault instruction discriminators */
const SPEND_PARTIAL_PUBLIC = 4;
const SPEND_SPLIT = 3;
const PROOF_SOURCE_BUFFER = 1;

// =============================================================================
// Types
// =============================================================================

/** Parameters for spend_partial_public relay */
export interface RelaySpendPartialPublicParams {
  /** Groth16 proof bytes */
  proof: Uint8Array;
  /** Merkle root (32 bytes) */
  root: Uint8Array;
  /** Nullifier hash (32 bytes) */
  nullifierHash: Uint8Array;
  /** Public amount in sats */
  publicAmountSats: bigint;
  /** Change commitment (32 bytes) */
  changeCommitment: Uint8Array;
  /** Recipient Solana address */
  recipient: Address;
  /** VK hash (32 bytes) */
  vkHash: Uint8Array;
}

/** Parameters for spend_split relay */
export interface RelaySpendSplitParams {
  /** Groth16 proof bytes */
  proof: Uint8Array;
  /** Merkle root (32 bytes) */
  root: Uint8Array;
  /** Nullifier hash (32 bytes) */
  nullifierHash: Uint8Array;
  /** Output commitment 1 (32 bytes) */
  outputCommitment1: Uint8Array;
  /** Output commitment 2 (32 bytes) */
  outputCommitment2: Uint8Array;
  /** VK hash (32 bytes) */
  vkHash: Uint8Array;
}

/** Result of relay operation */
export interface RelayResult {
  /** Transaction signature */
  signature: string;
  /** ChadBuffer address used */
  bufferAddress: string;
  /** Whether buffer was closed and rent reclaimed */
  bufferClosed: boolean;
}

// =============================================================================
// PDA Derivation
// =============================================================================

async function derivePoolStatePDA(programId: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [new TextEncoder().encode("pool")],
  });
  return pda;
}

async function deriveCommitmentTreePDA(programId: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [new TextEncoder().encode("commitment_tree")],
  });
  return pda;
}

async function deriveNullifierPDA(programId: Address, nullifierHash: Uint8Array): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [new TextEncoder().encode("nullifier"), nullifierHash],
  });
  return pda;
}

async function deriveZbtcMintPDA(programId: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [new TextEncoder().encode("zbtc_mint")],
  });
  return pda;
}

// =============================================================================
// ChadBuffer Operations
// =============================================================================

/**
 * Create a ChadBuffer account for storing proof data
 */
export async function createChadBuffer(
  rpc: Rpc<SolanaRpcApi>,
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>,
  payer: KeyPairSigner,
  proofSize: number
): Promise<{ keypair: KeyPairSigner; signature: string }> {
  const bufferKeypair = await generateKeyPairSigner();
  const bufferSize = CHADBUFFER_AUTHORITY_SIZE + proofSize;

  const rentExemption = await rpc.getMinimumBalanceForRentExemption(BigInt(bufferSize)).send();
  const { value: blockhash } = await rpc.getLatestBlockhash().send();

  const createAccountIx = getCreateAccountInstruction({
    payer,
    newAccount: bufferKeypair,
    lamports: rentExemption,
    space: BigInt(bufferSize),
    programAddress: getChadBufferProgramId(),
  });

  const initIx: Instruction = {
    programAddress: getChadBufferProgramId(),
    accounts: [
      { address: payer.address, role: AccountRole.WRITABLE_SIGNER, signer: payer },
      { address: bufferKeypair.address, role: AccountRole.WRITABLE },
    ],
    data: new Uint8Array([CHADBUFFER_INIT]),
  };

  const tx = pipe(
    createTransactionMessage({ version: 0 }),
    (msg) => setTransactionMessageFeePayer(payer.address, msg),
    (msg) => setTransactionMessageLifetimeUsingBlockhash(blockhash, msg),
    (msg) => appendTransactionMessageInstructions([createAccountIx, initIx], msg)
  );

  const signedTx = await signTransactionMessageWithSigners(tx);
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
  await sendAndConfirm(signedTx as any, { commitment: "confirmed" });

  return { keypair: bufferKeypair, signature: getSignatureFromTransaction(signedTx) };
}

/**
 * Upload proof to ChadBuffer in chunks
 */
export async function uploadProofToBuffer(
  rpc: Rpc<SolanaRpcApi>,
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>,
  payer: KeyPairSigner,
  bufferAddress: Address,
  proof: Uint8Array,
  onProgress?: (uploaded: number, total: number) => void
): Promise<string[]> {
  const signatures: string[] = [];
  let offset = 0;
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

  while (offset < proof.length) {
    const chunkSize = Math.min(MAX_CHUNK_SIZE, proof.length - offset);
    const chunk = proof.slice(offset, offset + chunkSize);

    // ChadBuffer Write instruction: discriminator(1) + u24_offset(3) + data
    const writeData = new Uint8Array(1 + 3 + chunk.length);
    writeData[0] = CHADBUFFER_WRITE;
    // Write u24 offset (little-endian, 3 bytes)
    writeData[1] = offset & 0xff;
    writeData[2] = (offset >> 8) & 0xff;
    writeData[3] = (offset >> 16) & 0xff;
    writeData.set(chunk, 4);

    const writeIx: Instruction = {
      programAddress: getChadBufferProgramId(),
      accounts: [
        { address: payer.address, role: AccountRole.WRITABLE_SIGNER, signer: payer },
        { address: bufferAddress, role: AccountRole.WRITABLE },
      ],
      data: writeData,
    };

    const { value: blockhash } = await rpc.getLatestBlockhash().send();
    const tx = pipe(
      createTransactionMessage({ version: 0 }),
      (msg) => setTransactionMessageFeePayer(payer.address, msg),
      (msg) => setTransactionMessageLifetimeUsingBlockhash(blockhash, msg),
      (msg) => appendTransactionMessageInstruction(writeIx, msg)
    );

    const signedTx = await signTransactionMessageWithSigners(tx);
    await sendAndConfirm(signedTx as any, { commitment: "confirmed" });
    signatures.push(getSignatureFromTransaction(signedTx));

    offset += chunkSize;
    onProgress?.(offset, proof.length);
  }

  return signatures;
}

/**
 * Close ChadBuffer and reclaim rent
 */
export async function closeChadBuffer(
  rpc: Rpc<SolanaRpcApi>,
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>,
  payer: KeyPairSigner,
  bufferAddress: Address
): Promise<string> {
  const closeIx: Instruction = {
    programAddress: getChadBufferProgramId(),
    accounts: [
      { address: payer.address, role: AccountRole.WRITABLE_SIGNER, signer: payer },
      { address: bufferAddress, role: AccountRole.WRITABLE },
    ],
    data: new Uint8Array([CHADBUFFER_CLOSE]),
  };

  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const tx = pipe(
    createTransactionMessage({ version: 0 }),
    (msg) => setTransactionMessageFeePayer(payer.address, msg),
    (msg) => setTransactionMessageLifetimeUsingBlockhash(blockhash, msg),
    (msg) => appendTransactionMessageInstruction(closeIx, msg)
  );

  const signedTx = await signTransactionMessageWithSigners(tx);
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
  await sendAndConfirm(signedTx as any, { commitment: "confirmed" });

  return getSignatureFromTransaction(signedTx);
}

// =============================================================================
// Compute Budget Helper
// =============================================================================

/** Compute Budget Program ID */
const COMPUTE_BUDGET_PROGRAM: Address = address("ComputeBudget111111111111111111111111111111");

function createSetComputeUnitLimitInstruction(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 2; // SetComputeUnitLimit instruction
  const view = new DataView(data.buffer);
  view.setUint32(1, units, true);
  return {
    programAddress: COMPUTE_BUDGET_PROGRAM,
    accounts: [],
    data,
  };
}

// =============================================================================
// Relay Functions
// =============================================================================

/**
 * Relay a spend_partial_public transaction
 *
 * Full flow:
 * 1. Create ChadBuffer
 * 2. Upload proof in chunks
 * 3. Submit zVault transaction (buffer mode)
 * 4. Close buffer and reclaim rent
 */
export async function relaySpendPartialPublic(
  rpc: Rpc<SolanaRpcApi>,
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>,
  relayer: KeyPairSigner,
  params: RelaySpendPartialPublicParams,
  onProgress?: (stage: string, progress?: number) => void
): Promise<RelayResult> {
  const config = getConfig();
  const zvaultProgram = address(config.zvaultProgramId);
  const groth16Verifier = address(config.groth16VerifierProgramId);

  onProgress?.("Creating buffer...");

  // 1. Create ChadBuffer
  const { keypair: bufferKeypair } = await createChadBuffer(
    rpc,
    rpcSubscriptions,
    relayer,
    params.proof.length
  );

  onProgress?.("Uploading proof...", 0);

  // 2. Upload proof in chunks
  await uploadProofToBuffer(
    rpc,
    rpcSubscriptions,
    relayer,
    bufferKeypair.address,
    params.proof,
    (uploaded, total) => onProgress?.("Uploading proof...", (uploaded / total) * 100)
  );

  onProgress?.("Building transaction...");

  // 3. Build and submit zVault transaction
  const poolState = await derivePoolStatePDA(zvaultProgram);
  const commitmentTree = await deriveCommitmentTreePDA(zvaultProgram);
  const nullifierPDA = await deriveNullifierPDA(zvaultProgram, params.nullifierHash);
  const zbtcMint = await deriveZbtcMintPDA(zvaultProgram);
  const poolVault = await getAssociatedTokenAddress(zbtcMint, poolState, TOKEN_2022_PROGRAM);
  const recipientAta = await getAssociatedTokenAddress(
    zbtcMint,
    params.recipient,
    TOKEN_2022_PROGRAM
  );

  // Build instruction data (buffer mode)
  const ixData = new Uint8Array(1 + 1 + 32 + 32 + 8 + 32 + 32 + 32);
  let offset = 0;
  ixData[offset++] = SPEND_PARTIAL_PUBLIC;
  ixData[offset++] = PROOF_SOURCE_BUFFER;
  ixData.set(params.root, offset); offset += 32;
  ixData.set(params.nullifierHash, offset); offset += 32;
  const amountView = new DataView(ixData.buffer, offset, 8);
  amountView.setBigUint64(0, params.publicAmountSats, true);
  offset += 8;
  ixData.set(params.changeCommitment, offset); offset += 32;
  ixData.set(getAddressBytes(params.recipient), offset); offset += 32;
  ixData.set(params.vkHash, offset);

  // Check if recipient ATA exists, create if needed
  const recipientAtaInfo = await rpc.getAccountInfo(recipientAta, { encoding: "base64" }).send();
  const instructions: Instruction[] = [];

  // Add compute budget for ZK verification
  instructions.push(createSetComputeUnitLimitInstruction(1_400_000));

  if (!recipientAtaInfo.value) {
    instructions.push(
      createAssociatedTokenAccountInstruction(
        relayer,
        recipientAta,
        params.recipient,
        zbtcMint,
        TOKEN_2022_PROGRAM
      )
    );
  }

  instructions.push({
    programAddress: zvaultProgram,
    accounts: [
      { address: poolState, role: AccountRole.WRITABLE },
      { address: commitmentTree, role: AccountRole.WRITABLE },
      { address: nullifierPDA, role: AccountRole.WRITABLE },
      { address: zbtcMint, role: AccountRole.WRITABLE },
      { address: poolVault, role: AccountRole.WRITABLE },
      { address: recipientAta, role: AccountRole.WRITABLE },
      { address: relayer.address, role: AccountRole.WRITABLE_SIGNER, signer: relayer },
      { address: TOKEN_2022_PROGRAM, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: groth16Verifier, role: AccountRole.READONLY },
      { address: bufferKeypair.address, role: AccountRole.READONLY },
    ],
    data: ixData,
  });

  onProgress?.("Submitting transaction...");

  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const tx = pipe(
    createTransactionMessage({ version: 0 }),
    (msg) => setTransactionMessageFeePayer(relayer.address, msg),
    (msg) => setTransactionMessageLifetimeUsingBlockhash(blockhash, msg),
    (msg) => appendTransactionMessageInstructions(instructions, msg)
  );

  const signedTx = await signTransactionMessageWithSigners(tx);
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
  await sendAndConfirm(signedTx as any, { commitment: "confirmed" });

  const signature = getSignatureFromTransaction(signedTx);

  onProgress?.("Closing buffer...");

  // 4. Close buffer and reclaim rent
  let bufferClosed = false;
  try {
    await closeChadBuffer(rpc, rpcSubscriptions, relayer, bufferKeypair.address);
    bufferClosed = true;
  } catch (e) {
    console.warn("Failed to close buffer:", e);
  }

  onProgress?.("Done!");

  return {
    signature,
    bufferAddress: bufferKeypair.address,
    bufferClosed,
  };
}

/**
 * Relay a spend_split transaction
 */
export async function relaySpendSplit(
  rpc: Rpc<SolanaRpcApi>,
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>,
  relayer: KeyPairSigner,
  params: RelaySpendSplitParams,
  onProgress?: (stage: string, progress?: number) => void
): Promise<RelayResult> {
  const config = getConfig();
  const zvaultProgram = address(config.zvaultProgramId);
  const groth16Verifier = address(config.groth16VerifierProgramId);

  onProgress?.("Creating buffer...");

  // 1. Create ChadBuffer
  const { keypair: bufferKeypair } = await createChadBuffer(
    rpc,
    rpcSubscriptions,
    relayer,
    params.proof.length
  );

  onProgress?.("Uploading proof...", 0);

  // 2. Upload proof in chunks
  await uploadProofToBuffer(
    rpc,
    rpcSubscriptions,
    relayer,
    bufferKeypair.address,
    params.proof,
    (uploaded, total) => onProgress?.("Uploading proof...", (uploaded / total) * 100)
  );

  onProgress?.("Building transaction...");

  // 3. Build and submit zVault transaction
  const poolState = await derivePoolStatePDA(zvaultProgram);
  const commitmentTree = await deriveCommitmentTreePDA(zvaultProgram);
  const nullifierPDA = await deriveNullifierPDA(zvaultProgram, params.nullifierHash);

  // Build instruction data (buffer mode)
  const ixData = new Uint8Array(1 + 1 + 32 + 32 + 32 + 32 + 32);
  let offset = 0;
  ixData[offset++] = SPEND_SPLIT;
  ixData[offset++] = PROOF_SOURCE_BUFFER;
  ixData.set(params.root, offset); offset += 32;
  ixData.set(params.nullifierHash, offset); offset += 32;
  ixData.set(params.outputCommitment1, offset); offset += 32;
  ixData.set(params.outputCommitment2, offset); offset += 32;
  ixData.set(params.vkHash, offset);

  const instructions: Instruction[] = [];

  // Add compute budget for ZK verification
  instructions.push(createSetComputeUnitLimitInstruction(1_400_000));

  instructions.push({
    programAddress: zvaultProgram,
    accounts: [
      { address: poolState, role: AccountRole.WRITABLE },
      { address: commitmentTree, role: AccountRole.WRITABLE },
      { address: nullifierPDA, role: AccountRole.WRITABLE },
      { address: relayer.address, role: AccountRole.WRITABLE_SIGNER, signer: relayer },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: groth16Verifier, role: AccountRole.READONLY },
      { address: bufferKeypair.address, role: AccountRole.READONLY },
    ],
    data: ixData,
  });

  onProgress?.("Submitting transaction...");

  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const tx = pipe(
    createTransactionMessage({ version: 0 }),
    (msg) => setTransactionMessageFeePayer(relayer.address, msg),
    (msg) => setTransactionMessageLifetimeUsingBlockhash(blockhash, msg),
    (msg) => appendTransactionMessageInstructions(instructions, msg)
  );

  const signedTx = await signTransactionMessageWithSigners(tx);
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
  await sendAndConfirm(signedTx as any, { commitment: "confirmed" });

  const signature = getSignatureFromTransaction(signedTx);

  onProgress?.("Closing buffer...");

  // 4. Close buffer and reclaim rent
  let bufferClosed = false;
  try {
    await closeChadBuffer(rpc, rpcSubscriptions, relayer, bufferKeypair.address);
    bufferClosed = true;
  } catch (e) {
    console.warn("Failed to close buffer:", e);
  }

  onProgress?.("Done!");

  return {
    signature,
    bufferAddress: bufferKeypair.address,
    bufferClosed,
  };
}
