import { describe, it, expect, beforeAll } from "bun:test";
import { initPoseidon } from "../../src/poseidon";
import {
  deriveKeysFromSeed,
  serializeStealthMetaAddress,
  deserializeStealthMetaAddress,
  createStealthMetaAddress,
  hasPermission,
  ViewPermissions,
  constantTimeCompare,
  clearKey,
  type DelegatedViewKey,
  type StealthMetaAddress,
} from "../../src/keys";

beforeAll(async () => {
  await initPoseidon();
});

describe("deriveKeysFromSeed", () => {
  const seed = new Uint8Array(32).fill(0xab);

  it("returns all expected key fields", () => {
    const keys = deriveKeysFromSeed(seed);
    expect(keys.spendingPrivKey).toBeTypeOf("bigint");
    expect(keys.spendingPubKey).toBeDefined();
    expect(keys.spendingPubKey.x).toBeTypeOf("bigint");
    expect(keys.spendingPubKey.y).toBeTypeOf("bigint");
    expect(keys.nullifyingKey).toBeTypeOf("bigint");
    expect(keys.viewingPrivKey).toBeInstanceOf(Uint8Array);
    expect(keys.viewingPrivKey.length).toBe(32);
    expect(keys.viewingPubKey).toBeInstanceOf(Uint8Array);
    expect(keys.viewingPubKey.length).toBe(32);
    expect(keys.eddsaSeed).toBeInstanceOf(Uint8Array);
    expect(keys.eddsaSeed.length).toBe(32);
    expect(keys.solanaPublicKey).toBeInstanceOf(Uint8Array);
    expect(keys.solanaPublicKey.length).toBe(32);
  });

  it("is deterministic (same seed = same keys)", () => {
    const keys1 = deriveKeysFromSeed(seed);
    const keys2 = deriveKeysFromSeed(seed);

    expect(keys1.spendingPrivKey).toBe(keys2.spendingPrivKey);
    expect(keys1.spendingPubKey.x).toBe(keys2.spendingPubKey.x);
    expect(keys1.spendingPubKey.y).toBe(keys2.spendingPubKey.y);
    expect(keys1.nullifyingKey).toBe(keys2.nullifyingKey);
    expect(keys1.viewingPrivKey).toEqual(keys2.viewingPrivKey);
    expect(keys1.viewingPubKey).toEqual(keys2.viewingPubKey);
    expect(keys1.eddsaSeed).toEqual(keys2.eddsaSeed);
  });

  it("different seeds produce different keys", () => {
    const otherSeed = new Uint8Array(32).fill(0xcd);
    const keys1 = deriveKeysFromSeed(seed);
    const keys2 = deriveKeysFromSeed(otherSeed);

    expect(keys1.spendingPrivKey).not.toBe(keys2.spendingPrivKey);
    expect(keys1.nullifyingKey).not.toBe(keys2.nullifyingKey);
    expect(keys1.viewingPubKey).not.toEqual(keys2.viewingPubKey);
  });

  it("spending private key is non-zero", () => {
    const keys = deriveKeysFromSeed(seed);
    expect(keys.spendingPrivKey).not.toBe(0n);
  });
});

describe("serializeStealthMetaAddress / deserializeStealthMetaAddress", () => {
  it("roundtrips correctly", () => {
    const meta: StealthMetaAddress = {
      spendingPubKey: new Uint8Array(32).fill(0x11),
      viewingPubKey: new Uint8Array(32).fill(0x22),
      mpk: new Uint8Array(32).fill(0x33),
    };

    const serialized = serializeStealthMetaAddress(meta);
    expect(serialized.spendingPubKey).toBeTypeOf("string");
    expect(serialized.viewingPubKey).toBeTypeOf("string");
    expect(serialized.mpk).toBeTypeOf("string");

    const deserialized = deserializeStealthMetaAddress(serialized);
    expect(deserialized.spendingPubKey).toEqual(meta.spendingPubKey);
    expect(deserialized.viewingPubKey).toEqual(meta.viewingPubKey);
    expect(deserialized.mpk).toEqual(meta.mpk);
  });

  it("serializes to hex strings of correct length", () => {
    const meta: StealthMetaAddress = {
      spendingPubKey: new Uint8Array(32).fill(0xff),
      viewingPubKey: new Uint8Array(32).fill(0x00),
      mpk: new Uint8Array(32).fill(0xaa),
    };
    const serialized = serializeStealthMetaAddress(meta);

    // 32 bytes = 64 hex chars
    expect(serialized.spendingPubKey.length).toBe(64);
    expect(serialized.viewingPubKey.length).toBe(64);
    expect(serialized.mpk.length).toBe(64);
  });

  it("roundtrips with keys derived from seed", () => {
    const seed = new Uint8Array(32).fill(0x42);
    const keys = deriveKeysFromSeed(seed);
    const meta = createStealthMetaAddress(keys);

    const serialized = serializeStealthMetaAddress(meta);
    const deserialized = deserializeStealthMetaAddress(serialized);

    expect(deserialized.spendingPubKey).toEqual(meta.spendingPubKey);
    expect(deserialized.viewingPubKey).toEqual(meta.viewingPubKey);
    expect(deserialized.mpk).toEqual(meta.mpk);
  });
});

describe("hasPermission", () => {
  it("detects SCAN permission", () => {
    const key: DelegatedViewKey = {
      viewingPrivKey: new Uint8Array(32),
      permissions: ViewPermissions.SCAN,
    };
    expect(hasPermission(key, ViewPermissions.SCAN)).toBe(true);
    expect(hasPermission(key, ViewPermissions.HISTORY)).toBe(false);
  });

  it("detects HISTORY permission", () => {
    const key: DelegatedViewKey = {
      viewingPrivKey: new Uint8Array(32),
      permissions: ViewPermissions.HISTORY,
    };
    expect(hasPermission(key, ViewPermissions.HISTORY)).toBe(true);
    expect(hasPermission(key, ViewPermissions.SCAN)).toBe(false);
  });

  it("FULL includes SCAN and HISTORY", () => {
    const key: DelegatedViewKey = {
      viewingPrivKey: new Uint8Array(32),
      permissions: ViewPermissions.FULL,
    };
    expect(hasPermission(key, ViewPermissions.SCAN)).toBe(true);
    expect(hasPermission(key, ViewPermissions.HISTORY)).toBe(true);
    expect(hasPermission(key, ViewPermissions.FULL)).toBe(true);
    expect(hasPermission(key, ViewPermissions.INCOMING_ONLY)).toBe(false);
  });

  it("combined permissions work", () => {
    const key: DelegatedViewKey = {
      viewingPrivKey: new Uint8Array(32),
      permissions: ViewPermissions.SCAN | ViewPermissions.INCOMING_ONLY,
    };
    expect(hasPermission(key, ViewPermissions.SCAN)).toBe(true);
    expect(hasPermission(key, ViewPermissions.INCOMING_ONLY)).toBe(true);
    expect(hasPermission(key, ViewPermissions.HISTORY)).toBe(false);
  });
});

describe("constantTimeCompare", () => {
  it("returns true for equal arrays", () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 4]);
    expect(constantTimeCompare(a, b)).toBe(true);
  });

  it("returns false for unequal arrays of same length", () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 5]);
    expect(constantTimeCompare(a, b)).toBe(false);
  });

  it("returns false for different length arrays", () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3, 4]);
    expect(constantTimeCompare(a, b)).toBe(false);
  });

  it("returns true for empty arrays", () => {
    expect(constantTimeCompare(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });

  it("returns false when only first byte differs", () => {
    const a = new Uint8Array([0, 2, 3]);
    const b = new Uint8Array([1, 2, 3]);
    expect(constantTimeCompare(a, b)).toBe(false);
  });
});

describe("clearKey", () => {
  it("zeroes out the key bytes", () => {
    const key = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    clearKey(key);
    expect(key).toEqual(new Uint8Array(8));
  });

  it("works on 32-byte keys", () => {
    const key = new Uint8Array(32).fill(0xff);
    clearKey(key);
    for (let i = 0; i < 32; i++) {
      expect(key[i]).toBe(0);
    }
  });
});
