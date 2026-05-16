/**
 * Stealth Deposit utilities for UTXOPIA
 *
 * Combines BTC deposit verification with automatic stealth announcement.
 * Uses Ed25519 ephemeral keys for ECDH and Baby Jubjub for stealth derivation.
 *
 * OP_RETURN Format (MINIMAL - 32 bytes):
 * - [0-31]    commitment (32 bytes, raw Poseidon hash)
 */

import {
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  pipe,
  signTransactionMessageWithSigners,
  getSignatureFromTransaction,
  getProgramDerivedAddress,
  sendAndConfirmTransactionFactory,
  AccountRole,
  type Address,
  type Rpc,
  type RpcSubscriptions,
  type KeyPairSigner,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
} from "@solana/kit";
import { sha256 } from "@noble/hashes/sha2.js";
import { address } from "./config";

import {
  bytesToBigint,
  bigintToBytes,
  BN254_FIELD_PRIME,
  babyJubMul,
  babyJubAdd,
  BABYJUB_BASE8,
  scalarFromBytes,
  type BabyJubPoint,
} from "./crypto";
import {
  ed25519GenerateKeyPair,
  x25519Ecdh,
} from "./crypto-ed25519";
import type { StealthMetaAddress } from "./keys";
import { parseStealthMetaAddress } from "./keys";
import { deriveTaprootAddress } from "./taproot";
import { poseidonHashSync } from "./poseidon";
import {
  bytesToHex,
} from "./chadbuffer";
import {
  derivePoolStatePDA,
  deriveLightClientPDA,
  deriveCommitmentTreePDA,
  deriveVerifiedTransactionPDA,
} from "./pda";

// ========== Constants ==========

/**
 * Total size of stealth OP_RETURN data
 * = 32 bytes (commitment only)
 */
export const STEALTH_OP_RETURN_SIZE = 32;

/** Instruction discriminator for complete_deposit */
export const COMPLETE_DEPOSIT_DISCRIMINATOR = 11;

import { UTXOPIA_PROGRAM_ID } from "./pda";
import { debug } from "./logger";
const SYSTEM_PROGRAM_ID: Address = address(
  "11111111111111111111111111111111"
);

/** Domain separator for stealth key derivation.
 *  LOAD-BEARING: see stealth.ts for the full note. Stays as "Aegis-stealth-v1". */
const STEALTH_KEY_DOMAIN = new TextEncoder().encode("Aegis-stealth-v1");

// ========== Types ==========

export interface PreparedStealthDeposit {
  btcDepositAddress: string;
  opReturnData: Uint8Array;
  stealthData: StealthDepositData;
}

export interface StealthDepositData {
  /** Ed25519 ephemeral public key (32 bytes) */
  ephemeralPub: Uint8Array;
  commitment: Uint8Array;
}

export interface ParsedStealthOpReturn {
  commitment: Uint8Array;
}

// ========== Helper Functions ==========

/**
 * Derive stealth scalar from X25519 shared secret
 */
function deriveStealthScalar(sharedSecret: Uint8Array): bigint {
  const hashInput = new Uint8Array(sharedSecret.length + STEALTH_KEY_DOMAIN.length);
  hashInput.set(sharedSecret, 0);
  hashInput.set(STEALTH_KEY_DOMAIN, sharedSecret.length);
  const hash = sha256(hashInput);
  return scalarFromBytes(hash);
}

// ========== Sender Functions ==========

/**
 * Ed25519 keypair type for optional ephemeral key injection
 */
export interface Ed25519KeyPair {
  privKey: Uint8Array;
  pubKey: Uint8Array;
}


/**
 * Prepare a stealth deposit for a recipient
 *
 * Uses Ed25519 ephemeral keys for ECDH and Baby Jubjub for stealth derivation.
 */
export async function prepareStealthDeposit(params: {
  recipientMeta: StealthMetaAddress;
  network: "testnet" | "mainnet";
  ephemeralKeyPair?: Ed25519KeyPair;
}): Promise<PreparedStealthDeposit> {
  const { recipientMeta, network, ephemeralKeyPair } = params;

  const { spendingPubKey, viewingPubKey } = parseStealthMetaAddress(recipientMeta);

  // Use provided or generate Ed25519 ephemeral keypair
  const ephemeral = ephemeralKeyPair ?? ed25519GenerateKeyPair();

  // X25519 ECDH
  const sharedSecret = x25519Ecdh(ephemeral.privKey, viewingPubKey);

  // Derive stealth public key (Baby Jubjub)
  const stealthScalar = deriveStealthScalar(sharedSecret);
  const scalarPoint = babyJubMul(stealthScalar, BABYJUB_BASE8);
  const stealthPub = babyJubAdd(spendingPubKey, scalarPoint);

  // Compute commitment (amount-independent)
  const commitmentBigint = poseidonHashSync([stealthPub.x]);
  const commitment = bigintToBytes(commitmentBigint);

  const opReturnData = buildStealthOpReturn({ commitment });

  const { address: btcDepositAddress } = await deriveTaprootAddress(
    commitment,
    network
  );

  return {
    btcDepositAddress,
    opReturnData,
    stealthData: {
      ephemeralPub: new Uint8Array(ephemeral.pubKey),
      commitment,
    },
  };
}

/**
 * Build the OP_RETURN script data (32 bytes commitment)
 */
export function buildStealthOpReturn(params: {
  commitment: Uint8Array;
}): Uint8Array {
  return new Uint8Array(params.commitment);
}

/**
 * Parse stealth data from OP_RETURN
 */
export function parseStealthOpReturn(
  data: Uint8Array
): ParsedStealthOpReturn | null {
  if (data.length !== STEALTH_OP_RETURN_SIZE) {
    return null;
  }
  return { commitment: new Uint8Array(data) };
}

// ========== On-chain Verification ==========

/**
 * Verify a stealth deposit on Solana
 *
 * IMPORTANT: Before calling this, the caller must first call btc-light-client's
 * verify_transaction (disc 3) to create the VerifiedTransaction PDA.
 *
 * @param verifiedTransactionPda - Address of the btc-light-client VerifiedTransaction PDA
 * @param blockHash - Block hash (32 bytes) used to derive the VerifiedTransaction PDA
 */
export async function completeDeposit(
  rpc: Rpc<SolanaRpcApi>,
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>,
  payer: KeyPairSigner,
  btcTxid: string,
  expectedValue: bigint,
  ephemeralPub: Uint8Array,
  npk: Uint8Array,
  blockHeight: number,
  bufferAddress: Address,
  transactionSize: number,
  verifiedTransactionPda: Address,
  network: "mainnet" | "testnet" = "testnet",
  programId: Address = UTXOPIA_PROGRAM_ID
): Promise<string> {
  debug("stealth", "Verify Stealth Deposit", { txid: btcTxid.slice(0, 12) + "...", sats: expectedValue });

  if (ephemeralPub.length !== 32) {
    throw new Error("ephemeralPub must be 32 bytes (Ed25519)");
  }
  if (npk.length !== 32) {
    throw new Error("npk must be 32 bytes");
  }

  // Convert txid to internal byte order
  const txidHex = btcTxid.replace(/^0x/, "");
  const txidBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    txidBytes[i] = parseInt(txidHex.slice(i * 2, i * 2 + 2), 16);
  }
  txidBytes.reverse(); // internal byte order

  const { BTC_LIGHT_CLIENT_PROGRAM_ID } = await import("./pda");
  const [poolState] = await derivePoolStatePDA(programId);
  const [lightClient] = await deriveLightClientPDA(BTC_LIGHT_CLIENT_PROGRAM_ID);
  const [commitmentTree] = await deriveCommitmentTreePDA(programId);

  debug("stealth", "PDAs derived", { pool: String(poolState).slice(0, 8), tree: String(commitmentTree).slice(0, 8) });

  const instructionData = buildVerifyStealthDepositData({
    txid: txidBytes,
    blockHeight: BigInt(blockHeight),
    expectedValue,
    transactionSize,
    ephemeralPub,
    npk,
  });

  // Token-2022 program ID
  const TOKEN_2022_PROGRAM: Address = address(
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
  );

  const instruction = {
    programAddress: programId,
    accounts: [
      { address: poolState, role: AccountRole.WRITABLE },          // 0
      { address: verifiedTransactionPda, role: AccountRole.READONLY }, // 1
      { address: lightClient, role: AccountRole.READONLY },         // 2
      { address: commitmentTree, role: AccountRole.WRITABLE },      // 3
      { address: bufferAddress, role: AccountRole.READONLY },       // 4
      { address: payer.address, role: AccountRole.WRITABLE_SIGNER }, // 5
      { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },   // 6
      // zkBTC mint, pool vault, token_program, deposit_tx_buffer added by caller
    ],
    data: new Uint8Array(instructionData),
  };

  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  const txMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (msg) => setTransactionMessageFeePayer(payer.address, msg),
    (msg) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, msg),
    (msg) => appendTransactionMessageInstruction(instruction, msg)
  );

  const signedTx = await signTransactionMessageWithSigners(txMessage);
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
  await sendAndConfirm(signedTx as any, { commitment: "confirmed" });

  const signature = getSignatureFromTransaction(signedTx);
  debug("stealth", "Transaction confirmed", signature.slice(0, 12));
  return signature;
}

/**
 * Build instruction data for complete_deposit
 *
 * Layout (117 bytes = 1 disc + 116 data):
 * - discriminator: 1 byte
 * - txid: 32 bytes
 * - block_height: 8 bytes
 * - amount_sats: 8 bytes
 * - tx_size: 4 bytes
 * - ephemeral_pub: 32 bytes (Ed25519)
 * - npk: 32 bytes
 */
function buildVerifyStealthDepositData(params: {
  txid: Uint8Array;
  blockHeight: bigint;
  expectedValue: bigint;
  transactionSize: number;
  ephemeralPub: Uint8Array;
  npk: Uint8Array;
}): Uint8Array {
  // discriminator + txid + block_height + amount_sats + tx_size + ephemeral_pub(32) + npk(32)
  const data = new Uint8Array(1 + 32 + 8 + 8 + 4 + 32 + 32);
  let offset = 0;

  data[offset++] = COMPLETE_DEPOSIT_DISCRIMINATOR;

  data.set(params.txid, offset);
  offset += 32;

  const blockHeightBytes = new Uint8Array(8);
  new DataView(blockHeightBytes.buffer).setBigUint64(0, params.blockHeight, true);
  data.set(blockHeightBytes, offset);
  offset += 8;

  const valueBytes = new Uint8Array(8);
  new DataView(valueBytes.buffer).setBigUint64(0, params.expectedValue, true);
  data.set(valueBytes, offset);
  offset += 8;

  const sizeBytes = new Uint8Array(4);
  new DataView(sizeBytes.buffer).setUint32(0, params.transactionSize, true);
  data.set(sizeBytes, offset);
  offset += 4;

  data.set(params.ephemeralPub, offset);
  offset += 32;

  data.set(params.npk, offset);

  return data;
}

/**
 * Extract stealth data from raw BTC transaction
 */
function extractStealthDataFromRawTx(
  rawTx: Uint8Array
): ParsedStealthOpReturn | null {
  for (let i = 0; i < rawTx.length - STEALTH_OP_RETURN_SIZE - 2; i++) {
    if (rawTx[i] === 0x6a) {
      let pushLen = 0;
      let dataStart = i + 2;

      if (rawTx[i + 1] <= 0x4b) {
        pushLen = rawTx[i + 1];
      } else if (rawTx[i + 1] === 0x4c) {
        pushLen = rawTx[i + 2];
        dataStart = i + 3;
      } else if (rawTx[i + 1] === 0x4d) {
        pushLen = rawTx[i + 2] | (rawTx[i + 3] << 8);
        dataStart = i + 4;
      }

      if (pushLen >= STEALTH_OP_RETURN_SIZE && dataStart + pushLen <= rawTx.length) {
        const opReturnData = rawTx.slice(dataStart, dataStart + pushLen);
        const parsed = parseStealthOpReturn(opReturnData);
        if (parsed) {
          return parsed;
        }
      }
    }
  }
  return null;
}
