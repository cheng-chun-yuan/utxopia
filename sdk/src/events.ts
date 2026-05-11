/**
 * Event parser for Privacy Coin sol_log_data events
 *
 * Events are emitted by the on-chain program as base64-encoded log data.
 * Transaction logs contain lines like: "Program data: <base64>"
 * Each base64 segment decodes to one slice from sol_log_data.
 *
 * ## Events
 *
 * - 0x02 NullifierSpent: disc(1) + hash(32) + op_type(1) = 34 bytes
 * - 0x03 StealthAnnouncement: disc(1) + type(1) + ephemeral(32) + amount(8) + commitment(32) + leaf_index(4) = 78 bytes
 * - 0x0B NullifiersBatch: flat payload in single segment
 * - 0x0C AnnouncementsBatch: flat payload in single segment
 */

/** Event discriminators matching contracts/programs/privacy-coin/src/utils/events.rs */
export const EVENT_NULLIFIER_SPENT = 0x02;
export const EVENT_STEALTH_ANNOUNCEMENT = 0x03;
export const EVENT_NULLIFIERS_BATCH = 0x0b;
export const EVENT_ANNOUNCEMENTS_BATCH = 0x0c;

/** Parsed nullifier spent event */
export interface NullifierSpentEvent {
  type: "nullifier_spent";
  nullifierHash: Uint8Array; // 32 bytes
  operationType: number;
}

/** Parsed stealth announcement event (includes token_id) */
export interface StealthAnnouncementEvent {
  type: "stealth_announcement";
  announcementType: number; // 0=deposit, 1=transfer
  ephemeralPub: Uint8Array; // 32 bytes
  encryptedAmount: Uint8Array; // 8 bytes
  commitment: Uint8Array; // 32 bytes
  leafIndex: number;
  tokenId?: Uint8Array; // 32 bytes (present for deposit/unshield, zero for private transfers)
}

export type ProgramEvent =
  | NullifierSpentEvent
  | StealthAnnouncementEvent;

/**
 * Parse a nullifier spent event from decoded sol_log_data segments.
 * Expected: disc(1) + nullifier_hash(32) + op_type(1)
 */
export function parseNullifierSpentEvent(segments: Uint8Array[]): NullifierSpentEvent | null {
  if (segments.length < 3) return null;
  if (segments[0].length !== 1 || segments[0][0] !== EVENT_NULLIFIER_SPENT) return null;

  const nullifierHash = segments[1];
  if (nullifierHash.length !== 32) return null;

  const opType = segments[2];
  if (opType.length !== 1) return null;

  return {
    type: "nullifier_spent",
    nullifierHash,
    operationType: opType[0],
  };
}

/**
 * Parse a stealth announcement event from decoded sol_log_data segments.
 * v1: disc(1) + type(1) + ephemeral_pub(32) + encrypted_amount(8) + commitment(32) + leaf_index(4) = 6 segments
 * v2: + token_id(32) = 7 segments
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

  // v2: token_id at segment 6
  let tokenId: Uint8Array | undefined;
  if (segments.length >= 7 && segments[6].length === 32) {
    tokenId = segments[6];
  }

  return {
    type: "stealth_announcement",
    announcementType: atype[0],
    ephemeralPub,
    encryptedAmount,
    commitment,
    leafIndex,
    tokenId,
  };
}

/**
 * Parse batched nullifiers from a single flat segment.
 * Layout: disc(1) + count(1) + op_type(1) + [hash(32)] x count
 */
function parseNullifiersBatch(data: Uint8Array): NullifierSpentEvent[] {
  if (data.length < 3) return [];
  const count = data[1];
  const opType = data[2];
  const expectedLen = 3 + count * 32;
  if (data.length < expectedLen) return [];

  const events: NullifierSpentEvent[] = [];
  for (let i = 0; i < count; i++) {
    const offset = 3 + i * 32;
    events.push({
      type: "nullifier_spent",
      nullifierHash: data.slice(offset, offset + 32),
      operationType: opType,
    });
  }
  return events;
}

/**
 * Parse batched announcements from a single flat segment.
 * v1: disc(1) + count(1) + [type(1) + ephemeral(32) + amount(8) + commitment(32) + leaf_index(4)] x count (77 per item)
 * v2: disc(1) + count(1) + [type(1) + ephemeral(32) + amount(8) + commitment(32) + leaf_index(4) + token_id(32)] x count (109 per item)
 */
function parseAnnouncementsBatch(data: Uint8Array): StealthAnnouncementEvent[] {
  if (data.length < 2) return [];
  const count = data[1];
  if (count === 0) return [];

  // Detect v1 vs v2 by checking total size
  const remainingBytes = data.length - 2;
  const v2ItemSize = 109;
  const v1ItemSize = 77;
  const isV2 = remainingBytes >= count * v2ItemSize;
  const itemSize = isV2 ? v2ItemSize : v1ItemSize;

  const expectedLen = 2 + count * itemSize;
  if (data.length < expectedLen) return [];

  const events: StealthAnnouncementEvent[] = [];
  for (let i = 0; i < count; i++) {
    const offset = 2 + i * itemSize;
    const liView = new DataView(data.buffer, data.byteOffset + offset + 73, 4);
    const event: StealthAnnouncementEvent = {
      type: "stealth_announcement",
      announcementType: data[offset],
      ephemeralPub: data.slice(offset + 1, offset + 33),
      encryptedAmount: data.slice(offset + 33, offset + 41),
      commitment: data.slice(offset + 41, offset + 73),
      leafIndex: liView.getUint32(0, true),
    };
    if (isV2) {
      event.tokenId = data.slice(offset + 77, offset + 109);
    }
    events.push(event);
  }
  return events;
}

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
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

    if (segments.length === 0) continue;

    // Handle batch events (single flat segment)
    if (segments.length === 1 && segments[0].length > 1) {
      const disc = segments[0][0];
      if (disc === EVENT_NULLIFIERS_BATCH) {
        events.push(...parseNullifiersBatch(segments[0]));
        continue;
      }
      if (disc === EVENT_ANNOUNCEMENTS_BATCH) {
        events.push(...parseAnnouncementsBatch(segments[0]));
        continue;
      }
    }

    if (segments[0].length !== 1) continue;

    const disc = segments[0][0];

    if (disc === EVENT_NULLIFIER_SPENT) {
      const event = parseNullifierSpentEvent(segments);
      if (event) events.push(event);
    } else if (disc === EVENT_STEALTH_ANNOUNCEMENT) {
      const event = parseStealthAnnouncementEvent(segments);
      if (event) events.push(event);
    }
  }

  return events;
}
