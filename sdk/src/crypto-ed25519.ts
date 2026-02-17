/**
 * Ed25519/X25519 utilities for zVault viewing keys
 *
 * Uses @noble/curves for Ed25519 key generation and X25519 ECDH.
 * Ed25519 is used for viewing keys (off-chain only, fast and standard).
 *
 * Viewing key operations:
 * - Key generation: Ed25519 keypair
 * - ECDH: X25519 (Montgomery form of Curve25519)
 * - Shared secret: 32 bytes from X25519
 *
 * @see https://github.com/paulmillr/noble-curves
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";

// =============================================================================
// Key Generation
// =============================================================================

/**
 * Generate an Ed25519 keypair for viewing key use
 *
 * @returns 32-byte private key and 32-byte public key
 */
export function ed25519GenerateKeyPair(): { privKey: Uint8Array; pubKey: Uint8Array } {
  const privKey = ed25519.utils.randomSecretKey();
  const pubKey = ed25519.getPublicKey(privKey);
  return { privKey, pubKey };
}

/**
 * Derive an Ed25519 public key from a private key
 *
 * @param privKey - 32-byte Ed25519 private key
 * @returns 32-byte Ed25519 public key
 */
export function ed25519GetPublicKey(privKey: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(privKey);
}

/**
 * Derive an Ed25519 keypair from a seed (deterministic)
 *
 * @param seed - Arbitrary bytes to derive from (will be SHA256'd to 32 bytes)
 * @returns Ed25519 keypair
 */
export function ed25519DeriveKeyFromSeed(seed: Uint8Array): { privKey: Uint8Array; pubKey: Uint8Array } {
  const privKey = sha256(seed);
  const pubKey = ed25519.getPublicKey(privKey);
  return { privKey, pubKey };
}

// =============================================================================
// ECDH (X25519)
// =============================================================================

/**
 * Convert Ed25519 public key to X25519 (Montgomery form) for ECDH
 *
 * Uses the birational map from twisted Edwards to Montgomery form.
 */
export function ed25519PubToX25519(edPub: Uint8Array): Uint8Array {
  return ed25519.utils.toMontgomery(edPub);
}

/**
 * Perform X25519 ECDH key exchange
 *
 * @param privKey - 32-byte Ed25519 private key (will be converted internally)
 * @param pubKey - 32-byte Ed25519 public key (will be converted to X25519)
 * @returns 32-byte shared secret
 */
export function x25519Ecdh(privKey: Uint8Array, pubKey: Uint8Array): Uint8Array {
  // Convert Ed25519 pub to X25519 u-coordinate
  const x25519Pub = ed25519.utils.toMontgomery(pubKey);

  // Convert Ed25519 private key to X25519 scalar
  const x25519Priv = ed25519.utils.toMontgomerySecret(privKey);

  return x25519.getSharedSecret(x25519Priv, x25519Pub);
}

// =============================================================================
// Amount Encryption/Decryption
// =============================================================================

/**
 * Derive an 8-byte encryption key from X25519 shared secret
 *
 * @param sharedSecret - 32-byte X25519 shared secret
 * @returns 8-byte encryption key
 */
export function deriveAmountKey(sharedSecret: Uint8Array): Uint8Array {
  const hash = sha256(sharedSecret);
  return hash.slice(0, 8);
}

/**
 * Encrypt amount with XOR using shared secret
 *
 * @param amount - Amount in satoshis
 * @param sharedSecret - 32-byte X25519 shared secret
 * @returns 8-byte encrypted amount
 */
export function encryptAmountEd25519(amount: bigint, sharedSecret: Uint8Array): Uint8Array {
  const key = deriveAmountKey(sharedSecret);
  const amountBytes = new Uint8Array(8);

  let temp = amount;
  for (let i = 0; i < 8; i++) {
    amountBytes[i] = Number(temp & 0xffn);
    temp >>= 8n;
  }

  const encrypted = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    encrypted[i] = amountBytes[i] ^ key[i];
  }

  return encrypted;
}

/**
 * Decrypt amount with XOR using shared secret
 *
 * @param encryptedAmount - 8-byte encrypted amount
 * @param sharedSecret - 32-byte X25519 shared secret
 * @returns Decrypted amount in satoshis
 */
export function decryptAmountEd25519(encryptedAmount: Uint8Array, sharedSecret: Uint8Array): bigint {
  const key = deriveAmountKey(sharedSecret);

  const decrypted = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    decrypted[i] = encryptedAmount[i] ^ key[i];
  }

  let amount = 0n;
  for (let i = 7; i >= 0; i--) {
    amount = (amount << 8n) | BigInt(decrypted[i]);
  }

  return amount;
}
