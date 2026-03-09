/**
 * Cross-platform encoding utilities.
 *
 * Works in Browser, Node.js, and React Native without polyfills.
 * Hex helpers re-export the canonical implementations from crypto.ts.
 */

import { bytesToHex, hexToBytes } from "../crypto";

// Re-export hex utilities under the names specified by the encoding API
export { bytesToHex as toHex, hexToBytes as fromHex };

/**
 * Decode a base64 string to Uint8Array.
 * Uses atob() which is available in browsers, Node 16+, and React Native.
 */
export function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Decode a base64 string to a binary string (each char = one byte).
 * Useful for RPC account-data decoding where the consumer expects
 * `charCodeAt(i)` to yield raw byte values.
 */
export function base64ToBinaryString(b64: string): string {
  return atob(b64);
}
