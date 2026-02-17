/**
 * Name Registry utilities for ZVault (.zkey.sol names)
 *
 * Provides on-chain lookup for .zkey.sol names (human-readable stealth addresses).
 * Names map to (spendingPubKey, viewingPubKey) for easy stealth sends.
 *
 * Example:
 * ```typescript
 * import { lookupZkeyName } from '@zvault/sdk';
 *
 * const entry = await lookupZkeyName(connection, 'alice');
 * if (entry) {
 *   console.log('Found alice.zkey.sol:', entry.spendingPubKey);
 * }
 * ```
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { ZVAULT_PROGRAM_ID as PROGRAM_ID_ADDRESS } from "./pda";

// ========== Constants ==========

/** Maximum name length (excluding .zkey suffix) */
export const MAX_NAME_LENGTH = 32;

/** Allowed characters regex */
const NAME_REGEX = /^[a-z0-9_]{1,32}$/;

/** PDA seed for name registry */
export const NAME_REGISTRY_SEED = "zkey";

/** PDA seed for reverse registry (SNS pattern) */
export const REVERSE_REGISTRY_SEED = "reverse";

/** Account discriminator */
export const NAME_REGISTRY_DISCRIMINATOR = 0x09;

/** Reverse registry discriminator */
export const REVERSE_REGISTRY_DISCRIMINATOR = 0x0a;

/** Account size in bytes */
export const NAME_REGISTRY_SIZE = 178;

/** Reverse registry size in bytes */
export const REVERSE_REGISTRY_SIZE = 100;

/** Default program ID (devnet) - re-exported from pda.ts as string */
export const ZVAULT_PROGRAM_ID = PROGRAM_ID_ADDRESS as string;

// ========== Types ==========

/**
 * Parsed name registry entry from on-chain data
 */
export interface NameRegistryEntry {
  /** The registered name (without .zkey suffix) */
  name: string;

  /** SHA256 hash of the lowercase name */
  nameHash: Uint8Array;

  /** Solana pubkey of the owner (can update/transfer) */
  owner: Uint8Array;

  /** Baby Jubjub spending public key (32 bytes compressed) */
  spendingPubKey: Uint8Array;

  /** Ed25519 viewing public key (32 bytes) */
  viewingPubKey: Uint8Array;

  /** Registration timestamp */
  createdAt: Date;

  /** Last update timestamp */
  updatedAt: Date;
}

/**
 * Stealth meta-address derived from name registry
 */
export interface ZkeyStealthAddress {
  /** The .zkey name */
  name: string;

  /** Baby Jubjub spending public key (32 bytes compressed) */
  spendingPubKey: Uint8Array;

  /** Ed25519 viewing public key (32 bytes) */
  viewingPubKey: Uint8Array;

  /** Combined stealth meta-address (64 bytes = spending + viewing) */
  stealthMetaAddress: Uint8Array;

  /** Hex-encoded stealth meta-address (128 chars) */
  stealthMetaAddressHex: string;
}

// ========== Validation ==========

/**
 * Check if a name is valid (lowercase alphanumeric + underscore, 1-32 chars)
 */
export function isValidName(name: string): boolean {
  return NAME_REGEX.test(name);
}

/**
 * Normalize a name (lowercase, trim, remove .zkey.sol or .zkey suffix)
 */
export function normalizeName(name: string): string {
  let normalized = name.toLowerCase().trim();
  if (normalized.endsWith(".zkey.sol")) {
    normalized = normalized.slice(0, -9);
  } else if (normalized.endsWith(".zkey")) {
    normalized = normalized.slice(0, -5);
  }
  return normalized;
}

/**
 * Format a name with .zkey.sol suffix (SNS subdomain format)
 */
export function formatZkeyName(name: string): string {
  return `${normalizeName(name)}.zkey.sol`;
}

/**
 * Get validation error for a name, or null if valid
 */
export function getNameValidationError(name: string): string | null {
  const normalized = normalizeName(name);

  if (normalized.length === 0) {
    return "Name cannot be empty";
  }
  if (normalized.length > MAX_NAME_LENGTH) {
    return `Name cannot exceed ${MAX_NAME_LENGTH} characters`;
  }
  if (!NAME_REGEX.test(normalized)) {
    return "Name can only contain lowercase letters, numbers, and underscores";
  }
  return null;
}

// ========== Hashing ==========

/**
 * Hash a name using SHA256 (matches on-chain)
 */
export function hashName(name: string): Uint8Array {
  const normalized = normalizeName(name);
  if (!isValidName(normalized)) {
    throw new Error(
      `Invalid name "${name}". Must be 1-32 lowercase letters, numbers, or underscores.`
    );
  }
  const encoder = new TextEncoder();
  return sha256(encoder.encode(normalized));
}

// ========== PDA Derivation ==========

/**
 * Derive the PDA address for a name registry
 *
 * @param name - The name to look up (with or without .zkey suffix)
 * @param programId - The zVault program ID (defaults to devnet)
 * @returns [pda, bump] tuple
 */
export function deriveNameRegistryPDA(
  name: string,
  programId: string = ZVAULT_PROGRAM_ID
): { pda: Uint8Array; bump: number; nameHash: Uint8Array } {
  const nameHash = hashName(name);

  // Manual PDA derivation (platform-agnostic)
  // In practice, use PublicKey.findProgramAddressSync on Solana
  // This returns the hash for SDK consumers to use with their preferred library

  return {
    pda: new Uint8Array(32), // Placeholder - actual PDA derived by caller
    bump: 0,
    nameHash,
  };
}

// ========== On-chain Parsing ==========

/**
 * Parse a NameRegistry account data
 *
 * Layout (180 bytes):
 * - discriminator (1 byte) = 0x09
 * - bump (1 byte)
 * - name_hash (32 bytes)
 * - owner (32 bytes)
 * - spending_pubkey (32 bytes)
 * - viewing_pubkey (32 bytes)
 * - created_at (8 bytes, i64 LE)
 * - updated_at (8 bytes, i64 LE)
 * - _reserved (32 bytes)
 *
 * @param data - Raw account data
 * @param name - Optional name to set in the result
 * @returns Parsed entry or null if invalid
 */
export function parseNameRegistry(
  data: Uint8Array,
  name?: string
): NameRegistryEntry | null {
  if (data.length < NAME_REGISTRY_SIZE) {
    return null;
  }

  // Check discriminator
  if (data[0] !== NAME_REGISTRY_DISCRIMINATOR) {
    return null;
  }

  let offset = 2; // Skip discriminator and bump

  const nameHash = data.slice(offset, offset + 32);
  offset += 32;

  const owner = data.slice(offset, offset + 32);
  offset += 32;

  const spendingPubKey = data.slice(offset, offset + 32);
  offset += 32;

  const viewingPubKey = data.slice(offset, offset + 32);
  offset += 32;

  // Parse timestamps (i64 LE)
  const createdAtBytes = data.slice(offset, offset + 8);
  offset += 8;
  const updatedAtBytes = data.slice(offset, offset + 8);

  const createdAtView = new DataView(createdAtBytes.buffer, createdAtBytes.byteOffset, 8);
  const updatedAtView = new DataView(updatedAtBytes.buffer, updatedAtBytes.byteOffset, 8);

  // Safe BigInt to Number conversion with overflow check
  const createdAtBigInt = createdAtView.getBigInt64(0, true);
  const updatedAtBigInt = updatedAtView.getBigInt64(0, true);

  // Check for overflow before converting to Number (timestamps should be reasonable)
  const MAX_SAFE_TIMESTAMP = BigInt(Number.MAX_SAFE_INTEGER);
  const createdAtNum = createdAtBigInt > MAX_SAFE_TIMESTAMP ? Number.MAX_SAFE_INTEGER : Number(createdAtBigInt);
  const updatedAtNum = updatedAtBigInt > MAX_SAFE_TIMESTAMP ? Number.MAX_SAFE_INTEGER : Number(updatedAtBigInt);

  const createdAt = new Date(createdAtNum * 1000);
  const updatedAt = new Date(updatedAtNum * 1000);

  return {
    name: name ? normalizeName(name) : "",
    nameHash,
    owner,
    spendingPubKey,
    viewingPubKey,
    createdAt,
    updatedAt,
  };
}

// ========== High-level Lookup ==========

/**
 * Look up a .zkey name and return the stealth address
 *
 * This is a convenience function that:
 * 1. Derives the PDA for the name
 * 2. Fetches the account data
 * 3. Parses and returns the stealth address
 *
 * @param connection - Solana connection (must have getAccountInfo method)
 * @param name - The name to look up (with or without .zkey suffix)
 * @param programId - The zVault program ID
 * @returns Stealth address or null if not found
 */
export async function lookupZkeyName(
  connection: {
    getAccountInfo: (
      pubkey: import("@solana/kit").Address
    ) => Promise<{ data: Uint8Array } | null>;
  },
  name: string,
  programId: string = ZVAULT_PROGRAM_ID
): Promise<ZkeyStealthAddress | null> {
  const normalized = normalizeName(name);
  const error = getNameValidationError(normalized);
  if (error) {
    return null;
  }

  try {
    const nameHash = hashName(normalized);

    // Caller must provide a way to derive PDA and fetch account
    // This is a platform-agnostic interface
    const { address, getProgramDerivedAddress } = await import("@solana/kit");

    const [pda] = await getProgramDerivedAddress({
      seeds: [
        new TextEncoder().encode(NAME_REGISTRY_SEED),
        nameHash,
      ],
      programAddress: address(programId),
    });

    const accountInfo = await connection.getAccountInfo(pda);
    if (!accountInfo) {
      return null;
    }

    const entry = parseNameRegistry(new Uint8Array(accountInfo.data), normalized);
    if (!entry) {
      return null;
    }

    // Combine spending + viewing into stealth meta-address (32 + 32 = 64 bytes)
    const stealthMetaAddress = new Uint8Array(64);
    stealthMetaAddress.set(entry.spendingPubKey, 0);
    stealthMetaAddress.set(entry.viewingPubKey, 32);

    return {
      name: normalized,
      spendingPubKey: entry.spendingPubKey,
      viewingPubKey: entry.viewingPubKey,
      stealthMetaAddress,
      stealthMetaAddressHex: Buffer.from(stealthMetaAddress).toString("hex"),
    };
  } catch (err) {
    console.error("Failed to lookup .zkey name:", err);
    return null;
  }
}

/**
 * Look up a .zkey name with a pre-constructed PDA
 *
 * Use this when you already have the PDA (e.g., from frontend with wallet adapter)
 *
 * @param getAccountInfo - Function to fetch account data
 * @param pda - The pre-computed PDA
 * @param name - The name being looked up
 * @returns Stealth address or null if not found
 */
export async function lookupZkeyNameWithPDA(
  getAccountInfo: () => Promise<{ data: Uint8Array } | null>,
  name: string
): Promise<ZkeyStealthAddress | null> {
  const normalized = normalizeName(name);

  try {
    const accountInfo = await getAccountInfo();
    if (!accountInfo) {
      return null;
    }

    const entry = parseNameRegistry(new Uint8Array(accountInfo.data), normalized);
    if (!entry) {
      return null;
    }

    const stealthMetaAddress = new Uint8Array(66);
    stealthMetaAddress.set(entry.spendingPubKey, 0);
    stealthMetaAddress.set(entry.viewingPubKey, 33);

    return {
      name: normalized,
      spendingPubKey: entry.spendingPubKey,
      viewingPubKey: entry.viewingPubKey,
      stealthMetaAddress,
      stealthMetaAddressHex: Buffer.from(stealthMetaAddress).toString("hex"),
    };
  } catch (err) {
    console.error("Failed to lookup .zkey name:", err);
    return null;
  }
}

// ========== Reverse Lookup (SNS Pattern) ==========

/**
 * Parse a ReverseRegistry account data
 *
 * Layout (100 bytes):
 * - discriminator (1 byte) = 0x0A
 * - bump (1 byte)
 * - spending_pubkey (32 bytes)
 * - name_len (1 byte)
 * - name (32 bytes, padded)
 * - _reserved (32 bytes)
 *
 * @param data - Raw account data
 * @returns The name string or null if invalid
 */
export function parseReverseRegistry(data: Uint8Array): string | null {
  if (data.length < REVERSE_REGISTRY_SIZE) {
    return null;
  }

  // Check discriminator
  if (data[0] !== REVERSE_REGISTRY_DISCRIMINATOR) {
    return null;
  }

  // Skip discriminator (1), bump (1), spending_pubkey (32)
  const nameLen = data[34];
  if (nameLen === 0 || nameLen > MAX_NAME_LENGTH) {
    return null;
  }

  // Name starts at offset 35
  const nameBytes = data.slice(35, 35 + nameLen);
  return new TextDecoder().decode(nameBytes);
}

/**
 * Reverse lookup: Get the .zkey.sol name for a spending public key
 *
 * This is the SNS-style reverse lookup that enables:
 * spending_pubkey → name
 *
 * @param connection - Solana connection
 * @param spendingPubKey - 32-byte compressed Baby Jubjub spending public key
 * @param programId - The zVault program ID
 * @returns The registered name or null if not found
 */
export async function reverseLookupZkeyName(
  connection: {
    getAccountInfo: (
      pubkey: import("@solana/kit").Address
    ) => Promise<{ data: Uint8Array } | null>;
  },
  spendingPubKey: Uint8Array,
  programId: string = ZVAULT_PROGRAM_ID
): Promise<string | null> {
  if (spendingPubKey.length !== 32) {
    return null;
  }

  try {
    const { address, getProgramDerivedAddress } = await import("@solana/kit");

    // 32-byte key fits directly as PDA seed
    const seed = spendingPubKey;

    const [pda] = await getProgramDerivedAddress({
      seeds: [
        new TextEncoder().encode(REVERSE_REGISTRY_SEED),
        seed,
      ],
      programAddress: address(programId),
    });

    const accountInfo = await connection.getAccountInfo(pda);
    if (!accountInfo) {
      return null;
    }

    return parseReverseRegistry(new Uint8Array(accountInfo.data));
  } catch (err) {
    console.error("Failed to reverse lookup .zkey name:", err);
    return null;
  }
}

// No longer needed - Baby Jubjub compressed keys are already 32 bytes

/**
 * Derive the reverse registry PDA for a spending public key
 *
 * @param spendingPubKey - 32-byte compressed Baby Jubjub spending public key
 * @param programId - The zVault program ID
 * @returns The PDA address
 */
export async function deriveReverseRegistryPDA(
  spendingPubKey: Uint8Array,
  programId: string = ZVAULT_PROGRAM_ID
): Promise<string> {
  const { address, getProgramDerivedAddress } = await import("@solana/kit");

  // 32-byte key fits directly as PDA seed
  const seed = spendingPubKey;

  const [pda] = await getProgramDerivedAddress({
    seeds: [
      new TextEncoder().encode(REVERSE_REGISTRY_SEED),
      seed,
    ],
    programAddress: address(programId),
  });

  return pda;
}

// ========== Instruction Data Builders ==========

/**
 * Build instruction data for REGISTER_NAME
 *
 * Layout:
 * - discriminator (1 byte) = 8
 * - name_len (1 byte)
 * - name (name_len bytes)
 * - name_hash (32 bytes)
 * - spending_pubkey (32 bytes)
 * - viewing_pubkey (32 bytes)
 */
export function buildRegisterNameData(
  name: string,
  spendingPubKey: Uint8Array,
  viewingPubKey: Uint8Array
): Uint8Array {
  const normalized = normalizeName(name);
  const error = getNameValidationError(normalized);
  if (error) {
    throw new Error(error);
  }

  if (spendingPubKey.length !== 32) {
    throw new Error("Spending public key must be 32 bytes (compressed Baby Jubjub)");
  }
  if (viewingPubKey.length !== 32) {
    throw new Error("Viewing public key must be 32 bytes (Ed25519)");
  }

  const nameBytes = new TextEncoder().encode(normalized);
  const nameHash = hashName(normalized);

  // Total size: 1 + 1 + nameLen + 32 + 32 + 32
  const data = new Uint8Array(1 + 1 + nameBytes.length + 32 + 32 + 32);
  let offset = 0;

  // Discriminator
  data[offset++] = 8; // REGISTER_NAME

  // Name length and name
  data[offset++] = nameBytes.length;
  data.set(nameBytes, offset);
  offset += nameBytes.length;

  // Name hash
  data.set(nameHash, offset);
  offset += 32;

  // Spending pubkey
  data.set(spendingPubKey, offset);
  offset += 32;

  // Viewing pubkey
  data.set(viewingPubKey, offset);

  return data;
}

/**
 * Build instruction data for UPDATE_NAME
 *
 * Layout:
 * - discriminator (1 byte) = 9
 * - name_hash (32 bytes)
 * - spending_pubkey (32 bytes)
 * - viewing_pubkey (32 bytes)
 */
export function buildUpdateNameData(
  name: string,
  spendingPubKey: Uint8Array,
  viewingPubKey: Uint8Array
): Uint8Array {
  const nameHash = hashName(name);

  if (spendingPubKey.length !== 32) {
    throw new Error("Spending public key must be 32 bytes");
  }
  if (viewingPubKey.length !== 32) {
    throw new Error("Viewing public key must be 32 bytes");
  }

  const data = new Uint8Array(1 + 32 + 32 + 32);
  let offset = 0;

  data[offset++] = 9; // UPDATE_NAME
  data.set(nameHash, offset);
  offset += 32;
  data.set(spendingPubKey, offset);
  offset += 32;
  data.set(viewingPubKey, offset);

  return data;
}

/**
 * Build instruction data for TRANSFER_NAME
 *
 * Layout:
 * - discriminator (1 byte) = 10
 * - name_hash (32 bytes)
 */
export function buildTransferNameData(name: string): Uint8Array {
  const nameHash = hashName(name);

  const data = new Uint8Array(1 + 32);
  data[0] = 10; // TRANSFER_NAME
  data.set(nameHash, 1);

  return data;
}
