import { describe, it, expect, beforeAll } from "bun:test";
import { initPoseidon } from "../../src/poseidon";
import {
  createDelegatedViewKey,
  deserializeDelegatedViewKey,
  fingerprintDelegatedKey,
  isSlotInDelegatedRange,
  makeDelegationRecord,
  serializeDelegatedViewKey,
  ViewPermissions,
  deriveKeysFromSeed,
} from "../../src/keys";
import { auditScan, auditRecordsToCsv } from "../../src/auditor";
import {
  createStealthDepositWithKeys,
  ANNOUNCEMENT_TYPE_DEPOSIT,
  createStealthMetaAddress,
  encryptSenderMemo,
  type AuditScanAnnouncement,
  type OnChainSenderMemo,
} from "../../src/index";

beforeAll(async () => {
  await initPoseidon();
});

const ZKBTC_TOKEN_ID = BigInt(0x7a627463); // "zkbtc"

describe("createDelegatedViewKey (v2)", () => {
  const seed = new Uint8Array(32).fill(0x42);

  it("populates spendingPubKey + nullifyingKey + delegation metadata", () => {
    const keys = deriveKeysFromSeed(seed);
    const delegated = createDelegatedViewKey(keys, ViewPermissions.FULL, {
      label: "tax-2026",
      fromSlot: 100,
      toSlot: 200,
    });

    expect(delegated.viewingPrivKey).toEqual(keys.viewingPrivKey);
    expect(delegated.spendingPubKeyCompressed).toBeDefined();
    expect(delegated.spendingPubKeyCompressed?.length).toBe(32);
    expect(delegated.nullifyingKey).toBe(keys.nullifyingKey);
    expect(delegated.fromSlot).toBe(100);
    expect(delegated.toSlot).toBe(200);
    expect(delegated.label).toBe("tax-2026");
    expect(delegated.issuedAt).toBeGreaterThan(0);
    expect(delegated.delegationId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("produces a different delegationId every call", () => {
    const keys = deriveKeysFromSeed(seed);
    const a = createDelegatedViewKey(keys);
    const b = createDelegatedViewKey(keys);
    expect(a.delegationId).not.toBe(b.delegationId);
  });
});

describe("fingerprintDelegatedKey", () => {
  it("is stable across re-issuance and matches across encode roundtrip", async () => {
    const keys = deriveKeysFromSeed(new Uint8Array(32).fill(0x42));
    const a = createDelegatedViewKey(keys);
    const b = createDelegatedViewKey(keys);
    expect(fingerprintDelegatedKey(a)).toBe(fingerprintDelegatedKey(b));

    const serialized = await serializeDelegatedViewKey(a, "pw");
    const restored = await deserializeDelegatedViewKey(serialized, "pw");
    expect(fingerprintDelegatedKey(restored)).toBe(fingerprintDelegatedKey(a));
  });

  it("differs across distinct viewing keys", () => {
    const a = createDelegatedViewKey(deriveKeysFromSeed(new Uint8Array(32).fill(0x42)));
    const b = createDelegatedViewKey(deriveKeysFromSeed(new Uint8Array(32).fill(0x99)));
    expect(fingerprintDelegatedKey(a)).not.toBe(fingerprintDelegatedKey(b));
  });
});

describe("isSlotInDelegatedRange", () => {
  it("accepts any slot when no range set", () => {
    const key = createDelegatedViewKey(deriveKeysFromSeed(new Uint8Array(32).fill(0x42)));
    expect(isSlotInDelegatedRange(key, 1)).toBe(true);
    expect(isSlotInDelegatedRange(key, 9_999_999)).toBe(true);
  });

  it("rejects slots outside [from, to]", () => {
    const key = createDelegatedViewKey(
      deriveKeysFromSeed(new Uint8Array(32).fill(0x42)),
      ViewPermissions.FULL,
      { fromSlot: 10, toSlot: 20 },
    );
    expect(isSlotInDelegatedRange(key, 9)).toBe(false);
    expect(isSlotInDelegatedRange(key, 10)).toBe(true);
    expect(isSlotInDelegatedRange(key, 20)).toBe(true);
    expect(isSlotInDelegatedRange(key, 21)).toBe(false);
  });

  it("rejects when slot unknown but key has bounds", () => {
    const key = createDelegatedViewKey(
      deriveKeysFromSeed(new Uint8Array(32).fill(0x42)),
      ViewPermissions.FULL,
      { fromSlot: 10 },
    );
    expect(isSlotInDelegatedRange(key, undefined)).toBe(false);
  });
});

describe("v2 serialize/deserialize roundtrip", () => {
  it("preserves all v2 fields through password-encrypted export", async () => {
    const keys = deriveKeysFromSeed(new Uint8Array(32).fill(0x42));
    const original = createDelegatedViewKey(keys, ViewPermissions.FULL, {
      label: "auditor-firm",
      fromSlot: 5,
      toSlot: 50,
      expiresAt: Date.now() + 86_400_000,
    });

    const blob = await serializeDelegatedViewKey(original, "correct-horse-battery-staple");
    const obj = JSON.parse(blob);
    expect(obj.version).toBe(2);
    expect(obj.fingerprint).toBe(fingerprintDelegatedKey(original));

    const restored = await deserializeDelegatedViewKey(blob, "correct-horse-battery-staple");
    expect(restored.viewingPrivKey).toEqual(original.viewingPrivKey);
    expect(restored.permissions).toBe(original.permissions);
    expect(restored.fromSlot).toBe(5);
    expect(restored.toSlot).toBe(50);
    expect(restored.spendingPubKeyCompressed).toEqual(original.spendingPubKeyCompressed);
    expect(restored.nullifyingKey).toBe(original.nullifyingKey);
    expect(restored.delegationId).toBe(original.delegationId);
    expect(restored.label).toBe("auditor-firm");
  });

  it("rejects wrong password", async () => {
    const keys = deriveKeysFromSeed(new Uint8Array(32).fill(0x42));
    const original = createDelegatedViewKey(keys);
    const blob = await serializeDelegatedViewKey(original, "right");
    await expect(deserializeDelegatedViewKey(blob, "wrong")).rejects.toThrow();
  });

  it("refuses v1 keys at parse time by default", async () => {
    // Synthesize a v1 blob by mutating a serialized v2 blob.
    const keys = deriveKeysFromSeed(new Uint8Array(32).fill(0x42));
    const original = createDelegatedViewKey(keys);
    const v2blob = await serializeDelegatedViewKey(original, "pw");
    const obj = JSON.parse(v2blob);
    obj.version = 1;
    delete obj.spendingPubKeyCompressed;
    delete obj.nullifyingKey;
    const v1blob = JSON.stringify(obj);

    await expect(deserializeDelegatedViewKey(v1blob, "pw")).rejects.toThrow(/v1/);
  });

  it("accepts v1 keys when acceptV1=true (migration path)", async () => {
    const keys = deriveKeysFromSeed(new Uint8Array(32).fill(0x42));
    const original = createDelegatedViewKey(keys);
    const v2blob = await serializeDelegatedViewKey(original, "pw");
    const obj = JSON.parse(v2blob);
    obj.version = 1;
    delete obj.spendingPubKeyCompressed;
    delete obj.nullifyingKey;
    const v1blob = JSON.stringify(obj);

    const restored = await deserializeDelegatedViewKey(v1blob, "pw", { acceptV1: true });
    expect(restored.viewingPrivKey).toEqual(original.viewingPrivKey);
    // v1 keys decrypt but lack the v2 fields — that's the whole point of
    // the migration flag. auditScan will still reject them downstream.
    expect(restored.spendingPubKeyCompressed).toBeUndefined();
    expect(restored.nullifyingKey).toBeUndefined();
  });
});

describe("makeDelegationRecord", () => {
  it("strips secret material and preserves scope metadata", () => {
    const keys = deriveKeysFromSeed(new Uint8Array(32).fill(0x42));
    const delegated = createDelegatedViewKey(keys, ViewPermissions.FULL, {
      label: "tax-2026",
      fromSlot: 100,
      toSlot: 200,
    });
    const record = makeDelegationRecord(delegated, { recipient: "Big Four LLP" });
    expect(record.fingerprint).toBe(fingerprintDelegatedKey(delegated));
    expect(record.fromSlot).toBe(100);
    expect(record.toSlot).toBe(200);
    expect(record.recipient).toBe("Big Four LLP");
    expect(record.label).toBe("tax-2026");
    expect(record.permissions).toBe(ViewPermissions.FULL);
    expect("viewingPrivKey" in record).toBe(false);
  });
});

describe("auditScan — matching incoming deposits", () => {
  it("recovers amount for a deposit it owns", async () => {
    const recipient = deriveKeysFromSeed(new Uint8Array(32).fill(0x42));
    const delegated = createDelegatedViewKey(recipient, ViewPermissions.FULL);

    const amount = 12_345n;
    const meta = createStealthMetaAddress(recipient);
    const deposit = await createStealthDepositWithKeys(meta, amount, ZKBTC_TOKEN_ID);

    const ann: AuditScanAnnouncement = {
      announcementType: ANNOUNCEMENT_TYPE_DEPOSIT,
      ephemeralPub: deposit.ephemeralPub,
      // Deposit amount is plaintext u64 LE
      encryptedAmount: u64LE(amount),
      commitment: deposit.commitment,
      leafIndex: 7,
      tokenId: ZKBTC_TOKEN_ID,
      slot: 100,
      blockTime: 1_700_000_000,
    };

    const result = await auditScan(delegated, [ann], { tokenIds: [ZKBTC_TOKEN_ID] });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].amount).toBe(amount);
    expect(result.records[0].direction).toBe("IN");
    expect(result.records[0].leafIndex).toBe(7);
    expect(result.records[0].slot).toBe(100);
  });

  it("ignores deposit destined for a different recipient", async () => {
    const me = deriveKeysFromSeed(new Uint8Array(32).fill(0x42));
    const them = deriveKeysFromSeed(new Uint8Array(32).fill(0x77));
    const delegated = createDelegatedViewKey(me, ViewPermissions.FULL);

    const amount = 9_999n;
    const themMeta = createStealthMetaAddress(them);
    const deposit = await createStealthDepositWithKeys(themMeta, amount, ZKBTC_TOKEN_ID);

    const ann: AuditScanAnnouncement = {
      announcementType: ANNOUNCEMENT_TYPE_DEPOSIT,
      ephemeralPub: deposit.ephemeralPub,
      encryptedAmount: u64LE(amount),
      commitment: deposit.commitment,
      leafIndex: 7,
      tokenId: ZKBTC_TOKEN_ID,
      slot: 100,
    };

    const result = await auditScan(delegated, [ann], { tokenIds: [ZKBTC_TOKEN_ID] });
    expect(result.records).toHaveLength(0);
    expect(result.notForViewerSkipped).toBe(1);
  });

  it("filters announcements outside the slot range", async () => {
    const recipient = deriveKeysFromSeed(new Uint8Array(32).fill(0x42));
    const delegated = createDelegatedViewKey(recipient, ViewPermissions.FULL, {
      fromSlot: 200,
      toSlot: 300,
    });
    const amount = 5_000n;
    const recipientMeta = createStealthMetaAddress(recipient);
    const deposit = await createStealthDepositWithKeys(recipientMeta, amount, ZKBTC_TOKEN_ID);

    const inRange: AuditScanAnnouncement = {
      announcementType: ANNOUNCEMENT_TYPE_DEPOSIT,
      ephemeralPub: deposit.ephemeralPub,
      encryptedAmount: u64LE(amount),
      commitment: deposit.commitment,
      leafIndex: 1,
      tokenId: ZKBTC_TOKEN_ID,
      slot: 250,
    };
    const outOfRange = { ...inRange, slot: 100, leafIndex: 2 };

    const result = await auditScan(delegated, [inRange, outOfRange], {
      tokenIds: [ZKBTC_TOKEN_ID],
    });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].leafIndex).toBe(1);
    expect(result.outOfRangeSkipped).toBe(1);
  });

  it("refuses to scan when the delegated key is expired", () => {
    const recipient = deriveKeysFromSeed(new Uint8Array(32).fill(0x42));
    const delegated = createDelegatedViewKey(recipient, ViewPermissions.FULL, {
      expiresAt: Date.now() - 1000,
    });
    expect(() =>
      auditScan(delegated, [], { tokenIds: [ZKBTC_TOKEN_ID] }),
    ).toThrow(/expired/);
  });

  it("refuses to scan without SCAN permission", () => {
    const recipient = deriveKeysFromSeed(new Uint8Array(32).fill(0x42));
    const delegated = createDelegatedViewKey(recipient, ViewPermissions.HISTORY);
    expect(() =>
      auditScan(delegated, [], { tokenIds: [ZKBTC_TOKEN_ID] }),
    ).toThrow(/SCAN/);
  });
});

describe("auditScan — sender memos (Phase 2)", () => {
  it("produces OUT records when sender memos are provided", async () => {
    const sender = deriveKeysFromSeed(new Uint8Array(32).fill(0x42));
    const delegated = createDelegatedViewKey(sender, ViewPermissions.FULL);

    const commitment = new Uint8Array(32).fill(0xcc);
    const memo = encryptSenderMemo(
      sender.viewingPrivKey,
      { tokenId: ZKBTC_TOKEN_ID, amount: 70_000n },
      { commitment, leafIndex: 12 },
    );
    const senderMemo: OnChainSenderMemo = {
      ...memo,
      slot: 555,
      blockTime: 1_700_000_000,
    };

    const result = await auditScan(delegated, [], {
      tokenIds: [ZKBTC_TOKEN_ID],
      senderMemos: [senderMemo],
    });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].direction).toBe("OUT");
    expect(result.records[0].amount).toBe(70_000n);
    expect(result.records[0].slot).toBe(555);
    expect(result.records[0].leafIndex).toBe(12);
  });

  it("skips sender memos outside the slot range", async () => {
    const sender = deriveKeysFromSeed(new Uint8Array(32).fill(0x42));
    const delegated = createDelegatedViewKey(sender, ViewPermissions.FULL, {
      fromSlot: 200,
      toSlot: 300,
    });

    const commitment = new Uint8Array(32);
    const memo = encryptSenderMemo(
      sender.viewingPrivKey,
      { tokenId: ZKBTC_TOKEN_ID, amount: 1_000n },
      { commitment, leafIndex: 1 },
    );
    const tooEarly: OnChainSenderMemo = { ...memo, slot: 100 };

    const result = await auditScan(delegated, [], {
      tokenIds: [ZKBTC_TOKEN_ID],
      senderMemos: [tooEarly],
    });
    expect(result.records).toHaveLength(0);
    expect(result.outOfRangeSkipped).toBe(1);
  });

  it("CSV labels OUT rows as sender-memo", async () => {
    const sender = deriveKeysFromSeed(new Uint8Array(32).fill(0x42));
    const delegated = createDelegatedViewKey(sender, ViewPermissions.FULL);
    const memo = encryptSenderMemo(
      sender.viewingPrivKey,
      { tokenId: ZKBTC_TOKEN_ID, amount: 1n },
      { commitment: new Uint8Array(32), leafIndex: 0 },
    );
    const result = await auditScan(delegated, [], {
      tokenIds: [ZKBTC_TOKEN_ID],
      senderMemos: [memo],
    });
    const csv = auditRecordsToCsv(result.records);
    expect(csv).toContain(",OUT,sender-memo,");
  });

  it("ignores sender memos with a tampered commitment (AAD mismatch)", async () => {
    const sender = deriveKeysFromSeed(new Uint8Array(32).fill(0x42));
    const delegated = createDelegatedViewKey(sender, ViewPermissions.FULL);
    const memo = encryptSenderMemo(
      sender.viewingPrivKey,
      { tokenId: ZKBTC_TOKEN_ID, amount: 1n },
      { commitment: new Uint8Array(32).fill(0xcc), leafIndex: 0 },
    );
    // Attacker swaps the commitment after-the-fact
    memo.commitment = new Uint8Array(32).fill(0xdd);

    const result = await auditScan(delegated, [], {
      tokenIds: [ZKBTC_TOKEN_ID],
      senderMemos: [memo],
    });
    expect(result.records).toHaveLength(0);
  });

  it("INCOMING_ONLY delegation produces zero OUT records even when memos are provided", async () => {
    const sender = deriveKeysFromSeed(new Uint8Array(32).fill(0x42));
    const delegated = createDelegatedViewKey(
      sender,
      ViewPermissions.SCAN | ViewPermissions.INCOMING_ONLY,
    );

    const commitment = new Uint8Array(32).fill(0xcc);
    const memo = encryptSenderMemo(
      sender.viewingPrivKey,
      { tokenId: ZKBTC_TOKEN_ID, amount: 70_000n },
      { commitment, leafIndex: 12 },
    );
    const senderMemo: OnChainSenderMemo = { ...memo, slot: 555 };

    const result = await auditScan(delegated, [], {
      tokenIds: [ZKBTC_TOKEN_ID],
      senderMemos: [senderMemo],
    });
    // The memo is decryptable, slot is in range, token matches — but the
    // delegation forbids OUT records, so the auditor must not emit one.
    expect(result.records).toHaveLength(0);
  });

  it("FULL delegation still emits OUT records when INCOMING_ONLY is not set", async () => {
    // Sibling assertion to lock in the contrast: same data, different
    // permissions, different result.
    const sender = deriveKeysFromSeed(new Uint8Array(32).fill(0x42));
    const delegated = createDelegatedViewKey(sender, ViewPermissions.FULL);
    const memo = encryptSenderMemo(
      sender.viewingPrivKey,
      { tokenId: ZKBTC_TOKEN_ID, amount: 70_000n },
      { commitment: new Uint8Array(32).fill(0xcc), leafIndex: 12 },
    );
    const senderMemo: OnChainSenderMemo = { ...memo, slot: 555 };
    const result = await auditScan(delegated, [], {
      tokenIds: [ZKBTC_TOKEN_ID],
      senderMemos: [senderMemo],
    });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].direction).toBe("OUT");
  });
});

describe("auditRecordsToCsv", () => {
  it("renders header even when no records", () => {
    const csv = auditRecordsToCsv([]);
    expect(csv.split("\n")[0]).toBe(
      "slot,block_time_iso,leaf_index,direction,type,token_id,amount,commitment,ephemeral_pub",
    );
    expect(csv.endsWith("\n")).toBe(true);
  });

  it("formats one record per line with ISO timestamp", () => {
    const csv = auditRecordsToCsv([
      {
        slot: 42,
        blockTime: 1_700_000_000,
        leafIndex: 7,
        direction: "IN",
        announcementType: 0,
        tokenId: 0x7a627463n,
        amount: 12_345n,
        commitmentHex: "ab".repeat(32),
        ephemeralPubHex: "cd".repeat(32),
      },
    ]);
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("42,2023-11-14T22:13:20.000Z,7,IN,deposit,2053272675,12345,");
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function u64LE(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  const v = new DataView(out.buffer);
  v.setBigUint64(0, n, true);
  return out;
}
