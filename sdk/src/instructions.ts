/**
 * ZVault Instruction Builders
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

/** Instructions sysvar address */
const INSTRUCTIONS_SYSVAR = address("Sysvar1nstructions1111111111111111111111111");

// =============================================================================
// Types
// =============================================================================

/** Instruction type for v2 */
export interface Instruction {
  programAddress: Address;
  accounts: Array<{ address: Address; role: (typeof AccountRole)[keyof typeof AccountRole] }>;
  data: Uint8Array;
}

/** Claim instruction options */
export interface ClaimInstructionOptions {
  /** Groth16 proof bytes (256 bytes, always inline) */
  proofBytes: Uint8Array;
  /** Merkle root */
  root: Uint8Array;
  /** Nullifier hash */
  nullifierHash: Uint8Array;
  /** Amount in satoshis */
  amountSats: bigint;
  /** Recipient address */
  recipient: Address;
  /** VK hash */
  vkHash: Uint8Array;
  /** Account addresses */
  accounts: {
    poolState: Address;
    commitmentTree: Address;
    nullifierRecord: Address;
    zbtcMint: Address;
    poolVault: Address;
    recipientAta: Address;
    user: Address;
  };
}

/** Split instruction options */
export interface SplitInstructionOptions {
  /** Groth16 proof bytes (256 bytes, always inline) */
  proofBytes: Uint8Array;
  /** Merkle root */
  root: Uint8Array;
  /** Nullifier hash */
  nullifierHash: Uint8Array;
  /** First output commitment */
  outputCommitment1: Uint8Array;
  /** Second output commitment */
  outputCommitment2: Uint8Array;
  /** VK hash */
  vkHash: Uint8Array;
  /** Ephemeral pubkey x-coordinate for first output stealth announcement (32 bytes) */
  output1EphemeralPubX: Uint8Array;
  /** Packed encrypted amount with y_sign for first output (32 bytes) */
  output1EncryptedAmountWithSign: Uint8Array;
  /** Ephemeral pubkey x-coordinate for second output stealth announcement (32 bytes) */
  output2EphemeralPubX: Uint8Array;
  /** Packed encrypted amount with y_sign for second output (32 bytes) */
  output2EncryptedAmountWithSign: Uint8Array;
  /** Account addresses */
  accounts: {
    poolState: Address;
    commitmentTree: Address;
    nullifierRecord: Address;
    user: Address;
    /** Stealth announcement PDA for first output */
    stealthAnnouncement1: Address;
    /** Stealth announcement PDA for second output */
    stealthAnnouncement2: Address;
  };
}

/** SpendPartialPublic instruction options */
export interface SpendPartialPublicInstructionOptions {
  /** Groth16 proof bytes (256 bytes, always inline) */
  proofBytes: Uint8Array;
  /** Merkle root */
  root: Uint8Array;
  /** Nullifier hash */
  nullifierHash: Uint8Array;
  /** Public output amount in sats */
  publicAmountSats: bigint;
  /** Change commitment */
  changeCommitment: Uint8Array;
  /** Recipient address */
  recipient: Address;
  /** VK hash */
  vkHash: Uint8Array;
  /** Ephemeral pubkey x-coordinate for change stealth announcement (32 bytes) */
  changeEphemeralPubX: Uint8Array;
  /** Packed encrypted amount with y_sign (32 bytes) */
  changeEncryptedAmountWithSign: Uint8Array;
  /** Account addresses */
  accounts: {
    poolState: Address;
    commitmentTree: Address;
    nullifierRecord: Address;
    zbtcMint: Address;
    poolVault: Address;
    recipientAta: Address;
    user: Address;
    /** Stealth announcement PDA for change output */
    stealthAnnouncementChange: Address;
  };
}

// =============================================================================
// Constants
// =============================================================================

/** Instruction discriminators (must match contracts/programs/zvault/src/lib.rs) */
const INSTRUCTION = {
  INITIALIZE: 0,
  VERIFY_STEALTH_DEPOSIT: 1,
  CLAIM: 2,
  SPEND_SPLIT: 3,
  SPEND_PARTIAL_PUBLIC: 4,
  REQUEST_REDEMPTION: 5,
  COMPLETE_REDEMPTION: 6,
  SET_PAUSED: 7,
  REGISTER_NAME: 8,
  UPDATE_NAME: 9,
  TRANSFER_NAME: 10,
  INIT_VK_REGISTRY: 11,
  UPDATE_VK_REGISTRY: 12,
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
// Claim Instruction Builder
// =============================================================================

/**
 * Build claim instruction data (Groth16 - always inline)
 *
 * On-chain layout after discriminator:
 * - proof: [u8; 256] - Groth16 proof
 * - root: [u8; 32]
 * - nullifier_hash: [u8; 32]
 * - amount_sats: u64 (LE)
 * - recipient: [u8; 32]
 * - vk_hash: [u8; 32]
 *
 * Total: disc(1) + 392 = 393 bytes
 */
export function buildClaimInstructionData(options: {
  proofBytes: Uint8Array;
  root: Uint8Array;
  nullifierHash: Uint8Array;
  amountSats: bigint;
  recipient: Address;
  vkHash: Uint8Array;
}): Uint8Array {
  const { proofBytes, root, nullifierHash, amountSats, recipient, vkHash } = options;
  const recipientBytes = addressToBytes(recipient);

  if (proofBytes.length !== 256) {
    throw new Error(`Groth16 proof must be 256 bytes, got ${proofBytes.length}`);
  }

  // Format: disc(1) + proof(256) + root(32) + nullifier(32) + amount(8) + recipient(32) + vk_hash(32) = 393
  const totalSize = 1 + 256 + 32 + 32 + 8 + 32 + 32;
  const data = new Uint8Array(totalSize);
  const view = new DataView(data.buffer);

  let offset = 0;

  // Discriminator
  data[offset++] = INSTRUCTION.CLAIM;

  // Proof bytes (256)
  data.set(proofBytes, offset);
  offset += 256;

  // Root (32 bytes)
  data.set(root, offset);
  offset += 32;

  // Nullifier hash (32 bytes)
  data.set(nullifierHash, offset);
  offset += 32;

  // Amount (8 bytes, LE)
  view.setBigUint64(offset, amountSats, true);
  offset += 8;

  // Recipient (32 bytes)
  data.set(recipientBytes, offset);
  offset += 32;

  // VK hash (32 bytes)
  data.set(vkHash, offset);

  return data;
}

/**
 * Build a complete claim instruction (9 accounts, inline proof)
 */
export function buildClaimInstruction(options: ClaimInstructionOptions): Instruction {
  const config = getConfig();

  // Build instruction data
  const data = buildClaimInstructionData({
    proofBytes: options.proofBytes,
    root: options.root,
    nullifierHash: options.nullifierHash,
    amountSats: options.amountSats,
    recipient: options.recipient,
    vkHash: options.vkHash,
  });

  // Build accounts list (9 accounts - matching on-chain ClaimAccounts)
  const accounts: Instruction["accounts"] = [
    { address: options.accounts.poolState, role: AccountRole.WRITABLE },
    { address: options.accounts.commitmentTree, role: AccountRole.READONLY },
    { address: options.accounts.nullifierRecord, role: AccountRole.WRITABLE },
    { address: options.accounts.zbtcMint, role: AccountRole.WRITABLE },
    { address: options.accounts.poolVault, role: AccountRole.WRITABLE },
    { address: options.accounts.recipientAta, role: AccountRole.WRITABLE },
    { address: options.accounts.user, role: AccountRole.WRITABLE_SIGNER },
    { address: TOKEN_2022_PROGRAM_ID, role: AccountRole.READONLY },
    { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
  ];

  return {
    programAddress: config.zvaultProgramId,
    accounts,
    data,
  };
}

// =============================================================================
// Split Instruction Builder
// =============================================================================

/**
 * Build split instruction data (Groth16 - always inline)
 *
 * Format: disc(1) + proof(256) + root(32) + nullifier(32) + out1(32) + out2(32)
 *         + vk_hash(32) + eph1_x(32) + enc1(32) + eph2_x(32) + enc2(32)
 *
 * Total: disc(1) + 544 = 545 bytes
 */
export function buildSplitInstructionData(options: {
  proofBytes: Uint8Array;
  root: Uint8Array;
  nullifierHash: Uint8Array;
  outputCommitment1: Uint8Array;
  outputCommitment2: Uint8Array;
  vkHash: Uint8Array;
  output1EphemeralPubX: Uint8Array;
  output1EncryptedAmountWithSign: Uint8Array;
  output2EphemeralPubX: Uint8Array;
  output2EncryptedAmountWithSign: Uint8Array;
}): Uint8Array {
  const { proofBytes, root, nullifierHash, outputCommitment1, outputCommitment2, vkHash, output1EphemeralPubX, output1EncryptedAmountWithSign, output2EphemeralPubX, output2EncryptedAmountWithSign } = options;

  if (proofBytes.length !== 256) {
    throw new Error(`Groth16 proof must be 256 bytes, got ${proofBytes.length}`);
  }

  const totalSize = 1 + 256 + 32 + 32 + 32 + 32 + 32 + 32 + 32 + 32 + 32;
  const data = new Uint8Array(totalSize);

  let offset = 0;
  data[offset++] = INSTRUCTION.SPEND_SPLIT;

  data.set(proofBytes, offset); offset += 256;
  data.set(root, offset); offset += 32;
  data.set(nullifierHash, offset); offset += 32;
  data.set(outputCommitment1, offset); offset += 32;
  data.set(outputCommitment2, offset); offset += 32;
  data.set(vkHash, offset); offset += 32;
  data.set(output1EphemeralPubX, offset); offset += 32;
  data.set(output1EncryptedAmountWithSign, offset); offset += 32;
  data.set(output2EphemeralPubX, offset); offset += 32;
  data.set(output2EncryptedAmountWithSign, offset);

  return data;
}

/**
 * Build a complete split instruction (7 accounts, inline proof)
 */
export function buildSplitInstruction(options: SplitInstructionOptions): Instruction {
  const config = getConfig();

  const data = buildSplitInstructionData({
    proofBytes: options.proofBytes,
    root: options.root,
    nullifierHash: options.nullifierHash,
    outputCommitment1: options.outputCommitment1,
    outputCommitment2: options.outputCommitment2,
    vkHash: options.vkHash,
    output1EphemeralPubX: options.output1EphemeralPubX,
    output1EncryptedAmountWithSign: options.output1EncryptedAmountWithSign,
    output2EphemeralPubX: options.output2EphemeralPubX,
    output2EncryptedAmountWithSign: options.output2EncryptedAmountWithSign,
  });

  // Build accounts list (7 accounts - matching on-chain SpendSplitAccounts)
  const accounts: Instruction["accounts"] = [
    { address: options.accounts.poolState, role: AccountRole.WRITABLE },
    { address: options.accounts.commitmentTree, role: AccountRole.WRITABLE },
    { address: options.accounts.nullifierRecord, role: AccountRole.WRITABLE },
    { address: options.accounts.user, role: AccountRole.WRITABLE_SIGNER },
    { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    { address: options.accounts.stealthAnnouncement1, role: AccountRole.WRITABLE },
    { address: options.accounts.stealthAnnouncement2, role: AccountRole.WRITABLE },
  ];

  return {
    programAddress: config.zvaultProgramId,
    accounts,
    data,
  };
}

// =============================================================================
// SpendPartialPublic Instruction Builder
// =============================================================================

/**
 * Build spend_partial_public instruction data (Groth16 - always inline)
 *
 * On-chain layout after discriminator:
 * - proof: [u8; 256]
 * - root: [u8; 32]
 * - nullifier_hash: [u8; 32]
 * - public_amount: u64 (LE)
 * - change_commitment: [u8; 32]
 * - recipient: [u8; 32]
 * - vk_hash: [u8; 32]
 * - change_ephemeral_pub_x: [u8; 32]
 * - change_encrypted_amount_with_sign: [u8; 32]
 *
 * Total: disc(1) + 488 = 489 bytes
 */
export function buildSpendPartialPublicInstructionData(options: {
  proofBytes: Uint8Array;
  root: Uint8Array;
  nullifierHash: Uint8Array;
  publicAmountSats: bigint;
  changeCommitment: Uint8Array;
  recipient: Address;
  vkHash: Uint8Array;
  changeEphemeralPubX: Uint8Array;
  changeEncryptedAmountWithSign: Uint8Array;
}): Uint8Array {
  const { proofBytes, root, nullifierHash, publicAmountSats, changeCommitment, recipient, vkHash, changeEphemeralPubX, changeEncryptedAmountWithSign } = options;
  const recipientBytes = addressToBytes(recipient);

  if (proofBytes.length !== 256) {
    throw new Error(`Groth16 proof must be 256 bytes, got ${proofBytes.length}`);
  }

  // disc(1) + proof(256) + root(32) + nullifier(32) + amount(8) + change(32) + recipient(32) + vk_hash(32) + eph_x(32) + enc_amount(32) = 489
  const totalSize = 1 + 256 + 32 + 32 + 8 + 32 + 32 + 32 + 32 + 32;
  const data = new Uint8Array(totalSize);
  const view = new DataView(data.buffer);

  let offset = 0;
  data[offset++] = INSTRUCTION.SPEND_PARTIAL_PUBLIC;

  data.set(proofBytes, offset); offset += 256;
  data.set(root, offset); offset += 32;
  data.set(nullifierHash, offset); offset += 32;
  view.setBigUint64(offset, publicAmountSats, true); offset += 8;
  data.set(changeCommitment, offset); offset += 32;
  data.set(recipientBytes, offset); offset += 32;
  data.set(vkHash, offset); offset += 32;
  data.set(changeEphemeralPubX, offset); offset += 32;
  data.set(changeEncryptedAmountWithSign, offset);

  return data;
}

/**
 * Build a complete spend_partial_public instruction (10 accounts, inline proof)
 */
export function buildSpendPartialPublicInstruction(options: SpendPartialPublicInstructionOptions): Instruction {
  const config = getConfig();

  const data = buildSpendPartialPublicInstructionData({
    proofBytes: options.proofBytes,
    root: options.root,
    nullifierHash: options.nullifierHash,
    publicAmountSats: options.publicAmountSats,
    changeCommitment: options.changeCommitment,
    recipient: options.recipient,
    vkHash: options.vkHash,
    changeEphemeralPubX: options.changeEphemeralPubX,
    changeEncryptedAmountWithSign: options.changeEncryptedAmountWithSign,
  });

  // Build accounts list (10 accounts - matching on-chain SpendPartialPublicAccounts)
  const accounts: Instruction["accounts"] = [
    { address: options.accounts.poolState, role: AccountRole.WRITABLE },
    { address: options.accounts.commitmentTree, role: AccountRole.WRITABLE },
    { address: options.accounts.nullifierRecord, role: AccountRole.WRITABLE },
    { address: options.accounts.zbtcMint, role: AccountRole.WRITABLE },
    { address: options.accounts.poolVault, role: AccountRole.WRITABLE },
    { address: options.accounts.recipientAta, role: AccountRole.WRITABLE },
    { address: options.accounts.user, role: AccountRole.WRITABLE_SIGNER },
    { address: TOKEN_2022_PROGRAM_ID, role: AccountRole.READONLY },
    { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    { address: options.accounts.stealthAnnouncementChange, role: AccountRole.WRITABLE },
  ];

  return {
    programAddress: config.zvaultProgramId,
    accounts,
    data,
  };
}

// =============================================================================
// Redemption Request Instruction Builder
// =============================================================================

/**
 * Build instruction data for REQUEST_REDEMPTION
 *
 * Burns zBTC and creates a RedemptionRequest PDA that the
 * backend redemption processor will pick up.
 *
 * Layout:
 * - discriminator (1 byte) = 5
 * - amount_sats (8 bytes, LE)
 * - btc_address_len (1 byte)
 * - btc_address (variable, max 62 bytes)
 *
 * @param amountSats - Amount to redeem in satoshis
 * @param btcAddress - Bitcoin address for withdrawal (max 62 bytes)
 */
export function buildRedemptionRequestInstructionData(
  amountSats: bigint,
  btcAddress: string
): Uint8Array {
  const btcAddrBytes = new TextEncoder().encode(btcAddress);
  if (btcAddrBytes.length > 62) {
    throw new Error("BTC address too long (max 62 bytes)");
  }

  // Layout: discriminator(1) + amount(8) + addr_len(1) + addr
  const totalLen = 1 + 8 + 1 + btcAddrBytes.length;
  const data = new Uint8Array(totalLen);
  const view = new DataView(data.buffer);

  let offset = 0;
  data[offset++] = INSTRUCTION.REQUEST_REDEMPTION;

  view.setBigUint64(offset, amountSats, true);
  offset += 8;

  data[offset++] = btcAddrBytes.length;
  data.set(btcAddrBytes, offset);

  return data;
}

/** Redemption request instruction options */
export interface RedemptionRequestInstructionOptions {
  /** Amount to redeem in satoshis */
  amountSats: bigint;
  /** Bitcoin address for withdrawal */
  btcAddress: string;
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
    options.btcAddress
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
