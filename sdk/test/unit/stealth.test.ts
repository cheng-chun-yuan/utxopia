import { describe, it, expect } from "bun:test";
import { encryptAmount, decryptAmount } from "../../src/stealth";
import { encryptNoteData, decryptNoteData } from "../../src/crypto-ed25519";

const testSecret = new Uint8Array(32).fill(0x42);

describe("encryptAmount / decryptAmount", () => {
  it("roundtrips a small amount", () => {
    const amount = 100_000n;
    const encrypted = encryptAmount(amount, testSecret);
    expect(encrypted).toBeInstanceOf(Uint8Array);
    expect(encrypted.length).toBe(8);
    const decrypted = decryptAmount(encrypted, testSecret);
    expect(decrypted).toBe(amount);
  });

  it("roundtrips zero", () => {
    const encrypted = encryptAmount(0n, testSecret);
    expect(decryptAmount(encrypted, testSecret)).toBe(0n);
  });

  it("roundtrips a large amount (max u64-ish)", () => {
    const amount = (1n << 53n) - 1n; // safe large value
    const encrypted = encryptAmount(amount, testSecret);
    expect(decryptAmount(encrypted, testSecret)).toBe(amount);
  });

  it("encrypted bytes differ from plaintext LE bytes", () => {
    const amount = 12345n;
    const encrypted = encryptAmount(amount, testSecret);
    // plaintext LE of 12345 = [0x39, 0x30, 0, 0, 0, 0, 0, 0]
    const isAllSame = encrypted[0] === 0x39 && encrypted[1] === 0x30;
    expect(isAllSame).toBe(false);
  });

  it("different secrets produce different ciphertext", () => {
    const amount = 50_000n;
    const secret2 = new Uint8Array(32).fill(0x99);
    const enc1 = encryptAmount(amount, testSecret);
    const enc2 = encryptAmount(amount, secret2);
    expect(enc1).not.toEqual(enc2);
  });

  it("wrong secret produces wrong decryption", () => {
    const amount = 777n;
    const encrypted = encryptAmount(amount, testSecret);
    const wrongSecret = new Uint8Array(32).fill(0x00);
    const wrongDecryption = decryptAmount(encrypted, wrongSecret);
    expect(wrongDecryption).not.toBe(amount);
  });
});

describe("encryptNoteData / decryptNoteData", () => {
  it("roundtrips token_id and amount", () => {
    const tokenId = 0x7a627463n; // "zkbtc"
    const amount = 50_000n;
    const encrypted = encryptNoteData(tokenId, amount, testSecret);
    expect(encrypted).toBeInstanceOf(Uint8Array);
    expect(encrypted.length).toBe(40);

    const decrypted = decryptNoteData(encrypted, testSecret);
    expect(decrypted.tokenId).toBe(tokenId);
    expect(decrypted.amount).toBe(amount);
  });

  it("roundtrips zero values", () => {
    const encrypted = encryptNoteData(0n, 0n, testSecret);
    const decrypted = decryptNoteData(encrypted, testSecret);
    expect(decrypted.tokenId).toBe(0n);
    expect(decrypted.amount).toBe(0n);
  });

  it("roundtrips large token_id", () => {
    const tokenId = (1n << 128n) - 1n;
    const amount = 999_999_999n;
    const encrypted = encryptNoteData(tokenId, amount, testSecret);
    const decrypted = decryptNoteData(encrypted, testSecret);
    expect(decrypted.tokenId).toBe(tokenId);
    expect(decrypted.amount).toBe(amount);
  });

  it("different secrets produce different ciphertext", () => {
    const secret2 = new Uint8Array(32).fill(0xbb);
    const enc1 = encryptNoteData(1n, 100n, testSecret);
    const enc2 = encryptNoteData(1n, 100n, secret2);
    expect(enc1).not.toEqual(enc2);
  });

  it("wrong secret produces wrong decryption", () => {
    const encrypted = encryptNoteData(42n, 1000n, testSecret);
    const wrongSecret = new Uint8Array(32).fill(0x00);
    const decrypted = decryptNoteData(encrypted, wrongSecret);
    // At least one field should differ
    const bothMatch = decrypted.tokenId === 42n && decrypted.amount === 1000n;
    expect(bothMatch).toBe(false);
  });

  it("throws on too-short encrypted data", () => {
    expect(() => decryptNoteData(new Uint8Array(10), testSecret)).toThrow();
  });
});
