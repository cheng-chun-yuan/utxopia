/**
 * Bound Parameters Hash for JoinSplit transactions
 *
 * The boundParamsHash binds transaction metadata to the proof:
 * - treeNumber: Which commitment tree (for multi-tree support)
 * - unshieldAddress: Recipient for public unshield (null = private transfer)
 * - chainId: Prevents cross-chain replay
 *
 * Hash: SHA256(serialize(params)) mod BN254_SCALAR_FIELD
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { BN254_FIELD_PRIME, bytesToBigint } from "./crypto";

export interface BoundParams {
  /** Tree number (0 for default) */
  treeNumber: number;
  /** Unshield recipient address (null = private transfer, 32 bytes = public unshield) */
  unshieldAddress: Uint8Array | null;
  /** Chain ID (prevents cross-chain replay) */
  chainId: bigint;
}

/**
 * Compute the bound parameters hash
 *
 * Deterministic serialization:
 * - treeNumber: 4 bytes LE
 * - hasUnshield: 1 byte (0 or 1)
 * - unshieldAddress: 32 bytes (zeros if null)
 * - chainId: 8 bytes LE
 *
 * Total: 45 bytes → SHA256 → mod BN254
 */
export function computeBoundParamsHash(params: BoundParams): bigint {
  const buf = new Uint8Array(45);
  const view = new DataView(buf.buffer);

  // treeNumber (4 bytes LE)
  view.setUint32(0, params.treeNumber, true);

  // hasUnshield (1 byte)
  buf[4] = params.unshieldAddress ? 1 : 0;

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

  // SHA256 → mod BN254
  const hash = sha256(buf);
  return bytesToBigint(hash) % BN254_FIELD_PRIME;
}

/**
 * Default bound params for Solana devnet (private transfer)
 */
export const DEFAULT_BOUND_PARAMS: BoundParams = {
  treeNumber: 0,
  unshieldAddress: null,
  chainId: 103n, // Solana devnet chain ID
};

/**
 * Create bound params for an unshield (public withdrawal)
 */
export function createUnshieldBoundParams(
  recipientAddress: Uint8Array,
  chainId: bigint = 103n,
  treeNumber: number = 0,
): BoundParams {
  return {
    treeNumber,
    unshieldAddress: recipientAddress,
    chainId,
  };
}
