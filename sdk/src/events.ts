/**
 * Event parser for zVault sol_log_data events
 *
 * Events are emitted by the on-chain program as base64-encoded log data.
 * Transaction logs contain lines like: "Program data: <base64>"
 * Each base64 segment decodes to one slice from sol_log_data.
 */

/** Event discriminators matching contracts/programs/zvault/src/utils/events.rs */
export const EVENT_LEAF_INSERTED = 0x01;
export const EVENT_NULLIFIER_SPENT = 0x02;

/** Parsed leaf inserted event */
export interface LeafInsertedEvent {
  type: "leaf_inserted";
  commitment: Uint8Array; // 32 bytes
  createdAt: number; // unix timestamp
}

/** Parsed nullifier spent event */
export interface NullifierSpentEvent {
  type: "nullifier_spent";
  nullifierHash: Uint8Array; // 32 bytes
  operationType: number;
  spentAt: number; // unix timestamp
  spentBy: Uint8Array; // 32 bytes (pubkey)
}

export type ProgramEvent = LeafInsertedEvent | NullifierSpentEvent;

/**
 * Parse a leaf inserted event from decoded sol_log_data segments.
 * Expected: disc(1) + commitment(32) + created_at(8)
 */
export function parseLeafInsertedEvent(segments: Uint8Array[]): LeafInsertedEvent | null {
  if (segments.length < 3) return null;
  if (segments[0].length !== 1 || segments[0][0] !== EVENT_LEAF_INSERTED) return null;

  const commitment = segments[1];
  if (commitment.length !== 32) return null;

  const tsBytes = segments[2];
  if (tsBytes.length !== 8) return null;
  const view = new DataView(tsBytes.buffer, tsBytes.byteOffset, 8);
  const createdAt = Number(view.getBigInt64(0, true));

  return { type: "leaf_inserted", commitment, createdAt };
}

/**
 * Parse a nullifier spent event from decoded sol_log_data segments.
 * Expected: disc(1) + nullifier_hash(32) + op_type(1) + spent_at(8) + spent_by(32)
 */
export function parseNullifierSpentEvent(segments: Uint8Array[]): NullifierSpentEvent | null {
  if (segments.length < 5) return null;
  if (segments[0].length !== 1 || segments[0][0] !== EVENT_NULLIFIER_SPENT) return null;

  const nullifierHash = segments[1];
  if (nullifierHash.length !== 32) return null;

  const opType = segments[2];
  if (opType.length !== 1) return null;

  const tsBytes = segments[3];
  if (tsBytes.length !== 8) return null;
  const view = new DataView(tsBytes.buffer, tsBytes.byteOffset, 8);
  const spentAt = Number(view.getBigInt64(0, true));

  const spentBy = segments[4];
  if (spentBy.length !== 32) return null;

  return {
    type: "nullifier_spent",
    nullifierHash,
    operationType: opType[0],
    spentAt,
    spentBy,
  };
}

function decodeBase64(b64: string): Uint8Array {
  if (typeof atob === "function") {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/**
 * Parse program events from Solana transaction log messages.
 *
 * sol_log_data emits log lines in the format:
 *   "Program data: <base64_segment1> <base64_segment2> ..."
 *
 * @param logs - Array of log message strings from a transaction
 * @param programId - Optional program ID to filter events (matches "Program <id> invoke" blocks)
 */
export function parseProgramEvents(logs: string[], programId?: string): ProgramEvent[] {
  const events: ProgramEvent[] = [];
  const DATA_PREFIX = "Program data: ";

  for (const line of logs) {
    if (!line.startsWith(DATA_PREFIX)) continue;

    const b64Parts = line.slice(DATA_PREFIX.length).split(" ");
    const segments = b64Parts.map(decodeBase64);

    if (segments.length === 0 || segments[0].length !== 1) continue;

    const disc = segments[0][0];

    if (disc === EVENT_LEAF_INSERTED) {
      const event = parseLeafInsertedEvent(segments);
      if (event) events.push(event);
    } else if (disc === EVENT_NULLIFIER_SPENT) {
      const event = parseNullifierSpentEvent(segments);
      if (event) events.push(event);
    }
  }

  return events;
}
