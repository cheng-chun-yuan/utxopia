/**
 * Shared utility functions for the header relayer.
 */

import { createHash } from 'crypto';

/**
 * Convert hex string to Uint8Array
 */
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Convert hex string to Uint8Array in reversed byte order (Bitcoin internal byte order)
 */
export function hexToBytesReversed(hex: string): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[31 - i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Convert Uint8Array to hex string
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Compute double SHA-256 of raw block header (80 bytes) -> block hash
 */
export function computeBlockHash(rawHeader: Uint8Array): Uint8Array {
  const first = createHash('sha256').update(rawHeader).digest();
  const second = createHash('sha256').update(first).digest();
  return new Uint8Array(second);
}
