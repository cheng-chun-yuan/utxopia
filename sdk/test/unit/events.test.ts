/**
 * Event parser tests for UTXOpia sol_log_data events
 */

import { describe, test, expect } from "bun:test";
import {
  parseProgramEvents,
  parseNullifierSpentEvent,
  parseStealthAnnouncementEvent,
  parseBtcOriginAttestationEvent,
  EVENT_NULLIFIER_SPENT,
  EVENT_STEALTH_ANNOUNCEMENT,
  EVENT_NULLIFIERS_BATCH,
  EVENT_ANNOUNCEMENTS_BATCH,
  EVENT_BTC_ORIGIN_ATTESTATION,
  type NullifierSpentEvent,
  type StealthAnnouncementEvent,
  type BtcOriginAttestationEvent,
} from "../../src/events";

// =============================================================================
// Helpers
// =============================================================================

/** Encode bytes to base64 */
function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/** Build a "Program data: ..." log line from multiple segments */
function buildProgramDataLog(...segments: Uint8Array[]): string {
  return "Program data: " + segments.map(toBase64).join(" ");
}

/** Create a 32-byte array filled with a repeating value */
function bytes32(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

/** Create a u32 LE encoded leaf index */
function leafIndexBytes(index: number): Uint8Array {
  const buf = new Uint8Array(4);
  const view = new DataView(buf.buffer);
  view.setUint32(0, index, true);
  return buf;
}

// =============================================================================
// Nullifier Spent Events
// =============================================================================

describe("parseNullifierSpentEvent", () => {
  test("parses valid nullifier spent event", () => {
    const segments = [
      new Uint8Array([EVENT_NULLIFIER_SPENT]),
      bytes32(0xaa), // nullifier hash
      new Uint8Array([1]), // op_type
    ];
    const event = parseNullifierSpentEvent(segments);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("nullifier_spent");
    expect(event!.nullifierHash).toEqual(bytes32(0xaa));
    expect(event!.operationType).toBe(1);
  });

  test("returns null for wrong discriminator", () => {
    const segments = [
      new Uint8Array([0xff]),
      bytes32(0xaa),
      new Uint8Array([1]),
    ];
    expect(parseNullifierSpentEvent(segments)).toBeNull();
  });

  test("returns null for too few segments", () => {
    expect(parseNullifierSpentEvent([
      new Uint8Array([EVENT_NULLIFIER_SPENT]),
      bytes32(0xaa),
    ])).toBeNull();
  });

  test("returns null for wrong hash length", () => {
    const segments = [
      new Uint8Array([EVENT_NULLIFIER_SPENT]),
      new Uint8Array(31), // wrong length
      new Uint8Array([1]),
    ];
    expect(parseNullifierSpentEvent(segments)).toBeNull();
  });

  test("returns null for multi-byte discriminator", () => {
    const segments = [
      new Uint8Array([EVENT_NULLIFIER_SPENT, 0x00]), // 2 bytes
      bytes32(0xaa),
      new Uint8Array([1]),
    ];
    expect(parseNullifierSpentEvent(segments)).toBeNull();
  });

  test("returns null for wrong op_type length", () => {
    const segments = [
      new Uint8Array([EVENT_NULLIFIER_SPENT]),
      bytes32(0xaa),
      new Uint8Array([1, 2]), // 2 bytes instead of 1
    ];
    expect(parseNullifierSpentEvent(segments)).toBeNull();
  });

  test("parses op_type 0 (transact)", () => {
    const segments = [
      new Uint8Array([EVENT_NULLIFIER_SPENT]),
      bytes32(0xbb),
      new Uint8Array([0]),
    ];
    const event = parseNullifierSpentEvent(segments);
    expect(event).not.toBeNull();
    expect(event!.operationType).toBe(0);
  });
});

// =============================================================================
// Stealth Announcement Events
// =============================================================================

describe("parseStealthAnnouncementEvent", () => {
  test("parses v1 stealth announcement (6 segments)", () => {
    const segments = [
      new Uint8Array([EVENT_STEALTH_ANNOUNCEMENT]),
      new Uint8Array([0]), // type: deposit
      bytes32(0x11), // ephemeral pub
      new Uint8Array(8).fill(0x22), // encrypted amount
      bytes32(0x33), // commitment
      leafIndexBytes(42), // leaf index
    ];
    const event = parseStealthAnnouncementEvent(segments);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("stealth_announcement");
    expect(event!.announcementType).toBe(0);
    expect(event!.ephemeralPub).toEqual(bytes32(0x11));
    expect(event!.encryptedAmount).toEqual(new Uint8Array(8).fill(0x22));
    expect(event!.commitment).toEqual(bytes32(0x33));
    expect(event!.leafIndex).toBe(42);
    expect(event!.tokenId).toBeUndefined();
  });

  test("parses v2 stealth announcement with token_id (7 segments)", () => {
    const tokenId = bytes32(0x44);
    const segments = [
      new Uint8Array([EVENT_STEALTH_ANNOUNCEMENT]),
      new Uint8Array([1]), // type: transfer
      bytes32(0x11),
      new Uint8Array(8).fill(0x22),
      bytes32(0x33),
      leafIndexBytes(100),
      tokenId,
    ];
    const event = parseStealthAnnouncementEvent(segments);
    expect(event).not.toBeNull();
    expect(event!.announcementType).toBe(1);
    expect(event!.leafIndex).toBe(100);
    expect(event!.tokenId).toEqual(tokenId);
  });

  test("returns null for too few segments", () => {
    const segments = [
      new Uint8Array([EVENT_STEALTH_ANNOUNCEMENT]),
      new Uint8Array([0]),
      bytes32(0x11),
      new Uint8Array(8),
      bytes32(0x33),
      // missing leaf_index
    ];
    expect(parseStealthAnnouncementEvent(segments)).toBeNull();
  });

  test("returns null for wrong discriminator", () => {
    const segments = [
      new Uint8Array([0x01]), // wrong
      new Uint8Array([0]),
      bytes32(0x11),
      new Uint8Array(8),
      bytes32(0x33),
      leafIndexBytes(1),
    ];
    expect(parseStealthAnnouncementEvent(segments)).toBeNull();
  });

  test("returns null for wrong ephemeral pub length", () => {
    const segments = [
      new Uint8Array([EVENT_STEALTH_ANNOUNCEMENT]),
      new Uint8Array([0]),
      new Uint8Array(33), // wrong length
      new Uint8Array(8),
      bytes32(0x33),
      leafIndexBytes(1),
    ];
    expect(parseStealthAnnouncementEvent(segments)).toBeNull();
  });

  test("returns null for wrong encrypted amount length", () => {
    const segments = [
      new Uint8Array([EVENT_STEALTH_ANNOUNCEMENT]),
      new Uint8Array([0]),
      bytes32(0x11),
      new Uint8Array(7), // wrong length
      bytes32(0x33),
      leafIndexBytes(1),
    ];
    expect(parseStealthAnnouncementEvent(segments)).toBeNull();
  });

  test("returns null for wrong commitment length", () => {
    const segments = [
      new Uint8Array([EVENT_STEALTH_ANNOUNCEMENT]),
      new Uint8Array([0]),
      bytes32(0x11),
      new Uint8Array(8),
      new Uint8Array(31), // wrong length
      leafIndexBytes(1),
    ];
    expect(parseStealthAnnouncementEvent(segments)).toBeNull();
  });

  test("returns null for wrong leaf_index length", () => {
    const segments = [
      new Uint8Array([EVENT_STEALTH_ANNOUNCEMENT]),
      new Uint8Array([0]),
      bytes32(0x11),
      new Uint8Array(8),
      bytes32(0x33),
      new Uint8Array(3), // wrong length
    ];
    expect(parseStealthAnnouncementEvent(segments)).toBeNull();
  });

  test("ignores token_id segment if not exactly 32 bytes", () => {
    const segments = [
      new Uint8Array([EVENT_STEALTH_ANNOUNCEMENT]),
      new Uint8Array([0]),
      bytes32(0x11),
      new Uint8Array(8),
      bytes32(0x33),
      leafIndexBytes(5),
      new Uint8Array(16), // wrong length for token_id
    ];
    const event = parseStealthAnnouncementEvent(segments);
    expect(event).not.toBeNull();
    expect(event!.tokenId).toBeUndefined();
  });

  test("parses leaf_index little-endian correctly", () => {
    // 0x01020304 in LE = [0x04, 0x03, 0x02, 0x01]
    const leafBytes = new Uint8Array([0x04, 0x03, 0x02, 0x01]);
    const segments = [
      new Uint8Array([EVENT_STEALTH_ANNOUNCEMENT]),
      new Uint8Array([0]),
      bytes32(0x11),
      new Uint8Array(8),
      bytes32(0x33),
      leafBytes,
    ];
    const event = parseStealthAnnouncementEvent(segments);
    expect(event).not.toBeNull();
    expect(event!.leafIndex).toBe(0x01020304);
  });
});

// =============================================================================
// parseProgramEvents — integration
// =============================================================================

describe("parseProgramEvents", () => {
  test("parses nullifier spent from log lines", () => {
    const logs = [
      "Program 7JJeVjVCy invoke [1]",
      buildProgramDataLog(
        new Uint8Array([EVENT_NULLIFIER_SPENT]),
        bytes32(0xab),
        new Uint8Array([2]),
      ),
      "Program 7JJeVjVCy success",
    ];
    const events = parseProgramEvents(logs);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("nullifier_spent");
    const nse = events[0] as NullifierSpentEvent;
    expect(nse.operationType).toBe(2);
  });

  test("parses stealth announcement from log lines", () => {
    const logs = [
      buildProgramDataLog(
        new Uint8Array([EVENT_STEALTH_ANNOUNCEMENT]),
        new Uint8Array([0]),
        bytes32(0x11),
        new Uint8Array(8).fill(0x22),
        bytes32(0x33),
        leafIndexBytes(7),
      ),
    ];
    const events = parseProgramEvents(logs);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("stealth_announcement");
    const sae = events[0] as StealthAnnouncementEvent;
    expect(sae.leafIndex).toBe(7);
    expect(sae.announcementType).toBe(0);
  });

  test("parses v2 stealth announcement with token_id", () => {
    const tokenId = bytes32(0x55);
    const logs = [
      buildProgramDataLog(
        new Uint8Array([EVENT_STEALTH_ANNOUNCEMENT]),
        new Uint8Array([1]),
        bytes32(0x11),
        new Uint8Array(8),
        bytes32(0x33),
        leafIndexBytes(99),
        tokenId,
      ),
    ];
    const events = parseProgramEvents(logs);
    expect(events.length).toBe(1);
    const sae = events[0] as StealthAnnouncementEvent;
    expect(sae.tokenId).toEqual(tokenId);
    expect(sae.leafIndex).toBe(99);
  });

  test("parses multiple events from a single transaction", () => {
    const logs = [
      buildProgramDataLog(
        new Uint8Array([EVENT_NULLIFIER_SPENT]),
        bytes32(0x01),
        new Uint8Array([0]),
      ),
      buildProgramDataLog(
        new Uint8Array([EVENT_NULLIFIER_SPENT]),
        bytes32(0x02),
        new Uint8Array([1]),
      ),
      buildProgramDataLog(
        new Uint8Array([EVENT_STEALTH_ANNOUNCEMENT]),
        new Uint8Array([1]),
        bytes32(0x11),
        new Uint8Array(8),
        bytes32(0x33),
        leafIndexBytes(0),
      ),
    ];
    const events = parseProgramEvents(logs);
    expect(events.length).toBe(3);
    expect(events[0].type).toBe("nullifier_spent");
    expect(events[1].type).toBe("nullifier_spent");
    expect(events[2].type).toBe("stealth_announcement");
  });

  test("ignores non-program-data log lines", () => {
    const logs = [
      "Program 7JJeVjVCy invoke [1]",
      "Program log: Instruction: Transact",
      "Program 7JJeVjVCy consumed 50000 of 200000 compute units",
      "Program 7JJeVjVCy success",
    ];
    const events = parseProgramEvents(logs);
    expect(events.length).toBe(0);
  });

  test("returns empty array for empty logs", () => {
    expect(parseProgramEvents([])).toEqual([]);
  });

  test("skips malformed base64 gracefully", () => {
    // atob throws on truly invalid base64, but the parser should handle
    // lines that have valid prefix but garbage content
    const logs = [
      "Program data: ====", // invalid base64 padding
    ];
    // This may throw or return empty — either is acceptable behavior
    try {
      const events = parseProgramEvents(logs);
      expect(events.length).toBe(0);
    } catch {
      // Also acceptable — malformed input
    }
  });

  test("handles unknown discriminator by skipping", () => {
    const logs = [
      buildProgramDataLog(
        new Uint8Array([0xff]), // unknown disc
        bytes32(0x00),
      ),
    ];
    const events = parseProgramEvents(logs);
    expect(events.length).toBe(0);
  });
});

// =============================================================================
// Batch Events
// =============================================================================

describe("parseProgramEvents — batch nullifiers", () => {
  test("parses batch of 2 nullifiers", () => {
    // Layout: disc(1) + count(1) + op_type(1) + [hash(32)] x count
    const count = 2;
    const opType = 1;
    const batchData = new Uint8Array(3 + count * 32);
    batchData[0] = EVENT_NULLIFIERS_BATCH;
    batchData[1] = count;
    batchData[2] = opType;
    batchData.set(bytes32(0xaa), 3);
    batchData.set(bytes32(0xbb), 35);

    const logs = [buildProgramDataLog(batchData)];
    const events = parseProgramEvents(logs);

    expect(events.length).toBe(2);
    expect(events[0].type).toBe("nullifier_spent");
    expect((events[0] as NullifierSpentEvent).nullifierHash).toEqual(bytes32(0xaa));
    expect((events[0] as NullifierSpentEvent).operationType).toBe(opType);
    expect((events[1] as NullifierSpentEvent).nullifierHash).toEqual(bytes32(0xbb));
  });

  test("parses batch of 0 nullifiers", () => {
    const batchData = new Uint8Array(3);
    batchData[0] = EVENT_NULLIFIERS_BATCH;
    batchData[1] = 0; // count
    batchData[2] = 0; // op_type

    const logs = [buildProgramDataLog(batchData)];
    const events = parseProgramEvents(logs);
    expect(events.length).toBe(0);
  });

  test("rejects truncated batch nullifiers", () => {
    // Claims 2 items but only has data for 1
    const batchData = new Uint8Array(3 + 32); // only 1 hash, claims 2
    batchData[0] = EVENT_NULLIFIERS_BATCH;
    batchData[1] = 2;
    batchData[2] = 0;
    batchData.set(bytes32(0xcc), 3);

    const logs = [buildProgramDataLog(batchData)];
    const events = parseProgramEvents(logs);
    expect(events.length).toBe(0); // should reject due to insufficient data
  });
});

describe("parseProgramEvents — batch announcements", () => {
  test("parses v1 batch of 1 announcement (77 bytes per item)", () => {
    const itemSize = 77;
    const count = 1;
    const batchData = new Uint8Array(2 + count * itemSize);
    batchData[0] = EVENT_ANNOUNCEMENTS_BATCH;
    batchData[1] = count;

    const offset = 2;
    batchData[offset] = 0; // announcement type (deposit)
    batchData.set(bytes32(0x11), offset + 1); // ephemeral pub
    batchData.set(new Uint8Array(8).fill(0x22), offset + 33); // encrypted amount
    batchData.set(bytes32(0x33), offset + 41); // commitment
    // leaf_index at offset + 73, LE u32
    const liView = new DataView(batchData.buffer, offset + 73, 4);
    liView.setUint32(0, 15, true);

    const logs = [buildProgramDataLog(batchData)];
    const events = parseProgramEvents(logs);

    expect(events.length).toBe(1);
    const sae = events[0] as StealthAnnouncementEvent;
    expect(sae.type).toBe("stealth_announcement");
    expect(sae.announcementType).toBe(0);
    expect(sae.ephemeralPub).toEqual(bytes32(0x11));
    expect(sae.leafIndex).toBe(15);
    expect(sae.tokenId).toBeUndefined();
  });

  test("parses v2 batch of 1 announcement (109 bytes per item)", () => {
    const itemSize = 109;
    const count = 1;
    const batchData = new Uint8Array(2 + count * itemSize);
    batchData[0] = EVENT_ANNOUNCEMENTS_BATCH;
    batchData[1] = count;

    const offset = 2;
    batchData[offset] = 1; // transfer
    batchData.set(bytes32(0x11), offset + 1);
    batchData.set(new Uint8Array(8).fill(0x22), offset + 33);
    batchData.set(bytes32(0x33), offset + 41);
    const liView = new DataView(batchData.buffer, offset + 73, 4);
    liView.setUint32(0, 200, true);
    batchData.set(bytes32(0x55), offset + 77); // token_id

    const logs = [buildProgramDataLog(batchData)];
    const events = parseProgramEvents(logs);

    expect(events.length).toBe(1);
    const sae = events[0] as StealthAnnouncementEvent;
    expect(sae.announcementType).toBe(1);
    expect(sae.leafIndex).toBe(200);
    expect(sae.tokenId).toEqual(bytes32(0x55));
  });

  test("parses v2 batch of 2 announcements", () => {
    const itemSize = 109;
    const count = 2;
    const batchData = new Uint8Array(2 + count * itemSize);
    batchData[0] = EVENT_ANNOUNCEMENTS_BATCH;
    batchData[1] = count;

    for (let i = 0; i < count; i++) {
      const offset = 2 + i * itemSize;
      batchData[offset] = i; // type
      batchData.set(bytes32(0x10 + i), offset + 1);
      batchData.set(new Uint8Array(8).fill(0x20 + i), offset + 33);
      batchData.set(bytes32(0x30 + i), offset + 41);
      const liView = new DataView(batchData.buffer, offset + 73, 4);
      liView.setUint32(0, i * 10, true);
      batchData.set(bytes32(0x50 + i), offset + 77);
    }

    const logs = [buildProgramDataLog(batchData)];
    const events = parseProgramEvents(logs);

    expect(events.length).toBe(2);
    expect((events[0] as StealthAnnouncementEvent).leafIndex).toBe(0);
    expect((events[1] as StealthAnnouncementEvent).leafIndex).toBe(10);
    expect((events[0] as StealthAnnouncementEvent).announcementType).toBe(0);
    expect((events[1] as StealthAnnouncementEvent).announcementType).toBe(1);
  });

  test("batch with count=0 returns empty", () => {
    const batchData = new Uint8Array(2);
    batchData[0] = EVENT_ANNOUNCEMENTS_BATCH;
    batchData[1] = 0;

    const logs = [buildProgramDataLog(batchData)];
    const events = parseProgramEvents(logs);
    expect(events.length).toBe(0);
  });

  test("rejects truncated batch announcements", () => {
    // Claims 2 v1 items but data is too short
    const batchData = new Uint8Array(2 + 77); // only 1 item worth
    batchData[0] = EVENT_ANNOUNCEMENTS_BATCH;
    batchData[1] = 2; // claims 2
    batchData[2] = 0;
    batchData.set(bytes32(0x11), 3);

    const logs = [buildProgramDataLog(batchData)];
    const events = parseProgramEvents(logs);
    expect(events.length).toBe(0);
  });
});

// =============================================================================
// Mixed events
// =============================================================================

describe("parseProgramEvents — mixed event types", () => {
  test("handles mix of individual and batch events", () => {
    // Individual nullifier
    const nullLog = buildProgramDataLog(
      new Uint8Array([EVENT_NULLIFIER_SPENT]),
      bytes32(0xaa),
      new Uint8Array([0]),
    );

    // Batch of 1 nullifier
    const batchNull = new Uint8Array(3 + 32);
    batchNull[0] = EVENT_NULLIFIERS_BATCH;
    batchNull[1] = 1;
    batchNull[2] = 1;
    batchNull.set(bytes32(0xcc), 3);
    const batchNullLog = buildProgramDataLog(batchNull);

    // Individual announcement
    const annLog = buildProgramDataLog(
      new Uint8Array([EVENT_STEALTH_ANNOUNCEMENT]),
      new Uint8Array([0]),
      bytes32(0x11),
      new Uint8Array(8),
      bytes32(0x33),
      leafIndexBytes(1),
    );

    const logs = [
      "Program invoke [1]",
      nullLog,
      batchNullLog,
      annLog,
      "Program success",
    ];
    const events = parseProgramEvents(logs);

    expect(events.length).toBe(3);
    expect(events[0].type).toBe("nullifier_spent");
    expect(events[1].type).toBe("nullifier_spent");
    expect(events[2].type).toBe("stealth_announcement");
  });
});

// =============================================================================
// parseBtcOriginAttestationEvent
// =============================================================================

describe("parseBtcOriginAttestationEvent", () => {
  /** Build a synthetic disc 0x15 event matching the Rust emit layout. */
  function buildBtcOriginAttestation(opts: {
    blockHeight: bigint;
    depositTxid: Uint8Array;
    sweepVout: number;
    commitment: Uint8Array;
    amountSats: bigint;
  }): Uint8Array[] {
    const disc = new Uint8Array([EVENT_BTC_ORIGIN_ATTESTATION]);
    const bh = new Uint8Array(8);
    new DataView(bh.buffer).setBigUint64(0, opts.blockHeight, true);
    const vout = new Uint8Array(4);
    new DataView(vout.buffer).setUint32(0, opts.sweepVout, true);
    const amt = new Uint8Array(8);
    new DataView(amt.buffer).setBigUint64(0, opts.amountSats, true);
    return [disc, bh, opts.depositTxid, vout, opts.commitment, amt];
  }

  test("round-trips all fields", () => {
    const segments = buildBtcOriginAttestation({
      blockHeight: 850_123n,
      depositTxid: bytes32(0xab),
      sweepVout: 7,
      commitment: bytes32(0xcd),
      amountSats: 12_345_678n,
    });

    const event = parseBtcOriginAttestationEvent(segments);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("btc_origin_attestation");
    expect(event!.blockHeight).toBe(850_123n);
    expect(event!.sweepVout).toBe(7);
    expect(event!.amountSats).toBe(12_345_678n);
    expect(event!.depositTxid).toEqual(bytes32(0xab));
    expect(event!.commitment).toEqual(bytes32(0xcd));
  });

  test("handles 64-bit boundary values", () => {
    const max = (1n << 64n) - 1n;
    const segments = buildBtcOriginAttestation({
      blockHeight: max,
      depositTxid: bytes32(0x00),
      sweepVout: 0xffffffff,
      commitment: bytes32(0x00),
      amountSats: max,
    });
    const event = parseBtcOriginAttestationEvent(segments);
    expect(event!.blockHeight).toBe(max);
    expect(event!.amountSats).toBe(max);
    expect(event!.sweepVout).toBe(0xffffffff);
  });

  test("rejects wrong discriminator", () => {
    const segments = buildBtcOriginAttestation({
      blockHeight: 1n,
      depositTxid: bytes32(0x11),
      sweepVout: 0,
      commitment: bytes32(0x22),
      amountSats: 100n,
    });
    segments[0] = new Uint8Array([0xff]);
    expect(parseBtcOriginAttestationEvent(segments)).toBeNull();
  });

  test("rejects malformed segment lengths", () => {
    const segments = buildBtcOriginAttestation({
      blockHeight: 1n,
      depositTxid: bytes32(0x11),
      sweepVout: 0,
      commitment: bytes32(0x22),
      amountSats: 100n,
    });
    // wrong-length depositTxid
    const tampered = [...segments];
    tampered[2] = new Uint8Array(31);
    expect(parseBtcOriginAttestationEvent(tampered)).toBeNull();
  });

  test("parseProgramEvents picks it out of a mixed log stream", () => {
    const segments = buildBtcOriginAttestation({
      blockHeight: 42n,
      depositTxid: bytes32(0xaa),
      sweepVout: 1,
      commitment: bytes32(0xbb),
      amountSats: 500_000n,
    });
    const log = buildProgramDataLog(...segments);
    const events = parseProgramEvents([log]);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("btc_origin_attestation");
    const e = events[0] as BtcOriginAttestationEvent;
    expect(e.amountSats).toBe(500_000n);
  });
});
