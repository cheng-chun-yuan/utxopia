/**
 * Event parser for Aegis sol_log_data events
 *
 * Events are emitted by the on-chain program as base64-encoded log data.
 * Transaction logs contain lines like: "Program data: <base64>"
 * Each base64 segment decodes to one slice from sol_log_data.
 */

/** Event discriminators matching contracts/programs/aegis/src/utils/events.rs */
export const EVENT_LEAF_INSERTED = 0x01;
export const EVENT_NULLIFIER_SPENT = 0x02;
export const EVENT_STEALTH_ANNOUNCEMENT = 0x03;
export const EVENT_POOL_UPDATE_PROPOSED = 0x04;
export const EVENT_POOL_UPDATE_EXECUTED = 0x05;
export const EVENT_POOL_UPDATE_CANCELLED = 0x06;

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

/** Parsed stealth announcement event */
export interface StealthAnnouncementEvent {
  type: "stealth_announcement";
  announcementType: number; // 0=deposit, 1=transfer
  ephemeralPub: Uint8Array; // 32 bytes
  encryptedAmount: Uint8Array; // 8 bytes
  commitment: Uint8Array; // 32 bytes
  leafIndex: number;
}

/** Parsed pool update proposed event */
export interface PoolUpdateProposedEvent {
  type: "pool_update_proposed";
  minDeposit: bigint;
  maxDeposit: bigint;
  serviceFee: bigint;
  executeAfter: number; // unix timestamp
}

/** Parsed pool update executed event */
export interface PoolUpdateExecutedEvent {
  type: "pool_update_executed";
  minDeposit: bigint;
  maxDeposit: bigint;
  serviceFee: bigint;
}

/** Parsed pool update cancelled event */
export interface PoolUpdateCancelledEvent {
  type: "pool_update_cancelled";
}

export type ProgramEvent =
  | LeafInsertedEvent
  | NullifierSpentEvent
  | StealthAnnouncementEvent
  | PoolUpdateProposedEvent
  | PoolUpdateExecutedEvent
  | PoolUpdateCancelledEvent;

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

/**
 * Parse a stealth announcement event from decoded sol_log_data segments.
 * Expected: disc(1) + type(1) + ephemeral_pub(32) + encrypted_amount(8) + commitment(32) + leaf_index(4)
 */
export function parseStealthAnnouncementEvent(segments: Uint8Array[]): StealthAnnouncementEvent | null {
  if (segments.length < 6) return null;
  if (segments[0].length !== 1 || segments[0][0] !== EVENT_STEALTH_ANNOUNCEMENT) return null;

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
    type: "stealth_announcement",
    announcementType: atype[0],
    ephemeralPub,
    encryptedAmount,
    commitment,
    leafIndex,
  };
}

/**
 * Parse a pool update proposed event from decoded sol_log_data segments.
 * Expected: disc(1) + min_deposit(8) + max_deposit(8) + service_fee(8) + execute_after(8)
 */
export function parsePoolUpdateProposedEvent(segments: Uint8Array[]): PoolUpdateProposedEvent | null {
  if (segments.length < 5) return null;
  if (segments[0].length !== 1 || segments[0][0] !== EVENT_POOL_UPDATE_PROPOSED) return null;

  if (segments[1].length !== 8 || segments[2].length !== 8 || segments[3].length !== 8 || segments[4].length !== 8) return null;

  const minView = new DataView(segments[1].buffer, segments[1].byteOffset, 8);
  const maxView = new DataView(segments[2].buffer, segments[2].byteOffset, 8);
  const feeView = new DataView(segments[3].buffer, segments[3].byteOffset, 8);
  const tsView = new DataView(segments[4].buffer, segments[4].byteOffset, 8);

  return {
    type: "pool_update_proposed",
    minDeposit: minView.getBigUint64(0, true),
    maxDeposit: maxView.getBigUint64(0, true),
    serviceFee: feeView.getBigUint64(0, true),
    executeAfter: Number(tsView.getBigInt64(0, true)),
  };
}

/**
 * Parse a pool update executed event from decoded sol_log_data segments.
 * Expected: disc(1) + min_deposit(8) + max_deposit(8) + service_fee(8)
 */
export function parsePoolUpdateExecutedEvent(segments: Uint8Array[]): PoolUpdateExecutedEvent | null {
  if (segments.length < 4) return null;
  if (segments[0].length !== 1 || segments[0][0] !== EVENT_POOL_UPDATE_EXECUTED) return null;

  if (segments[1].length !== 8 || segments[2].length !== 8 || segments[3].length !== 8) return null;

  const minView = new DataView(segments[1].buffer, segments[1].byteOffset, 8);
  const maxView = new DataView(segments[2].buffer, segments[2].byteOffset, 8);
  const feeView = new DataView(segments[3].buffer, segments[3].byteOffset, 8);

  return {
    type: "pool_update_executed",
    minDeposit: minView.getBigUint64(0, true),
    maxDeposit: maxView.getBigUint64(0, true),
    serviceFee: feeView.getBigUint64(0, true),
  };
}

/**
 * Parse a pool update cancelled event from decoded sol_log_data segments.
 * Expected: disc(1)
 */
export function parsePoolUpdateCancelledEvent(segments: Uint8Array[]): PoolUpdateCancelledEvent | null {
  if (segments.length < 1) return null;
  if (segments[0].length !== 1 || segments[0][0] !== EVENT_POOL_UPDATE_CANCELLED) return null;

  return { type: "pool_update_cancelled" };
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
    } else if (disc === EVENT_STEALTH_ANNOUNCEMENT) {
      const event = parseStealthAnnouncementEvent(segments);
      if (event) events.push(event);
    } else if (disc === EVENT_POOL_UPDATE_PROPOSED) {
      const event = parsePoolUpdateProposedEvent(segments);
      if (event) events.push(event);
    } else if (disc === EVENT_POOL_UPDATE_EXECUTED) {
      const event = parsePoolUpdateExecutedEvent(segments);
      if (event) events.push(event);
    } else if (disc === EVENT_POOL_UPDATE_CANCELLED) {
      const event = parsePoolUpdateCancelledEvent(segments);
      if (event) events.push(event);
    }
  }

  return events;
}
