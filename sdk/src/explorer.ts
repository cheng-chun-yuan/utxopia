/**
 * Explorer utilities for AEGIS
 *
 * Types, parsers, and fetchers for browsing on-chain Aegis activity:
 * - Deposits (StealthAnnouncement with plaintext amounts)
 * - Transfers (StealthAnnouncement with encrypted amounts + NullifierRecords)
 * - Redemptions (RedemptionRequest accounts)
 */

import type { RpcClient } from "./commitment-tree";
import { STEALTH_ANNOUNCEMENT_SIZE } from "./stealth";

// =============================================================================
// Constants
// =============================================================================

/** NullifierRecord account size (1 byte — slim layout, just discriminator) */
export const NULLIFIER_RECORD_SIZE = 1;

/** RedemptionRequest account size (90 bytes) */
export const REDEMPTION_REQUEST_SIZE = 90;

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
  leafIndex: bigint;
  /** Commitment hex (from indexer events, not on-chain) */
  commitment?: string;
  /** Unix timestamp (from indexer events, not on-chain) */
  createdAt?: number;
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

/** Parse a StealthAnnouncement for explorer display (82B layout) */
function parseAnnouncement(pubkey: string, data: Uint8Array) {
  const amountSats = readU64LE(data, 34);
  return {
    pubkey,
    announcementType: data[1],
    amountSats,
    commitment: toHex(data.slice(42, 74)),
    leafIndex: readU64LE(data, 74),
    isDeposit: data[1] === 0,
  };
}

/** Parse a NullifierRecord account (1 byte — slim layout)
 * Only confirms existence (discriminator = 0x03). Metadata from indexer events. */
export function parseNullifierRecord(
  pubkey: string,
  _data: Uint8Array
): ExplorerTransferEvent {
  return {
    type: "nullifier",
    pubkey,
    timestamp: 0, // metadata available from indexer
  };
}

/** Parse a RedemptionRequest account (90 bytes, raw scriptPubKey) */
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
    btcScript: toHex(data.slice(56, 56 + Math.min(scriptLen, 34))),
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

/** Indexer leaf data for enriching explorer deposits */
export interface IndexerLeaf {
  leaf_index: number;
  commitment: string; // hex
  created_at: number; // unix timestamp
}

/** Fetch all deposit StealthAnnouncements (plaintext amounts) */
export async function fetchExplorerDeposits(
  rpc: RpcClient,
  programId: string,
  indexerLeaves?: IndexerLeaf[]
): Promise<ExplorerDeposit[]> {
  const accounts = await fetchAccountsBySize(rpc, programId, STEALTH_ANNOUNCEMENT_SIZE);

  // Build leaf_index → indexer data map for enrichment
  const leafMap = new Map<number, IndexerLeaf>();
  if (indexerLeaves) {
    for (const leaf of indexerLeaves) {
      leafMap.set(leaf.leaf_index, leaf);
    }
  }

  return accounts
    .map(({ pubkey, data }) => parseAnnouncement(pubkey, data))
    .filter((a) => a.isDeposit)
    .map(({ pubkey, amountSats, leafIndex, commitment }) => {
      const indexerData = leafMap.get(Number(leafIndex));
      return {
        pubkey,
        amountSats,
        leafIndex,
        commitment, // from on-chain account (self-sovereign)
        createdAt: indexerData?.created_at,
      };
    })
    .sort((a, b) => {
      const aHasTime = (a.createdAt ?? 0) > 0;
      const bHasTime = (b.createdAt ?? 0) > 0;
      if (aHasTime && bHasTime) return (b.createdAt ?? 0) - (a.createdAt ?? 0);
      if (aHasTime && !bHasTime) return -1;
      if (!aHasTime && bHasTime) return 1;
      return Number(b.leafIndex - a.leafIndex);
    });
}

/** Fetch all transfer events (encrypted announcements + nullifiers) */
export async function fetchExplorerTransfers(
  rpc: RpcClient,
  programId: string,
  indexerLeaves?: IndexerLeaf[]
): Promise<ExplorerTransferEvent[]> {
  const announcements = await fetchAccountsBySize(rpc, programId, STEALTH_ANNOUNCEMENT_SIZE);

  // Build leaf_index → indexer data map for enrichment
  const leafMap = new Map<number, IndexerLeaf>();
  if (indexerLeaves) {
    for (const leaf of indexerLeaves) {
      leafMap.set(leaf.leaf_index, leaf);
    }
  }

  const events: ExplorerTransferEvent[] = [];

  for (const { pubkey, data } of announcements) {
    const ann = parseAnnouncement(pubkey, data);
    if (ann.isDeposit) continue;
    const indexerData = leafMap.get(Number(ann.leafIndex));
    events.push({
      type: "commitment",
      pubkey,
      timestamp: indexerData?.created_at ?? 0,
      commitment: ann.commitment,
      leafIndex: ann.leafIndex,
    });
  }

  // Sort by timestamp descending (most recent first); if no timestamp, by leafIndex high→low
  events.sort((a, b) => {
    const aHasTime = a.timestamp > 0;
    const bHasTime = b.timestamp > 0;
    if (aHasTime && bHasTime) return b.timestamp - a.timestamp;
    if (aHasTime && !bHasTime) return -1;
    if (!aHasTime && bHasTime) return 1;
    return Number((b.leafIndex ?? 0n) - (a.leafIndex ?? 0n));
  });

  return events;
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
