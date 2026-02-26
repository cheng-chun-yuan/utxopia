/**
 * ZVault Instruction Builders (JoinSplit Architecture)
 *
 * Low-level instruction building for ZVault operations.
 * All Groth16 proofs are verified inline using BN254 pairing syscalls.
 *
 * @module instructions
 */

import {
  address,
  AccountRole,
  type Address,
} from "@solana/kit";

import { getConfig, TOKEN_2022_PROGRAM_ID } from "./config";

/** System program address */
const SYSTEM_PROGRAM_ADDRESS = address("11111111111111111111111111111111");

// =============================================================================
// Types
// =============================================================================

/** Instruction type for v2 */
export interface Instruction {
  programAddress: Address;
  accounts: Array<{ address: Address; role: (typeof AccountRole)[keyof typeof AccountRole] }>;
  data: Uint8Array;
}

// =============================================================================
// Constants
// =============================================================================

/** Instruction discriminators (must match contracts/programs/zvault/src/lib.rs) */
const INSTRUCTION = {
  INITIALIZE: 0,
  VERIFY_STEALTH_DEPOSIT: 1,
  REQUEST_REDEMPTION: 5,
  COMPLETE_REDEMPTION: 6,
  SET_PAUSED: 7,
  REGISTER_NAME: 8,
  UPDATE_NAME: 9,
  TRANSFER_NAME: 10,
  INIT_VK_REGISTRY: 11,
  UPDATE_VK_REGISTRY: 12,
  ADD_DEMO_STEALTH: 13,
  TRANSACT: 14,
} as const;

/** Export instruction discriminators for consumers */
export const INSTRUCTION_DISCRIMINATORS = INSTRUCTION;

// =============================================================================
// Utilities
// =============================================================================

/**
 * Simple base58 decoding for addresses
 */
function bs58Decode(str: string): Uint8Array {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const ALPHABET_MAP = new Map<string, number>();
  for (let i = 0; i < ALPHABET.length; i++) {
    ALPHABET_MAP.set(ALPHABET[i], i);
  }

  let num = BigInt(0);
  for (const char of str) {
    const val = ALPHABET_MAP.get(char);
    if (val === undefined) {
      throw new Error(`Invalid base58 character: ${char}`);
    }
    num = num * BigInt(58) + BigInt(val);
  }

  // Count leading zeros
  let leadingZeros = 0;
  for (const char of str) {
    if (char === "1") {
      leadingZeros++;
    } else {
      break;
    }
  }

  // Convert to bytes
  const bytes: number[] = [];
  while (num > BigInt(0)) {
    bytes.unshift(Number(num % BigInt(256)));
    num = num / BigInt(256);
  }

  // Add leading zeros
  for (let i = 0; i < leadingZeros; i++) {
    bytes.unshift(0);
  }

  // Ensure 32 bytes for Solana addresses
  while (bytes.length < 32) {
    bytes.unshift(0);
  }

  return new Uint8Array(bytes);
}

/**
 * Convert Address to bytes
 */
function addressToBytes(addr: Address): Uint8Array {
  return bs58Decode(addr.toString());
}

// =============================================================================
// Redemption Request Instruction Builder
// =============================================================================

/**
 * Build instruction data for REQUEST_REDEMPTION
 *
 * Creates a RedemptionRequest PDA with the scriptPubKey for BTC withdrawal.
 *
 * Layout:
 * - discriminator (1 byte) = 5
 * - amount_sats (8 bytes, LE)
 * - btc_script_len (1 byte)
 * - btc_script (variable, max 62 bytes - scriptPubKey)
 *
 * @param amountSats - Amount to redeem in satoshis
 * @param btcScript - Bitcoin scriptPubKey for withdrawal (raw bytes, max 62 bytes)
 */
export function buildRedemptionRequestInstructionData(
  amountSats: bigint,
  btcScript: Uint8Array
): Uint8Array {
  if (btcScript.length > 62) {
    throw new Error("BTC scriptPubKey too long (max 62 bytes)");
  }

  // Layout: discriminator(1) + amount(8) + script_len(1) + script
  const totalLen = 1 + 8 + 1 + btcScript.length;
  const data = new Uint8Array(totalLen);
  const view = new DataView(data.buffer);

  let offset = 0;
  data[offset++] = INSTRUCTION.REQUEST_REDEMPTION;

  view.setBigUint64(offset, amountSats, true);
  offset += 8;

  data[offset++] = btcScript.length;
  data.set(btcScript, offset);

  return data;
}

/** Redemption request instruction options */
export interface RedemptionRequestInstructionOptions {
  /** Amount to redeem in satoshis */
  amountSats: bigint;
  /** Bitcoin scriptPubKey for withdrawal (raw bytes) */
  btcScript: Uint8Array;
  /** Account addresses */
  accounts: {
    poolState: Address;
    zbtcMint: Address;
    userTokenAccount: Address;
    user: Address;
  };
}

/**
 * Build a complete redemption request instruction
 */
export function buildRedemptionRequestInstruction(
  options: RedemptionRequestInstructionOptions
): Instruction {
  const config = getConfig();

  const data = buildRedemptionRequestInstructionData(
    options.amountSats,
    options.btcScript
  );

  const accounts: Instruction["accounts"] = [
    { address: options.accounts.poolState, role: AccountRole.WRITABLE },
    { address: options.accounts.zbtcMint, role: AccountRole.WRITABLE },
    { address: options.accounts.userTokenAccount, role: AccountRole.WRITABLE },
    { address: options.accounts.user, role: AccountRole.WRITABLE_SIGNER },
    { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    { address: TOKEN_2022_PROGRAM_ID, role: AccountRole.READONLY },
  ];

  return {
    programAddress: config.zvaultProgramId,
    accounts,
    data,
  };
}

// =============================================================================
// Complete Redemption Instruction Builder
// =============================================================================

/** Complete redemption instruction options */
export interface CompleteRedemptionInstructionOptions {
  /** BTC transaction ID (internal byte order, 32 bytes) */
  btcTxid: Uint8Array;
  /** Raw tx size in ChadBuffer */
  txSize: number;
  /** Account addresses */
  accounts: {
    poolState: Address;
    redemptionRequest: Address;
    authority: Address;
    rentRecipient: Address;
    verifiedTransaction: Address;
    lightClient: Address;
    txBuffer: Address;
    zbtcMint: Address;
    poolVault: Address;
  };
}

/**
 * Build instruction data for COMPLETE_REDEMPTION
 *
 * Layout:
 * - discriminator (1 byte) = 6
 * - btc_txid (32 bytes)
 * - tx_size (4 bytes, LE)
 */
export function buildCompleteRedemptionInstructionData(
  btcTxid: Uint8Array,
  txSize: number,
): Uint8Array {
  const data = new Uint8Array(1 + 32 + 4);
  const view = new DataView(data.buffer);

  let offset = 0;
  data[offset++] = INSTRUCTION.COMPLETE_REDEMPTION;

  data.set(btcTxid, offset);
  offset += 32;

  view.setUint32(offset, txSize, true);

  return data;
}

/**
 * Build a complete redemption instruction
 */
export function buildCompleteRedemptionInstruction(
  options: CompleteRedemptionInstructionOptions
): Instruction {
  const config = getConfig();

  const data = buildCompleteRedemptionInstructionData(
    options.btcTxid,
    options.txSize,
  );

  const accounts: Instruction["accounts"] = [
    { address: options.accounts.poolState, role: AccountRole.WRITABLE },
    { address: options.accounts.redemptionRequest, role: AccountRole.WRITABLE },
    { address: options.accounts.authority, role: AccountRole.WRITABLE_SIGNER },
    { address: options.accounts.rentRecipient, role: AccountRole.READONLY },
    { address: options.accounts.verifiedTransaction, role: AccountRole.READONLY },
    { address: options.accounts.lightClient, role: AccountRole.READONLY },
    { address: options.accounts.txBuffer, role: AccountRole.READONLY },
    { address: options.accounts.zbtcMint, role: AccountRole.WRITABLE },
    { address: options.accounts.poolVault, role: AccountRole.WRITABLE },
    { address: TOKEN_2022_PROGRAM_ID, role: AccountRole.READONLY },
  ];

  return {
    programAddress: config.zvaultProgramId,
    accounts,
    data,
  };
}

// =============================================================================
// JoinSplit Transact Instruction Builder
// =============================================================================

/** JoinSplit transact instruction options */
export interface TransactInstructionOptions {
  /** Number of input notes being spent */
  nInputs: number;
  /** Number of output notes being created */
  nOutputs: number;
  /** Groth16 proof bytes (256 bytes) */
  proofBytes: Uint8Array;
  /** Merkle root */
  merkleRoot: Uint8Array;
  /** Bound parameters hash */
  boundParamsHash: Uint8Array;
  /** Nullifiers (32 bytes each) */
  nullifiers: Uint8Array[];
  /** Output commitments (32 bytes each) */
  commitmentsOut: Uint8Array[];
  /** Per-output stealth data: ephemeral_pub (32) + encrypted_amount (8) */
  stealthData: Uint8Array[];
  /** Account addresses */
  accounts: {
    poolState: Address;
    commitmentTree: Address;
    vkRegistry: Address;
    user: Address;
    /** Nullifier record PDAs (one per input) */
    nullifierRecords: Address[];
    /** Stealth announcement PDAs (one per output) */
    stealthAnnouncements: Address[];
  };
}

/**
 * Build transact instruction data (JoinSplit)
 *
 * Layout:
 * - n_inputs: u8
 * - n_outputs: u8
 * - proof: [u8; 256]
 * - merkle_root: [u8; 32]
 * - bound_params_hash: [u8; 32]
 * - nullifiers: [[u8; 32]; n_inputs]
 * - commitments_out: [[u8; 32]; n_outputs]
 * - stealth_data: [ephemeral_pub(32) + encrypted_amount(8)] x n_outputs
 */
export function buildTransactInstructionData(options: {
  nInputs: number;
  nOutputs: number;
  proofBytes: Uint8Array;
  merkleRoot: Uint8Array;
  boundParamsHash: Uint8Array;
  nullifiers: Uint8Array[];
  commitmentsOut: Uint8Array[];
  stealthData: Uint8Array[];
}): Uint8Array {
  const { nInputs, nOutputs, proofBytes, merkleRoot, boundParamsHash, nullifiers, commitmentsOut, stealthData } = options;

  if (proofBytes.length !== 256) {
    throw new Error(`Groth16 proof must be 256 bytes, got ${proofBytes.length}`);
  }
  if (nullifiers.length !== nInputs) {
    throw new Error(`Expected ${nInputs} nullifiers, got ${nullifiers.length}`);
  }
  if (commitmentsOut.length !== nOutputs) {
    throw new Error(`Expected ${nOutputs} commitments, got ${commitmentsOut.length}`);
  }
  if (stealthData.length !== nOutputs) {
    throw new Error(`Expected ${nOutputs} stealth data entries, got ${stealthData.length}`);
  }

  const STEALTH_DATA_PER_OUTPUT = 40; // 32 + 8
  const totalSize = 1 + 2 + 256 + 32 + 32 + (nInputs * 32) + (nOutputs * 32) + (nOutputs * STEALTH_DATA_PER_OUTPUT);
  const data = new Uint8Array(totalSize);

  let offset = 0;

  // Discriminator
  data[offset++] = INSTRUCTION.TRANSACT;

  // Header
  data[offset++] = nInputs;
  data[offset++] = nOutputs;

  // Proof (256 bytes)
  data.set(proofBytes, offset);
  offset += 256;

  // Merkle root (32 bytes)
  data.set(merkleRoot, offset);
  offset += 32;

  // Bound params hash (32 bytes)
  data.set(boundParamsHash, offset);
  offset += 32;

  // Nullifiers
  for (const nullifier of nullifiers) {
    data.set(nullifier, offset);
    offset += 32;
  }

  // Output commitments
  for (const commitment of commitmentsOut) {
    data.set(commitment, offset);
    offset += 32;
  }

  // Stealth data (ephemeral_pub + encrypted_amount per output)
  for (const sd of stealthData) {
    data.set(sd.slice(0, STEALTH_DATA_PER_OUTPUT), offset);
    offset += STEALTH_DATA_PER_OUTPUT;
  }

  return data;
}

/**
 * Build a complete JoinSplit transact instruction
 *
 * Accounts:
 * 0. pool_state (writable)
 * 1. commitment_tree (writable)
 * 2. vk_registry (read)
 * 3. user (signer)
 * 4. system_program (read)
 * 5..5+N nullifier_records (writable)
 * 5+N..5+N+M stealth_announcements (writable)
 */
export function buildTransactInstruction(options: TransactInstructionOptions): Instruction {
  const config = getConfig();

  const data = buildTransactInstructionData({
    nInputs: options.nInputs,
    nOutputs: options.nOutputs,
    proofBytes: options.proofBytes,
    merkleRoot: options.merkleRoot,
    boundParamsHash: options.boundParamsHash,
    nullifiers: options.nullifiers,
    commitmentsOut: options.commitmentsOut,
    stealthData: options.stealthData,
  });

  const accounts: Instruction["accounts"] = [
    { address: options.accounts.poolState, role: AccountRole.WRITABLE },
    { address: options.accounts.commitmentTree, role: AccountRole.WRITABLE },
    { address: options.accounts.vkRegistry, role: AccountRole.READONLY },
    { address: options.accounts.user, role: AccountRole.WRITABLE_SIGNER },
    { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
  ];

  // Nullifier records (writable PDAs)
  for (const nr of options.accounts.nullifierRecords) {
    accounts.push({ address: nr, role: AccountRole.WRITABLE });
  }

  // Stealth announcements (writable PDAs)
  for (const sa of options.accounts.stealthAnnouncements) {
    accounts.push({ address: sa, role: AccountRole.WRITABLE });
  }

  return {
    programAddress: config.zvaultProgramId,
    accounts,
    data,
  };
}

// =============================================================================
// Utility Exports
// =============================================================================

/**
 * Bigint to 32-byte Uint8Array (big-endian)
 */
export function bigintTo32Bytes(value: bigint): Uint8Array {
  const hex = value.toString(16).padStart(64, "0");
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * 32-byte Uint8Array to bigint (big-endian)
 */
export function bytes32ToBigint(bytes: Uint8Array): bigint {
  if (bytes.length !== 32) {
    throw new Error("Expected 32 bytes");
  }
  let hex = "0x";
  for (let i = 0; i < 32; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return BigInt(hex);
}

/**
 * Convert hex string to Uint8Array
 */
export function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.substr(i * 2, 2), 16);
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
