/**
 * SNS Subdomain Resolver for Stealth Addresses
 *
 * Resolves `<name>.utxopia.sol` (or configured parent domain) to stealth
 * address keys stored in the SNS name record data field.
 *
 * On-chain data layout (after 96-byte SNS header):
 *   version(1) + viewingPubKey(32) + mpk(32) = 65 bytes
 *
 * - viewingPubKey: Ed25519 public key (for X25519 ECDH)
 * - mpk:          Master Public Key = Poseidon(spendingPub.x, spendingPub.y, nullifyingKey)
 *
 * These two keys are all a sender needs to create a stealth deposit.
 * spendingPubKey is NOT stored — senders never use it.
 *
 * @module sns-resolver
 */

import { getConfig } from "./config";
import type { ConnectionAdapter } from "./stealth";
import { sha256Hash } from "./crypto";

// ========== Constants ==========

/** SNS name record header size (parent:32 + owner:32 + class:32) */
const SNS_HEADER_SIZE = 96;

/** Stealth data size: version(1) + viewingPubKey(32) + mpk(32) = 65 bytes */
export const SNS_STEALTH_DATA_SIZE = 65;

/** Legacy stealth data size v1: version(1) + spendingPubKey(32) + viewingPubKey(32) = 65 bytes (no mpk) */
export const SNS_STEALTH_DATA_SIZE_LEGACY_V1 = 65;

/** Legacy stealth data size v2: version(1) + spendingPubKey(32) + viewingPubKey(32) + mpk(32) = 97 bytes */
export const SNS_STEALTH_DATA_SIZE_LEGACY_V2 = 97;

/** SNS hash prefix used for PDA derivation */
const HASH_PREFIX = "SPL Name Service";

// ========== Types ==========

export interface SnsStealthAddress {
  /** The subdomain name (e.g., "alice") */
  name: string;

  /** Full domain (e.g., "alice.utxopia.sol") */
  fullDomain: string;

  /** Ed25519 viewing public key (32 bytes) — for X25519 ECDH */
  viewingPubKey: Uint8Array;

  /** Master public key: Poseidon(spendingPub.x, spendingPub.y, nullifyingKey) (32 bytes) — for NPK derivation */
  mpk: Uint8Array;

  /** Data version read from the record */
  version: number;

  /**
   * Compliance flag bits the recipient has self-published. Defaults to 0
   * when the SNS record only carries the legacy 65-byte stealth payload.
   * Check via {@link SnsComplianceFlags} / {@link isAuditorDisclosable}.
   */
  complianceFlags: number;

  /**
   * Optional 32-byte Solana pubkey of the recipient's designated auditor.
   * Present only when the record carries the v2 compliance bytes
   * (flag + 32-byte pubkey, 33 bytes total after the 65-byte stealth payload).
   * Senders treat this as a hint about who the recipient discloses to —
   * the actual DelegatedViewKey delivery is still out-of-band.
   */
  auditorPubkey?: Uint8Array;
}

/**
 * Bit-flags a recipient can opt into on their SNS subdomain. The byte sits
 * at offset 65 of the stealth payload (i.e. byte 161 of the on-chain
 * account, after the 96-byte SNS header). Absent → all bits 0.
 */
export const SnsComplianceFlags = {
  /**
   * Recipient is "auditor-disclosable by default" — they've signalled to
   * senders that they're OK receiving outgoing audit memos, and likely
   * already share a `DelegatedViewKey` with a designated auditor
   * out-of-band.
   */
  AUDITOR_DISCLOSABLE: 1 << 0,
} as const;

/** Returns true if the recipient has set the AUDITOR_DISCLOSABLE bit. */
export function isAuditorDisclosable(addr: SnsStealthAddress): boolean {
  return (addr.complianceFlags & SnsComplianceFlags.AUDITOR_DISCLOSABLE) !== 0;
}

/**
 * Total bytes of the stealth payload's compliance extension when both
 * pieces are present:
 *   [byte 65]      complianceFlags (u8)
 *   [bytes 66..97] auditorPubkey   (32-byte Solana pubkey)
 *
 * Recipients on the legacy 65-byte payload have neither (back-compat).
 * Recipients on the v1 66-byte payload have only `complianceFlags`.
 * Recipients on the v2 97-byte payload have both.
 */
export const SNS_COMPLIANCE_AUDITOR_OFFSET = 66;
export const SNS_COMPLIANCE_AUDITOR_BYTES = 32;

// ========== PDA Derivation ==========

/**
 * Hash a name for SNS PDA derivation (SHA256 of HASH_PREFIX + name)
 */
function hashSnsName(name: string): Uint8Array {
  const input = HASH_PREFIX + name;
  return sha256Hash(new TextEncoder().encode(input));
}

// ========== PDA Derivation (internal) ==========

/**
 * Derive the SNS key for a parent domain (e.g., "utxopia.sol")
 */
export async function deriveParentDomainKey(parentDomain: string): Promise<string> {
  const { address, getProgramDerivedAddress, getAddressEncoder } = await import("@solana/kit");
  const config = getConfig();

  if (!config.snsRootDomain) {
    throw new Error("SNS root domain not configured for this network");
  }

  const hashedParent = hashSnsName(parentDomain);
  const encoder = getAddressEncoder();

  const [pda] = await getProgramDerivedAddress({
    seeds: [
      hashedParent,
      new Uint8Array(32), // no class
      new Uint8Array(encoder.encode(address(config.snsRootDomain))),
    ],
    programAddress: address(config.snsNameServiceProgramId),
  });

  return pda;
}

/**
 * Derive the SNS key for a subdomain (e.g., "alice" under "utxopia.sol")
 *
 * Seeds: [hash("SPL Name Service" + "\0" + name), zeros(32), parentKey]
 */
async function deriveSubdomainKey(
  subdomain: string,
  parentKey: string,
): Promise<string> {
  const { address, getProgramDerivedAddress, getAddressEncoder } = await import("@solana/kit");
  const config = getConfig();

  const hashedSub = hashSnsName("\0" + subdomain);
  const encoder = getAddressEncoder();

  const [pda] = await getProgramDerivedAddress({
    seeds: [
      hashedSub,
      new Uint8Array(32), // no class
      new Uint8Array(encoder.encode(address(parentKey))),
    ],
    programAddress: address(config.snsNameServiceProgramId),
  });

  return pda;
}

// ========== Parsing ==========

/**
 * Parse stealth address data from an SNS name record.
 *
 * Supports three formats:
 * - Current (65 bytes, version 2): version(1) + viewingPubKey(32) + mpk(32)
 * - Legacy v2 (97 bytes, version 1): version(1) + spendingPubKey(32) + viewingPubKey(32) + mpk(32)
 * - Legacy v1 (65 bytes, version 1): version(1) + spendingPubKey(32) + viewingPubKey(32) — mpk missing
 *
 * Optional trailing byte (offset 65 of the stealth payload, byte 161 of the
 * account) carries `complianceFlags: u8` — see {@link SnsComplianceFlags}.
 * When absent, the parsed result has `complianceFlags = 0` (back-compat).
 *
 * @param accountData - Raw account data (including 96-byte header)
 * @returns Parsed stealth keys + compliance flags, or null if invalid
 */
export function parseSnsStealthData(
  accountData: Uint8Array,
):
  | {
      viewingPubKey: Uint8Array;
      mpk: Uint8Array;
      version: number;
      complianceFlags: number;
      auditorPubkey?: Uint8Array;
    }
  | null {
  // Need at least header + 65 bytes of stealth data
  if (accountData.length < SNS_HEADER_SIZE + SNS_STEALTH_DATA_SIZE) {
    return null;
  }

  const data = accountData.slice(SNS_HEADER_SIZE);
  const version = data[0];
  const allZero = (buf: Uint8Array) => buf.every((b) => b === 0);

  // Current format (version 2): version(1) + viewingPubKey(32) + mpk(32)
  if (version === 2) {
    const viewingPubKey = data.slice(1, 33);
    const mpk = data.slice(33, 65);

    if (allZero(viewingPubKey) || allZero(mpk)) {
      return null;
    }

    // Optional compliance bytes only attach to the current (v2) layout — the
    // legacy v1 layouts reuse byte 65 for `mpk`, so reading a flag there
    // would alias real cryptographic material.
    const complianceFlags =
      data.length > SNS_STEALTH_DATA_SIZE ? data[SNS_STEALTH_DATA_SIZE] : 0;

    let auditorPubkey: Uint8Array | undefined;
    if (
      data.length >= SNS_COMPLIANCE_AUDITOR_OFFSET + SNS_COMPLIANCE_AUDITOR_BYTES
    ) {
      const buf = data.slice(
        SNS_COMPLIANCE_AUDITOR_OFFSET,
        SNS_COMPLIANCE_AUDITOR_OFFSET + SNS_COMPLIANCE_AUDITOR_BYTES,
      );
      // All-zero pubkey means "no auditor set" — distinguishes from the
      // case where a recipient flips the flag bit but skips the pubkey.
      if (!allZero(buf)) {
        auditorPubkey = new Uint8Array(buf);
      }
    }

    return {
      viewingPubKey: new Uint8Array(viewingPubKey),
      mpk: new Uint8Array(mpk),
      version,
      complianceFlags,
      auditorPubkey,
    };
  }

  // Legacy formats (version 1): spendingPubKey was at offset 1
  if (version !== 1) {
    return null;
  }

  // Legacy v2 (97 bytes): version(1) + spendingPubKey(32) + viewingPubKey(32) + mpk(32)
  // Legacy layouts reuse byte 65+ for `mpk`, so they CAN'T carry compliance
  // bytes — return complianceFlags=0 unconditionally for v1.
  if (data.length >= SNS_STEALTH_DATA_SIZE_LEGACY_V2) {
    const viewingPubKey = data.slice(33, 65);
    const mpk = data.slice(65, 97);

    if (!allZero(viewingPubKey) && !allZero(mpk)) {
      return {
        viewingPubKey: new Uint8Array(viewingPubKey),
        mpk: new Uint8Array(mpk),
        version,
        complianceFlags: 0,
      };
    }
  }

  // Legacy v1 (65 bytes): version(1) + spendingPubKey(32) + viewingPubKey(32) — no mpk
  const viewingPubKey = data.slice(33, 65);
  if (!allZero(viewingPubKey)) {
    return {
      viewingPubKey: new Uint8Array(viewingPubKey),
      mpk: new Uint8Array(32), // No MPK — deposits will fail (user must re-register)
      version,
      complianceFlags: 0,
    };
  }

  return null;
}

// ========== Resolution ==========

/**
 * Resolve a name to a stealth address via SNS subdomain.
 *
 * Accepts multiple formats:
 *   - "alice"              → resolves alice.<parentDomain>.sol
 *   - "alice.utxopia"       → resolves alice.utxopia.sol
 *   - "alice.utxopia.sol"   → resolves alice.utxopia.sol
 *
 * @param connection - RPC connection adapter
 * @param name - Name to resolve
 * @returns Stealth address or null if not found / no stealth data
 */
export async function resolveSnsName(
  connection: ConnectionAdapter,
  name: string,
): Promise<SnsStealthAddress | null> {
  const config = getConfig();

  if (!config.snsNameServiceProgramId || !config.snsParentDomain) {
    return null; // SNS not configured
  }

  // Normalize: strip .sol and parent domain suffix
  const parentDomain = config.snsParentDomain;
  let subdomain = name.trim().toLowerCase();
  if (subdomain.endsWith(".sol")) {
    subdomain = subdomain.slice(0, -4);
  }
  if (subdomain.endsWith("." + parentDomain)) {
    subdomain = subdomain.slice(0, -(parentDomain.length + 1));
  }

  if (!subdomain || subdomain.includes(".")) {
    return null; // Invalid: either empty or has extra dots
  }

  try {
    // Derive parent domain key
    const parentKey = await deriveParentDomainKey(parentDomain);

    // Derive subdomain key
    const subKey = await deriveSubdomainKey(subdomain, parentKey);

    // Fetch account
    const accountInfo = await connection.getAccountInfo(subKey as any);
    if (!accountInfo) {
      return null;
    }

    // Parse stealth data
    const parsed = parseSnsStealthData(new Uint8Array(accountInfo.data));
    if (!parsed) {
      return null;
    }

    const fullDomain = `${subdomain}.${parentDomain}.sol`;

    return {
      name: subdomain,
      fullDomain,
      viewingPubKey: parsed.viewingPubKey,
      mpk: parsed.mpk,
      version: parsed.version,
      complianceFlags: parsed.complianceFlags,
      auditorPubkey: parsed.auditorPubkey,
    };
  } catch (err) {
    console.error(`Failed to resolve SNS name "${name}":`, err);
    return null;
  }
}

/**
 * Resolve a stealth name via SNS subdomain.
 *
 * This is the unified resolver that the frontend should use.
 * All names are resolved as SNS subdomains under the configured parent domain.
 */
export async function resolveStealthName(
  connection: ConnectionAdapter,
  name: string,
): Promise<SnsStealthAddress | null> {
  return resolveSnsName(connection, name);
}

/**
 * Type guard to check if a resolved address is from SNS
 */
export function isSnsStealthAddress(
  addr: SnsStealthAddress | unknown,
): addr is SnsStealthAddress {
  return typeof addr === "object" && addr !== null && "fullDomain" in addr;
}
