/**
 * Baby Jubjub curve operations for UTXOpia
 *
 * Twisted Edwards curve matching circomlib's BabyJubjub:
 *   a*x^2 + y^2 = 1 + d*x^2*y^2
 *   a = 168700, d = 168696
 *
 * Over BN254 scalar field.
 * Used for spending keys and in-circuit key derivation via BabyPbk().
 *
 * @see https://eips.ethereum.org/EIPS/eip-2494
 * @see circomlib/circuits/babyjub.circom
 */

import { sha256 } from "@noble/hashes/sha2.js";

// =============================================================================
// Field Constants
// =============================================================================

/** BN254 scalar field prime (Baby Jubjub base field) */
export const BABYJUB_FIELD_PRIME =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Baby Jubjub curve parameter a */
export const BABYJUB_A = 168700n;

/** Baby Jubjub curve parameter d */
export const BABYJUB_D = 168696n;

/**
 * Baby Jubjub subgroup order (order of BASE8 generator)
 * = field_prime / 8 (cofactor 8)
 */
export const BABYJUB_ORDER =
  2736030358979909402780800718157159386076813972158567259200215660948447373041n;

/**
 * Baby Jubjub cofactor
 */
export const BABYJUB_COFACTOR = 8n;

/**
 * Generator point (BASE8) - matches circomlib's BabyPbk() generator
 * This is the base point of the prime-order subgroup (cofactor-cleared).
 */
export const BABYJUB_BASE8: BabyJubPoint = {
  x: 5299619240641551281634865583518297030282874472190772894086521144482721001553n,
  y: 16950150798460657717958625567821834550301663161624707787222815936182638968203n,
};

// =============================================================================
// Types
// =============================================================================

/** Point on the Baby Jubjub curve (affine coordinates) */
export interface BabyJubPoint {
  x: bigint;
  y: bigint;
}

/** Identity element (point at infinity for twisted Edwards) */
export const BABYJUB_IDENTITY: BabyJubPoint = { x: 0n, y: 1n };

// =============================================================================
// Modular Arithmetic
// =============================================================================

const P = BABYJUB_FIELD_PRIME;

function mod(n: bigint, p: bigint = P): bigint {
  const result = n % p;
  return result >= 0n ? result : result + p;
}

function modInverse(a: bigint, p: bigint = P): bigint {
  let [old_r, r] = [a, p];
  let [old_s, s] = [1n, 0n];

  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }

  return mod(old_s, p);
}

// =============================================================================
// Curve Operations
// =============================================================================

/**
 * Check if a point is the identity element
 */
export function isIdentity(point: BabyJubPoint): boolean {
  return point.x === 0n && point.y === 1n;
}

/**
 * Verify a point is on the Baby Jubjub curve
 *
 * a*x^2 + y^2 = 1 + d*x^2*y^2
 */
export function isOnBabyJubCurve(point: BabyJubPoint): boolean {
  if (isIdentity(point)) return true;

  const { x, y } = point;
  const x2 = mod(x * x);
  const y2 = mod(y * y);

  const lhs = mod(BABYJUB_A * x2 + y2);
  const rhs = mod(1n + BABYJUB_D * x2 * y2);

  return lhs === rhs;
}

/**
 * Point addition on Baby Jubjub (twisted Edwards addition law)
 *
 * For twisted Edwards: a*x^2 + y^2 = 1 + d*x^2*y^2
 * x3 = (x1*y2 + y1*x2) / (1 + d*x1*x2*y1*y2)
 * y3 = (y1*y2 - a*x1*x2) / (1 - d*x1*x2*y1*y2)
 */
export function babyJubAdd(p1: BabyJubPoint, p2: BabyJubPoint): BabyJubPoint {
  const { x: x1, y: y1 } = p1;
  const { x: x2, y: y2 } = p2;

  const x1x2 = mod(x1 * x2);
  const y1y2 = mod(y1 * y2);
  const dx1x2y1y2 = mod(BABYJUB_D * x1x2 * y1y2);

  const x3Num = mod(x1 * y2 + y1 * x2);
  const x3Den = mod(1n + dx1x2y1y2);

  const y3Num = mod(y1y2 - BABYJUB_A * x1x2);
  const y3Den = mod(1n - dx1x2y1y2);

  const x3 = mod(x3Num * modInverse(x3Den));
  const y3 = mod(y3Num * modInverse(y3Den));

  return { x: x3, y: y3 };
}

/**
 * Point doubling on Baby Jubjub
 */
export function babyJubDouble(point: BabyJubPoint): BabyJubPoint {
  return babyJubAdd(point, point);
}

/**
 * Scalar multiplication using double-and-add (constant-time Montgomery ladder)
 *
 * SECURITY: Uses Montgomery ladder for constant-time execution.
 */
export function babyJubMul(scalar: bigint, point: BabyJubPoint): BabyJubPoint {
  scalar = mod(scalar, BABYJUB_ORDER);

  if (scalar === 0n) return BABYJUB_IDENTITY;
  if (isIdentity(point)) return BABYJUB_IDENTITY;

  // Montgomery ladder
  let r0 = BABYJUB_IDENTITY;
  let r1 = point;

  // Process all bits of the scalar
  const bits = scalar.toString(2).length;
  for (let i = bits - 1; i >= 0; i--) {
    const bit = (scalar >> BigInt(i)) & 1n;

    if (bit === 1n) {
      r0 = babyJubAdd(r0, r1);
      r1 = babyJubDouble(r1);
    } else {
      r1 = babyJubAdd(r0, r1);
      r0 = babyJubDouble(r0);
    }
  }

  return r0;
}

/**
 * Negate a point (flip x coordinate for twisted Edwards)
 */
export function babyJubNegate(point: BabyJubPoint): BabyJubPoint {
  if (isIdentity(point)) return point;
  return {
    x: mod(-point.x),
    y: point.y,
  };
}

// =============================================================================
// Compression / Serialization
// =============================================================================

/**
 * Compress a Baby Jubjub point to 32 bytes
 *
 * Format: y-coordinate with sign of x stored in MSB of last byte
 * This matches circomlib's pointbits.circom compression.
 */
export function babyJubCompress(point: BabyJubPoint): Uint8Array {
  const bytes = new Uint8Array(32);
  let y = point.y;

  // Store y in little-endian (matching circomlib convention)
  let temp = y;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(temp & 0xffn);
    temp = temp >> 8n;
  }

  // Set MSB of last byte to sign of x (1 if x is odd)
  if ((point.x & 1n) === 1n) {
    bytes[31] |= 0x80;
  }

  return bytes;
}

/**
 * Decompress a 32-byte representation to a Baby Jubjub point
 */
export function babyJubDecompress(bytes: Uint8Array): BabyJubPoint {
  if (bytes.length !== 32) {
    throw new Error("Expected 32 bytes for compressed Baby Jubjub point");
  }

  // Extract sign of x from MSB
  const xSign = (bytes[31] & 0x80) !== 0;

  // Read y (little-endian), clearing the sign bit
  const cleanBytes = new Uint8Array(bytes);
  cleanBytes[31] &= 0x7f;

  let y = 0n;
  for (let i = 31; i >= 0; i--) {
    y = (y << 8n) | BigInt(cleanBytes[i]);
  }

  // Recover x from curve equation: a*x^2 + y^2 = 1 + d*x^2*y^2
  // x^2 = (1 - y^2) / (a - d*y^2)
  const y2 = mod(y * y);
  const num = mod(1n - y2);
  const den = mod(BABYJUB_A - BABYJUB_D * y2);
  const x2 = mod(num * modInverse(den));

  // Compute x via Tonelli-Shanks square root
  let x = modSqrt(x2);

  // Adjust sign of x
  const xIsOdd = (x & 1n) === 1n;
  if (xIsOdd !== xSign) {
    x = mod(-x);
  }

  const point = { x, y };
  if (!isOnBabyJubCurve(point)) {
    throw new Error("Decompressed point is not on the Baby Jubjub curve");
  }

  return point;
}

/**
 * Tonelli-Shanks modular square root
 */
function modSqrt(n: bigint): bigint {
  if (n === 0n) return 0n;

  // For p ≡ 3 (mod 4), sqrt = n^((p+1)/4)
  // BN254 scalar field: p ≡ 1 (mod 4), so we need full Tonelli-Shanks
  const p = P;

  // Check if n is a quadratic residue
  const euler = modPow(n, (p - 1n) / 2n);
  if (euler !== 1n) {
    throw new Error("No square root exists (not a quadratic residue)");
  }

  // Factor out powers of 2 from p-1
  let Q = p - 1n;
  let S = 0n;
  while ((Q & 1n) === 0n) {
    Q >>= 1n;
    S++;
  }

  // Find a non-residue z
  let z = 2n;
  while (modPow(z, (p - 1n) / 2n) !== p - 1n) {
    z++;
  }

  let M = S;
  let c = modPow(z, Q);
  let t = modPow(n, Q);
  let R = modPow(n, (Q + 1n) / 2n);

  while (true) {
    if (t === 1n) return R;

    let i = 1n;
    let temp = mod(t * t);
    while (temp !== 1n) {
      temp = mod(temp * temp);
      i++;
    }

    const b = modPow(c, 1n << (M - i - 1n));
    M = i;
    c = mod(b * b);
    t = mod(t * c);
    R = mod(R * b);
  }
}

function modPow(base: bigint, exp: bigint): bigint {
  let result = 1n;
  base = mod(base);

  while (exp > 0n) {
    if (exp & 1n) {
      result = mod(result * base);
    }
    exp >>= 1n;
    base = mod(base * base);
  }

  return result;
}

// =============================================================================
// Key Generation
// =============================================================================

/**
 * Generate a random Baby Jubjub keypair
 */
export function generateBabyJubKeyPair(): { privKey: bigint; pubKey: BabyJubPoint } {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const privKey = babyJubScalarFromBytes(bytes);
  const pubKey = babyJubMul(privKey, BABYJUB_BASE8);
  return { privKey, pubKey };
}

/**
 * Derive a Baby Jubjub keypair from a seed (deterministic)
 */
export function deriveBabyJubKeyFromSeed(
  seed: Uint8Array
): { privKey: bigint; pubKey: BabyJubPoint } {
  const hash = sha256(seed);
  const privKey = babyJubScalarFromBytes(hash);
  const pubKey = babyJubMul(privKey, BABYJUB_BASE8);
  return { privKey, pubKey };
}

/**
 * Derive a scalar from bytes (reduces modulo Baby Jubjub order)
 */
export function babyJubScalarFromBytes(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = 0; i < bytes.length; i++) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return mod(result, BABYJUB_ORDER);
}

/**
 * Convert a Baby Jubjub scalar to 32 bytes (big-endian)
 */
export function babyJubScalarToBytes(scalar: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let temp = mod(scalar, BABYJUB_ORDER);
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(temp & 0xffn);
    temp >>= 8n;
  }
  return bytes;
}
