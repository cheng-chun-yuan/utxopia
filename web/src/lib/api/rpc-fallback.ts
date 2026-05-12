/**
 * RPC Fallback — scan Solana program logs for UTXOpia events
 *
 * Used by explorer API routes when the backend is unreachable.
 * Reconstructs deposit/transfer data from on-chain sol_log_data events.
 */

import { getNetworkConfig } from "../network-config";
import { SOLANA_RPC_FALLBACK_URL } from "./constants";
const UTXOPIA_PROGRAM_ID = getNetworkConfig().solana.privacyCoinProgramId;
const COMMITMENT_TREE_PDA = "CbaDvGVVQqskcu4cz6Fsu3i2q8eWG8GjeqpZiKgPiCaW";

// Rent-exempt minimum for a 1-byte account (NullifierRecord)
const RENT_EXEMPT_1_BYTE = 897840;
const KNOWN_PROGRAMS = new Set([
  "11111111111111111111111111111111",
  "ComputeBudget111111111111111111111111",
  "SysvarC1ock11111111111111111111111111",
]);

// Event discriminators (matching sdk/src/events.ts)
const EVENT_STEALTH_ANNOUNCEMENT = 0x03;

export interface RpcAnnouncement {
  announcementType: number; // 0=deposit, 1=transfer
  ephemeralPub: string;     // hex
  encryptedAmount: string;  // hex (LE u64)
  commitment: string;       // hex
  leafIndex: number;
}

export interface RpcTxMeta {
  signature: string;
  slot: number;
  blockTime: number;
  announcements: RpcAnnouncement[];
  nullifierPdas: string[];
  /** UTXOpia instruction discriminator (1=verify_stealth_deposit, 13=demo, 14=transact, 29=shield) */
  instructionDisc: number | null;
}

function getRpcUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
    process.env.SOLANA_RPC_URL ||
    SOLANA_RPC_FALLBACK_URL
  );
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function parseStealthAnnouncementFromSegments(
  segments: Uint8Array[],
): RpcAnnouncement | null {
  if (segments.length < 6) return null;
  if (segments[0].length !== 1 || segments[0][0] !== EVENT_STEALTH_ANNOUNCEMENT)
    return null;

  const atype = segments[1];
  if (atype.length !== 1) return null;

  const ephemeralPub = segments[2];
  if (ephemeralPub.length !== 32) return null;

  const encryptedAmount = segments[3];
  if (encryptedAmount.length !== 8) return null;

  const commitment = segments[4];
  if (commitment.length !== 32) return null;

  const liBytes = segments[5];
  if (liBytes.length !== 4) return null;
  const view = new DataView(liBytes.buffer, liBytes.byteOffset, 4);
  const leafIndex = view.getUint32(0, true);

  return {
    announcementType: atype[0],
    ephemeralPub: toHex(ephemeralPub),
    encryptedAmount: toHex(encryptedAmount),
    commitment: toHex(commitment),
    leafIndex,
  };
}

function parseAnnouncementsFromLogs(logs: string[]): RpcAnnouncement[] {
  const announcements: RpcAnnouncement[] = [];
  const DATA_PREFIX = "Program data: ";

  for (const line of logs) {
    if (!line.startsWith(DATA_PREFIX)) continue;
    const b64Parts = line.slice(DATA_PREFIX.length).split(" ");
    const segments = b64Parts.map(decodeBase64);
    if (segments.length === 0 || segments[0].length !== 1) continue;

    if (segments[0][0] === EVENT_STEALTH_ANNOUNCEMENT) {
      const ann = parseStealthAnnouncementFromSegments(segments);
      if (ann) announcements.push(ann);
    }
  }
  return announcements;
}

interface RpcTransactionResult {
  transaction?: {
    message?: {
      accountKeys?: Array<string | { pubkey: string }>;
      instructions?: Array<{ programIdIndex: number; data?: string }>;
    };
  };
  meta?: {
    preBalances?: number[];
    postBalances?: number[];
    logMessages?: string[];
  };
  slot?: number;
  blockTime?: number;
}

function extractNullifierPdas(result: RpcTransactionResult): string[] {
  const accountKeys: string[] = (
    result.transaction?.message?.accountKeys ?? []
  ).map((k: string | { pubkey: string }) =>
    typeof k === "string" ? k : k.pubkey,
  );
  const preBalances: number[] = result.meta?.preBalances ?? [];
  const postBalances: number[] = result.meta?.postBalances ?? [];
  const pdas: string[] = [];

  for (let i = 0; i < accountKeys.length; i++) {
    const pre = preBalances[i] ?? 0;
    const post = postBalances[i] ?? 0;
    const key = accountKeys[i];
    if (pre === 0 && post === RENT_EXEMPT_1_BYTE && !KNOWN_PROGRAMS.has(key)) {
      pdas.push(key);
    }
  }
  return pdas;
}

/** Extract the first UTXOpia instruction discriminator from a transaction */
function extractInstructionDisc(result: RpcTransactionResult): number | null {
  try {
    const message = result.transaction?.message;
    const accountKeys: string[] = (message?.accountKeys ?? []).map(
      (k: string | { pubkey: string }) => (typeof k === "string" ? k : k.pubkey),
    );
    const instructions = message?.instructions ?? [];
    for (const ix of instructions) {
      const programIdx = ix.programIdIndex;
      if (accountKeys[programIdx] === UTXOPIA_PROGRAM_ID && ix.data) {
        // Decode base58 instruction data, first byte is discriminator
        const decoded = decodeBase58(ix.data);
        if (decoded.length > 0) return decoded[0];
      }
    }
  } catch {}
  return null;
}

function decodeBase58(str: string): Uint8Array {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes: number[] = [];
  for (const c of str) {
    let carry = ALPHABET.indexOf(c);
    if (carry < 0) return new Uint8Array(0);
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const c of str) {
    if (c !== "1") break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

/**
 * Fetch UTXOpia program transactions from RPC and parse events.
 * Returns transaction metadata with parsed stealth announcements.
 */
export async function fetchAnnouncementsFromRpc(
  announcementTypeFilter?: number,
): Promise<RpcTxMeta[]> {
  const rpcUrl = getRpcUrl();

  // 1. Get recent signatures for the commitment tree PDA
  const sigsResp = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getSignaturesForAddress",
      params: [COMMITMENT_TREE_PDA, { limit: 200, commitment: "confirmed" }],
    }),
    signal: AbortSignal.timeout(15000),
  });

  const sigsJson = await sigsResp.json();
  const signatures: { signature: string; slot: number; blockTime: number | null }[] =
    sigsJson.result ?? [];

  if (signatures.length === 0) return [];

  // 2. Batch getTransaction (10 at a time)
  const results: RpcTxMeta[] = [];

  for (let i = 0; i < signatures.length; i += 10) {
    const batch = signatures.slice(i, i + 10);
    const batchRequests = batch.map((sig, idx) => ({
      jsonrpc: "2.0",
      id: idx,
      method: "getTransaction",
      params: [
        sig.signature,
        { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
      ],
    }));

    const txResp = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batchRequests),
      signal: AbortSignal.timeout(30000),
    });

    const txResultsRaw = await txResp.json();
    const txResults: Array<{ id: number; result?: RpcTransactionResult }> = Array.isArray(txResultsRaw) ? txResultsRaw : [txResultsRaw];
    // Sort by id to match batch order
    txResults.sort((a, b) => a.id - b.id);

    for (let j = 0; j < batch.length; j++) {
      const sig = batch[j];
      const txResult = txResults[j]?.result;
      if (!txResult) continue;

      const logs: string[] = txResult.meta?.logMessages ?? [];
      const announcements = parseAnnouncementsFromLogs(logs);

      // Filter by announcement type if specified
      const filtered =
        announcementTypeFilter !== undefined
          ? announcements.filter((a) => a.announcementType === announcementTypeFilter)
          : announcements;

      if (filtered.length === 0) continue;

      const nullifierPdas = extractNullifierPdas(txResult);
      const instructionDisc = extractInstructionDisc(txResult);

      results.push({
        signature: sig.signature,
        slot: txResult.slot ?? sig.slot,
        blockTime: txResult.blockTime ?? sig.blockTime ?? 0,
        announcements: filtered,
        nullifierPdas,
        instructionDisc,
      });
    }
  }

  return results;
}
