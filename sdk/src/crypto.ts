/**
 * Cryptographic utilities for UTXOpia
 *
 * This module provides:
 * - Field constants (BN254)
 * - Byte conversion utilities
 * - SHA-256 and tagged hashing
 * - Re-exports from Baby Jubjub (spending keys) and Ed25519 (viewing keys)
 *
 * Baby Jubjub: Twisted Edwards curve for SNARK-friendly spending key operations
 * Ed25519/X25519: Fast standard curve for viewing key ECDH (off-chain only)
 *
 * @module crypto
 */

import { sha256 } from "@noble/hashes/sha2.js";

// =============================================================================
// Field Constants
// =============================================================================

/** BN254 field prime (used by circom/snarkjs, also Baby Jubjub base field) */
export const BN254_FIELD_PRIME =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// =============================================================================
// Re-exports from Baby Jubjub (spending keys)
// =============================================================================

export {
  BABYJUB_FIELD_PRIME,
  BABYJUB_A,
  BABYJUB_D,
  BABYJUB_ORDER,
  BABYJUB_BASE8,
  BABYJUB_IDENTITY,
  babyJubAdd,
  babyJubDouble,
  babyJubMul,
  babyJubNegate,
  isOnBabyJubCurve,
  isIdentity,
  babyJubCompress,
  babyJubDecompress,
  generateBabyJubKeyPair,
  deriveBabyJubKeyFromSeed,
  babyJubScalarFromBytes,
  babyJubScalarToBytes,
  type BabyJubPoint,
} from "./crypto-babyjub";

// =============================================================================
// Re-exports from Ed25519 (viewing keys)
// =============================================================================

export {
  ed25519GenerateKeyPair,
  ed25519GetPublicKey,
  ed25519DeriveKeyFromSeed,
  ed25519PubToX25519,
  x25519Ecdh,
  deriveAmountKey,
  encryptAmountEd25519,
  decryptAmountEd25519,
  encryptNoteData,
  decryptNoteData,
} from "./crypto-ed25519";

// =============================================================================
// Byte Conversion Utilities
// =============================================================================

/**
 * Generate a random field element (< BN254 prime)
 */
export function randomFieldElement(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBigint(bytes) % BN254_FIELD_PRIME;
}

/**
 * Convert bigint to 32-byte Uint8Array (big-endian)
 */
export function bigintToBytes(value: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let temp = value;
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(temp & 0xffn);
    temp = temp >> 8n;
  }
  return bytes;
}

/**
 * Convert Uint8Array to bigint (big-endian)
 */
export function bytesToBigint(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = 0; i < bytes.length; i++) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result;
}

/**
 * Convert hex string to Uint8Array
 */
export function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = parseInt(cleanHex.substr(i, 2), 16);
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

// =============================================================================
// Hashing Utilities
// =============================================================================

/**
 * SHA-256 hash using @noble/hashes
 */
export function sha256Hash(data: Uint8Array): Uint8Array {
  return sha256(data);
}

/**
 * Double SHA256 hash (Bitcoin standard)
 */
export function doubleSha256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

/**
 * Tagged hash as used in BIP-340/341 (Taproot)
 * H_tag(x) = SHA256(SHA256(tag) || SHA256(tag) || x)
 */
export function taggedHash(tag: string, data: Uint8Array): Uint8Array {
  const encoder = new TextEncoder();
  const tagBytes = encoder.encode(tag);
  const tagHash = sha256(tagBytes);

  // Concatenate: SHA256(tag) || SHA256(tag) || data
  const combined = new Uint8Array(64 + data.length);
  combined.set(tagHash, 0);
  combined.set(tagHash, 32);
  combined.set(data, 64);

  return sha256(combined);
}

// =============================================================================
// Scalar Utilities (curve-agnostic, uses Baby Jubjub order)
// =============================================================================

import { BABYJUB_ORDER } from "./crypto-babyjub";

function mod(n: bigint, p: bigint): bigint {
  const result = n % p;
  return result >= 0n ? result : result + p;
}

/**
 * Derive a scalar from bytes (reduces modulo Baby Jubjub subgroup order)
 */
export function scalarFromBytes(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = 0; i < bytes.length; i++) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return mod(result, BABYJUB_ORDER);
}

/**
 * Convert a bigint scalar to 32 bytes (big-endian)
 */
export function scalarToBytes(scalar: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let temp = mod(scalar, BABYJUB_ORDER);
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(temp & 0xffn);
    temp = temp >> 8n;
  }
  return bytes;
}
