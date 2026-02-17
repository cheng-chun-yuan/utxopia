/**
 * Stealth Deposit utilities for ZVault
 *
 * Combines BTC deposit verification with automatic stealth announcement.
 * Uses Ed25519 ephemeral keys for ECDH and Baby Jubjub for stealth derivation.
 *
 * OP_RETURN Format (MINIMAL - 32 bytes):
 * - [0-31]    commitment (32 bytes, raw Poseidon hash)
 */

import {
  address,
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
  prepareVerifyDeposit,
  bytesToHex,
  fetchRawTransaction,
  fetchMerkleProof,
  uploadTransactionToBuffer,
} from "./chadbuffer";
import {
  derivePoolStatePDA,
  deriveLightClientPDA,
  deriveBlockHeaderPDA,
  deriveCommitmentTreePDA,
  deriveDepositRecordPDA,
} from "./pda";
import { buildMerkleProof } from "./chadbuffer";

// ========== Constants ==========

/**
 * Total size of stealth OP_RETURN data
 * = 32 bytes (commitment only)
 */
export const STEALTH_OP_RETURN_SIZE = 32;

/** Instruction discriminator for verify_stealth_deposit */
export const VERIFY_STEALTH_DEPOSIT_DISCRIMINATOR = 1;

import { ZVAULT_PROGRAM_ID } from "./pda";
const SYSTEM_PROGRAM_ID: Address = address(
  "11111111111111111111111111111111"
);

/** Domain separator for stealth key derivation */
const STEALTH_KEY_DOMAIN = new TextEncoder().encode("zVault-stealth-v1");

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
 * Derive stealth announcement PDA
 *
 * Uses Ed25519 ephemeral public key (32 bytes) as seed.
 */
export async function deriveStealthAnnouncementPDA(
  programId: Address,
  ephemeralPub: Uint8Array
): Promise<[Address, number]> {
  const seeds = [
    new TextEncoder().encode("stealth"),
    ephemeralPub,
  ];
  const [pda, bump] = await getProgramDerivedAddress({
    seeds,
    programAddress: programId,
  });
  return [pda, bump];
}

/**
 * Verify a stealth deposit on Solana
 */
export async function verifyStealthDeposit(
  rpc: Rpc<SolanaRpcApi>,
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>,
  payer: KeyPairSigner,
  btcTxid: string,
  expectedValue: bigint,
  ephemeralPub: Uint8Array,
  network: "mainnet" | "testnet" = "testnet",
  programId: Address = ZVAULT_PROGRAM_ID
): Promise<string> {
  console.log("=== Verify Stealth Deposit ===");
  console.log(`Txid: ${btcTxid}`);
  console.log(`Expected value: ${expectedValue} sats`);

  if (ephemeralPub.length !== 32) {
    throw new Error("ephemeralPub must be 32 bytes (Ed25519)");
  }

  const {
    bufferAddress,
    transactionSize,
    merkleProof,
    blockHeight,
    txIndex,
    txidBytes,
  } = await prepareVerifyDeposit(rpc, rpcSubscriptions, payer, btcTxid, network);

  const rawTx = await fetchRawTransaction(btcTxid, network);
  const stealthData = extractStealthDataFromRawTx(rawTx);
  if (!stealthData) {
    throw new Error("Could not find stealth OP_RETURN in transaction");
  }

  const [poolState] = await derivePoolStatePDA(programId);
  const [lightClient] = await deriveLightClientPDA(programId);
  const [blockHeader] = await deriveBlockHeaderPDA(blockHeight, programId);
  const [commitmentTree] = await deriveCommitmentTreePDA(programId);
  const [depositRecord] = await deriveDepositRecordPDA(txidBytes, programId);
  const [stealthAnnouncement] = await deriveStealthAnnouncementPDA(
    programId,
    ephemeralPub
  );

  console.log("PDAs derived:");
  console.log(`  Pool: ${poolState}`);
  console.log(`  Light Client: ${lightClient}`);
  console.log(`  Block Header: ${blockHeader}`);
  console.log(`  Commitment Tree: ${commitmentTree}`);
  console.log(`  Deposit Record: ${depositRecord}`);
  console.log(`  Stealth Announcement: ${stealthAnnouncement}`);

  const merkleProofData = buildMerkleProof(txidBytes, merkleProof, txIndex);

  const instructionData = buildVerifyStealthDepositData({
    txid: txidBytes,
    blockHeight: BigInt(blockHeight),
    expectedValue,
    transactionSize,
    merkleProof: merkleProofData,
    ephemeralPub,
  });

  const instruction = {
    programAddress: programId,
    accounts: [
      { address: poolState, role: AccountRole.WRITABLE },
      { address: lightClient, role: AccountRole.READONLY },
      { address: blockHeader, role: AccountRole.READONLY },
      { address: commitmentTree, role: AccountRole.WRITABLE },
      { address: depositRecord, role: AccountRole.WRITABLE },
      { address: stealthAnnouncement, role: AccountRole.WRITABLE },
      { address: bufferAddress, role: AccountRole.READONLY },
      { address: payer.address, role: AccountRole.WRITABLE_SIGNER },
      { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
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
  console.log(`Transaction confirmed: ${signature}`);
  return signature;
}

/**
 * Build instruction data for verify_stealth_deposit
 *
 * Ephemeral key is now 32 bytes (Ed25519).
 */
function buildVerifyStealthDepositData(params: {
  txid: Uint8Array;
  blockHeight: bigint;
  expectedValue: bigint;
  transactionSize: number;
  merkleProof: Uint8Array;
  ephemeralPub: Uint8Array;
}): Uint8Array {
  // discriminator + txid + block_height + expected_value + tx_size + ephemeral_pub(32) + merkle_proof
  const data = new Uint8Array(1 + 32 + 8 + 8 + 4 + 32 + params.merkleProof.length);
  let offset = 0;

  data[offset++] = VERIFY_STEALTH_DEPOSIT_DISCRIMINATOR;

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

  data.set(params.merkleProof, offset);

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
