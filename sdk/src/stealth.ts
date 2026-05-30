/**
 * Stealth address utilities for UTXOPIA
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

/** Announcement type: deposit (plaintext amount) */
export const ANNOUNCEMENT_TYPE_DEPOSIT = 0;

/** Announcement type: transfer (XOR-encrypted amount) */
export const ANNOUNCEMENT_TYPE_TRANSFER = 1;

// ========== Imports ==========

import { sha256 } from "@noble/hashes/sha2.js";
import {
  bigintToBytes,
  bytesToBigint,
  bytesToHex,
  hexToBytes,
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
import type { StealthMetaAddress, UTXOpiaKeys, WalletSignerAdapter } from "./keys";
import { deriveKeysFromWallet, parseStealthMetaAddress, constantTimeCompare } from "./keys";
import {
  poseidonHashSync,
  computeNullifierSync as poseidonComputeNullifier,
  computeMPKSync,
  computeNPKSync,
  computeJoinSplitCommitmentSync,
  computeJoinSplitNullifierSync,
} from "./poseidon";
import { getConfig } from "./config";
import { deriveRawXOnlyP2TRAddress } from "./bitcoin/ika";

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

// Re-export combined note data encryption
export { encryptNoteData, decryptNoteData } from "./crypto-ed25519";

// ========== Type Guard ==========

/**
 * Type guard to distinguish between WalletSignerAdapter and UTXOpiaKeys
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

  /** Unix timestamp (seconds) from on-chain block_time, 0 if unavailable */
  blockTime?: number;
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
  /** Commitment = Poseidon(npk, token, amount) stored on-chain */
  commitment: Uint8Array;
  leafIndex: number;
  /** Unix timestamp (seconds) from on-chain block_time, 0 if unavailable */
  blockTime?: number;
  /** Solana slot the announcement was emitted in. Needed for auditor slot-range scoping. */
  slot?: number;
  /** Token id hex from the backend indexer, when available. */
  tokenIdHex?: string;
}

// ========== Helper Functions ==========

/** Domain separator for stealth key derivation.
 *  "Aegis-stealth-v1" is LOAD-BEARING — every existing stealth address was
 *  derived using this exact byte sequence. The project's name is now
 *  "UTXOpia"; this string stays as-is. A v2 would bump the suffix. */
const STEALTH_KEY_DOMAIN = new TextEncoder().encode("Aegis-stealth-v1");

// tokenId removed — use computeTokenId(mintBytes) from poseidon.ts instead

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
 * 6. commitment = Poseidon(npk, tokenId, amount)
 * 7. encryptedAmount = amount XOR sha256(sharedSecret)[0..8]
 */
export async function createStealthDeposit(
  recipientMeta: StealthMetaAddress,
  amountSats: bigint,
  tokenId: bigint,
): Promise<StealthDeposit> {
  // Only viewingPubKey + mpk needed (spendingPubKey not used by sender)
  const viewingPubKey = new Uint8Array(recipientMeta.viewingPubKey);

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
  const commitmentBigint = computeJoinSplitCommitmentSync(npk, tokenId, amountSats);
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
  /** npk as 32-byte LE Uint8Array — ready for on-chain instruction data */
  npkBytes: Uint8Array;
}

/**
 * Create stealth deposit with npk for JoinSplit circuit input
 */
export async function createStealthDepositWithKeys(
  recipientMeta: StealthMetaAddress,
  amountSats: bigint,
  tokenId: bigint,
): Promise<StealthOutputWithKeys> {
  // Only viewingPubKey + mpk needed (spendingPubKey not used by sender)
  const viewingPubKey = new Uint8Array(recipientMeta.viewingPubKey);

  const ephemeral = ed25519GenerateKeyPair();
  const sharedSecret = x25519Ecdh(ephemeral.privKey, viewingPubKey);

  const stealthScalar = deriveStealthScalar(sharedSecret);
  const recipientMPK = bytesToBigint(recipientMeta.mpk);
  const npk = computeNPKSync(recipientMPK, stealthScalar);

  const commitmentBigint = computeJoinSplitCommitmentSync(npk, tokenId, amountSats);
  const commitment = bigintToBytes(commitmentBigint);
  const encryptedAmount = encryptAmount(amountSats, sharedSecret);

  return {
    ephemeralPub: new Uint8Array(ephemeral.pubKey),
    encryptedAmount,
    commitment,
    stealthPubKeyX: npk,
    npkBytes: bigintToBytes(npk),
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
 * Extended result when a user refund pubkey is provided.
 * Includes Taproot script-path data for the refund spending path.
 */
export interface NonInteractiveDepositWithRefundResult extends NonInteractiveDepositResult {
  /** 32-byte Merkle root (TapLeaf hash of the refund script) */
  merkleRoot: Uint8Array;
  /** 33-byte control block for script-path spend (leaf_version|parity + internal_key) */
  controlBlock: Uint8Array;
  /** 73-byte refund script */
  refundScript: Uint8Array;
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
 * When `userRefundPubkey` is provided, the Taproot address includes a
 * script-path with a time-locked refund spending condition (144 blocks).
 *
 * @param recipientMeta - Recipient's stealth meta-address
 * @param groupPubKey - FROST group public key (32-byte x-only), used as Taproot internal key
 * @param network - Bitcoin network for address encoding
 * @param userRefundPubkey - Optional 32-byte x-only pubkey for refund script path
 */
export async function createNonInteractiveDeposit(
  recipientMeta: StealthMetaAddress,
  groupPubKey: Uint8Array,
  network?: "mainnet" | "testnet" | "regtest",
  userRefundPubkey?: undefined,
): Promise<NonInteractiveDepositResult>;
export async function createNonInteractiveDeposit(
  recipientMeta: StealthMetaAddress,
  groupPubKey: Uint8Array,
  network: "mainnet" | "testnet" | "regtest",
  userRefundPubkey: Uint8Array,
): Promise<NonInteractiveDepositWithRefundResult>;
export async function createNonInteractiveDeposit(
  recipientMeta: StealthMetaAddress,
  groupPubKey: Uint8Array,
  network: "mainnet" | "testnet" | "regtest" = "testnet",
  userRefundPubkey?: Uint8Array,
): Promise<NonInteractiveDepositResult | NonInteractiveDepositWithRefundResult> {
  // Only viewingPubKey + mpk needed (spendingPubKey not used by sender)
  const viewingPubKey = new Uint8Array(recipientMeta.viewingPubKey);

  // 1. Generate ephemeral Ed25519 keypair
  const ephemeral = ed25519GenerateKeyPair();

  // 2. X25519 ECDH shared secret
  const sharedSecret = x25519Ecdh(ephemeral.privKey, viewingPubKey);

  // 3. Derive stealth scalar → NPK (no commitment — computed on-chain)
  const stealthScalar = deriveStealthScalar(sharedSecret);
  const recipientMPK = bytesToBigint(recipientMeta.mpk);
  const npkBigint = computeNPKSync(recipientMPK, stealthScalar);
  const npk = bigintToBytes(npkBigint);

  const ephemeralPub = new Uint8Array(ephemeral.pubKey);

  if (userRefundPubkey) {
    // Refund path: Taproot with script tree containing refund script
    const { deriveTaprootAddressWithRefund, buildDepositOpReturn } = await import("./taproot");
    const {
      address: btcAddress,
      outputKey,
      merkleRoot,
      controlBlock,
      refundScript,
    } = deriveTaprootAddressWithRefund(npk, userRefundPubkey, groupPubKey, network);

    // Still build OP_RETURN so the backend can detect the deposit
    const opReturnPayload = buildDepositOpReturn(ephemeralPub, npk);

    return {
      btcAddress,
      depositOutputKey: outputKey,
      opReturnPayload,
      npk,
      ephemeralPub,
      merkleRoot,
      controlBlock,
      refundScript,
    };
  }

  // Standard path: key-path-only Taproot address
  const { deriveTaprootAddress, buildDepositOpReturn } = await import("./taproot");
  const { address: btcAddress, outputKey } = deriveTaprootAddress(npk, network, groupPubKey);

  // Build 64-byte OP_RETURN payload (ephemeralPub || npk)
  const opReturnPayload = buildDepositOpReturn(ephemeralPub, npk);

  return {
    btcAddress,
    depositOutputKey: outputKey,
    opReturnPayload,
    npk,
    ephemeralPub,
  };
}

/**
 * Create a non-interactive deposit directly to an Ika-controlled vault.
 *
 * The BTC address is the raw Ika x-only Taproot witness program, so Ika can
 * later sign and spend the UTXO. Privacy/ownership metadata stays per-deposit
 * in OP_RETURN(ephemeralPub || npk), and Solana credits the note from that tx.
 */
export async function createDirectVaultDeposit(
  recipientMeta: StealthMetaAddress,
  vaultXOnlyPubkey: Uint8Array,
  network: "mainnet" | "testnet" | "regtest" = "testnet",
): Promise<NonInteractiveDepositResult> {
  if (vaultXOnlyPubkey.length !== 32) {
    throw new Error("vaultXOnlyPubkey must be 32 bytes");
  }

  const viewingPubKey = new Uint8Array(recipientMeta.viewingPubKey);
  const ephemeral = ed25519GenerateKeyPair();
  const sharedSecret = x25519Ecdh(ephemeral.privKey, viewingPubKey);
  const stealthScalar = deriveStealthScalar(sharedSecret);
  const recipientMPK = bytesToBigint(recipientMeta.mpk);
  const npkBigint = computeNPKSync(recipientMPK, stealthScalar);
  const npk = bigintToBytes(npkBigint);
  const ephemeralPub = new Uint8Array(ephemeral.pubKey);

  const { buildDepositOpReturn } = await import("./taproot");
  const opReturnPayload = buildDepositOpReturn(ephemeralPub, npk);

  return {
    btcAddress: deriveRawXOnlyP2TRAddress(vaultXOnlyPubkey, network),
    depositOutputKey: vaultXOnlyPubkey,
    opReturnPayload,
    npk,
    ephemeralPub,
  };
}

/**
 * Create a non-interactive deposit using the current SDK config.
 *
 * Direct-vault/Ika deposit helper.
 *
 * Deposits go to the raw Ika x-only P2TR vault address. Recipient binding
 * stays per-deposit in OP_RETURN(ephemeralPub || npk), and Solana credits the
 * note by SPV-verifying that deposit transaction directly. Legacy sweep-mode
 * address derivation is intentionally not selected from config anymore.
 */
export async function createDepositFromConfig(
  recipientMeta: StealthMetaAddress,
  network: "mainnet" | "testnet" | "regtest" = "testnet",
): Promise<NonInteractiveDepositResult> {
  const config = getConfig();
  const ikaKey = pickIkaCustodyKey(config);
  if (!ikaKey) {
    throw new Error("Ika direct-vault deposits require ikaDwalletXOnlyPubkey in config");
  }
  if (config.depositMode && !isDirectVaultDepositMode(config.depositMode)) {
    throw new Error(`Unsupported depositMode "${config.depositMode}"; only Ika direct-vault deposits are supported`);
  }
  return createDirectVaultDeposit(recipientMeta, ikaKey, network);
}

export function isDirectVaultDepositMode(mode?: string): boolean {
  return mode === "direct" || mode === "direct_vault" || mode === "ika_direct";
}

/**
 * Choose the Taproot internal key for deposit-address derivation.
 * Exported for unit tests; non-test callers should use `createDepositFromConfig`.
 */
export function pickCustodyInternalKey(config: {
  ikaDwalletXOnlyPubkey?: string;
  groupPubKey: string;
}): Uint8Array {
  return pickIkaCustodyKey(config) ?? hexToBytes(config.groupPubKey);
}

export function pickIkaCustodyKey(config: {
  ikaDwalletXOnlyPubkey?: string;
}): Uint8Array | null {
  const ikaHex = config.ikaDwalletXOnlyPubkey ?? "";
  if (ikaHex && /[1-9a-f]/i.test(ikaHex)) {
    return hexToBytes(ikaHex);
  }
  return null;
}

// ========== Recipient Scanning (Viewing Key Only) ==========

/**
 * Scan announcements using viewing key only
 */
export async function scanAnnouncements(
  source: WalletSignerAdapter | UTXOpiaKeys,
  announcements: {
    ephemeralPub: Uint8Array;
    encryptedAmount: Uint8Array;
    commitment: Uint8Array;
    leafIndex: number;
  }[],
  tokenId: bigint,
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
      const expectedCommitment = computeJoinSplitCommitmentSync(npk, tokenId, amount);
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
  /** Unix timestamp (seconds) from on-chain block_time, 0 if unavailable */
  blockTime?: number;
}

/**
 * Scan announcements with VIEW-ONLY keys.
 * Supports both legacy format and unified format (with announcementType).
 */
export async function scanAnnouncementsViewOnly(
  viewOnlyKeys: ViewOnlyKeys,
  announcements: {
    announcementType?: number;
    ephemeralPub: Uint8Array;
    encryptedAmount: Uint8Array;
    commitment: Uint8Array;
    leafIndex: number;
    blockTime?: number;
  }[],
  tokenId: bigint,
): Promise<ViewOnlyScannedNote[]> {
  const found: ViewOnlyScannedNote[] = [];
  const MAX_SATS = 21_000_000n * 100_000_000n;

  const mpk = computeMPKSync(
    viewOnlyKeys.spendingPubKey.x,
    viewOnlyKeys.spendingPubKey.y,
    viewOnlyKeys.nullifyingKey
  );

  for (const ann of announcements) {
    try {
      const sharedSecret = x25519Ecdh(viewOnlyKeys.viewingPrivKey, ann.ephemeralPub);

      // Get amount based on announcement type
      let amount: bigint;
      if (ann.announcementType === ANNOUNCEMENT_TYPE_DEPOSIT) {
        const view = new DataView(ann.encryptedAmount.buffer, ann.encryptedAmount.byteOffset, 8);
        amount = view.getBigUint64(0, true);
      } else {
        amount = decryptAmount(ann.encryptedAmount, sharedSecret);
      }

      if (amount <= 0n || amount > MAX_SATS) {
        continue;
      }

      const stealthScalar = deriveStealthScalar(sharedSecret);
      const npk = computeNPKSync(mpk, stealthScalar);
      const expectedCommitment = computeJoinSplitCommitmentSync(npk, tokenId, amount);
      const actualCommitment = bytesToBigint(ann.commitment);

      // For deposits, must verify commitment to filter non-matching
      if (ann.announcementType === ANNOUNCEMENT_TYPE_DEPOSIT) {
        if (expectedCommitment !== actualCommitment) {
          continue;
        }
      }

      // For transfers, wrong key → garbage amount already filtered above

      found.push({
        amount,
        leafIndex: ann.leafIndex,
        commitment: ann.announcementType === ANNOUNCEMENT_TYPE_DEPOSIT
          ? bigintToBytes(expectedCommitment)
          : new Uint8Array(ann.commitment),
        ephemeralPub: ann.ephemeralPub,
        blockTime: ann.blockTime ?? 0,
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

/**
 * Export view-only keys from full UTXOpiaKeys
 */
export function exportViewOnlyKeys(keys: UTXOpiaKeys): ViewOnlyKeys {
  return {
    viewingPrivKey: keys.viewingPrivKey,
    spendingPubKey: keys.spendingPubKey,
    nullifyingKey: keys.nullifyingKey,
  };
}

/**
 * Encode view-only keys as a hex string for sharing
 * Format: viewingPrivKey(32) + compressedSpendingPub(32) + nullifyingKey(32) = 96 bytes
 */
export function encodeViewOnlyKeys(keys: ViewOnlyKeys): string {
  const compressed = babyJubCompress(keys.spendingPubKey);
  const nullBytes = bigintToBytes(keys.nullifyingKey);
  const combined = new Uint8Array(96);
  combined.set(keys.viewingPrivKey, 0);
  combined.set(compressed, 32);
  combined.set(nullBytes, 64);
  return bytesToHex(combined);
}

/**
 * Decode view-only keys from a hex string
 */
export function decodeViewOnlyKeys(encoded: string): ViewOnlyKeys {
  const bytes = hexToBytes(encoded);
  if (bytes.length !== 96) {
    throw new Error("Invalid view-only key length (expected 96 bytes)");
  }
  const viewingPrivKey = bytes.slice(0, 32);
  const compressed = bytes.slice(32, 64);
  const spendingPubKey = babyJubDecompress(compressed);
  const nullifyingKey = bytesToBigint(bytes.slice(64, 96));
  return { viewingPrivKey, spendingPubKey, nullifyingKey };
}

// ========== Claim Preparation (Spending Key Required) ==========

/**
 * Prepare claim inputs for ZK proof generation
 */
export async function prepareClaimInputs(
  source: WalletSignerAdapter | UTXOpiaKeys,
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

// ========== Unified Note Scanning ==========

/**
 * Scan unified StealthAnnouncement notes (both deposits and transfers).
 *
 * For each announcement:
 * - type=0 (deposit): amount is plaintext u64 LE in amount_bytes
 * - type=1 (transfer): amount is XOR-encrypted in amount_bytes
 *
 * Commitment is computed locally: Poseidon(npk, tokenId, amount).
 * For deposits, we verify the derived NPK produces a valid commitment.
 * For transfers, we verify the decrypted amount is in a valid range.
 */
export async function scanUnifiedNotes(
  source: WalletSignerAdapter | UTXOpiaKeys,
  announcements: OnChainStealthAnnouncement[],
  tokenId: bigint,
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

      // Derive stealth scalar and expected NPK + commitment (computed locally)
      const stealthScalar = deriveStealthScalar(sharedSecret);
      const npk = computeNPKSync(mpk, stealthScalar);
      const commitmentBigint = computeJoinSplitCommitmentSync(npk, tokenId, amount);

      // For deposits (type=0), amount is plaintext so any key reads valid amount.
      // Must verify commitment to filter out deposits that don't belong to us.
      // For transfers (type=1), wrong key → garbage decrypted amount → already filtered above.
      if (ann.announcementType === ANNOUNCEMENT_TYPE_DEPOSIT) {
        const onChainCommitment = bytesToBigint(ann.commitment);
        if (commitmentBigint !== onChainCommitment) {
          continue; // Not our deposit — ECDH shared secret doesn't match
        }
      }

      // Convert commitment bigint to bytes for the ScannedNote
      // Use on-chain commitment bytes for transfers (preserves exact on-chain value)
      const commitmentBytes = ann.announcementType === ANNOUNCEMENT_TYPE_DEPOSIT
        ? bigintToBytes(commitmentBigint)
        : new Uint8Array(ann.commitment);

      // Derive stealth public key (for spending)
      const stealthPub = deriveStealthPubKey(keys.spendingPubKey, sharedSecret);

      found.push({
        amount,
        ephemeralPub: ann.ephemeralPub,
        stealthPub,
        leafIndex: ann.leafIndex,
        commitment: commitmentBytes,
        blockTime: ann.blockTime ?? 0,
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

// ========== Connection Adapter ==========

import type { Address } from "@solana/kit";

export interface ConnectionAdapter {
  getAccountInfo: (
    pubkey: Address
  ) => Promise<{ data: Uint8Array } | null>;
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
  keys: UTXOpiaKeys,
  amountSats: bigint,
  tokenId: bigint,
): Promise<StealthOutputData> {
  const ephemeral = ed25519GenerateKeyPair();
  const sharedSecret = x25519Ecdh(ephemeral.privKey, keys.viewingPubKey);

  const stealthScalar = deriveStealthScalar(sharedSecret);
  const mpk = computeMPKSync(keys.spendingPubKey.x, keys.spendingPubKey.y, keys.nullifyingKey);
  const npk = computeNPKSync(mpk, stealthScalar);

  const commitmentBigint = computeJoinSplitCommitmentSync(npk, tokenId, amountSats);
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
  keys: UTXOpiaKeys,
  amountSats: bigint,
  tokenId: bigint,
): Promise<StealthOutputWithKeys> {
  const ephemeral = ed25519GenerateKeyPair();
  const sharedSecret = x25519Ecdh(ephemeral.privKey, keys.viewingPubKey);

  const stealthScalar = deriveStealthScalar(sharedSecret);
  const mpk = computeMPKSync(keys.spendingPubKey.x, keys.spendingPubKey.y, keys.nullifyingKey);
  const npk = computeNPKSync(mpk, stealthScalar);

  const commitmentBigint = computeJoinSplitCommitmentSync(npk, tokenId, amountSats);
  const commitment = bigintToBytes(commitmentBigint);
  const encryptedAmount = encryptAmount(amountSats, sharedSecret);

  return {
    ephemeralPub: new Uint8Array(ephemeral.pubKey),
    encryptedAmount,
    commitment,
    stealthPubKeyX: npk,
    npkBytes: bigintToBytes(npk),
  };
}

/**
 * Create stealth output data with pre-computed commitment
 */
export async function createStealthOutputForCommitment(
  keys: UTXOpiaKeys,
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
  keys: UTXOpiaKeys,
  note: ScannedNote
): Uint8Array {
  // In JoinSplit model, nullifier = Poseidon(nullifyingKey, leafIndex)
  // No extra hash layer — the nullifier IS the public output
  const nullifier = computeJoinSplitNullifierSync(keys.nullifyingKey, BigInt(note.leafIndex));
  return bigintToBytes(nullifier);
}

/**
 * Compute nullifier hash for a note and return as raw bytes.
 * Convenience wrapper — avoids importing computeJoinSplitNullifierSync + bigintToBytes in consumers.
 */
export function computeNullifierBytes(nullifyingKey: bigint, leafIndex: number): Uint8Array {
  const nullifier = computeJoinSplitNullifierSync(nullifyingKey, BigInt(leafIndex));
  return bigintToBytes(nullifier);
}

// ========== Announcement Parsing ==========

/**
 * Parse backend announcement rows (hex strings) into the format scanUnifiedNotes expects.
 */
export function parseAnnouncementsFromHex(rows: Array<{
  announcement_type: number;
  ephemeral_pub: string;
  encrypted_amount: string;
  commitment: string;
  leaf_index: number;
  token_id?: string | null;
}>): Array<{
  announcementType: number;
  ephemeralPub: Uint8Array;
  encryptedAmount: Uint8Array;
  commitment: Uint8Array;
  leafIndex: number;
  tokenIdHex?: string;
}> {
  return rows.map((r) => ({
    announcementType: r.announcement_type,
    ephemeralPub: hexToBytes(r.ephemeral_pub),
    encryptedAmount: hexToBytes(r.encrypted_amount),
    commitment: hexToBytes(r.commitment),
    leafIndex: r.leaf_index,
    tokenIdHex: r.token_id ?? undefined,
  }));
}

// ========== Deposit Ownership Check ==========

/**
 * Check if a deposit (identified by its OP_RETURN ephemeralPub + npk) belongs
 * to the given viewing key holder.
 *
 * Performs X25519 ECDH between the viewer's private key and the deposit's
 * ephemeral public key, derives the expected NPK, and compares it with the
 * deposit's actual NPK.
 */
export function isDepositForViewer(
  viewingPrivKey: Uint8Array,
  spendingPubKey: { x: bigint; y: bigint },
  nullifyingKey: bigint,
  ephemeralPub: Uint8Array,
  depositNpk: bigint,
): boolean {
  try {
    const sharedSecret = x25519Ecdh(viewingPrivKey, ephemeralPub);
    const mpk = computeMPKSync(spendingPubKey.x, spendingPubKey.y, nullifyingKey);
    const stealthScalar = deriveStealthScalar(sharedSecret);
    const expectedNpk = computeNPKSync(mpk, stealthScalar);
    return expectedNpk === depositNpk;
  } catch {
    return false;
  }
}

/**
 * Check if a deposit belongs to this viewer — accepts hex string inputs.
 * Convenience wrapper around isDepositForViewer for frontend use.
 */
export function isDepositForViewerHex(
  keys: { viewingPrivKey: Uint8Array; spendingPubKey: { x: bigint; y: bigint }; nullifyingKey: bigint },
  ephemeralPubHex: string,
  npkHex: string,
): boolean {
  try {
    const ephPub = hexToBytes(ephemeralPubHex);
    const npk = bytesToBigint(hexToBytes(npkHex));
    return isDepositForViewer(keys.viewingPrivKey, keys.spendingPubKey, keys.nullifyingKey, ephPub, npk);
  } catch {
    return false;
  }
}
