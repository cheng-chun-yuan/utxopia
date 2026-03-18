/**
 * Baby Jubjub curve operations tests
 */

import { describe, test, expect } from "bun:test";
import {
  BABYJUB_FIELD_PRIME,
  BABYJUB_A,
  BABYJUB_D,
  BABYJUB_ORDER,
  BABYJUB_BASE8,
  BABYJUB_IDENTITY,
  isIdentity,
  isOnBabyJubCurve,
  babyJubAdd,
  babyJubDouble,
  babyJubMul,
  babyJubNegate,
  babyJubCompress,
  babyJubDecompress,
  generateBabyJubKeyPair,
  deriveBabyJubKeyFromSeed,
  babyJubScalarFromBytes,
  babyJubScalarToBytes,
  type BabyJubPoint,
} from "../../src/crypto-babyjub";

// =============================================================================
// Constants
// =============================================================================

describe("Baby Jubjub Constants", () => {
  test("field prime is correct BN254 scalar field", () => {
    expect(BABYJUB_FIELD_PRIME).toBe(
      21888242871839275222246405745257275088548364400416034343698204186575808495617n
    );
  });

  test("curve parameters a and d are correct", () => {
    expect(BABYJUB_A).toBe(168700n);
    expect(BABYJUB_D).toBe(168696n);
  });

  test("order * cofactor relationship", () => {
    // order * 8 should relate to the full group order
    expect(BABYJUB_ORDER * 8n).toBeLessThan(BABYJUB_FIELD_PRIME * 8n);
    expect(BABYJUB_ORDER).toBeGreaterThan(0n);
  });

  test("identity point is (0, 1)", () => {
    expect(BABYJUB_IDENTITY.x).toBe(0n);
    expect(BABYJUB_IDENTITY.y).toBe(1n);
  });

  test("BASE8 generator is on the curve", () => {
    expect(isOnBabyJubCurve(BABYJUB_BASE8)).toBe(true);
  });
});

// =============================================================================
// Point Validation
// =============================================================================

describe("isIdentity", () => {
  test("returns true for identity point", () => {
    expect(isIdentity(BABYJUB_IDENTITY)).toBe(true);
    expect(isIdentity({ x: 0n, y: 1n })).toBe(true);
  });

  test("returns false for non-identity points", () => {
    expect(isIdentity(BABYJUB_BASE8)).toBe(false);
    expect(isIdentity({ x: 1n, y: 0n })).toBe(false);
    expect(isIdentity({ x: 0n, y: 0n })).toBe(false);
  });
});

describe("isOnBabyJubCurve", () => {
  test("identity is on curve", () => {
    expect(isOnBabyJubCurve(BABYJUB_IDENTITY)).toBe(true);
  });

  test("BASE8 generator is on curve", () => {
    expect(isOnBabyJubCurve(BABYJUB_BASE8)).toBe(true);
  });

  test("random point is not on curve", () => {
    expect(isOnBabyJubCurve({ x: 123n, y: 456n })).toBe(false);
  });

  test("derived points are on curve", () => {
    const p2 = babyJubDouble(BABYJUB_BASE8);
    expect(isOnBabyJubCurve(p2)).toBe(true);

    const p3 = babyJubAdd(BABYJUB_BASE8, p2);
    expect(isOnBabyJubCurve(p3)).toBe(true);
  });
});

// =============================================================================
// Point Addition
// =============================================================================

describe("babyJubAdd", () => {
  test("adding identity returns the same point", () => {
    const result = babyJubAdd(BABYJUB_BASE8, BABYJUB_IDENTITY);
    expect(result.x).toBe(BABYJUB_BASE8.x);
    expect(result.y).toBe(BABYJUB_BASE8.y);
  });

  test("adding identity (reversed) returns the same point", () => {
    const result = babyJubAdd(BABYJUB_IDENTITY, BABYJUB_BASE8);
    expect(result.x).toBe(BABYJUB_BASE8.x);
    expect(result.y).toBe(BABYJUB_BASE8.y);
  });

  test("identity + identity = identity", () => {
    const result = babyJubAdd(BABYJUB_IDENTITY, BABYJUB_IDENTITY);
    expect(isIdentity(result)).toBe(true);
  });

  test("P + (-P) = identity", () => {
    const neg = babyJubNegate(BABYJUB_BASE8);
    const result = babyJubAdd(BABYJUB_BASE8, neg);
    expect(isIdentity(result)).toBe(true);
  });

  test("addition is commutative", () => {
    const p2 = babyJubDouble(BABYJUB_BASE8);
    const ab = babyJubAdd(BABYJUB_BASE8, p2);
    const ba = babyJubAdd(p2, BABYJUB_BASE8);
    expect(ab.x).toBe(ba.x);
    expect(ab.y).toBe(ba.y);
  });

  test("result is on curve", () => {
    const p2 = babyJubDouble(BABYJUB_BASE8);
    const result = babyJubAdd(BABYJUB_BASE8, p2);
    expect(isOnBabyJubCurve(result)).toBe(true);
  });
});

// =============================================================================
// Point Doubling
// =============================================================================

describe("babyJubDouble", () => {
  test("doubling identity returns identity", () => {
    const result = babyJubDouble(BABYJUB_IDENTITY);
    expect(isIdentity(result)).toBe(true);
  });

  test("double equals add to self", () => {
    const doubled = babyJubDouble(BABYJUB_BASE8);
    const added = babyJubAdd(BABYJUB_BASE8, BABYJUB_BASE8);
    expect(doubled.x).toBe(added.x);
    expect(doubled.y).toBe(added.y);
  });

  test("doubled point is on curve", () => {
    const result = babyJubDouble(BABYJUB_BASE8);
    expect(isOnBabyJubCurve(result)).toBe(true);
  });
});

// =============================================================================
// Scalar Multiplication
// =============================================================================

describe("babyJubMul", () => {
  test("multiply by 0 returns identity", () => {
    const result = babyJubMul(0n, BABYJUB_BASE8);
    expect(isIdentity(result)).toBe(true);
  });

  test("multiply by 1 returns the same point", () => {
    const result = babyJubMul(1n, BABYJUB_BASE8);
    expect(result.x).toBe(BABYJUB_BASE8.x);
    expect(result.y).toBe(BABYJUB_BASE8.y);
  });

  test("multiply by 2 equals doubling", () => {
    const mul2 = babyJubMul(2n, BABYJUB_BASE8);
    const doubled = babyJubDouble(BABYJUB_BASE8);
    expect(mul2.x).toBe(doubled.x);
    expect(mul2.y).toBe(doubled.y);
  });

  test("multiply by 3 equals G + 2G", () => {
    const mul3 = babyJubMul(3n, BABYJUB_BASE8);
    const g2 = babyJubDouble(BABYJUB_BASE8);
    const added = babyJubAdd(BABYJUB_BASE8, g2);
    expect(mul3.x).toBe(added.x);
    expect(mul3.y).toBe(added.y);
  });

  test("multiply identity by any scalar returns identity", () => {
    const result = babyJubMul(42n, BABYJUB_IDENTITY);
    expect(isIdentity(result)).toBe(true);
  });

  test("multiply by subgroup order returns identity", () => {
    const result = babyJubMul(BABYJUB_ORDER, BABYJUB_BASE8);
    expect(isIdentity(result)).toBe(true);
  });

  test("result is on curve for various scalars", () => {
    for (const scalar of [5n, 100n, 999n, 123456789n]) {
      const result = babyJubMul(scalar, BABYJUB_BASE8);
      expect(isOnBabyJubCurve(result)).toBe(true);
    }
  });

  test("scalar multiplication is consistent: (a+b)*G = a*G + b*G", () => {
    const a = 7n;
    const b = 13n;
    const aG = babyJubMul(a, BABYJUB_BASE8);
    const bG = babyJubMul(b, BABYJUB_BASE8);
    const sumG = babyJubAdd(aG, bG);
    const abG = babyJubMul(a + b, BABYJUB_BASE8);
    expect(abG.x).toBe(sumG.x);
    expect(abG.y).toBe(sumG.y);
  });
});

// =============================================================================
// Negate
// =============================================================================

describe("babyJubNegate", () => {
  test("negating identity returns identity", () => {
    const result = babyJubNegate(BABYJUB_IDENTITY);
    expect(isIdentity(result)).toBe(true);
  });

  test("negation flips x coordinate, keeps y", () => {
    const neg = babyJubNegate(BABYJUB_BASE8);
    expect(neg.y).toBe(BABYJUB_BASE8.y);
    expect(neg.x).not.toBe(BABYJUB_BASE8.x);
    // -x mod p + x mod p = p
    expect((neg.x + BABYJUB_BASE8.x) % BABYJUB_FIELD_PRIME).toBe(0n);
  });

  test("double negation returns original", () => {
    const neg1 = babyJubNegate(BABYJUB_BASE8);
    const neg2 = babyJubNegate(neg1);
    expect(neg2.x).toBe(BABYJUB_BASE8.x);
    expect(neg2.y).toBe(BABYJUB_BASE8.y);
  });

  test("negated point is on curve", () => {
    const neg = babyJubNegate(BABYJUB_BASE8);
    expect(isOnBabyJubCurve(neg)).toBe(true);
  });
});

// =============================================================================
// Compression / Decompression
// =============================================================================

describe("babyJubCompress / babyJubDecompress", () => {
  test("roundtrip for BASE8 generator", () => {
    const compressed = babyJubCompress(BABYJUB_BASE8);
    expect(compressed.length).toBe(32);
    const decompressed = babyJubDecompress(compressed);
    expect(decompressed.x).toBe(BABYJUB_BASE8.x);
    expect(decompressed.y).toBe(BABYJUB_BASE8.y);
  });

  test("roundtrip for identity point", () => {
    const compressed = babyJubCompress(BABYJUB_IDENTITY);
    const decompressed = babyJubDecompress(compressed);
    expect(isIdentity(decompressed)).toBe(true);
  });

  test("roundtrip for derived points", () => {
    for (const scalar of [2n, 3n, 42n, 1000n]) {
      const point = babyJubMul(scalar, BABYJUB_BASE8);
      const compressed = babyJubCompress(point);
      const decompressed = babyJubDecompress(compressed);
      expect(decompressed.x).toBe(point.x);
      expect(decompressed.y).toBe(point.y);
    }
  });

  test("roundtrip for negated point", () => {
    const neg = babyJubNegate(BABYJUB_BASE8);
    const compressed = babyJubCompress(neg);
    const decompressed = babyJubDecompress(compressed);
    expect(decompressed.x).toBe(neg.x);
    expect(decompressed.y).toBe(neg.y);
  });

  test("compressed size is always 32 bytes", () => {
    for (const scalar of [1n, 2n, 100n]) {
      const point = babyJubMul(scalar, BABYJUB_BASE8);
      expect(babyJubCompress(point).length).toBe(32);
    }
  });

  test("decompression rejects wrong length", () => {
    expect(() => babyJubDecompress(new Uint8Array(31))).toThrow("Expected 32 bytes");
    expect(() => babyJubDecompress(new Uint8Array(33))).toThrow("Expected 32 bytes");
  });

  test("sign bit is set correctly for odd x", () => {
    // Find a point with odd x
    let point: BabyJubPoint = BABYJUB_BASE8;
    let scalar = 1n;
    while ((point.x & 1n) !== 1n) {
      scalar++;
      point = babyJubMul(scalar, BABYJUB_BASE8);
    }
    const compressed = babyJubCompress(point);
    expect(compressed[31] & 0x80).toBe(0x80);
  });
});

// =============================================================================
// Key Generation
// =============================================================================

describe("generateBabyJubKeyPair", () => {
  test("generates valid keypair", () => {
    const { privKey, pubKey } = generateBabyJubKeyPair();
    expect(privKey).toBeGreaterThan(0n);
    expect(privKey).toBeLessThan(BABYJUB_ORDER);
    expect(isOnBabyJubCurve(pubKey)).toBe(true);
  });

  test("generates different keypairs each time", () => {
    const kp1 = generateBabyJubKeyPair();
    const kp2 = generateBabyJubKeyPair();
    // Extremely unlikely to be equal
    expect(kp1.privKey).not.toBe(kp2.privKey);
  });

  test("pubKey = privKey * BASE8", () => {
    const { privKey, pubKey } = generateBabyJubKeyPair();
    const derived = babyJubMul(privKey, BABYJUB_BASE8);
    expect(derived.x).toBe(pubKey.x);
    expect(derived.y).toBe(pubKey.y);
  });
});

describe("deriveBabyJubKeyFromSeed", () => {
  test("deterministic: same seed produces same keypair", () => {
    const seed = new TextEncoder().encode("test-seed-1234");
    const kp1 = deriveBabyJubKeyFromSeed(seed);
    const kp2 = deriveBabyJubKeyFromSeed(seed);
    expect(kp1.privKey).toBe(kp2.privKey);
    expect(kp1.pubKey.x).toBe(kp2.pubKey.x);
    expect(kp1.pubKey.y).toBe(kp2.pubKey.y);
  });

  test("different seeds produce different keypairs", () => {
    const kp1 = deriveBabyJubKeyFromSeed(new TextEncoder().encode("seed-a"));
    const kp2 = deriveBabyJubKeyFromSeed(new TextEncoder().encode("seed-b"));
    expect(kp1.privKey).not.toBe(kp2.privKey);
  });

  test("generated pubKey is on curve", () => {
    const seed = new TextEncoder().encode("curve-check");
    const { pubKey } = deriveBabyJubKeyFromSeed(seed);
    expect(isOnBabyJubCurve(pubKey)).toBe(true);
  });

  test("privKey is reduced modulo order", () => {
    const seed = new Uint8Array(32).fill(0xff); // large value
    const { privKey } = deriveBabyJubKeyFromSeed(seed);
    expect(privKey).toBeGreaterThan(0n);
    expect(privKey).toBeLessThan(BABYJUB_ORDER);
  });
});

// =============================================================================
// Scalar Utilities
// =============================================================================

describe("babyJubScalarFromBytes / babyJubScalarToBytes", () => {
  test("roundtrip for small value", () => {
    const bytes = new Uint8Array(32);
    bytes[31] = 42;
    const scalar = babyJubScalarFromBytes(bytes);
    expect(scalar).toBe(42n);
    const back = babyJubScalarToBytes(scalar);
    expect(back[31]).toBe(42);
  });

  test("scalar is reduced modulo order", () => {
    // All 0xFF bytes = very large number
    const bytes = new Uint8Array(32).fill(0xff);
    const scalar = babyJubScalarFromBytes(bytes);
    expect(scalar).toBeGreaterThanOrEqual(0n);
    expect(scalar).toBeLessThan(BABYJUB_ORDER);
  });

  test("roundtrip preserves value when within order", () => {
    const original = 123456789012345678901234n;
    const bytes = babyJubScalarToBytes(original);
    const recovered = babyJubScalarFromBytes(bytes);
    expect(recovered).toBe(original % BABYJUB_ORDER);
  });

  test("zero bytes produce zero scalar", () => {
    const bytes = new Uint8Array(32);
    const scalar = babyJubScalarFromBytes(bytes);
    expect(scalar).toBe(0n);
  });

  test("output is always 32 bytes", () => {
    expect(babyJubScalarToBytes(0n).length).toBe(32);
    expect(babyJubScalarToBytes(1n).length).toBe(32);
    expect(babyJubScalarToBytes(BABYJUB_ORDER - 1n).length).toBe(32);
  });
});
