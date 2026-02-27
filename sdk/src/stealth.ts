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
 * Layout: 1 (disc) + 1 (type) + 32 (ephemeral) + 8 (amount_bytes) + 32 (commitment) + 8 (leaf_idx) + 8 (created_at) */
export const STEALTH_ANNOUNCEMENT_SIZE = 90;

/** Discriminator for StealthAnnouncement */
export const STEALTH_ANNOUNCEMENT_DISCRIMINATOR = 0x08;

/** Announcement type: deposit (plaintext amount) */
export const ANNOUNCEMENT_TYPE_DEPOSIT = 0;

/** Announcement type: transfer (XOR-encrypted amount) */
export const ANNOUNCEMENT_TYPE_TRANSFER = 1;

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
  computeMPKSync,
  computeNPKSync,
  computeJoinSplitCommitmentSync,
  computeJoinSplitNullifierSync,
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
 * Prepared claim inputs for JoinSplit ZK proof (requires spending key)
 */
export interface ClaimInputs {
  stealthPrivKey: bigint;
  nullifyingKey: bigint;
  amount: bigint;
  leafIndex: number;
  merklePath: bigint[];
  merkleIndices: number[];
  merkleRoot: bigint;
  nullifier: bigint;
  npk: bigint;
  random: bigint;
}

// ========== On-chain Announcement ==========

/**
 * Parsed stealth announcement from on-chain data
 */
export interface OnChainStealthAnnouncement {
  /** 0 = deposit (plaintext amount), 1 = transfer (encrypted amount) */
  announcementType: number;
  ephemeralPub: Uint8Array;
  /** Raw amount bytes: plaintext if type=0, encrypted if type=1 */
  encryptedAmount: Uint8Array;
  commitment: Uint8Array;
  leafIndex: number;
  createdAt: number;
}

// ========== Helper Functions ==========

/** Domain separator for stealth key derivation */
const STEALTH_KEY_DOMAIN = new TextEncoder().encode("zVault-stealth-v1");

/**
 * ZBTC token identifier for JoinSplit commitments.
 * This is a fixed constant — Poseidon(npk, ZBTC_TOKEN_ID, amount).
 * Value: SHA256("zbtc") mod BN254_SCALAR_FIELD, truncated to fit.
 */
export const ZBTC_TOKEN_ID = 0x7a627463n; // "zbtc" as u32 (simple, deterministic)

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
 * Create a stealth deposit (JoinSplit-compatible)
 *
 * 1. Generate Ed25519 ephemeral keypair
 * 2. sharedSecret = X25519(ephemeral.priv, viewingPub)
 * 3. stealthPub = spendingPub + hash(sharedSecret) × BASE8
 * 4. stealthMPK = Poseidon(stealthPub.x, stealthPub.y, nullifyingKey)
 *    (sender uses recipientMPK from meta-address for stealth deposits)
 * 5. npk = Poseidon(recipientMPK, random)
 * 6. commitment = Poseidon(npk, ZBTC_TOKEN_ID, amount)
 * 7. encryptedAmount = amount XOR sha256(sharedSecret)[0..8]
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

  // Derive stealth scalar as the random value for NPK
  const stealthScalar = deriveStealthScalar(sharedSecret);

  // Use recipient's MPK from meta-address to compute NPK
  const recipientMPK = bytesToBigint(recipientMeta.mpk);
  const npk = computeNPKSync(recipientMPK, stealthScalar);

  // Compute JoinSplit commitment = Poseidon(npk, token, amount)
  const commitmentBigint = computeJoinSplitCommitmentSync(npk, ZBTC_TOKEN_ID, amountSats);
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
 * Create stealth deposit with npk for JoinSplit circuit input
 */
export async function createStealthDepositWithKeys(
  recipientMeta: StealthMetaAddress,
  amountSats: bigint
): Promise<StealthOutputWithKeys> {
  const { viewingPubKey } = parseStealthMetaAddress(recipientMeta);

  const ephemeral = ed25519GenerateKeyPair();
  const sharedSecret = x25519Ecdh(ephemeral.privKey, viewingPubKey);

  const stealthScalar = deriveStealthScalar(sharedSecret);
  const recipientMPK = bytesToBigint(recipientMeta.mpk);
  const npk = computeNPKSync(recipientMPK, stealthScalar);

  const commitmentBigint = computeJoinSplitCommitmentSync(npk, ZBTC_TOKEN_ID, amountSats);
  const commitment = bigintToBytes(commitmentBigint);
  const encryptedAmount = encryptAmount(amountSats, sharedSecret);

  return {
    ephemeralPub: new Uint8Array(ephemeral.pubKey),
    encryptedAmount,
    commitment,
    stealthPubKeyX: npk, // npk is the note public key for circuit
  };
}

// ========== Non-Interactive Deposit (OP_RETURN) ==========

/**
 * Result of a non-interactive deposit preparation.
 * Contains everything needed to build a PSBT with an OP_RETURN output.
 *
 * npk-based flow: user can send any amount of BTC. The commitment is
 * computed on-chain from npk + actual amount.
 */
export interface NonInteractiveDepositResult {
  /** Taproot address to send BTC to */
  btcAddress: string;
  /** 32-byte x-only output key for the deposit P2TR output */
  depositOutputKey: Uint8Array;
  /** 64-byte OP_RETURN payload (ephemeralPub || npk) */
  opReturnPayload: Uint8Array;
  /** 32-byte note public key (for tracking) */
  npk: Uint8Array;
  /** 32-byte Ed25519 ephemeral public key */
  ephemeralPub: Uint8Array;
}

/**
 * Create a non-interactive stealth deposit (npk-based).
 *
 * This is the client-side-only deposit flow: no backend API call needed.
 * The ephemeral key and npk are embedded in the BTC transaction's OP_RETURN
 * output so the backend can passively detect them.
 *
 * The user can send ANY amount of BTC — the commitment is computed on-chain
 * from the npk + actual BTC amount received.
 *
 * @param recipientMeta - Recipient's stealth meta-address
 * @param groupPubKey - FROST group public key (32-byte x-only), used as Taproot internal key
 * @param network - Bitcoin network for address encoding
 */
export async function createNonInteractiveDeposit(
  recipientMeta: StealthMetaAddress,
  groupPubKey: Uint8Array,
  network: "mainnet" | "testnet" | "regtest" = "testnet",
): Promise<NonInteractiveDepositResult> {
  const { viewingPubKey } = parseStealthMetaAddress(recipientMeta);

  // 1. Generate ephemeral Ed25519 keypair
  const ephemeral = ed25519GenerateKeyPair();

  // 2. X25519 ECDH shared secret
  const sharedSecret = x25519Ecdh(ephemeral.privKey, viewingPubKey);

  // 3. Derive stealth scalar → NPK (no commitment — computed on-chain)
  const stealthScalar = deriveStealthScalar(sharedSecret);
  const recipientMPK = bytesToBigint(recipientMeta.mpk);
  const npkBigint = computeNPKSync(recipientMPK, stealthScalar);
  const npk = bigintToBytes(npkBigint);

  // 4. Derive Taproot address from npk + group key
  const { deriveTaprootAddress, buildDepositOpReturn } = await import("./taproot");
  const { address: btcAddress, outputKey } = deriveTaprootAddress(npk, network, groupPubKey);

  // 5. Build 64-byte OP_RETURN payload (ephemeralPub || npk)
  const ephemeralPub = new Uint8Array(ephemeral.pubKey);
  const opReturnPayload = buildDepositOpReturn(ephemeralPub, npk);

  return {
    btcAddress,
    depositOutputKey: outputKey,
    opReturnPayload,
    npk,
    ephemeralPub,
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

  // Compute MPK for this key set
  const mpk = computeMPKSync(keys.spendingPubKey.x, keys.spendingPubKey.y, keys.nullifyingKey);

  for (const ann of announcements) {
    try {
      // X25519 ECDH with viewing key
      const sharedSecret = x25519Ecdh(keys.viewingPrivKey, ann.ephemeralPub);

      // Decrypt amount
      const amount = decryptAmount(ann.encryptedAmount, sharedSecret);

      if (amount <= 0n || amount > MAX_SATS) {
        continue;
      }

      // Derive stealth public key (still needed for spending)
      const stealthPub = deriveStealthPubKey(keys.spendingPubKey, sharedSecret);

      // Derive stealth scalar as random for NPK
      const stealthScalar = deriveStealthScalar(sharedSecret);

      // Compute expected NPK and commitment (JoinSplit format)
      const npk = computeNPKSync(mpk, stealthScalar);
      const expectedCommitment = computeJoinSplitCommitmentSync(npk, ZBTC_TOKEN_ID, amount);
      const actualCommitment = bytesToBigint(ann.commitment);

      if (expectedCommitment !== actualCommitment) {
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
  /** Nullifying key (needed for MPK computation in JoinSplit scanning) */
  nullifyingKey: bigint;
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

  // Compute MPK for this key set
  const mpk = computeMPKSync(
    viewOnlyKeys.spendingPubKey.x,
    viewOnlyKeys.spendingPubKey.y,
    viewOnlyKeys.nullifyingKey
  );

  for (const ann of announcements) {
    try {
      const sharedSecret = x25519Ecdh(viewOnlyKeys.viewingPrivKey, ann.ephemeralPub);
      const amount = decryptAmount(ann.encryptedAmount, sharedSecret);

      if (amount <= 0n || amount > MAX_SATS) {
        continue;
      }

      const stealthScalar = deriveStealthScalar(sharedSecret);
      const npk = computeNPKSync(mpk, stealthScalar);
      const expectedCommitment = computeJoinSplitCommitmentSync(npk, ZBTC_TOKEN_ID, amount);
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
    nullifyingKey: keys.nullifyingKey,
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

  // Derive the random value (stealth scalar) for NPK
  const stealthScalar = deriveStealthScalar(sharedSecret);

  // Compute MPK and NPK
  const mpk = computeMPKSync(keys.spendingPubKey.x, keys.spendingPubKey.y, keys.nullifyingKey);
  const npk = computeNPKSync(mpk, stealthScalar);

  // Compute JoinSplit nullifier
  const nullifier = computeJoinSplitNullifierSync(keys.nullifyingKey, BigInt(note.leafIndex));

  return {
    stealthPrivKey,
    nullifyingKey: keys.nullifyingKey,
    amount: note.amount,
    leafIndex: note.leafIndex,
    merklePath: merkleProof.pathElements,
    merkleIndices: merkleProof.pathIndices,
    merkleRoot: merkleProof.root,
    nullifier,
    npk,
    random: stealthScalar,
  };
}

// ========== On-chain Parsing ==========

/**
 * Parse a StealthAnnouncement account data (unified format)
 *
 * Layout (90 bytes):
 * - discriminator (1 byte) = 0x08
 * - announcement_type (1 byte): 0=deposit (plaintext), 1=transfer (encrypted)
 * - ephemeral_pub (32 bytes) - Ed25519 key
 * - amount_bytes (8 bytes) - plaintext if type=0, encrypted if type=1
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

  const announcementType = data[1];

  let offset = 2; // Skip discriminator and announcement_type

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
    announcementType,
    ephemeralPub,
    encryptedAmount,
    commitment,
    leafIndex,
    createdAt,
  };
}

// ========== Unified Note Scanning ==========

/**
 * Scan unified StealthAnnouncement notes (both deposits and transfers).
 *
 * For each announcement:
 * - type=0 (deposit): amount is plaintext u64 LE in amount_bytes
 * - type=1 (transfer): amount is XOR-encrypted in amount_bytes
 *
 * Both are verified with: Poseidon(npk, ZBTC_TOKEN_ID, amount) == commitment
 */
export async function scanUnifiedNotes(
  source: WalletSignerAdapter | ZVaultKeys,
  announcements: OnChainStealthAnnouncement[]
): Promise<ScannedNote[]> {
  const keys = isWalletAdapter(source) ? await deriveKeysFromWallet(source) : source;

  const found: ScannedNote[] = [];
  const MAX_SATS = 21_000_000n * 100_000_000n;

  const mpk = computeMPKSync(keys.spendingPubKey.x, keys.spendingPubKey.y, keys.nullifyingKey);

  for (const ann of announcements) {
    try {
      // X25519 ECDH with viewing key
      const sharedSecret = x25519Ecdh(keys.viewingPrivKey, ann.ephemeralPub);

      // Get amount based on type
      let amount: bigint;
      if (ann.announcementType === ANNOUNCEMENT_TYPE_DEPOSIT) {
        // Plaintext u64 LE
        const view = new DataView(ann.encryptedAmount.buffer, ann.encryptedAmount.byteOffset, 8);
        amount = view.getBigUint64(0, true);
      } else {
        // XOR-encrypted
        amount = decryptAmount(ann.encryptedAmount, sharedSecret);
      }

      if (amount <= 0n || amount > MAX_SATS) {
        continue;
      }

      // Derive stealth scalar and expected NPK + commitment
      const stealthScalar = deriveStealthScalar(sharedSecret);
      const npk = computeNPKSync(mpk, stealthScalar);
      const expectedCommitment = computeJoinSplitCommitmentSync(npk, ZBTC_TOKEN_ID, amount);
      const actualCommitment = bytesToBigint(ann.commitment);

      if (expectedCommitment !== actualCommitment) {
        continue;
      }

      // Derive stealth public key (for spending)
      const stealthPub = deriveStealthPubKey(keys.spendingPubKey, sharedSecret);

      found.push({
        amount,
        ephemeralPub: ann.ephemeralPub,
        stealthPub,
        leafIndex: ann.leafIndex,
        commitment: ann.commitment,
      });
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) {
        throw error;
      }
      continue;
    }
  }

  return found;
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

  const stealthScalar = deriveStealthScalar(sharedSecret);
  const mpk = computeMPKSync(keys.spendingPubKey.x, keys.spendingPubKey.y, keys.nullifyingKey);
  const npk = computeNPKSync(mpk, stealthScalar);

  const commitmentBigint = computeJoinSplitCommitmentSync(npk, ZBTC_TOKEN_ID, amountSats);
  const commitment = bigintToBytes(commitmentBigint);
  const encryptedAmount = encryptAmount(amountSats, sharedSecret);

  return {
    ephemeralPub: new Uint8Array(ephemeral.pubKey),
    encryptedAmount,
    commitment,
  };
}

/**
 * Create stealth output with npk for JoinSplit circuit input
 */
export async function createStealthOutputWithKeys(
  keys: ZVaultKeys,
  amountSats: bigint
): Promise<StealthOutputWithKeys> {
  const ephemeral = ed25519GenerateKeyPair();
  const sharedSecret = x25519Ecdh(ephemeral.privKey, keys.viewingPubKey);

  const stealthScalar = deriveStealthScalar(sharedSecret);
  const mpk = computeMPKSync(keys.spendingPubKey.x, keys.spendingPubKey.y, keys.nullifyingKey);
  const npk = computeNPKSync(mpk, stealthScalar);

  const commitmentBigint = computeJoinSplitCommitmentSync(npk, ZBTC_TOKEN_ID, amountSats);
  const commitment = bigintToBytes(commitmentBigint);
  const encryptedAmount = encryptAmount(amountSats, sharedSecret);

  return {
    ephemeralPub: new Uint8Array(ephemeral.pubKey),
    encryptedAmount,
    commitment,
    stealthPubKeyX: npk,
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
  // In JoinSplit model, nullifier = Poseidon(nullifyingKey, leafIndex)
  // No extra hash layer — the nullifier IS the public output
  const nullifier = computeJoinSplitNullifierSync(keys.nullifyingKey, BigInt(note.leafIndex));
  return bigintToBytes(nullifier);
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
