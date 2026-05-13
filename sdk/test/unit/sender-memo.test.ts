import { describe, it, expect } from "bun:test";
import {
  encryptSenderMemo,
  decryptSenderMemo,
  deriveOutgoingViewingKey,
  packSenderMemo,
  unpackSenderMemo,
  generateSenderMemoNonce,
  SENDER_MEMO_AMOUNT_BYTES,
  SENDER_MEMO_CIPHERTEXT_BYTES,
  SENDER_MEMO_COMMITMENT_BYTES,
  SENDER_MEMO_NONCE_BYTES,
  SENDER_MEMO_PACKED_BYTES,
  SENDER_MEMO_TOKEN_BYTES,
} from "../../src/sender-memo";

const ZKBTC_TOKEN_ID = BigInt(0x7a627463);

function fakeViewingKey(byte = 0x42): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

function fakeCommitment(byte = 0xcc): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

describe("ovk derivation", () => {
  it("returns 32 bytes deterministically", () => {
    const vk = fakeViewingKey();
    const ovk1 = deriveOutgoingViewingKey(vk);
    const ovk2 = deriveOutgoingViewingKey(vk);
    expect(ovk1.length).toBe(32);
    expect(ovk1).toEqual(ovk2);
  });

  it("differs across distinct viewing keys", () => {
    const a = deriveOutgoingViewingKey(fakeViewingKey(0x11));
    const b = deriveOutgoingViewingKey(fakeViewingKey(0x22));
    expect(a).not.toEqual(b);
  });

  it("rejects non-32-byte input", () => {
    expect(() => deriveOutgoingViewingKey(new Uint8Array(31))).toThrow();
  });
});

describe("sender memo — encrypt/decrypt roundtrip (AEAD)", () => {
  it("roundtrips amount + tokenId with a fresh nonce", () => {
    const vk = fakeViewingKey();
    const memo = encryptSenderMemo(
      vk,
      { tokenId: ZKBTC_TOKEN_ID, amount: 12_345n },
      { commitment: fakeCommitment(), leafIndex: 42 },
    );

    expect(memo.nonce.length).toBe(SENDER_MEMO_NONCE_BYTES);
    expect(memo.ciphertextWithTag.length).toBe(SENDER_MEMO_CIPHERTEXT_BYTES);
    expect(memo.commitment.length).toBe(SENDER_MEMO_COMMITMENT_BYTES);
    expect(memo.leafIndex).toBe(42);

    const plain = decryptSenderMemo(vk, memo);
    expect(plain).not.toBeNull();
    expect(plain!.amount).toBe(12_345n);
    expect(plain!.tokenId).toBe(ZKBTC_TOKEN_ID);
  });

  it("uses a different ciphertext for each nonce", () => {
    const vk = fakeViewingKey();
    const ctx = { commitment: fakeCommitment(), leafIndex: 0 };
    const a = encryptSenderMemo(vk, { tokenId: 1n, amount: 1n }, ctx);
    const b = encryptSenderMemo(vk, { tokenId: 1n, amount: 1n }, ctx);
    expect(a.nonce).not.toEqual(b.nonce);
    expect(a.ciphertextWithTag).not.toEqual(b.ciphertextWithTag);
  });

  it("respects a caller-supplied nonce for determinism", () => {
    const vk = fakeViewingKey();
    const ctx = { commitment: fakeCommitment(), leafIndex: 7 };
    const nonce = new Uint8Array(SENDER_MEMO_NONCE_BYTES).fill(0xab);
    const a = encryptSenderMemo(vk, { tokenId: 1n, amount: 1n }, ctx, nonce);
    const b = encryptSenderMemo(vk, { tokenId: 1n, amount: 1n }, ctx, nonce);
    expect(a.ciphertextWithTag).toEqual(b.ciphertextWithTag);
  });

  it("rejects wrong-sized nonce / commitment at encrypt", () => {
    const vk = fakeViewingKey();
    const ctx = { commitment: fakeCommitment(), leafIndex: 0 };
    expect(() =>
      encryptSenderMemo(vk, { tokenId: 1n, amount: 1n }, ctx, new Uint8Array(8)),
    ).toThrow();
    expect(() =>
      encryptSenderMemo(
        vk,
        { tokenId: 1n, amount: 1n },
        { commitment: new Uint8Array(16), leafIndex: 0 },
      ),
    ).toThrow();
  });

  it("handles maximum-sized amount", () => {
    const vk = fakeViewingKey();
    const max = (1n << 64n) - 1n;
    const memo = encryptSenderMemo(
      vk,
      { tokenId: 1n, amount: max },
      { commitment: fakeCommitment(), leafIndex: 0 },
    );
    const plain = decryptSenderMemo(vk, memo);
    expect(plain!.amount).toBe(max);
  });
});

describe("sender memo — tamper detection (Poly1305)", () => {
  function freshMemo(byte = 0x42, commitmentByte = 0xcc, leafIndex = 42) {
    return encryptSenderMemo(
      fakeViewingKey(byte),
      { tokenId: ZKBTC_TOKEN_ID, amount: 555n },
      { commitment: fakeCommitment(commitmentByte), leafIndex },
    );
  }

  it("decrypts to null with a wrong viewing key", () => {
    const memo = freshMemo(0x11);
    const wrongKey = fakeViewingKey(0x22);
    expect(decryptSenderMemo(wrongKey, memo)).toBeNull();
  });

  it("rejects a single bit flipped in the ciphertext", () => {
    const memo = freshMemo();
    memo.ciphertextWithTag[10] ^= 0x01;
    expect(decryptSenderMemo(fakeViewingKey(), memo)).toBeNull();
  });

  it("rejects a single bit flipped in the auth tag (last 16 bytes)", () => {
    const memo = freshMemo();
    memo.ciphertextWithTag[memo.ciphertextWithTag.length - 1] ^= 0x01;
    expect(decryptSenderMemo(fakeViewingKey(), memo)).toBeNull();
  });

  it("rejects a swapped commitment (AAD binding)", () => {
    const memo = freshMemo(0x42, 0xcc, 10);
    memo.commitment = fakeCommitment(0xdd);
    expect(decryptSenderMemo(fakeViewingKey(), memo)).toBeNull();
  });

  it("rejects a swapped leafIndex (AAD binding)", () => {
    const memo = freshMemo(0x42, 0xcc, 10);
    memo.leafIndex = 999;
    expect(decryptSenderMemo(fakeViewingKey(), memo)).toBeNull();
  });

  it("rejects a wrong-sized nonce / ciphertext / commitment at decrypt", () => {
    const memo = freshMemo();
    const bad1 = { ...memo, nonce: new Uint8Array(8) };
    const bad2 = { ...memo, ciphertextWithTag: new Uint8Array(40) };
    const bad3 = { ...memo, commitment: new Uint8Array(16) };
    expect(decryptSenderMemo(fakeViewingKey(), bad1)).toBeNull();
    expect(decryptSenderMemo(fakeViewingKey(), bad2)).toBeNull();
    expect(decryptSenderMemo(fakeViewingKey(), bad3)).toBeNull();
  });
});

describe("sender memo — packed format", () => {
  it("pack/unpack roundtrips and decrypts", () => {
    const vk = fakeViewingKey();
    const memo = encryptSenderMemo(
      vk,
      { tokenId: 99n, amount: 42n },
      { commitment: fakeCommitment(0xab), leafIndex: 11 },
    );
    const packed = packSenderMemo(memo);
    expect(packed.length).toBe(SENDER_MEMO_PACKED_BYTES);
    expect(packed.length).toBe(
      SENDER_MEMO_NONCE_BYTES +
        SENDER_MEMO_CIPHERTEXT_BYTES +
        SENDER_MEMO_COMMITMENT_BYTES +
        4,
    );

    const restored = unpackSenderMemo(packed);
    expect(restored.nonce).toEqual(memo.nonce);
    expect(restored.ciphertextWithTag).toEqual(memo.ciphertextWithTag);
    expect(restored.commitment).toEqual(memo.commitment);
    expect(restored.leafIndex).toBe(memo.leafIndex);

    const plain = decryptSenderMemo(vk, restored);
    expect(plain!.amount).toBe(42n);
    expect(plain!.tokenId).toBe(99n);
  });

  it("unpack rejects wrong-length input", () => {
    expect(() => unpackSenderMemo(new Uint8Array(50))).toThrow();
  });
});

describe("generateSenderMemoNonce", () => {
  it("returns a 24-byte nonce", () => {
    expect(generateSenderMemoNonce().length).toBe(SENDER_MEMO_NONCE_BYTES);
  });

  it("almost certainly produces different values across calls", () => {
    const a = generateSenderMemoNonce();
    const b = generateSenderMemoNonce();
    expect(a).not.toEqual(b);
  });
});

describe("constants", () => {
  it("AMOUNT(8) + TOKEN(32) + TAG(16) === CIPHERTEXT(56)", () => {
    expect(SENDER_MEMO_AMOUNT_BYTES + SENDER_MEMO_TOKEN_BYTES + 16).toBe(
      SENDER_MEMO_CIPHERTEXT_BYTES,
    );
  });
});
