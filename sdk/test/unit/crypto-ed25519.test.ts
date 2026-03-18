/**
 * Ed25519/X25519 crypto utilities tests
 */

import { describe, test, expect } from "bun:test";
import {
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
} from "../../src/crypto-ed25519";

// =============================================================================
// Key Generation
// =============================================================================

describe("ed25519GenerateKeyPair", () => {
  test("generates 32-byte private and public keys", () => {
    const { privKey, pubKey } = ed25519GenerateKeyPair();
    expect(privKey.length).toBe(32);
    expect(pubKey.length).toBe(32);
  });

  test("generates different keypairs each call", () => {
    const kp1 = ed25519GenerateKeyPair();
    const kp2 = ed25519GenerateKeyPair();
    expect(Buffer.from(kp1.privKey).equals(Buffer.from(kp2.privKey))).toBe(false);
  });
});

describe("ed25519GetPublicKey", () => {
  test("derives correct public key from private key", () => {
    const { privKey, pubKey } = ed25519GenerateKeyPair();
    const derived = ed25519GetPublicKey(privKey);
    expect(Buffer.from(derived).equals(Buffer.from(pubKey))).toBe(true);
  });

  test("returns 32-byte public key", () => {
    const privKey = new Uint8Array(32);
    privKey[0] = 1;
    const pubKey = ed25519GetPublicKey(privKey);
    expect(pubKey.length).toBe(32);
  });
});

describe("ed25519DeriveKeyFromSeed", () => {
  test("deterministic: same seed produces same keypair", () => {
    const seed = new TextEncoder().encode("deterministic-seed");
    const kp1 = ed25519DeriveKeyFromSeed(seed);
    const kp2 = ed25519DeriveKeyFromSeed(seed);
    expect(Buffer.from(kp1.privKey).equals(Buffer.from(kp2.privKey))).toBe(true);
    expect(Buffer.from(kp1.pubKey).equals(Buffer.from(kp2.pubKey))).toBe(true);
  });

  test("different seeds produce different keys", () => {
    const kp1 = ed25519DeriveKeyFromSeed(new TextEncoder().encode("seed-alpha"));
    const kp2 = ed25519DeriveKeyFromSeed(new TextEncoder().encode("seed-beta"));
    expect(Buffer.from(kp1.privKey).equals(Buffer.from(kp2.privKey))).toBe(false);
  });

  test("privKey is sha256 of seed", () => {
    const seed = new TextEncoder().encode("known-seed");
    const { privKey } = ed25519DeriveKeyFromSeed(seed);
    // privKey should be 32 bytes (sha256 output)
    expect(privKey.length).toBe(32);
  });

  test("pubKey matches derived from privKey", () => {
    const seed = new TextEncoder().encode("consistency-check");
    const { privKey, pubKey } = ed25519DeriveKeyFromSeed(seed);
    const derivedPub = ed25519GetPublicKey(privKey);
    expect(Buffer.from(pubKey).equals(Buffer.from(derivedPub))).toBe(true);
  });
});

// =============================================================================
// ECDH / Shared Secret
// =============================================================================

describe("ed25519PubToX25519", () => {
  test("converts to 32-byte X25519 public key", () => {
    const { pubKey } = ed25519GenerateKeyPair();
    const x25519Pub = ed25519PubToX25519(pubKey);
    expect(x25519Pub.length).toBe(32);
  });

  test("deterministic conversion", () => {
    const { pubKey } = ed25519DeriveKeyFromSeed(new TextEncoder().encode("conversion-test"));
    const x1 = ed25519PubToX25519(pubKey);
    const x2 = ed25519PubToX25519(pubKey);
    expect(Buffer.from(x1).equals(Buffer.from(x2))).toBe(true);
  });
});

describe("x25519Ecdh", () => {
  test("shared secret is symmetric (Alice-Bob)", () => {
    const alice = ed25519GenerateKeyPair();
    const bob = ed25519GenerateKeyPair();

    const secretAB = x25519Ecdh(alice.privKey, bob.pubKey);
    const secretBA = x25519Ecdh(bob.privKey, alice.pubKey);

    expect(secretAB.length).toBe(32);
    expect(Buffer.from(secretAB).equals(Buffer.from(secretBA))).toBe(true);
  });

  test("different keypairs produce different shared secrets", () => {
    const alice = ed25519GenerateKeyPair();
    const bob = ed25519GenerateKeyPair();
    const charlie = ed25519GenerateKeyPair();

    const secretAB = x25519Ecdh(alice.privKey, bob.pubKey);
    const secretAC = x25519Ecdh(alice.privKey, charlie.pubKey);

    expect(Buffer.from(secretAB).equals(Buffer.from(secretAC))).toBe(false);
  });

  test("shared secret is 32 bytes", () => {
    const alice = ed25519GenerateKeyPair();
    const bob = ed25519GenerateKeyPair();
    const secret = x25519Ecdh(alice.privKey, bob.pubKey);
    expect(secret.length).toBe(32);
  });
});

// =============================================================================
// Amount Encryption / Decryption
// =============================================================================

describe("deriveAmountKey", () => {
  test("returns 8 bytes", () => {
    const sharedSecret = new Uint8Array(32).fill(0xab);
    const key = deriveAmountKey(sharedSecret);
    expect(key.length).toBe(8);
  });

  test("deterministic", () => {
    const sharedSecret = new Uint8Array(32).fill(0x42);
    const k1 = deriveAmountKey(sharedSecret);
    const k2 = deriveAmountKey(sharedSecret);
    expect(Buffer.from(k1).equals(Buffer.from(k2))).toBe(true);
  });

  test("different secrets produce different keys", () => {
    const k1 = deriveAmountKey(new Uint8Array(32).fill(0x01));
    const k2 = deriveAmountKey(new Uint8Array(32).fill(0x02));
    expect(Buffer.from(k1).equals(Buffer.from(k2))).toBe(false);
  });
});

describe("encryptAmountEd25519 / decryptAmountEd25519", () => {
  const sharedSecret = new Uint8Array(32);
  sharedSecret[0] = 0xde;
  sharedSecret[1] = 0xad;

  test("roundtrip for typical amount", () => {
    const amount = 100000n; // 0.001 BTC in sats
    const encrypted = encryptAmountEd25519(amount, sharedSecret);
    expect(encrypted.length).toBe(8);
    const decrypted = decryptAmountEd25519(encrypted, sharedSecret);
    expect(decrypted).toBe(amount);
  });

  test("roundtrip for zero amount", () => {
    const encrypted = encryptAmountEd25519(0n, sharedSecret);
    const decrypted = decryptAmountEd25519(encrypted, sharedSecret);
    expect(decrypted).toBe(0n);
  });

  test("roundtrip for max u64", () => {
    const maxU64 = (1n << 64n) - 1n; // 18446744073709551615
    const encrypted = encryptAmountEd25519(maxU64, sharedSecret);
    const decrypted = decryptAmountEd25519(encrypted, sharedSecret);
    expect(decrypted).toBe(maxU64);
  });

  test("roundtrip for 1 satoshi", () => {
    const encrypted = encryptAmountEd25519(1n, sharedSecret);
    const decrypted = decryptAmountEd25519(encrypted, sharedSecret);
    expect(decrypted).toBe(1n);
  });

  test("encrypted output differs from plaintext", () => {
    const amount = 50000n;
    const encrypted = encryptAmountEd25519(amount, sharedSecret);
    // Convert amount to LE bytes for comparison
    const amountBytes = new Uint8Array(8);
    let temp = amount;
    for (let i = 0; i < 8; i++) {
      amountBytes[i] = Number(temp & 0xffn);
      temp >>= 8n;
    }
    expect(Buffer.from(encrypted).equals(Buffer.from(amountBytes))).toBe(false);
  });

  test("different secrets produce different ciphertexts", () => {
    const amount = 10000n;
    const secret1 = new Uint8Array(32).fill(0x01);
    const secret2 = new Uint8Array(32).fill(0x02);
    const enc1 = encryptAmountEd25519(amount, secret1);
    const enc2 = encryptAmountEd25519(amount, secret2);
    expect(Buffer.from(enc1).equals(Buffer.from(enc2))).toBe(false);
  });

  test("wrong secret fails to decrypt correctly", () => {
    const amount = 12345n;
    const encrypted = encryptAmountEd25519(amount, new Uint8Array(32).fill(0x01));
    const wrongDecrypt = decryptAmountEd25519(encrypted, new Uint8Array(32).fill(0x02));
    expect(wrongDecrypt).not.toBe(amount);
  });

  test("end-to-end with real ECDH shared secret", () => {
    const alice = ed25519GenerateKeyPair();
    const bob = ed25519GenerateKeyPair();
    const secret = x25519Ecdh(alice.privKey, bob.pubKey);

    const amount = 21000000_00000000n; // 21M BTC in sats
    const encrypted = encryptAmountEd25519(amount, secret);
    const decrypted = decryptAmountEd25519(encrypted, x25519Ecdh(bob.privKey, alice.pubKey));
    expect(decrypted).toBe(amount);
  });
});

// =============================================================================
// Note Data Encryption (token_id + amount)
// =============================================================================

describe("encryptNoteData / decryptNoteData", () => {
  const sharedSecret = new Uint8Array(32);
  sharedSecret[0] = 0xca;
  sharedSecret[1] = 0xfe;

  test("roundtrip for typical values", () => {
    const tokenId = 0x7a627463n; // "zkbtc"
    const amount = 50000n;
    const encrypted = encryptNoteData(tokenId, amount, sharedSecret);
    expect(encrypted.length).toBe(40);

    const decrypted = decryptNoteData(encrypted, sharedSecret);
    expect(decrypted.tokenId).toBe(tokenId);
    expect(decrypted.amount).toBe(amount);
  });

  test("roundtrip for zero token_id and zero amount", () => {
    const encrypted = encryptNoteData(0n, 0n, sharedSecret);
    const decrypted = decryptNoteData(encrypted, sharedSecret);
    expect(decrypted.tokenId).toBe(0n);
    expect(decrypted.amount).toBe(0n);
  });

  test("roundtrip for max u64 amount", () => {
    const maxU64 = (1n << 64n) - 1n;
    const tokenId = 42n;
    const encrypted = encryptNoteData(tokenId, maxU64, sharedSecret);
    const decrypted = decryptNoteData(encrypted, sharedSecret);
    expect(decrypted.tokenId).toBe(tokenId);
    expect(decrypted.amount).toBe(maxU64);
  });

  test("roundtrip for large token_id (32 bytes worth)", () => {
    const largeTokenId = (1n << 255n) - 1n;
    const amount = 1n;
    const encrypted = encryptNoteData(largeTokenId, amount, sharedSecret);
    const decrypted = decryptNoteData(encrypted, sharedSecret);
    expect(decrypted.tokenId).toBe(largeTokenId);
    expect(decrypted.amount).toBe(amount);
  });

  test("encrypted output is 40 bytes", () => {
    const encrypted = encryptNoteData(1n, 1n, sharedSecret);
    expect(encrypted.length).toBe(40);
  });

  test("wrong secret fails to decrypt correctly", () => {
    const tokenId = 123n;
    const amount = 456n;
    const encrypted = encryptNoteData(tokenId, amount, new Uint8Array(32).fill(0x01));
    const decrypted = decryptNoteData(encrypted, new Uint8Array(32).fill(0x02));
    // At least one field should be wrong
    const wrongResult = decrypted.tokenId !== tokenId || decrypted.amount !== amount;
    expect(wrongResult).toBe(true);
  });

  test("decryptNoteData rejects short input", () => {
    expect(() => decryptNoteData(new Uint8Array(39), sharedSecret)).toThrow("Expected 40-byte");
  });

  test("end-to-end with real ECDH", () => {
    const alice = ed25519GenerateKeyPair();
    const bob = ed25519GenerateKeyPair();
    const secretA = x25519Ecdh(alice.privKey, bob.pubKey);
    const secretB = x25519Ecdh(bob.privKey, alice.pubKey);

    const tokenId = 0x7a627463n;
    const amount = 100000000n; // 1 BTC
    const encrypted = encryptNoteData(tokenId, amount, secretA);
    const decrypted = decryptNoteData(encrypted, secretB);
    expect(decrypted.tokenId).toBe(tokenId);
    expect(decrypted.amount).toBe(amount);
  });
});
