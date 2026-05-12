/**
 * Explorer utilities for UTXOPIA
 *
 * Types, parsers, and fetchers for browsing on-chain UTXOpia activity:
 * - Deposits (from event indexer)
 * - Transfers (from event indexer)
 * - Redemptions (RedemptionRequest accounts)
 */

import type { RpcClient } from "./commitment-tree";

// =============================================================================
// Constants
// =============================================================================

/** NullifierRecord account size (1 byte — slim layout, just discriminator) */
export const NULLIFIER_RECORD_SIZE = 1;

/** RedemptionRequest account size (98 bytes) */
export const REDEMPTION_REQUEST_SIZE = 98;

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

/** Parsed deposit from indexer event data */
export interface ExplorerDeposit {
  pubkey: string;
  amountSats: bigint;
  leafIndex: bigint;
  /** Commitment hex (from indexer events, not on-chain) */
  commitment?: string;
  /** Unix timestamp (from indexer events, not on-chain) */
  createdAt?: number;
  /** Ephemeral public key hex (from stealth announcement) */
  ephemeralPub?: string;
  /** Solana transaction signature */
  txSignature?: string;
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
  /** Service fee in satoshis, locked at request time */
  serviceFee: bigint;
  status: "Pending" | "Processing" | "Failed";
  requester: string;
  btcScript: string;
  /** Slot when processing started (from PDA data[4..8]) — 0 if still Pending */
  processingSlot: number;
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
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// =============================================================================
// Parsers
// =============================================================================

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

/** Parse a RedemptionRequest account (98 bytes, raw scriptPubKey) */
export function parseRedemptionRequest(
  pubkey: string,
  data: Uint8Array
): ExplorerRedemption {
  const statusByte = data[1];
  const status: ExplorerRedemption["status"] =
    statusByte === 1 ? "Processing" : statusByte === 2 ? "Failed" : "Pending";
  const scriptLen = data[2];
  // data[3] = padding, data[4..8] = processing_slot (u32 LE)
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const processingSlot = view.getUint32(4, true);

  return {
    pubkey,
    requestId: readU64LE(data, 8),
    amountSats: readU64LE(data, 48),
    serviceFee: readU64LE(data, 56),
    status,
    requester: bs58Encode(data.slice(16, 48)),
    btcScript: toHex(data.slice(64, 64 + Math.min(scriptLen, 34))),
    processingSlot,
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
  announcement_type?: number; // 0=deposit, 1=transfer
  amount_sats?: number; // plaintext amount (deposits only)
  ephemeral_pub?: string; // hex (from stealth announcement)
  tx_signature?: string; // Solana tx signature
}

/** Fetch all deposit announcements from indexer data */
export async function fetchExplorerDeposits(
  _rpc: RpcClient,
  _programId: string,
  indexerLeaves?: IndexerLeaf[]
): Promise<ExplorerDeposit[]> {
  if (!indexerLeaves || indexerLeaves.length === 0) return [];

  return indexerLeaves
    .filter((leaf) => leaf.announcement_type === 0) // deposits only
    .map((leaf) => ({
      pubkey: "", // no PDA — data comes from events
      amountSats: BigInt(leaf.amount_sats ?? 0),
      leafIndex: BigInt(leaf.leaf_index),
      commitment: leaf.commitment,
      createdAt: leaf.created_at,
      ephemeralPub: leaf.ephemeral_pub,
      txSignature: leaf.tx_signature,
    }))
    .sort((a, b) => {
      const aHasTime = (a.createdAt ?? 0) > 0;
      const bHasTime = (b.createdAt ?? 0) > 0;
      if (aHasTime && bHasTime) return (b.createdAt ?? 0) - (a.createdAt ?? 0);
      if (aHasTime && !bHasTime) return -1;
      if (!aHasTime && bHasTime) return 1;
      return Number(b.leafIndex - a.leafIndex);
    });
}

/** Fetch all transfer events from indexer data */
export async function fetchExplorerTransfers(
  _rpc: RpcClient,
  _programId: string,
  indexerLeaves?: IndexerLeaf[]
): Promise<ExplorerTransferEvent[]> {
  if (!indexerLeaves || indexerLeaves.length === 0) return [];

  const events: ExplorerTransferEvent[] = [];

  for (const leaf of indexerLeaves) {
    if (leaf.announcement_type === 0) continue; // skip deposits
    events.push({
      type: "commitment",
      pubkey: "",
      timestamp: leaf.created_at ?? 0,
      commitment: leaf.commitment,
      leafIndex: BigInt(leaf.leaf_index),
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
