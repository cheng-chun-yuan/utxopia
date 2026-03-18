/**
 * Cross-layer event parser alignment tests
 *
 * Verifies that the SDK event parser correctly handles events
 * emitted by the on-chain program. Simulates raw sol_log_data
 * segments and verifies parsing produces correct results.
 *
 * ┌─────────────┐    sol_log_data     ┌─────────────┐
 * │ Contract    │═══════════════════►│ SDK parser  │
 * │ events.rs   │  base64 segments   │ events.ts   │
 * └─────────────┘                     └─────────────┘
 */

import { describe, it, expect } from "bun:test";
import {
  parseStealthAnnouncementEvent,
  parseNullifierSpentEvent,
  EVENT_STEALTH_ANNOUNCEMENT,
  EVENT_NULLIFIER_SPENT,
} from "../../src/events";

describe("Cross-layer: event parser alignment", () => {
  describe("StealthAnnouncement (disc=0x03)", () => {
    it("parses v2 event with token_id (7 segments, 110 bytes total)", () => {
      // Simulate what the contract emits:
      // sol_log_data(&[&disc, &atype, ephemeral_pub, encrypted_amount, commitment, &li, token_id])
      const disc = new Uint8Array([EVENT_STEALTH_ANNOUNCEMENT]);
      const atype = new Uint8Array([0]); // deposit
      const ephemeralPub = new Uint8Array(32).fill(0xaa);
      const amount = new Uint8Array(8);
      new DataView(amount.buffer).setBigUint64(0, 50000n, true); // LE
      const commitment = new Uint8Array(32).fill(0xbb);
      const leafIndex = new Uint8Array(4);
      new DataView(leafIndex.buffer).setUint32(0, 7, true); // LE
      const tokenId = new Uint8Array(32).fill(0xcc);

      const segments = [disc, atype, ephemeralPub, amount, commitment, leafIndex, tokenId];
      const event = parseStealthAnnouncementEvent(segments);

      expect(event).not.toBeNull();
      expect(event!.type).toBe("stealth_announcement");
      expect(event!.announcementType).toBe(0);
      expect(event!.ephemeralPub).toEqual(ephemeralPub);
      expect(event!.encryptedAmount).toEqual(amount);
      expect(event!.commitment).toEqual(commitment);
      expect(event!.leafIndex).toBe(7);
      expect(event!.tokenId).toEqual(tokenId);
    });

    it("parses v1 event without token_id (6 segments, 78 bytes)", () => {
      const disc = new Uint8Array([EVENT_STEALTH_ANNOUNCEMENT]);
      const atype = new Uint8Array([1]); // transfer
      const ephemeralPub = new Uint8Array(32).fill(0x11);
      const amount = new Uint8Array(8).fill(0);
      const commitment = new Uint8Array(32).fill(0x22);
      const leafIndex = new Uint8Array(4);
      new DataView(leafIndex.buffer).setUint32(0, 0, true);

      const segments = [disc, atype, ephemeralPub, amount, commitment, leafIndex];
      const event = parseStealthAnnouncementEvent(segments);

      expect(event).not.toBeNull();
      expect(event!.announcementType).toBe(1);
      expect(event!.leafIndex).toBe(0);
      expect(event!.tokenId).toBeUndefined();
    });

    it("rejects wrong discriminator", () => {
      const segments = [
        new Uint8Array([0x99]),
        new Uint8Array([0]),
        new Uint8Array(32),
        new Uint8Array(8),
        new Uint8Array(32),
        new Uint8Array(4),
      ];
      expect(parseStealthAnnouncementEvent(segments)).toBeNull();
    });

    it("rejects too few segments", () => {
      const segments = [
        new Uint8Array([EVENT_STEALTH_ANNOUNCEMENT]),
        new Uint8Array([0]),
        new Uint8Array(32),
      ];
      expect(parseStealthAnnouncementEvent(segments)).toBeNull();
    });

    it("rejects wrong field sizes", () => {
      // ephemeral_pub wrong size (31 instead of 32)
      const segments = [
        new Uint8Array([EVENT_STEALTH_ANNOUNCEMENT]),
        new Uint8Array([0]),
        new Uint8Array(31), // wrong
        new Uint8Array(8),
        new Uint8Array(32),
        new Uint8Array(4),
      ];
      expect(parseStealthAnnouncementEvent(segments)).toBeNull();
    });

    it("correctly decodes leaf_index as LE u32", () => {
      const leafIndex = new Uint8Array(4);
      new DataView(leafIndex.buffer).setUint32(0, 65535, true); // max tree capacity

      const segments = [
        new Uint8Array([EVENT_STEALTH_ANNOUNCEMENT]),
        new Uint8Array([0]),
        new Uint8Array(32),
        new Uint8Array(8),
        new Uint8Array(32),
        leafIndex,
      ];
      const event = parseStealthAnnouncementEvent(segments);
      expect(event!.leafIndex).toBe(65535);
    });

    it("correctly decodes encrypted_amount as LE u64", () => {
      const amount = new Uint8Array(8);
      new DataView(amount.buffer).setBigUint64(0, 100_000_000n, true); // 1 BTC in sats

      const segments = [
        new Uint8Array([EVENT_STEALTH_ANNOUNCEMENT]),
        new Uint8Array([0]),
        new Uint8Array(32),
        amount,
        new Uint8Array(32),
        new Uint8Array(4),
      ];
      const event = parseStealthAnnouncementEvent(segments);
      const parsed = new DataView(
        event!.encryptedAmount.buffer,
        event!.encryptedAmount.byteOffset,
      ).getBigUint64(0, true);
      expect(parsed).toBe(100_000_000n);
    });
  });

  describe("NullifierSpent (disc=0x02)", () => {
    it("parses 3-segment event correctly", () => {
      const disc = new Uint8Array([EVENT_NULLIFIER_SPENT]);
      const hash = new Uint8Array(32).fill(0xff);
      const opType = new Uint8Array([2]); // PrivateTransfer

      const event = parseNullifierSpentEvent([disc, hash, opType]);
      expect(event).not.toBeNull();
      expect(event!.type).toBe("nullifier_spent");
      expect(event!.nullifierHash).toEqual(hash);
      expect(event!.operationType).toBe(2);
    });

    it("rejects wrong discriminator", () => {
      expect(parseNullifierSpentEvent([
        new Uint8Array([0x03]),
        new Uint8Array(32),
        new Uint8Array([0]),
      ])).toBeNull();
    });
  });
});
