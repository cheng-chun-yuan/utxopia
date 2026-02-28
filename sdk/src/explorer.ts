/**
 * Explorer utilities for ZVault
 *
 * Types, parsers, and fetchers for browsing on-chain zVault activity:
 * - Deposits (StealthAnnouncement with plaintext amounts)
 * - Transfers (StealthAnnouncement with encrypted amounts + NullifierRecords)
 * - Redemptions (RedemptionRequest accounts)
 */

import type { RpcClient } from "./commitment-tree";
import { STEALTH_ANNOUNCEMENT_SIZE } from "./stealth";

// =============================================================================
// Constants
// =============================================================================

/** NullifierRecord account size (88 bytes) */
export const NULLIFIER_RECORD_SIZE = 88;

/** RedemptionRequest account size (118 bytes) */
export const REDEMPTION_REQUEST_SIZE = 118;

/** NullifierRecord discriminator byte */
export const NULLIFIER_RECORD_DISCRIMINATOR = 0x03;

/** RedemptionRequest discriminator byte */
export const REDEMPTION_REQUEST_DISCRIMINATOR = 0x04;

/** Max plausible plaintext amount: 21M BTC in sats */
const MAX_PLAINTEXT_SATS = 21_000_000n * 100_000_000n;

/** Human-readable labels for nullifier operation types */
export const OPERATION_TYPE_LABELS: Record<number, string> = {
  0: "Full Withdrawal",
  1: "Partial Withdrawal",
  2: "Private Transfer",
  3: "Transfer",
  4: "Split",
  5: "Join",
};

// =============================================================================
// Types
// =============================================================================

/** Parsed deposit from a StealthAnnouncement account */
export interface ExplorerDeposit {
  pubkey: string;
  amountSats: bigint;
  commitment: string;
  leafIndex: bigint;
  createdAt: number;
}

/** Transfer event — either a new commitment or a spent nullifier */
export interface ExplorerTransferEvent {
  type: "commitment" | "nullifier";
  pubkey: string;
  timestamp: number;
  commitment?: string;
  leafIndex?: bigint;
  nullifierHash?: string;
  operationType?: string;
  spentBy?: string;
}

/** Parsed redemption request */
export interface ExplorerRedemption {
  pubkey: string;
  requestId: bigint;
  amountSats: bigint;
  status: "Pending" | "Processing" | "Failed";
  requester: string;
  btcScript: string;
}

// =============================================================================
// Helpers
// =============================================================================

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function readU64LE(data: Uint8Array, offset: number): bigint {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(offset, true);
}

function readI64LE(data: Uint8Array, offset: number): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return Number(view.getBigInt64(offset, true));
}

function bs58Encode(bytes: Uint8Array): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let num = 0n;
  for (const byte of bytes) {
    num = num * 256n + BigInt(byte);
  }
  let encoded = "";
  while (num > 0n) {
    const remainder = num % 58n;
    num = num / 58n;
    encoded = ALPHABET[Number(remainder)] + encoded;
  }
  for (const byte of bytes) {
    if (byte === 0) encoded = "1" + encoded;
    else break;
  }
  return encoded || "1";
}

function decodeBase64(b64: string): Uint8Array {
  // Works in both browser (atob) and Node.js (Buffer)
  if (typeof atob === "function") {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

// =============================================================================
// Parsers
// =============================================================================

/** Parse a StealthAnnouncement for explorer display */
function parseAnnouncement(pubkey: string, data: Uint8Array) {
  const amountSats = readU64LE(data, 34);
  return {
    pubkey,
    announcementType: data[1],
    amountSats,
    commitment: toHex(data.slice(42, 74)),
    leafIndex: readU64LE(data, 74),
    createdAt: readI64LE(data, 82),
    isDeposit: amountSats <= MAX_PLAINTEXT_SATS,
  };
}

/** Parse a NullifierRecord account (88 bytes) */
export function parseNullifierRecord(
  pubkey: string,
  data: Uint8Array
): ExplorerTransferEvent {
  return {
    type: "nullifier",
    pubkey,
    timestamp: readI64LE(data, 40),
    nullifierHash: toHex(data.slice(8, 40)),
    operationType: OPERATION_TYPE_LABELS[data[1]] ?? `Unknown(${data[1]})`,
    spentBy: bs58Encode(data.slice(48, 80)),
  };
}

/** Parse a RedemptionRequest account (118 bytes) */
export function parseRedemptionRequest(
  pubkey: string,
  data: Uint8Array
): ExplorerRedemption {
  const statusByte = data[1];
  const status: ExplorerRedemption["status"] =
    statusByte === 1 ? "Processing" : statusByte === 2 ? "Failed" : "Pending";
  const scriptLen = data[2];

  return {
    pubkey,
    requestId: readU64LE(data, 8),
    amountSats: readU64LE(data, 48),
    status,
    requester: bs58Encode(data.slice(16, 48)),
    btcScript: toHex(data.slice(56, 56 + Math.min(scriptLen, 62))),
  };
}

// =============================================================================
// RPC helpers
// =============================================================================

async function fetchAccountsBySize(
  rpc: RpcClient,
  programId: string,
  dataSize: number
): Promise<{ pubkey: string; data: Uint8Array }[]> {
  const accounts = await rpc.getProgramAccounts(programId, {
    filters: [{ dataSize }],
    encoding: "base64",
  });

  return accounts.map((acc) => {
    const raw =
      typeof acc.account.data === "string"
        ? acc.account.data
        : // @solana/kit returns [base64String, "base64"]
          (acc.account.data as unknown as string[])[0];
    return {
      pubkey: String(acc.pubkey),
      data: decodeBase64(raw),
    };
  });
}

// =============================================================================
// Fetchers
// =============================================================================

/** Fetch all deposit StealthAnnouncements (plaintext amounts) */
export async function fetchExplorerDeposits(
  rpc: RpcClient,
  programId: string
): Promise<ExplorerDeposit[]> {
  const accounts = await fetchAccountsBySize(rpc, programId, STEALTH_ANNOUNCEMENT_SIZE);

  return accounts
    .map(({ pubkey, data }) => parseAnnouncement(pubkey, data))
    .filter((a) => a.isDeposit)
    .map(({ pubkey, amountSats, commitment, leafIndex, createdAt }) => ({
      pubkey,
      amountSats,
      commitment,
      leafIndex,
      createdAt,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Fetch all transfer events (encrypted announcements + nullifiers) */
export async function fetchExplorerTransfers(
  rpc: RpcClient,
  programId: string
): Promise<ExplorerTransferEvent[]> {
  const [announcements, nullifiers] = await Promise.all([
    fetchAccountsBySize(rpc, programId, STEALTH_ANNOUNCEMENT_SIZE),
    fetchAccountsBySize(rpc, programId, NULLIFIER_RECORD_SIZE),
  ]);

  const events: ExplorerTransferEvent[] = [];

  for (const { pubkey, data } of announcements) {
    const ann = parseAnnouncement(pubkey, data);
    if (ann.isDeposit) continue;
    events.push({
      type: "commitment",
      pubkey,
      timestamp: ann.createdAt,
      commitment: ann.commitment,
      leafIndex: ann.leafIndex,
    });
  }

  for (const { pubkey, data } of nullifiers) {
    events.push(parseNullifierRecord(pubkey, data));
  }

  return events.sort((a, b) => b.timestamp - a.timestamp);
}

/** Fetch all redemption requests */
export async function fetchExplorerRedemptions(
  rpc: RpcClient,
  programId: string
): Promise<ExplorerRedemption[]> {
  const accounts = await fetchAccountsBySize(rpc, programId, REDEMPTION_REQUEST_SIZE);

  return accounts
    .map(({ pubkey, data }) => parseRedemptionRequest(pubkey, data))
    .sort((a, b) => Number(b.requestId - a.requestId));
}
