/**
 * Bound Parameters Hash for JoinSplit transactions
 *
 * The boundParamsHash binds transaction metadata to the proof:
 * - treeNumber: Which commitment tree (for multi-tree support)
 * - unshieldAddress: Recipient for public unshield (null = private transfer)
 * - chainId: Prevents cross-chain replay
 * - stealthDataHash: SHA256 of concatenated stealth data (prevents relayer tampering)
 *
 * Hash: SHA256(serialize(params)) mod BN254_SCALAR_FIELD
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { BN254_FIELD_PRIME, bytesToBigint } from "./crypto";

/** Bound params mode: transfer(0), unshield(1), redeem(2) */
export type BoundParamsMode = 'transfer' | 'unshield' | 'redeem';

export interface BoundParams {
  /** Tree number (0 for default) */
  treeNumber: number;
  /** Unshield recipient address (null = private transfer, 32 bytes = public unshield/redeem) */
  unshieldAddress: Uint8Array | null;
  /** Chain ID (prevents cross-chain replay) */
  chainId: bigint;
  /** Mode flag: 'transfer'(0), 'unshield'(1), 'redeem'(2). Defaults to inferred from unshieldAddress. */
  mode?: BoundParamsMode;
  /** SHA256 of concatenated stealth data (prevents relayer from corrupting change outputs) */
  stealthDataHash: Uint8Array;
}

/**
 * Compute SHA256 hash of concatenated stealth data arrays.
 * Returns 32-byte hash, or all zeros if no stealth data.
 */
export function computeStealthDataHash(stealthData: Uint8Array[]): Uint8Array {
  // Always SHA256 the concatenation — even for empty arrays.
  // On-chain: sha256(&data[stealth_start..stealth_end]) — empty slice → sha256("")
  const totalLen = stealthData.reduce((sum, sd) => sum + sd.length, 0);
  const concat = new Uint8Array(totalLen);
  let offset = 0;
  for (const sd of stealthData) {
    concat.set(sd, offset);
    offset += sd.length;
  }
  return sha256(concat);
}

/**
 * Compute the bound parameters hash
 *
 * Deterministic serialization:
 * - treeNumber: 4 bytes LE
 * - flag: 1 byte (0=transfer, 1=unshield, 2=redeem)
 * - unshieldAddress: 32 bytes (zeros if null)
 * - chainId: 8 bytes LE
 * - stealthDataHash: 32 bytes (SHA256 of concatenated stealth data)
 *
 * Total: 77 bytes → SHA256 → mod BN254
 */
export function computeBoundParamsHash(params: BoundParams): bigint {
  const buf = new Uint8Array(77);
  const view = new DataView(buf.buffer);

  // treeNumber (4 bytes LE)
  view.setUint32(0, params.treeNumber, true);

  // flag byte: transfer=0, unshield=1, redeem=2
  if (params.mode === 'redeem') {
    buf[4] = 2;
  } else if (params.mode === 'unshield' || params.unshieldAddress) {
    buf[4] = 1;
  } else {
    buf[4] = 0;
  }

  // unshieldAddress (32 bytes, zeros if null)
  if (params.unshieldAddress) {
    buf.set(params.unshieldAddress.slice(0, 32), 5);
  }

  // chainId (8 bytes LE)
  const chainIdBuf = new Uint8Array(8);
  let chainId = params.chainId;
  for (let i = 0; i < 8; i++) {
    chainIdBuf[i] = Number(chainId & 0xffn);
    chainId >>= 8n;
  }
  buf.set(chainIdBuf, 37);

  // stealthDataHash (32 bytes)
  buf.set(params.stealthDataHash.slice(0, 32), 45);

  // SHA256 → mod BN254
  const hash = sha256(buf);
  return bytesToBigint(hash) % BN254_FIELD_PRIME;
}

/**
 * Default bound params for Solana devnet (private transfer)
 */
export function createTransferBoundParams(
  stealthDataHash: Uint8Array,
  chainId: bigint = 103n,
  treeNumber: number = 0,
): BoundParams {
  return {
    treeNumber,
    unshieldAddress: null,
    chainId,
    stealthDataHash,
  };
}

/** @deprecated Use createTransferBoundParams instead */
export const DEFAULT_BOUND_PARAMS: BoundParams = {
  treeNumber: 0,
  unshieldAddress: null,
  chainId: 103n,
  stealthDataHash: new Uint8Array(32),
};

/**
 * Create bound params for a redeem (JoinSplit → BTC withdrawal, multi-output)
 *
 * The BTC scriptPubKeys are concatenated and SHA-256 hashed into the address field
 * so the proof cryptographically binds ALL withdrawal destinations.
 *
 * For single output: SHA256(script_1) — no special case.
 * For multi-output: SHA256(script_1 || script_2 || ...)
 */
export function createRedeemBoundParams(
  btcScripts: Uint8Array | Uint8Array[],
  stealthDataHash: Uint8Array,
  chainId: bigint = 103n,
  treeNumber: number = 0,
): BoundParams {
  // Normalize to array
  const scripts = btcScripts instanceof Uint8Array ? [btcScripts] : btcScripts;
  // Concatenate all scripts
  const totalLen = scripts.reduce((sum, s) => sum + s.length, 0);
  const concat = new Uint8Array(totalLen);
  let off = 0;
  for (const s of scripts) {
    concat.set(s, off);
    off += s.length;
  }
  const scriptHash = sha256(concat);
  return {
    treeNumber,
    unshieldAddress: scriptHash,
    chainId,
    mode: 'redeem',
    stealthDataHash,
  };
}

/**
 * Create bound params for an unshield (public withdrawal, multi-output)
 *
 * For multi-output: destinations_hash = SHA256(owner_1 || owner_2 || ...)
 * For single output: SHA256(owner_1) — no special case.
 */
export function createUnshieldBoundParams(
  recipientAddresses: Uint8Array | Uint8Array[],
  stealthDataHash: Uint8Array,
  chainId: bigint = 103n,
  treeNumber: number = 0,
): BoundParams {
  // Normalize to array
  const addrs = recipientAddresses instanceof Uint8Array ? [recipientAddresses] : recipientAddresses;
  // Concatenate all addresses
  const totalLen = addrs.reduce((sum, a) => sum + a.length, 0);
  const concat = new Uint8Array(totalLen);
  let off = 0;
  for (const a of addrs) {
    concat.set(a, off);
    off += a.length;
  }
  const addressHash = sha256(concat);
  return {
    treeNumber,
    unshieldAddress: addressHash,
    chainId,
    stealthDataHash,
  };
}
