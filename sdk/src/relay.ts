/**
 * ChadBuffer Relay Module (JoinSplit Architecture)
 *
 * Provides ChadBuffer utilities for uploading large data to Solana.
 * Used by backend relayer service to submit transactions on behalf of users.
 *
 * @module relay
 */

import {
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
import { address, getConfig } from "./config";

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
// Constants
// =============================================================================

/** Get ChadBuffer program ID from current config */
function getChadBufferProgramId(): Address {
  return address(getConfig().chadbufferProgramId);
}

/** ChadBuffer authority offset (first 32 bytes) */
const CHADBUFFER_AUTHORITY_SIZE = 32;

/** Solana transaction size limit (raw bytes) */
const SOLANA_TX_SIZE_LIMIT = 1232;

/** Transaction overhead for ChadBuffer write */
const CHADBUFFER_WRITE_TX_OVERHEAD = 210;

/** Maximum chunk size for uploading */
const MAX_CHUNK_SIZE = SOLANA_TX_SIZE_LIMIT - CHADBUFFER_WRITE_TX_OVERHEAD - 2; // 1020 bytes

/** ChadBuffer instruction discriminators */
const CHADBUFFER_INIT = 0;
const CHADBUFFER_WRITE = 2;
const CHADBUFFER_CLOSE = 3;

// =============================================================================
// Types
// =============================================================================

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

    const writeData = new Uint8Array(1 + 3 + chunk.length);
    writeData[0] = CHADBUFFER_WRITE;
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
