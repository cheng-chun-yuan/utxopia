/**
 * Key Derivation for UTXOpia (Baby Jubjub + Ed25519)
 *
 * Dual-curve architecture (Railgun-style):
 * - Baby Jubjub spending key: SNARK-friendly, in-circuit verification via BabyPbk()
 * - Ed25519 viewing key: Standard fast curve, off-chain ECDH only
 *
 * Key Architecture:
 * ```
 * Solana Wallet (Ed25519)
 *         │
 *         │ signs message: "UTXOpia key derivation v1"
 *         ▼
 *    Signature (64 bytes)
 *         │
 *         ├──► SHA256(sig || "spend") mod BJJ_ORDER ──► Baby Jubjub Spending Key
 *         │
 *         └──► SHA256(sig || "view") ──► Ed25519 Viewing Key
 * ```
 *
 * Stealth Address Flow:
 * ```
 * Sender:
 *   1. ephemeral = random Ed25519 keypair
 *   2. sharedSecret = X25519(ephemeral.priv, viewingPubX25519)
 *   3. stealthScalar = SHA256(sharedSecret || domain) mod BJJ_ORDER
 *   4. stealthPub = spendingPub + stealthScalar × BASE8
 *   5. commitment = Poseidon(stealthPub.x, amount)
 *
 * Recipient (viewing key - can detect):
 *   1. sharedSecret = X25519(viewingPriv, ephemeralPub)
 *   2. Decrypt amount, derive stealthPub, verify commitment
 *
 * Recipient (spending key - can claim):
 *   1. stealthPriv = spendingPriv + stealthScalar
 *   2. Circuit proves: BabyPbk(stealthPriv).x == pub_key_x
 * ```
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { pbkdf2 } from "@noble/hashes/pbkdf2";
import {
  scalarFromBytes,
  bigintToBytes,
  bytesToHex,
  hexToBytes,
  babyJubMul,
  BABYJUB_BASE8,
  babyJubCompress,
  babyJubDecompress,
  type BabyJubPoint,
} from "./crypto";
import {
  ed25519GetPublicKey,
} from "./crypto-ed25519";
import { computeMPKSync, poseidonHashSync } from "./poseidon";
import { BABYJUB_ORDER } from "./crypto-babyjub";
// circomlibjs is lazily imported to avoid pulling ffjavascript WASM into React Native bundles.
// Only eddsaGetPubKey, eddsaGetPrivScalar, and eddsaPoseidonSign need it (web/Node.js only).
type Eddsa = any;

// ========== Types ==========

/**
 * Complete UTXOpia key hierarchy derived from Solana wallet
 *
 * Uses Baby Jubjub for spending keys and Ed25519 for viewing keys.
 */
export interface UTXOpiaKeys {
  /** Solana public key (32 bytes) - user identity */
  solanaPublicKey: Uint8Array;

  /** Baby Jubjub spending private key (scalar) - for stealthPriv and nullifier */
  spendingPrivKey: bigint;

  /** Baby Jubjub spending public key (point) - share publicly */
  spendingPubKey: BabyJubPoint;

  /** Nullifying key (BN254 scalar) - for JoinSplit nullifier computation */
  nullifyingKey: bigint;

  /** Ed25519 viewing private key (32 bytes) - for X25519 ECDH scanning */
  viewingPrivKey: Uint8Array;

  /** Ed25519 viewing public key (32 bytes) - share publicly */
  viewingPubKey: Uint8Array;

  /** Raw EdDSA seed bytes (32 bytes) - for circomlibjs EdDSA-Poseidon signing */
  eddsaSeed: Uint8Array;
}

/**
 * Stealth meta-address for receiving funds
 *
 * Total size: 96 bytes (32 BJJ compressed + 32 Ed25519 + 32 MPK)
 */
export interface StealthMetaAddress {
  /** Baby Jubjub spending public key (32 bytes compressed) */
  spendingPubKey: Uint8Array;

  /** Ed25519 viewing public key (32 bytes) */
  viewingPubKey: Uint8Array;

  /** Master public key (32 bytes, Poseidon hash as BE bytes) */
  mpk: Uint8Array;
}

/**
 * Serialized stealth meta-address for display/sharing
 */
export interface SerializedStealthMetaAddress {
  /** Hex-encoded spending public key */
  spendingPubKey: string;

  /** Hex-encoded viewing public key */
  viewingPubKey: string;

  /** Hex-encoded master public key (Poseidon hash) */
  mpk: string;
}

export interface AuthSignatureKeyDerivationOptions {
  /** Sui zkLogin address, wallet address, or app account label used as domain context. */
  account?: string;
  /** Chain label used for domain separation. */
  chain?: string;
  /** Network label used for domain separation. */
  network?: string;
}

export interface AuthSignatureKeySetupResult {
  keys: UTXOpiaKeys;
  stealthMetaAddress: StealthMetaAddress;
  encodedStealthAddress: string;
  root: Uint8Array;
}

/**
 * View permission flags for delegated viewing keys
 */
export enum ViewPermissions {
  /** Can scan announcements and see amounts */
  SCAN = 1 << 0,

  /** Can see full transaction history */
  HISTORY = 1 << 1,

  /** Can see incoming transactions only */
  INCOMING_ONLY = 1 << 2,

  /** Full viewing access (scan + history) */
  FULL = SCAN | HISTORY,
}

/**
 * Delegated viewing key for auditors/compliance
 *
 * Uses Ed25519 private key for viewing. Deposit verification additionally
 * requires `spendingPubKeyCompressed` and `nullifyingKey` so the scanner
 * can compute MPK; without them, only transfer-type announcements can be
 * confidently matched.
 */
export interface DelegatedViewKey {
  /** Ed25519 viewing private key (32 bytes) */
  viewingPrivKey: Uint8Array;

  /** Permission flags */
  permissions: ViewPermissions;

  /** Baby Jubjub spending pubkey, compressed (32 bytes). Needed for deposit verification. */
  spendingPubKeyCompressed?: Uint8Array;

  /** Nullifying key (BN254 scalar). Needed for deposit verification. */
  nullifyingKey?: bigint;

  /** Inclusive lower slot bound for audit scope (honor-system on auditor side). */
  fromSlot?: number;

  /** Inclusive upper slot bound for audit scope. */
  toSlot?: number;

  /** Optional expiration timestamp (Unix ms) */
  expiresAt?: number;

  /** Optional label for identification */
  label?: string;

  /** Unix ms when the delegation was created (set by createDelegatedViewKey). */
  issuedAt?: number;

  /** Stable opaque ID for tracking this delegation in the user's audit trail. */
  delegationId?: string;
}

/**
 * Public record of a delegation that the *user* keeps as their audit trail of
 * keys they have handed out — never carries the viewing private key itself.
 */
export interface DelegationRecord {
  delegationId: string;
  fingerprint: string;
  permissions: ViewPermissions;
  fromSlot?: number;
  toSlot?: number;
  expiresAt?: number;
  issuedAt: number;
  label?: string;
  /** Optional free-form note about who received the key (auditor name, firm, etc.). */
  recipient?: string;
}

// ========== Constants ==========

/** Message to sign for key derivation */
export const SPENDING_KEY_DERIVATION_MESSAGE =
  "UTXOpia key derivation v1";

/** Domain separator for spending key derivation */
const SPENDING_KEY_DOMAIN = "spend";

/** Domain separator for viewing key derivation */
const VIEWING_KEY_DOMAIN = "view";

/** Domain separator for nullifying key derivation */
const NULLIFYING_KEY_DOMAIN = "nullify";

const AUTH_SIGNATURE_ROOT_DOMAIN = "utxopia:auth-signature-root:v1";
const AUTH_SPENDING_DOMAIN = "utxopia:spending:eddsa-poseidon:v1";
const AUTH_NULLIFYING_DOMAIN = "utxopia:nullifier:bn254:v1";
const AUTH_VIEWING_DOMAIN = "utxopia:viewing:ed25519:v1";

// ========== EdDSA-Poseidon Helpers ==========

let eddsaInstance: Eddsa | null = null;

async function getEddsa(): Promise<Eddsa> {
  if (!eddsaInstance) {
    const { buildEddsa } = await import("circomlibjs");
    eddsaInstance = await buildEddsa();
  }
  return eddsaInstance;
}

/**
 * Derive Baby Jubjub public key from raw seed using circomlibjs EdDSA.
 *
 * circomlibjs internally hashes the seed (like standard EdDSA key derivation),
 * producing keys compatible with the EdDSAPoseidonVerifier circuit.
 * This is NOT the same as `babyJubMul(scalarFromBytes(seed), BASE8)`.
 */
export async function eddsaGetPubKey(seed: Uint8Array): Promise<BabyJubPoint> {
  const eddsa = await getEddsa();
  const F = eddsa.babyJub.F;
  const pubKey = eddsa.prv2pub(new Uint8Array(seed));
  return {
    x: F.toObject(pubKey[0]) as bigint,
    y: F.toObject(pubKey[1]) as bigint,
  };
}

/**
 * Extract the internal EdDSA private scalar from a seed.
 *
 * circomlibjs does: BLAKE-512(seed) → pruneBuffer → fromRprLE(32 bytes) → shr(3)
 * This scalar × BASE8 = the public key from `eddsaGetPubKey(seed)`.
 *
 * We intercept circomlibjs's `pruneBuffer` call during `prv2pub` to capture
 * the intermediate buffer, then replicate the LE→bigint→shr(3) conversion.
 * This avoids directly importing ffjavascript/blake-hash which aren't bundled by webpack.
 */
export async function eddsaGetPrivScalar(seed: Uint8Array): Promise<bigint> {
  const eddsa = await getEddsa();
  const F = eddsa.babyJub.F;

  // Intercept the pruneBuffer call to capture the raw scalar.
  // circomlibjs prv2pub does: sBuff = pruneBuffer(blake512(seed)); s = fromRprLE(sBuff); A = Base8 * (s >> 3)
  // We temporarily replace pruneBuffer to capture sBuff.
  let capturedBuff: Uint8Array | null = null;
  const origPrune = eddsa.pruneBuffer.bind(eddsa);
  (eddsa as any).pruneBuffer = (buff: any) => {
    const result = origPrune(buff);
    capturedBuff = new Uint8Array(result);
    return result;
  };

  try {
    // Call prv2pub which triggers pruneBuffer internally
    eddsa.prv2pub(new Uint8Array(seed));
  } finally {
    // Restore original
    (eddsa as any).pruneBuffer = origPrune;
  }

  if (!capturedBuff) {
    throw new Error("Failed to capture EdDSA scalar buffer");
  }

  // Convert first 32 bytes from little-endian to bigint (same as Scalar.fromRprLE)
  let s = 0n;
  for (let i = 31; i >= 0; i--) {
    s = (s << 8n) | BigInt(capturedBuff[i]);
  }

  // Right-shift by 3 (same as Scalar.shr(s, 3) in circomlibjs)
  return s >> 3n;
}

/**
 * Sign a message hash with EdDSA-Poseidon (circomlibjs).
 *
 * Returns [R8.x, R8.y, S] compatible with the EdDSAPoseidonVerifier circuit.
 */
export async function eddsaPoseidonSign(
  seed: Uint8Array,
  msgHash: bigint,
): Promise<[bigint, bigint, bigint]> {
  const eddsa = await getEddsa();
  const F = eddsa.babyJub.F;
  const msgF = F.e(msgHash);
  const signature = eddsa.signPoseidon(new Uint8Array(seed), msgF);
  const R8x = F.toObject(signature.R8[0]) as bigint;
  const R8y = F.toObject(signature.R8[1]) as bigint;
  const S = signature.S;
  return [R8x, R8y, S];
}

/**
 * Sign a message hash with EdDSA-Poseidon using a given private scalar directly.
 *
 * Unlike `eddsaPoseidonSign` which derives the scalar internally via circomlibjs's
 * BLAKE-512 derivation, this function uses the provided scalar as-is.
 * This is needed when the public key was derived via `scalarFromBytes` (sync)
 * rather than circomlibjs's internal derivation.
 *
 * Returns [R8.x, R8.y, S] compatible with the EdDSAPoseidonVerifier circuit.
 */
export function eddsaPoseidonSignWithScalar(
  privScalar: bigint,
  pubKey: BabyJubPoint,
  msgHash: bigint,
): [bigint, bigint, bigint] {
  // Deterministic nonce: r = Poseidon(privScalar, msgHash) mod BABYJUB_ORDER
  const r = poseidonHashSync([privScalar, msgHash]) % BABYJUB_ORDER;

  // R8 = r * BASE8
  const R8 = babyJubMul(r, BABYJUB_BASE8);

  // hm = Poseidon(R8.x, R8.y, pubKey.x, pubKey.y, msgHash)
  const hm = poseidonHashSync([R8.x, R8.y, pubKey.x, pubKey.y, msgHash]);

  // S = (r + privScalar * hm) mod BABYJUB_ORDER
  const S = (r + privScalar * hm) % BABYJUB_ORDER;

  return [R8.x, R8.y, S];
}

// ========== Wallet Adapter Interface ==========

/**
 * Minimal wallet adapter interface for signing
 * Compatible with @solana/wallet-adapter-base
 */
export interface WalletSignerAdapter {
  publicKey: { toBytes(): Uint8Array } | null;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

// ========== Key Derivation ==========

/**
 * Derive UTXOpia keys from Solana wallet signature.
 *
 * Uses circomlibjs EdDSA for spendingPubKey derivation so keys are
 * compatible with the EdDSAPoseidonVerifier circuit.
 */
export async function deriveKeysFromWallet(
  wallet: WalletSignerAdapter
): Promise<UTXOpiaKeys> {
  if (!wallet.publicKey) {
    throw new Error("Wallet not connected");
  }

  const message = new TextEncoder().encode(SPENDING_KEY_DERIVATION_MESSAGE);
  const signature = await wallet.signMessage(message);

  // Start with sync key derivation (babyJubMul-based)
  const baseKeys = deriveKeysFromSignature(signature, wallet.publicKey.toBytes());

  // Override spending keys with circomlibjs-derived versions for circuit compatibility.
  // circomlibjs does: blake512(seed) → prune → fromRprLE → shr(3) → mulPointEscalar(Base8, scalar)
  // Both spendingPrivKey and spendingPubKey must correspond so that:
  //   stealthPriv = spendingPrivKey + stealthScalar → babyJubMul(stealthPriv, BASE8) = stealthPub
  const spendingPubKey = await eddsaGetPubKey(baseKeys.eddsaSeed);
  const spendingPrivKey = await eddsaGetPrivScalar(baseKeys.eddsaSeed);

  return {
    ...baseKeys,
    spendingPubKey,
    spendingPrivKey,
  };
}

/**
 * Derive UTXOpia keys from a signature
 *
 * Spending key: SHA256(sig || "spend") → reduce mod BJJ_ORDER → babyJubMul(scalar, BASE8)
 * Viewing key: SHA256(sig || "view") → Ed25519 private key → ed25519.getPublicKey()
 */
export function deriveKeysFromSignature(
  signature: Uint8Array,
  solanaPublicKey: Uint8Array
): UTXOpiaKeys {
  if (signature.length !== 64) {
    throw new Error("Signature must be 64 bytes");
  }

  if (solanaPublicKey.length !== 32) {
    throw new Error("Solana public key must be 32 bytes");
  }

  // Derive spending key: SHA256(signature || "spend") → Baby Jubjub scalar
  const spendingSeed = sha256(
    concatBytes(signature, new TextEncoder().encode(SPENDING_KEY_DOMAIN))
  );
  // Store raw seed for circomlibjs EdDSA signing (used by deriveKeysFromWallet to override pubkey)
  const eddsaSeed = new Uint8Array(spendingSeed);
  const spendingPrivKey = scalarFromBytes(spendingSeed);
  const spendingPubKey = babyJubMul(spendingPrivKey, BABYJUB_BASE8);

  // Clear intermediate seed
  clearKey(spendingSeed);

  // Derive nullifying key: SHA256(signature || "nullify") → BN254 scalar
  const nullifyingSeed = sha256(
    concatBytes(signature, new TextEncoder().encode(NULLIFYING_KEY_DOMAIN))
  );
  const nullifyingKey = scalarFromBytes(nullifyingSeed);
  clearKey(nullifyingSeed);

  // Derive viewing key: SHA256(signature || "view") → Ed25519 private key
  const viewingPrivKey = sha256(
    concatBytes(signature, new TextEncoder().encode(VIEWING_KEY_DOMAIN))
  );
  const viewingPubKey = ed25519GetPublicKey(viewingPrivKey);

  return {
    solanaPublicKey,
    spendingPrivKey,
    spendingPubKey,
    nullifyingKey,
    viewingPrivKey,
    viewingPubKey,
    eddsaSeed,
  };
}

/**
 * Generate a random 65-byte signature-shaped seed for dev/test auth flows.
 *
 * Mirrors Fluidkey's "signature as deterministic key source" shape without
 * requiring a wallet or zkLogin proof during local testing.
 */
export function generateRandomAuthSignature(): Uint8Array {
  const signature = new Uint8Array(65);
  crypto.getRandomValues(signature);
  signature[64] = signature[64] % 2 === 0 ? 27 : 28;
  return signature;
}

/**
 * Derive UTXOpia keys from a wallet/zkLogin signature-shaped secret.
 *
 * User-facing model is two keys:
 * - spending seed/key
 * - viewing seed/key
 *
 * The protocol nullifying key is internal and derived from the spending seed,
 * so delegated viewing keys do not automatically carry nullifier authority.
 */
export function deriveKeysFromAuthSignature(
  signature: Uint8Array,
  options: AuthSignatureKeyDerivationOptions = {},
): UTXOpiaKeys {
  const normalized = normalizeAuthSignature(signature);
  const root = deriveAuthSignatureRoot(normalized, options);
  const spendingSeed = deriveAuthSecret(root, AUTH_SPENDING_DOMAIN);
  const viewingPrivKey = deriveAuthSecret(root, AUTH_VIEWING_DOMAIN);
  const nullifyingSeed = deriveAuthSecret(spendingSeed, AUTH_NULLIFYING_DOMAIN);

  const eddsaSeed = new Uint8Array(spendingSeed);
  const spendingPrivKey = scalarFromBytes(spendingSeed);
  const spendingPubKey = babyJubMul(spendingPrivKey, BABYJUB_BASE8);
  const nullifyingKey = scalarFromBytes(nullifyingSeed);
  const viewingPubKey = ed25519GetPublicKey(viewingPrivKey);
  const identityHash = sha256(
    concatBytes(root, new TextEncoder().encode("utxopia:auth-identity:v1")),
  );

  clearKey(spendingSeed);
  clearKey(nullifyingSeed);

  return {
    solanaPublicKey: identityHash,
    spendingPrivKey,
    spendingPubKey,
    nullifyingKey,
    viewingPrivKey,
    viewingPubKey,
    eddsaSeed,
  };
}

export function setupKeysFromAuthSignature(
  signature: Uint8Array,
  options: AuthSignatureKeyDerivationOptions = {},
): AuthSignatureKeySetupResult {
  const normalized = normalizeAuthSignature(signature);
  const root = deriveAuthSignatureRoot(normalized, options);
  const keys = deriveKeysFromAuthSignature(normalized, options);
  const stealthMetaAddress = createStealthMetaAddress(keys);
  const encodedStealthAddress = encodeStealthMetaAddress(stealthMetaAddress);

  return {
    keys,
    stealthMetaAddress,
    encodedStealthAddress,
    root,
  };
}

/**
 * Derive keys from a seed phrase (sync — for scanning/non-circuit use)
 */
export function deriveKeysFromSeed(seed: Uint8Array): UTXOpiaKeys {
  const fakeSig = new Uint8Array(64);
  const hash1 = sha256(seed);
  const hash2 = sha256(concatBytes(seed, new Uint8Array([1])));
  fakeSig.set(hash1, 0);
  fakeSig.set(hash2, 32);

  return deriveKeysFromSignature(fakeSig, new Uint8Array(32));
}

/**
 * Derive keys from a seed phrase with circomlibjs-compatible spending keys.
 *
 * Must be used when the keys will be used for circuit proofs (EdDSA signing).
 * The sync `deriveKeysFromSeed` uses a different scalar derivation that doesn't
 * match circomlibjs's internal BLAKE-512 derivation used by `eddsaPoseidonSign`.
 */
export async function deriveKeysFromSeedCircuit(seed: Uint8Array): Promise<UTXOpiaKeys> {
  const baseKeys = deriveKeysFromSeed(seed);

  // Override spending keys with circomlibjs-derived versions (same as deriveKeysFromWallet)
  const spendingPubKey = await eddsaGetPubKey(baseKeys.eddsaSeed);
  const spendingPrivKey = await eddsaGetPrivScalar(baseKeys.eddsaSeed);

  return {
    ...baseKeys,
    spendingPubKey,
    spendingPrivKey,
  };
}

// ========== Stealth Meta-Address ==========

/**
 * Create a stealth meta-address from UTXOpia keys
 *
 * Size: 96 bytes (32 BJJ compressed + 32 Ed25519 + 32 MPK)
 */
export function createStealthMetaAddress(keys: UTXOpiaKeys): StealthMetaAddress {
  const mpk = computeMPKSync(
    keys.spendingPubKey.x,
    keys.spendingPubKey.y,
    keys.nullifyingKey
  );
  return {
    spendingPubKey: babyJubCompress(keys.spendingPubKey),
    viewingPubKey: new Uint8Array(keys.viewingPubKey),
    mpk: bigintToBytes(mpk),
  };
}

/**
 * Serialize a stealth meta-address for display/sharing
 */
export function serializeStealthMetaAddress(
  meta: StealthMetaAddress
): SerializedStealthMetaAddress {
  return {
    spendingPubKey: bytesToHex(meta.spendingPubKey),
    viewingPubKey: bytesToHex(meta.viewingPubKey),
    mpk: bytesToHex(meta.mpk),
  };
}

/**
 * Deserialize a stealth meta-address from string representation
 */
export function deserializeStealthMetaAddress(
  serialized: SerializedStealthMetaAddress
): StealthMetaAddress {
  return {
    spendingPubKey: hexToBytes(serialized.spendingPubKey),
    viewingPubKey: hexToBytes(serialized.viewingPubKey),
    mpk: hexToBytes(serialized.mpk),
  };
}

/**
 * Parse a stealth meta-address and extract public keys
 *
 * Returns Baby Jubjub spending pubkey and Ed25519 viewing pubkey.
 */
export function parseStealthMetaAddress(meta: StealthMetaAddress): {
  spendingPubKey: BabyJubPoint;
  viewingPubKey: Uint8Array;
} {
  return {
    spendingPubKey: babyJubDecompress(meta.spendingPubKey),
    viewingPubKey: new Uint8Array(meta.viewingPubKey),
  };
}

/**
 * Encode stealth meta-address as a single string with utxo: prefix
 * Format: "utxo:" + hex(spendingPubKey (32) || viewingPubKey (32) || mpk (32))
 */
export function encodeStealthMetaAddress(meta: StealthMetaAddress): string {
  const combined = concatBytes(meta.spendingPubKey, meta.viewingPubKey, meta.mpk);
  return "utxo:" + bytesToHex(combined);
}

/**
 * Decode stealth meta-address from a string (with or without utxo: prefix)
 */
export function decodeStealthMetaAddress(encoded: string): StealthMetaAddress {
  // "utxo:" is 5 chars — slice(5), not slice(6). Off-by-one was eating one
  // hex character and producing a 47-byte buffer that failed the length check.
  const hex = encoded.startsWith("utxo:") ? encoded.slice(5) : encoded;
  const bytes = hexToBytes(hex);
  if (bytes.length !== 96) {
    throw new Error("Invalid stealth meta-address length (expected 96 bytes)");
  }
  return {
    spendingPubKey: bytes.slice(0, 32),
    viewingPubKey: bytes.slice(32, 64),
    mpk: bytes.slice(64, 96),
  };
}

// ========== Viewing Key Delegation ==========

/**
 * Create a delegated viewing key for auditors/compliance
 *
 * The returned key carries everything an auditor needs to scan announcements
 * within the configured slot range, including the spending pubkey and
 * nullifying key (required for deposit verification — `Poseidon(npk, token, amount)`
 * must match on-chain commitment). A fresh `delegationId` and `issuedAt` are
 * generated so the user can keep an [[auditable-disclosure-status]] trail of
 * who they handed keys to.
 */
export function createDelegatedViewKey(
  keys: UTXOpiaKeys,
  permissions: ViewPermissions = ViewPermissions.FULL,
  options: {
    fromSlot?: number;
    toSlot?: number;
    expiresAt?: number;
    label?: string;
  } = {}
): DelegatedViewKey {
  const issuedAt = Date.now();
  const delegationId = generateDelegationId();
  return {
    viewingPrivKey: new Uint8Array(keys.viewingPrivKey),
    spendingPubKeyCompressed: babyJubCompress(keys.spendingPubKey),
    nullifyingKey: keys.nullifyingKey,
    permissions,
    fromSlot: options.fromSlot,
    toSlot: options.toSlot,
    expiresAt: options.expiresAt,
    label: options.label,
    issuedAt,
    delegationId,
  };
}

/**
 * Build a public-only record of a delegated viewing key for the issuer's
 * audit trail. Strips the secret material; only carries identifiers + scope.
 */
export function makeDelegationRecord(
  key: DelegatedViewKey,
  options: { recipient?: string } = {}
): DelegationRecord {
  return {
    delegationId: key.delegationId ?? generateDelegationId(),
    fingerprint: fingerprintDelegatedKey(key),
    permissions: key.permissions,
    fromSlot: key.fromSlot,
    toSlot: key.toSlot,
    expiresAt: key.expiresAt,
    issuedAt: key.issuedAt ?? Date.now(),
    label: key.label,
    recipient: options.recipient,
  };
}

/**
 * Compute a stable fingerprint for a delegated viewing key.
 *
 * `sha256(viewingPrivKey)[..16]` rendered as hex — short enough to display,
 * long enough to make collisions astronomically unlikely. Identical viewing
 * keys produce identical fingerprints, so the user can detect duplicate
 * delegations across export sessions.
 */
export function fingerprintDelegatedKey(key: DelegatedViewKey): string {
  return bytesToHex(sha256(key.viewingPrivKey).slice(0, 16));
}

function generateDelegationId(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

/**
 * Decide whether a slot falls within the delegated key's permitted range.
 * No range bound on a side ⇒ unbounded on that side.
 */
export function isSlotInDelegatedRange(
  key: DelegatedViewKey,
  slot: number | undefined
): boolean {
  if (slot == null) {
    // Slot unknown — only accept when the key itself has no range constraint.
    return key.fromSlot == null && key.toSlot == null;
  }
  if (key.fromSlot != null && slot < key.fromSlot) return false;
  if (key.toSlot != null && slot > key.toSlot) return false;
  return true;
}

/**
 * Serialize a delegated viewing key for export (ENCRYPTED)
 */
export async function serializeDelegatedViewKey(
  key: DelegatedViewKey,
  password?: string
): Promise<string> {
  if (!password) {
    throw new Error(
      "Password required for viewing key serialization. " +
      "Unencrypted export is not permitted for security."
    );
  }

  const passwordBytes = new TextEncoder().encode(password);
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);

  const PBKDF2_ITERATIONS = 600_000;
  const encryptionKey = pbkdf2(sha256, passwordBytes, salt, { c: PBKDF2_ITERATIONS, dkLen: 32 });

  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);

  const keyBuffer = encryptionKey.buffer.slice(
    encryptionKey.byteOffset,
    encryptionKey.byteOffset + encryptionKey.byteLength
  ) as ArrayBuffer;
  const nonceBuffer = nonce.buffer.slice(
    nonce.byteOffset,
    nonce.byteOffset + nonce.byteLength
  ) as ArrayBuffer;
  const dataBuffer = key.viewingPrivKey.buffer.slice(
    key.viewingPrivKey.byteOffset,
    key.viewingPrivKey.byteOffset + key.viewingPrivKey.byteLength
  ) as ArrayBuffer;

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBuffer,
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonceBuffer },
    cryptoKey,
    dataBuffer
  );

  const obj: Record<string, unknown> = {
    version: 2,
    encrypted: true,
    salt: bytesToHex(salt),
    nonce: bytesToHex(nonce),
    ciphertext: bytesToHex(new Uint8Array(ciphertext)),
    permissions: key.permissions,
    expiresAt: key.expiresAt,
    label: key.label,
    delegationId: key.delegationId,
    issuedAt: key.issuedAt,
    fromSlot: key.fromSlot,
    toSlot: key.toSlot,
    fingerprint: fingerprintDelegatedKey(key),
  };
  if (key.spendingPubKeyCompressed) {
    obj.spendingPubKeyCompressed = bytesToHex(key.spendingPubKeyCompressed);
  }
  if (key.nullifyingKey != null) {
    obj.nullifyingKey = key.nullifyingKey.toString(16);
  }
  return JSON.stringify(obj);
}

/**
 * Deserialize a delegated viewing key from JSON.
 *
 * v1 keys are refused at parse time by default (they lack
 * `spendingPubKeyCompressed`/`nullifyingKey`, so `auditScan` would error out
 * downstream anyway — failing early gives callers a clearer message and
 * avoids partial setup). Set `acceptV1: true` to opt in for migration
 * tools that need to crack open old blobs to re-issue them as v2.
 */
export async function deserializeDelegatedViewKey(
  json: string,
  password?: string,
  options: { acceptV1?: boolean } = {},
): Promise<DelegatedViewKey> {
  let obj;
  try {
    obj = JSON.parse(json);
  } catch {
    throw new Error("Invalid delegated view key format");
  }

  if (!obj.encrypted) {
    const privKeyBytes = hexToBytes(obj.viewingPrivKey);
    return {
      viewingPrivKey: privKeyBytes,
      permissions: obj.permissions,
      expiresAt: obj.expiresAt,
      label: obj.label,
    };
  }

  if (!password) {
    throw new Error("Password required to decrypt viewing key");
  }

  // Refuse v1 unless explicitly opted in. v1 keys decrypt fine but lack the
  // spendingPubKey + nullifyingKey material needed by auditScan, so they
  // produce a confusing late-stage failure. Better to surface it here.
  if (obj.version === 1 && !options.acceptV1) {
    throw new Error(
      "Delegated view key is v1 (pre-mpk format). v1 keys can no longer scan " +
        "deposits — re-issue as v2 via createDelegatedViewKey + " +
        "encryptDelegatedViewKey. Pass { acceptV1: true } if you're running " +
        "a one-shot migration.",
    );
  }

  const salt = hexToBytes(obj.salt);
  const nonce = hexToBytes(obj.nonce);
  const ciphertext = hexToBytes(obj.ciphertext);
  const passwordBytes = new TextEncoder().encode(password);

  if (obj.version === 1 || obj.version === 2) {
    const iterations = 600_000;
    const encryptionKey = pbkdf2(sha256, passwordBytes, salt, { c: iterations, dkLen: 32 });

    const keyBuffer = encryptionKey.buffer.slice(
      encryptionKey.byteOffset,
      encryptionKey.byteOffset + encryptionKey.byteLength
    ) as ArrayBuffer;
    const nonceBuffer = nonce.buffer.slice(
      nonce.byteOffset,
      nonce.byteOffset + nonce.byteLength
    ) as ArrayBuffer;
    const ciphertextBuffer = ciphertext.buffer.slice(
      ciphertext.byteOffset,
      ciphertext.byteOffset + ciphertext.byteLength
    ) as ArrayBuffer;

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyBuffer,
      { name: "AES-GCM" },
      false,
      ["decrypt"]
    );

    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonceBuffer },
        cryptoKey,
        ciphertextBuffer
      );
      const out: DelegatedViewKey = {
        viewingPrivKey: new Uint8Array(plaintext),
        permissions: obj.permissions,
        expiresAt: obj.expiresAt,
        label: obj.label,
      };
      if (obj.version === 2) {
        if (typeof obj.spendingPubKeyCompressed === "string") {
          out.spendingPubKeyCompressed = hexToBytes(obj.spendingPubKeyCompressed);
        }
        if (typeof obj.nullifyingKey === "string") {
          out.nullifyingKey = BigInt("0x" + obj.nullifyingKey);
        }
        if (typeof obj.fromSlot === "number") out.fromSlot = obj.fromSlot;
        if (typeof obj.toSlot === "number") out.toSlot = obj.toSlot;
        if (typeof obj.issuedAt === "number") out.issuedAt = obj.issuedAt;
        if (typeof obj.delegationId === "string") out.delegationId = obj.delegationId;
      }
      return out;
    } catch {
      throw new Error("Invalid password or corrupted data");
    }
  }

  throw new Error(
    "Unsupported encryption format (version " + obj.version + "). " +
    "Supported versions: 1, 2."
  );
}

/**
 * Check if a delegated viewing key is valid (not expired)
 */
export function isDelegatedKeyValid(key: DelegatedViewKey): boolean {
  if (!key.expiresAt) return true;
  return Date.now() < key.expiresAt;
}

/**
 * Check if a delegated key has a specific permission
 */
export function hasPermission(
  key: DelegatedViewKey,
  permission: ViewPermissions
): boolean {
  return (key.permissions & permission) === permission;
}

// ========== Key Security ==========

/**
 * Safely compare two keys in constant time
 */
export function constantTimeCompare(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

/**
 * Securely clear sensitive key material from memory
 */
export function clearKey(key: Uint8Array): void {
  crypto.getRandomValues(key);
  key.fill(0);
}

/**
 * Securely clear all sensitive keys from an UTXOpiaKeys object
 */
export function clearUTXOpiaKeys(keys: UTXOpiaKeys): void {
  (keys as { spendingPrivKey: bigint }).spendingPrivKey = 0n;
  (keys as { nullifyingKey: bigint }).nullifyingKey = 0n;
  clearKey(keys.viewingPrivKey);
  clearKey(keys.eddsaSeed);
}

/**
 * Securely clear a delegated viewing key
 */
export function clearDelegatedViewKey(key: DelegatedViewKey): void {
  clearKey(key.viewingPrivKey);
}

/**
 * Derive a view-only key bundle (no spending key)
 * Safe to export/backup separately from spending key
 */
export function extractViewOnlyBundle(keys: UTXOpiaKeys): {
  solanaPublicKey: Uint8Array;
  spendingPubKey: Uint8Array;
  viewingPrivKey: Uint8Array;
  viewingPubKey: Uint8Array;
} {
  return {
    solanaPublicKey: keys.solanaPublicKey,
    spendingPubKey: babyJubCompress(keys.spendingPubKey),
    viewingPrivKey: new Uint8Array(keys.viewingPrivKey),
    viewingPubKey: new Uint8Array(keys.viewingPubKey),
  };
}

// ========== Key Serialization ==========

/**
 * Serialized key storage format (all values are hex strings or string-encoded bigints).
 */
export interface SerializedKeysForStorage {
  eddsaSeedHex: string;
  spendingPrivKeyHex: string;
  spendingPubKey: { x: string; y: string };
  nullifyingKey: string;
  viewingPrivKeyHex: string;
  viewingPubKeyHex: string;
}

/**
 * Serialize UTXOpiaKeys to a plain object with hex strings (for encrypted storage).
 *
 * The result is JSON-safe. Use `deserializeKeysFromStorage` to reconstruct.
 */
export function serializeKeysForStorage(keys: UTXOpiaKeys): SerializedKeysForStorage {
  return {
    eddsaSeedHex: bytesToHex(keys.eddsaSeed),
    spendingPrivKeyHex: keys.spendingPrivKey.toString(16),
    spendingPubKey: { x: keys.spendingPubKey.x.toString(), y: keys.spendingPubKey.y.toString() },
    nullifyingKey: keys.nullifyingKey.toString(16),
    viewingPrivKeyHex: bytesToHex(keys.viewingPrivKey),
    viewingPubKeyHex: bytesToHex(keys.viewingPubKey),
  };
}

/**
 * Deserialize UTXOpiaKeys from a storage object (reverse of serializeKeysForStorage).
 *
 * Requires `solanaPublicKey` to be provided separately since it is not stored
 * in the serialized format (it comes from the connected wallet).
 */
export function deserializeKeysFromStorage(
  data: SerializedKeysForStorage,
  solanaPublicKey: Uint8Array,
): UTXOpiaKeys {
  return {
    solanaPublicKey,
    spendingPrivKey: BigInt("0x" + data.spendingPrivKeyHex),
    spendingPubKey: { x: BigInt(data.spendingPubKey.x), y: BigInt(data.spendingPubKey.y) },
    nullifyingKey: BigInt("0x" + data.nullifyingKey),
    viewingPrivKey: hexToBytes(data.viewingPrivKeyHex),
    viewingPubKey: hexToBytes(data.viewingPubKeyHex),
    eddsaSeed: hexToBytes(data.eddsaSeedHex),
  };
}

// ========== High-Level Key Setup ==========

/**
 * Result of a complete key setup operation (derivation + stealth address creation).
 */
export interface KeySetupResult {
  keys: UTXOpiaKeys;
  stealthAddress: StealthMetaAddress;
  stealthAddressEncoded: string;
}

/**
 * Derive keys from wallet signature and create stealth address in one step.
 *
 * Combines deriveKeysFromWallet + createStealthMetaAddress + encodeStealthMetaAddress.
 */
export async function setupKeysFromWallet(
  wallet: WalletSignerAdapter,
): Promise<KeySetupResult> {
  const keys = await deriveKeysFromWallet(wallet);
  const stealthAddress = createStealthMetaAddress(keys);
  const stealthAddressEncoded = encodeStealthMetaAddress(stealthAddress);
  return { keys, stealthAddress, stealthAddressEncoded };
}

/**
 * Derive keys from seed (passkey PRF or secret phrase) and create stealth address in one step.
 *
 * Combines deriveKeysFromSeedCircuit + createStealthMetaAddress + encodeStealthMetaAddress.
 */
export async function setupKeysFromSeed(
  seed: Uint8Array,
): Promise<KeySetupResult> {
  const keys = await deriveKeysFromSeedCircuit(seed);
  const stealthAddress = createStealthMetaAddress(keys);
  const stealthAddressEncoded = encodeStealthMetaAddress(stealthAddress);
  return { keys, stealthAddress, stealthAddressEncoded };
}

/**
 * Recreate stealth address from existing keys (for hydration from storage).
 *
 * Use this when keys are already deserialized and you just need the stealth address.
 */
export function recreateStealthAddress(keys: UTXOpiaKeys): {
  stealthAddress: StealthMetaAddress;
  stealthAddressEncoded: string;
} {
  const stealthAddress = createStealthMetaAddress(keys);
  const stealthAddressEncoded = encodeStealthMetaAddress(stealthAddress);
  return { stealthAddress, stealthAddressEncoded };
}

// ========== Utilities ==========

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

function normalizeAuthSignature(signature: Uint8Array): Uint8Array {
  if (signature.length === 64 || signature.length === 65) {
    return new Uint8Array(signature);
  }
  throw new Error("Auth signature must be 64 or 65 bytes");
}

function deriveAuthSignatureRoot(
  signature: Uint8Array,
  options: AuthSignatureKeyDerivationOptions,
): Uint8Array {
  const context = JSON.stringify({
    account: options.account ?? "",
    chain: options.chain ?? "sui",
    network: options.network ?? "testnet",
  });
  return sha256(
    concatBytes(
      new TextEncoder().encode(AUTH_SIGNATURE_ROOT_DOMAIN),
      new TextEncoder().encode(context),
      signature,
    ),
  );
}

function deriveAuthSecret(root: Uint8Array, domain: string): Uint8Array {
  return sha256(concatBytes(new TextEncoder().encode(domain), root));
}
