/**
 * SNS Subdomain Resolver for Stealth Addresses
 *
 * Resolves `<name>.btcpro.sol` (or configured parent domain) to stealth
 * address keys stored in the SNS name record data field.
 *
 * On-chain data layout (after 96-byte SNS header):
 *   version(1) + spendingPubKey(32) + viewingPubKey(32) = 65 bytes
 *
 * - spendingPubKey: Baby Jubjub compressed (y-coord + x sign bit in MSB)
 * - viewingPubKey:  Ed25519 public key (standard 32-byte encoding)
 *
 * These two keys are all a sender needs to create a stealth deposit.
 *
 * @module sns-resolver
 */

import { getConfig } from "./config";
import type { ConnectionAdapter } from "./stealth";
import { sha256Hash } from "./crypto";

// ========== Constants ==========

/** SNS name record header size (parent:32 + owner:32 + class:32) */
const SNS_HEADER_SIZE = 96;

/** Stealth data size: version(1) + spendingPubKey(32) + viewingPubKey(32) */
export const SNS_STEALTH_DATA_SIZE = 65;

/** SNS hash prefix used for PDA derivation */
const HASH_PREFIX = "SPL Name Service";

// ========== Types ==========

export interface SnsStealthAddress {
  /** The subdomain name (e.g., "alice") */
  name: string;

  /** Full domain (e.g., "alice.btcpro.sol") */
  fullDomain: string;

  /** Baby Jubjub spending public key (32 bytes compressed) */
  spendingPubKey: Uint8Array;

  /** Ed25519 viewing public key (32 bytes) */
  viewingPubKey: Uint8Array;

  /** Combined stealth meta-address (64 bytes = spending + viewing) */
  stealthMetaAddress: Uint8Array;

  /** Hex-encoded stealth meta-address (128 chars) */
  stealthMetaAddressHex: string;

  /** Data version read from the record */
  version: number;
}

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
 * Derive the SNS key for a parent domain (e.g., "btcpro.sol")
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
 * Derive the SNS key for a subdomain (e.g., "alice" under "btcpro.sol")
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
 * @param accountData - Raw account data (including 96-byte header)
 * @returns Parsed stealth keys or null if invalid
 */
export function parseSnsStealthData(
  accountData: Uint8Array,
): { spendingPubKey: Uint8Array; viewingPubKey: Uint8Array; version: number } | null {
  // Need at least header + stealth data
  if (accountData.length < SNS_HEADER_SIZE + SNS_STEALTH_DATA_SIZE) {
    return null;
  }

  const data = accountData.slice(SNS_HEADER_SIZE);

  const version = data[0];
  const config = getConfig();
  if (version !== config.snsStealthDataVersion) {
    return null;
  }

  const spendingPubKey = data.slice(1, 33);
  const viewingPubKey = data.slice(33, 65);

  // Basic validation: not all zeros
  const allZero = (buf: Uint8Array) => buf.every((b) => b === 0);
  if (allZero(spendingPubKey) || allZero(viewingPubKey)) {
    return null;
  }

  return {
    spendingPubKey: new Uint8Array(spendingPubKey),
    viewingPubKey: new Uint8Array(viewingPubKey),
    version,
  };
}

// ========== Resolution ==========

/**
 * Resolve a name to a stealth address via SNS subdomain.
 *
 * Accepts multiple formats:
 *   - "alice"              → resolves alice.<parentDomain>.sol
 *   - "alice.btcpro"       → resolves alice.btcpro.sol
 *   - "alice.btcpro.sol"   → resolves alice.btcpro.sol
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

    // Build combined meta-address (64 bytes)
    const stealthMetaAddress = new Uint8Array(64);
    stealthMetaAddress.set(parsed.spendingPubKey, 0);
    stealthMetaAddress.set(parsed.viewingPubKey, 32);

    const fullDomain = `${subdomain}.${parentDomain}.sol`;

    return {
      name: subdomain,
      fullDomain,
      spendingPubKey: parsed.spendingPubKey,
      viewingPubKey: parsed.viewingPubKey,
      stealthMetaAddress,
      stealthMetaAddressHex: Buffer.from(stealthMetaAddress).toString("hex"),
      version: parsed.version,
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
