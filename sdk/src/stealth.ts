/**
 * Stealth address utilities for ZVault
 *
 * Dual-curve stealth flow (Railgun-style):
 *
 * Stealth Deposit Flow:
 * ```
 * Sender:
 *   1. ephemeral = random Ed25519 keypair
 *   2. sharedSecret = X25519(ephemeral.priv, recipientViewingPub)
 *   3. stealthScalar = SHA256(sharedSecret || domain) mod BJJ_ORDER
 *   4. stealthPub = spendingPub + stealthScalar × BASE8 (Baby Jubjub)
 *   5. commitment = Poseidon(stealthPub.x, amount)
 *   6. encryptedAmount = amount XOR sha256(sharedSecret)[0..8]
 *
 * Recipient (viewing key only - can detect and see amount):
 *   1. sharedSecret = X25519(viewingPriv, ephemeralPub)
 *   2. amount = encryptedAmount XOR sha256(sharedSecret)[0..8]
 *   3. stealthPub = spendingPub + stealthScalar × BASE8
 *   4. Verify: commitment == Poseidon(stealthPub.x, amount)
 *
 * Recipient (spending key - can claim):
 *   1. stealthPriv = spendingPriv + stealthScalar (mod BJJ_ORDER)
 *   2. nullifier = Poseidon(stealthPriv, leafIndex)
 * ```
 *
 * Format (90 bytes on-chain):
 * - ephemeral_pub (32 bytes) - Ed25519 public key
 * - encrypted_amount (8 bytes) - XOR encrypted with shared secret
 * - commitment (32 bytes) - Poseidon hash for Merkle tree
 * - leaf_index (8 bytes) - Position in Merkle tree
 * - created_at (8 bytes) - Timestamp
 */

// ========== Constants (defined before imports to ensure availability) ==========

/** StealthAnnouncement account size (90 bytes - Ed25519 ephemeral key)
 * Layout: 1 (disc) + 1 (bump) + 32 (ephemeral) + 8 (encrypted_amount) + 32 (commitment) + 8 (leaf_idx) + 8 (created_at) */
export const STEALTH_ANNOUNCEMENT_SIZE = 90;

/** Discriminator for StealthAnnouncement */
export const STEALTH_ANNOUNCEMENT_DISCRIMINATOR = 0x08;

// ========== Imports ==========

import { sha256 } from "@noble/hashes/sha2.js";
import {
  bigintToBytes,
  bytesToBigint,
  BN254_FIELD_PRIME,
  babyJubMul,
  babyJubAdd,
  babyJubCompress,
  babyJubDecompress,
  BABYJUB_BASE8,
  BABYJUB_ORDER,
  scalarFromBytes,
  type BabyJubPoint,
} from "./crypto";
import {
  ed25519GenerateKeyPair,
  x25519Ecdh,
  encryptAmountEd25519,
  decryptAmountEd25519,
} from "./crypto-ed25519";
import type { StealthMetaAddress, ZVaultKeys, WalletSignerAdapter } from "./keys";
import { deriveKeysFromWallet, parseStealthMetaAddress, constantTimeCompare } from "./keys";
import { lookupZkeyName, type ZkeyStealthAddress } from "./name-registry";
import {
  poseidonHashSync,
  computeNullifierSync as poseidonComputeNullifier,
} from "./poseidon";

// ========== Amount Encryption Helpers ==========

/**
 * Encrypt amount using XOR with shared secret
 */
export function encryptAmount(amount: bigint, sharedSecret: Uint8Array): Uint8Array {
  return encryptAmountEd25519(amount, sharedSecret);
}

/**
 * Decrypt amount using XOR with shared secret
 */
export function decryptAmount(encryptedAmount: Uint8Array, sharedSecret: Uint8Array): bigint {
  return decryptAmountEd25519(encryptedAmount, sharedSecret);
}

// ========== Type Guard ==========

/**
 * Type guard to distinguish between WalletSignerAdapter and ZVaultKeys
 */
export function isWalletAdapter(source: unknown): source is WalletSignerAdapter {
  return (
    typeof source === "object" &&
    source !== null &&
    "signMessage" in source &&
    typeof (source as WalletSignerAdapter).signMessage === "function"
  );
}

// ========== Types ==========

/**
 * Stealth Deposit with single Ed25519 ephemeral key
 */
export interface StealthDeposit {
  /** Ed25519 ephemeral public key (32 bytes) */
  ephemeralPub: Uint8Array;

  /** Encrypted amount (8 bytes) */
  encryptedAmount: Uint8Array;

  /** Commitment for Merkle tree (32 bytes) - Poseidon(stealthPub.x, amount) */
  commitment: Uint8Array;

  /** Unix timestamp when created */
  createdAt: number;
}

/**
 * Scanned note from announcement (viewing key can detect)
 */
export interface ScannedNote {
  /** Amount in satoshis */
  amount: bigint;

  /** Ed25519 ephemeral public key (needed for shared secret) */
  ephemeralPub: Uint8Array;

  /** Computed stealth public key (Baby Jubjub) */
  stealthPub: BabyJubPoint;

  /** Leaf index in Merkle tree */
  leafIndex: number;

  /** Original announcement commitment */
  commitment: Uint8Array;
}

/**
 * Prepared claim inputs for ZK proof (requires spending key)
 */
export interface ClaimInputs {
  stealthPrivKey: bigint;
  amount: bigint;
  leafIndex: number;
  merklePath: bigint[];
  merkleIndices: number[];
  merkleRoot: bigint;
  nullifier: bigint;
  amountPub: bigint;
}

// ========== On-chain Announcement ==========

/**
 * Parsed stealth announcement from on-chain data
 */
export interface OnChainStealthAnnouncement {
  ephemeralPub: Uint8Array;
  encryptedAmount: Uint8Array;
  commitment: Uint8Array;
  leafIndex: number;
  createdAt: number;
}

// ========== Helper Functions ==========

/** Domain separator for stealth key derivation */
const STEALTH_KEY_DOMAIN = new TextEncoder().encode("zVault-stealth-v1");

/**
 * Derive stealth scalar from X25519 shared secret
 *
 * stealthScalar = SHA256(sharedSecret || domain) mod BJJ_ORDER
 */
function deriveStealthScalar(sharedSecret: Uint8Array): bigint {
  const hashInput = new Uint8Array(sharedSecret.length + STEALTH_KEY_DOMAIN.length);
  hashInput.set(sharedSecret, 0);
  hashInput.set(STEALTH_KEY_DOMAIN, sharedSecret.length);

  const hash = sha256(hashInput);
  return scalarFromBytes(hash);
}

/**
 * Derive stealth public key (Baby Jubjub)
 *
 * stealthPub = spendingPub + stealthScalar × BASE8
 */
function deriveStealthPubKey(
  spendingPub: BabyJubPoint,
  sharedSecret: Uint8Array
): BabyJubPoint {
  const scalar = deriveStealthScalar(sharedSecret);
  const scalarPoint = babyJubMul(scalar, BABYJUB_BASE8);
  return babyJubAdd(spendingPub, scalarPoint);
}

/**
 * Derive stealth private key (Baby Jubjub scalar addition)
 *
 * stealthPriv = spendingPriv + stealthScalar (mod BJJ_ORDER)
 */
function deriveStealthPrivKey(
  spendingPriv: bigint,
  sharedSecret: Uint8Array
): bigint {
  const scalar = deriveStealthScalar(sharedSecret);
  return (spendingPriv + scalar) % BABYJUB_ORDER;
}

// ========== Sender Functions ==========

/**
 * Create a stealth deposit
 *
 * 1. Generate Ed25519 ephemeral keypair
 * 2. sharedSecret = X25519(ephemeral.priv, viewingPub)
 * 3. stealthPub = spendingPub + hash(sharedSecret) × BASE8
 * 4. commitment = Poseidon(stealthPub.x, amount)
 * 5. encryptedAmount = amount XOR sha256(sharedSecret)[0..8]
 */
export async function createStealthDeposit(
  recipientMeta: StealthMetaAddress,
  amountSats: bigint
): Promise<StealthDeposit> {
  const { spendingPubKey, viewingPubKey } = parseStealthMetaAddress(recipientMeta);

  // Generate Ed25519 ephemeral keypair
  const ephemeral = ed25519GenerateKeyPair();

  // X25519 ECDH: shared secret
  const sharedSecret = x25519Ecdh(ephemeral.privKey, viewingPubKey);

  // Derive stealth public key (Baby Jubjub)
  const stealthPub = deriveStealthPubKey(spendingPubKey, sharedSecret);

  // Compute commitment
  const commitmentBigint = poseidonHashSync([stealthPub.x, amountSats]);
  const commitment = bigintToBytes(commitmentBigint);

  // Encrypt amount
  const encryptedAmount = encryptAmount(amountSats, sharedSecret);

  return {
    ephemeralPub: new Uint8Array(ephemeral.pubKey),
    encryptedAmount,
    commitment,
    createdAt: Date.now(),
  };
}

/**
 * Extended stealth output data including the derived stealth pub key
 */
export interface StealthOutputWithKeys extends StealthOutputData {
  stealthPubKeyX: bigint;
}

/**
 * Create stealth deposit with stealthPubKeyX for circuit input
 */
export async function createStealthDepositWithKeys(
  recipientMeta: StealthMetaAddress,
  amountSats: bigint
): Promise<StealthOutputWithKeys> {
  const { spendingPubKey, viewingPubKey } = parseStealthMetaAddress(recipientMeta);

  const ephemeral = ed25519GenerateKeyPair();
  const sharedSecret = x25519Ecdh(ephemeral.privKey, viewingPubKey);
  const stealthPub = deriveStealthPubKey(spendingPubKey, sharedSecret);

  const commitmentBigint = poseidonHashSync([stealthPub.x, amountSats]);
  const commitment = bigintToBytes(commitmentBigint);
  const encryptedAmount = encryptAmount(amountSats, sharedSecret);

  return {
    ephemeralPub: new Uint8Array(ephemeral.pubKey),
    encryptedAmount,
    commitment,
    stealthPubKeyX: stealthPub.x,
  };
}

// ========== Recipient Scanning (Viewing Key Only) ==========

/**
 * Scan announcements using viewing key only
 */
export async function scanAnnouncements(
  source: WalletSignerAdapter | ZVaultKeys,
  announcements: {
    ephemeralPub: Uint8Array;
    encryptedAmount: Uint8Array;
    commitment: Uint8Array;
    leafIndex: number;
  }[]
): Promise<ScannedNote[]> {
  const keys = isWalletAdapter(source) ? await deriveKeysFromWallet(source) : source;

  const found: ScannedNote[] = [];
  const MAX_SATS = 21_000_000n * 100_000_000n;

  for (const ann of announcements) {
    try {
      // X25519 ECDH with viewing key
      const sharedSecret = x25519Ecdh(keys.viewingPrivKey, ann.ephemeralPub);

      // Decrypt amount
      const amount = decryptAmount(ann.encryptedAmount, sharedSecret);

      if (amount <= 0n || amount > MAX_SATS) {
        continue;
      }

      // Derive stealth public key
      const stealthPub = deriveStealthPubKey(keys.spendingPubKey, sharedSecret);

      // Verify commitment
      const expectedCommitmentStealth = poseidonHashSync([stealthPub.x, amount]);
      const actualCommitment = bytesToBigint(ann.commitment);

      // Also try raw commitment for change outputs
      const expectedCommitmentRaw = poseidonHashSync([keys.spendingPubKey.x, amount]);

      if (expectedCommitmentStealth !== actualCommitment &&
          expectedCommitmentRaw !== actualCommitment) {
        continue;
      }

      found.push({
        amount,
        ephemeralPub: ann.ephemeralPub,
        stealthPub,
        leafIndex: ann.leafIndex,
        commitment: ann.commitment,
      });
    } catch (error) {
      // Re-throw programming errors; only skip data/crypto mismatches
      if (error instanceof TypeError || error instanceof RangeError) {
        throw error;
      }
      continue;
    }
  }

  return found;
}

// ========== View-Only Scanning ==========

/**
 * View-only keys for scanning without spending capability
 */
export interface ViewOnlyKeys {
  /** Ed25519 viewing private key (32 bytes) */
  viewingPrivKey: Uint8Array;
  /** Baby Jubjub spending public key */
  spendingPubKey: BabyJubPoint;
}

/**
 * Scanned note from view-only scanning
 */
export interface ViewOnlyScannedNote {
  amount: bigint;
  leafIndex: number;
  commitment: Uint8Array;
  ephemeralPub: Uint8Array;
}

/**
 * Scan announcements with VIEW-ONLY keys
 */
export async function scanAnnouncementsViewOnly(
  viewOnlyKeys: ViewOnlyKeys,
  announcements: {
    ephemeralPub: Uint8Array;
    encryptedAmount: Uint8Array;
    commitment: Uint8Array;
    leafIndex: number;
  }[]
): Promise<ViewOnlyScannedNote[]> {
  const found: ViewOnlyScannedNote[] = [];
  const MAX_SATS = 21_000_000n * 100_000_000n;

  for (const ann of announcements) {
    try {
      const sharedSecret = x25519Ecdh(viewOnlyKeys.viewingPrivKey, ann.ephemeralPub);
      const amount = decryptAmount(ann.encryptedAmount, sharedSecret);

      if (amount <= 0n || amount > MAX_SATS) {
        continue;
      }

      const stealthPub = deriveStealthPubKey(viewOnlyKeys.spendingPubKey, sharedSecret);
      const expectedCommitment = poseidonHashSync([stealthPub.x, amount]);
      const actualCommitment = bytesToBigint(ann.commitment);

      if (expectedCommitment !== actualCommitment) {
        continue;
      }

      found.push({
        amount,
        leafIndex: ann.leafIndex,
        commitment: ann.commitment,
        ephemeralPub: ann.ephemeralPub,
      });
    } catch (error) {
      // Re-throw programming errors; only skip data/crypto mismatches
      if (error instanceof TypeError || error instanceof RangeError) {
        throw error;
      }
      continue;
    }
  }

  return found;
}

/**
 * Export view-only keys from full ZVaultKeys
 */
export function exportViewOnlyKeys(keys: ZVaultKeys): ViewOnlyKeys {
  return {
    viewingPrivKey: keys.viewingPrivKey,
    spendingPubKey: keys.spendingPubKey,
  };
}

// ========== Claim Preparation (Spending Key Required) ==========

/**
 * Prepare claim inputs for ZK proof generation
 */
export async function prepareClaimInputs(
  source: WalletSignerAdapter | ZVaultKeys,
  note: ScannedNote,
  merkleProof: {
    root: bigint;
    pathElements: bigint[];
    pathIndices: number[];
  }
): Promise<ClaimInputs> {
  const keys = isWalletAdapter(source) ? await deriveKeysFromWallet(source) : source;

  // X25519 ECDH to recover shared secret
  const sharedSecret = x25519Ecdh(keys.viewingPrivKey, note.ephemeralPub);

  // Derive stealth private key (Baby Jubjub scalar addition)
  const stealthPrivKey = deriveStealthPrivKey(keys.spendingPrivKey, sharedSecret);

  // Verify stealth public key matches
  const expectedStealthPub = babyJubMul(stealthPrivKey, BABYJUB_BASE8);
  if (expectedStealthPub.x !== note.stealthPub.x || expectedStealthPub.y !== note.stealthPub.y) {
    throw new Error(
      "Stealth key mismatch - this note may not belong to you or the announcement is invalid"
    );
  }

  // Compute nullifier
  const nullifier = poseidonComputeNullifier(stealthPrivKey, BigInt(note.leafIndex));

  return {
    stealthPrivKey,
    amount: note.amount,
    leafIndex: note.leafIndex,
    merklePath: merkleProof.pathElements,
    merkleIndices: merkleProof.pathIndices,
    merkleRoot: merkleProof.root,
    nullifier,
    amountPub: note.amount,
  };
}

// ========== On-chain Parsing ==========

/**
 * Parse a StealthAnnouncement account data (Ed25519 ephemeral key)
 *
 * Layout (90 bytes):
 * - discriminator (1 byte)
 * - bump (1 byte)
 * - ephemeral_pub (32 bytes) - Ed25519 key
 * - encrypted_amount (8 bytes)
 * - commitment (32 bytes)
 * - leaf_index (8 bytes)
 * - created_at (8 bytes)
 */
export function parseStealthAnnouncement(
  data: Uint8Array
): OnChainStealthAnnouncement | null {
  if (data.length < STEALTH_ANNOUNCEMENT_SIZE) {
    return null;
  }

  if (data[0] !== STEALTH_ANNOUNCEMENT_DISCRIMINATOR) {
    return null;
  }

  let offset = 2; // Skip discriminator and bump

  const ephemeralPub = data.slice(offset, offset + 32);
  offset += 32;

  const encryptedAmount = data.slice(offset, offset + 8);
  offset += 8;

  const commitment = data.slice(offset, offset + 32);
  offset += 32;

  const leafIndexView = new DataView(
    data.buffer,
    data.byteOffset + offset,
    8
  );
  const leafIndexBigInt = leafIndexView.getBigUint64(0, true);
  if (leafIndexBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Leaf index overflow - value exceeds safe integer range");
  }
  const leafIndex = Number(leafIndexBigInt);
  offset += 8;

  const createdAtView = new DataView(
    data.buffer,
    data.byteOffset + offset,
    8
  );
  const createdAtBigInt = createdAtView.getBigInt64(0, true);
  const maxSafeTimestamp = BigInt(Number.MAX_SAFE_INTEGER);
  const createdAt = createdAtBigInt < 0n ? 0 :
    createdAtBigInt > maxSafeTimestamp ? Number.MAX_SAFE_INTEGER :
    Number(createdAtBigInt);

  return {
    ephemeralPub,
    encryptedAmount,
    commitment,
    leafIndex,
    createdAt,
  };
}

/**
 * Convert on-chain announcement to format expected by scanAnnouncements
 */
export function announcementToScanFormat(
  announcement: OnChainStealthAnnouncement
): {
  ephemeralPub: Uint8Array;
  encryptedAmount: Uint8Array;
  commitment: Uint8Array;
  leafIndex: number;
} {
  return {
    ephemeralPub: announcement.ephemeralPub,
    encryptedAmount: announcement.encryptedAmount,
    commitment: announcement.commitment,
    leafIndex: announcement.leafIndex,
  };
}

// ========== Connection Adapter for .zkey Name Lookup ==========

import type { Address } from "@solana/kit";

export interface ConnectionAdapter {
  getAccountInfo: (
    pubkey: Address
  ) => Promise<{ data: Uint8Array } | null>;
}

// ========== Scan by .zkey.sol Name ==========

export async function scanByZkeyName(
  keys: ZVaultKeys,
  expectedName: string,
  connection: ConnectionAdapter,
  announcements: {
    ephemeralPub: Uint8Array;
    encryptedAmount: Uint8Array;
    commitment: Uint8Array;
    leafIndex: number;
  }[],
  programId?: string
): Promise<ScannedNote[]> {
  const zkeyAddress = await lookupZkeyName(connection, expectedName, programId);
  if (!zkeyAddress) {
    throw new Error(`Name "${expectedName}.zkey.sol" not found`);
  }

  const userSpendingPub = babyJubCompress(keys.spendingPubKey);
  if (!constantTimeCompare(userSpendingPub, zkeyAddress.spendingPubKey)) {
    throw new Error(
      `Keys do not match "${expectedName}.zkey.sol" registration. ` +
      `The provided spending key does not match the registered spending key.`
    );
  }

  const userViewingPub = new Uint8Array(keys.viewingPubKey);
  if (!constantTimeCompare(userViewingPub, zkeyAddress.viewingPubKey)) {
    throw new Error(
      `Keys do not match "${expectedName}.zkey.sol" registration. ` +
      `The provided viewing key does not match the registered viewing key.`
    );
  }

  return scanAnnouncements(keys, announcements);
}

export async function resolveZkeyName(
  connection: ConnectionAdapter,
  name: string,
  programId?: string
): Promise<ZkeyStealthAddress | null> {
  return lookupZkeyName(connection, name, programId);
}

// ========== Stealth Output Creation ==========

export interface StealthOutputData {
  /** Ed25519 ephemeral public key (32 bytes) */
  ephemeralPub: Uint8Array;
  /** XOR encrypted amount (8 bytes) */
  encryptedAmount: Uint8Array;
  /** Commitment = Poseidon(stealthPub.x, amount) */
  commitment: Uint8Array;
}

/**
 * Circuit-ready stealth output data
 */
export interface CircuitStealthOutput {
  /** Ephemeral pubkey (32 bytes as bigint) */
  ephemeralPubX: bigint;
  /** Packed: bits 0-63 = encrypted amount, bit 64 = reserved (0 for Ed25519) */
  encryptedAmountWithSign: bigint;
}

/**
 * Pack encrypted amount (no y_sign needed for Ed25519 — 32-byte keys, no prefix)
 *
 * Layout: bits 0-63 = encrypted amount (little-endian), bit 64 = 0 (reserved)
 */
export function packEncryptedAmountWithSign(encryptedAmount: Uint8Array, _ySign: boolean = false): bigint {
  if (encryptedAmount.length !== 8) {
    throw new Error("Encrypted amount must be 8 bytes");
  }

  let amount = 0n;
  for (let i = 7; i >= 0; i--) {
    amount = (amount << 8n) | BigInt(encryptedAmount[i]);
  }

  // For Ed25519, we don't have a y_sign prefix, but keep the bit for compatibility
  if (_ySign) {
    amount |= (1n << 64n);
  }

  return amount;
}

/**
 * Convert StealthOutputData to circuit-ready format
 */
export function packStealthOutputForCircuit(output: StealthOutputData): CircuitStealthOutput {
  // Ed25519 ephemeral pub is 32 bytes — interpret as big-endian bigint
  const ephemeralPubX = bytesToBigint(output.ephemeralPub);
  const encryptedAmountWithSign = packEncryptedAmountWithSign(output.encryptedAmount);

  return {
    ephemeralPubX,
    encryptedAmountWithSign,
  };
}

/**
 * Unpack encrypted amount from packed Field element
 */
export function unpackEncryptedAmountWithSign(packed: bigint): { encryptedAmount: Uint8Array; ySign: boolean } {
  const ySign = (packed & (1n << 64n)) !== 0n;
  const amount = packed & ((1n << 64n) - 1n);

  const encryptedAmount = new Uint8Array(8);
  let temp = amount;
  for (let i = 0; i < 8; i++) {
    encryptedAmount[i] = Number(temp & 0xffn);
    temp >>= 8n;
  }

  return { encryptedAmount, ySign };
}

/**
 * Create stealth output data for a self-send (change output)
 */
export async function createStealthOutput(
  keys: ZVaultKeys,
  amountSats: bigint
): Promise<StealthOutputData> {
  const ephemeral = ed25519GenerateKeyPair();
  const sharedSecret = x25519Ecdh(ephemeral.privKey, keys.viewingPubKey);
  const stealthPub = deriveStealthPubKey(keys.spendingPubKey, sharedSecret);

  const commitmentBigint = poseidonHashSync([stealthPub.x, amountSats]);
  const commitment = bigintToBytes(commitmentBigint);
  const encryptedAmount = encryptAmount(amountSats, sharedSecret);

  return {
    ephemeralPub: new Uint8Array(ephemeral.pubKey),
    encryptedAmount,
    commitment,
  };
}

/**
 * Create stealth output with stealthPubKeyX for circuit input
 */
export async function createStealthOutputWithKeys(
  keys: ZVaultKeys,
  amountSats: bigint
): Promise<StealthOutputWithKeys> {
  const ephemeral = ed25519GenerateKeyPair();
  const sharedSecret = x25519Ecdh(ephemeral.privKey, keys.viewingPubKey);
  const stealthPub = deriveStealthPubKey(keys.spendingPubKey, sharedSecret);

  const commitmentBigint = poseidonHashSync([stealthPub.x, amountSats]);
  const commitment = bigintToBytes(commitmentBigint);
  const encryptedAmount = encryptAmount(amountSats, sharedSecret);

  return {
    ephemeralPub: new Uint8Array(ephemeral.pubKey),
    encryptedAmount,
    commitment,
    stealthPubKeyX: stealthPub.x,
  };
}

/**
 * Create stealth output data with pre-computed commitment
 */
export async function createStealthOutputForCommitment(
  keys: ZVaultKeys,
  amountSats: bigint,
  existingCommitment: Uint8Array
): Promise<StealthOutputData> {
  const ephemeral = ed25519GenerateKeyPair();
  const sharedSecret = x25519Ecdh(ephemeral.privKey, keys.viewingPubKey);

  const encryptedAmount = encryptAmount(amountSats, sharedSecret);

  return {
    ephemeralPub: new Uint8Array(ephemeral.pubKey),
    encryptedAmount,
    commitment: existingCommitment,
  };
}

// ========== Nullifier Computation ==========

/**
 * Compute nullifier hash for a scanned note
 */
export function computeNullifierHashForNote(
  keys: ZVaultKeys,
  note: ScannedNote
): Uint8Array {
  const sharedSecret = x25519Ecdh(keys.viewingPrivKey, note.ephemeralPub);
  const stealthPrivKey = deriveStealthPrivKey(keys.spendingPrivKey, sharedSecret);
  const nullifier = poseidonComputeNullifier(stealthPrivKey, BigInt(note.leafIndex));
  const nullifierHash = poseidonHashSync([nullifier]);
  return bigintToBytes(nullifierHash);
}

/**
 * Derive StealthAnnouncement PDA address from ephemeral pubkey
 *
 * PDA seed: ["stealth", ephemeral_pub] (full 32 bytes for Ed25519)
 */
export function deriveStealthAnnouncementPda(
  ephemeralPub: Uint8Array,
  programId: string
): string {
  if (ephemeralPub.length !== 32) {
    throw new Error("Ephemeral pubkey must be 32 bytes (Ed25519)");
  }

  const { getProgramDerivedAddress, address } = require("@solana/kit");

  const [pda] = getProgramDerivedAddress({
    programAddress: address(programId),
    seeds: [
      new TextEncoder().encode("stealth"),
      ephemeralPub,
    ],
  });

  return pda.toString();
}

// ========== Removed Grumpkin functions ==========
// extractYSign, extractX, reconstructCompressedPub are no longer needed
// as Ed25519 uses 32-byte keys without prefix bytes
