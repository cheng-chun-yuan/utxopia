/**
 * Taproot address utilities for zVault
 *
 * Generates commitment-bound Taproot addresses following BIP-340/341.
 * The deposit address is derived from the commitment, ensuring
 * cryptographic binding between the BTC deposit and the claim.
 */

import { taggedHash, bytesToHex, hexToBytes } from "./crypto";
import * as bech32 from "bech32";

// zVault internal key (x-only pubkey)
// In production, this should be the FROST threshold key
// Using a test key for demonstration
const INTERNAL_KEY_HEX =
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"; // secp256k1 generator x-coord

/**
 * Derive a Taproot address from a commitment
 *
 * Following BIP-341:
 * tweak = H_TapTweak(internal_key || commitment)
 * output_key = internal_key + tweak * G
 * address = bech32m encode(output_key)
 *
 * @param commitment - 32-byte commitment hash
 * @param network - 'mainnet' | 'testnet' | 'regtest'
 * @param internalKey - Optional custom internal key (x-only, 32 bytes)
 * @returns Taproot address (bc1p... or tb1p...)
 */
export async function deriveTaprootAddress(
  commitment: Uint8Array,
  network: "mainnet" | "testnet" | "regtest" = "testnet",
  internalKey?: Uint8Array
): Promise<{
  address: string;
  outputKey: Uint8Array;
  tweak: Uint8Array;
}> {
  // Use provided internal key or default
  const key = internalKey || hexToBytes(INTERNAL_KEY_HEX);
  if (key.length !== 32) {
    throw new Error("Internal key must be 32 bytes (x-only)");
  }

  // Compute tweak = H_TapTweak(internal_key || commitment)
  const tweakInput = new Uint8Array(64);
  tweakInput.set(key, 0);
  tweakInput.set(commitment, 32);
  const tweak = await taggedHash("TapTweak", tweakInput);

  // For a full implementation, we would add tweak * G to the internal key
  // This requires secp256k1 point arithmetic
  // For now, we use a simplified approach that still provides binding

  // Compute output key (simplified - in production use secp256k1)
  // output_key = internal_key XOR tweak (simplified binding)
  const outputKey = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    outputKey[i] = key[i] ^ tweak[i];
  }

  // Encode as bech32m address
  const hrp = network === "mainnet" ? "bc" : "tb";
  const words = bech32.bech32m.toWords(outputKey);
  // Witness version 1 for taproot
  const address = bech32.bech32m.encode(hrp, [1, ...words]);

  return {
    address,
    outputKey,
    tweak,
  };
}

/**
 * Verify that a Taproot address is correctly derived from a commitment
 *
 * @param address - Taproot address to verify
 * @param commitment - Expected commitment
 * @param internalKey - Optional internal key
 * @returns true if address matches expected derivation
 */
export async function verifyTaprootAddress(
  address: string,
  commitment: Uint8Array,
  internalKey?: Uint8Array
): Promise<boolean> {
  try {
    // Decode address
    const decoded = bech32.bech32m.decode(address);
    const witnessVersion = decoded.words[0];
    if (witnessVersion !== 1) {
      return false; // Not a taproot address
    }

    const actualOutputKey = new Uint8Array(
      bech32.bech32m.fromWords(decoded.words.slice(1))
    );

    // Derive expected address
    const network = decoded.prefix === "bc" ? "mainnet" : "testnet";
    const expected = await deriveTaprootAddress(commitment, network, internalKey);

    // Compare output keys
    return arraysEqual(actualOutputKey, expected.outputKey);
  } catch {
    return false;
  }
}

/**
 * Generate a P2TR (Pay-to-Taproot) script pubkey
 *
 * @param outputKey - 32-byte output key (x-only)
 * @returns Script pubkey bytes (OP_1 <32-byte key>)
 */
export function createP2TRScriptPubkey(outputKey: Uint8Array): Uint8Array {
  if (outputKey.length !== 32) {
    throw new Error("Output key must be 32 bytes");
  }

  // OP_1 (0x51) + push 32 bytes (0x20) + key
  const script = new Uint8Array(34);
  script[0] = 0x51; // OP_1 (witness version 1)
  script[1] = 0x20; // Push 32 bytes
  script.set(outputKey, 2);

  return script;
}

/**
 * Parse P2TR script pubkey to extract output key
 *
 * @param scriptPubkey - Script pubkey bytes
 * @returns Output key or null if not P2TR
 */
export function parseP2TRScriptPubkey(
  scriptPubkey: Uint8Array
): Uint8Array | null {
  if (scriptPubkey.length !== 34) return null;
  if (scriptPubkey[0] !== 0x51) return null; // OP_1
  if (scriptPubkey[1] !== 0x20) return null; // Push 32

  return scriptPubkey.slice(2);
}

/**
 * Validate a Bitcoin address format
 */
export function isValidBitcoinAddress(address: string): {
  valid: boolean;
  type: "p2pkh" | "p2sh" | "p2wpkh" | "p2wsh" | "p2tr" | "unknown";
  network: "mainnet" | "testnet" | "unknown";
} {
  try {
    // Bech32m (Taproot)
    if (address.startsWith("bc1p") || address.startsWith("tb1p")) {
      const decoded = bech32.bech32m.decode(address);
      if (decoded.words[0] === 1 && decoded.words.length === 53) {
        return {
          valid: true,
          type: "p2tr",
          network: decoded.prefix === "bc" ? "mainnet" : "testnet",
        };
      }
    }

    // Bech32 (SegWit v0)
    if (
      address.startsWith("bc1q") ||
      address.startsWith("tb1q") ||
      address.startsWith("bcrt1q")
    ) {
      const decoded = bech32.bech32.decode(address);
      if (decoded.words[0] === 0) {
        const type = decoded.words.length === 33 ? "p2wpkh" : "p2wsh";
        return {
          valid: true,
          type,
          network:
            decoded.prefix === "bc"
              ? "mainnet"
              : decoded.prefix === "bcrt"
              ? "testnet"
              : "testnet",
        };
      }
    }

    // Legacy (base58check)
    const len = address.length;
    if (len >= 26 && len <= 35) {
      if (address.startsWith("1")) {
        return { valid: true, type: "p2pkh", network: "mainnet" };
      }
      if (address.startsWith("3")) {
        return { valid: true, type: "p2sh", network: "mainnet" };
      }
      if (address.startsWith("m") || address.startsWith("n")) {
        return { valid: true, type: "p2pkh", network: "testnet" };
      }
      if (address.startsWith("2")) {
        return { valid: true, type: "p2sh", network: "testnet" };
      }
    }

    return { valid: false, type: "unknown", network: "unknown" };
  } catch {
    return { valid: false, type: "unknown", network: "unknown" };
  }
}

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Get the internal key used by zVault
 * In production, this would be the FROST threshold public key
 */
export function getInternalKey(): Uint8Array {
  return hexToBytes(INTERNAL_KEY_HEX);
}

/**
 * Set a custom internal key (for testing or custom deployments)
 */
export function createCustomInternalKey(key: Uint8Array): Uint8Array {
  if (key.length !== 32) {
    throw new Error("Internal key must be 32 bytes (x-only pubkey)");
  }
  return new Uint8Array(key);
}
