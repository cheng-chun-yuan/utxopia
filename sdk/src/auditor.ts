/**
 * Auditor toolkit (Phase 1)
 *
 * Given a {@link DelegatedViewKey}, produce a structured audit record for
 * every announcement that decrypts cleanly to a positive amount. The scanner:
 *
 *   - enforces the delegation's `expiresAt` (wall-clock check)
 *   - enforces the delegation's `[fromSlot, toSlot]` honor-system range
 *   - honors `ViewPermissions.INCOMING_ONLY` once outgoing memos exist
 *     (Phase 2). Today everything coming back is treated as IN since no
 *     sender-memo channel has shipped yet.
 *
 * No on-chain enforcement is possible (the auditor already holds the secret);
 * scope is enforced *inside this scanner* so a compliant tool obeys it and the
 * issuer can prove what scope they handed over.
 */

import {
  scanAnnouncementsViewOnly,
  ANNOUNCEMENT_TYPE_DEPOSIT,
  type OnChainStealthAnnouncement,
  type ViewOnlyKeys,
} from "./stealth";
import { babyJubDecompress, bytesToHex } from "./crypto";
import {
  ViewPermissions,
  hasPermission,
  isDelegatedKeyValid,
  isSlotInDelegatedRange,
  type DelegatedViewKey,
} from "./keys";
import { decryptSenderMemo, type SenderMemoCiphertext } from "./sender-memo";
export type { SenderMemoCiphertext };

/** Direction of a record relative to the audited user. */
export type AuditDirection = "IN" | "OUT" | "SELF" | "UNKNOWN";

/** A single matched announcement, ready for report rendering. */
export interface AuditRecord {
  slot: number;
  blockTime: number;
  leafIndex: number;
  direction: AuditDirection;
  announcementType: number;
  tokenId: bigint;
  amount: bigint;
  commitmentHex: string;
  ephemeralPubHex: string;
}

export interface AuditScanOptions {
  /** Token IDs to scan for. Required — auditor must know which token namespaces to look in. */
  tokenIds: bigint[];
  /** Override slot range (otherwise uses key's fromSlot/toSlot). */
  fromSlot?: number;
  toSlot?: number;
  /** Clock for `expiresAt` check. Override for tests; defaults to `Date.now()`. */
  now?: () => number;
  /** Sender-memo events (Phase 2). When supplied, OUT records will be produced. */
  senderMemos?: ReadonlyArray<OnChainSenderMemo>;
}

/**
 * Sender-memo event as observed on-chain. Emitted by `emit_sender_memo` in the
 * UTXOpia program. The memo carries its own `commitment` and `leafIndex` so
 * the auditor can join it back to the corresponding tree leaf, even though
 * the memo itself isn't a leaf.
 */
export interface OnChainSenderMemo extends SenderMemoCiphertext {
  blockTime?: number;
  slot?: number;
}

export interface AuditScanSummary {
  records: AuditRecord[];
  /** How many announcements fell outside the slot range. */
  outOfRangeSkipped: number;
  /** How many announcements lacked a slot but the key required one. */
  unscopedSkipped: number;
  /** How many announcements decrypted to something invalid (wrong key, out of range amount). */
  notForViewerSkipped: number;
  /** Effective slot range that was actually enforced. */
  effectiveFromSlot?: number;
  effectiveToSlot?: number;
}

/**
 * Annotated announcement input — carries the same shape as
 * {@link OnChainStealthAnnouncement} but the `tokenId` is opt-in. When
 * omitted, the caller will be matched against every `tokenIds` entry.
 */
export interface AuditScanAnnouncement extends OnChainStealthAnnouncement {
  /** Optional — when present, scanner only tries the matching tokenId. */
  tokenId?: bigint;
}

/**
 * Scan announcements with a delegated viewing key and produce {@link AuditRecord}s.
 *
 * Throws if the key is expired or lacks `SCAN` permission, or if the key is
 * missing the spending-pub/nullifying-key material required to verify deposits.
 */
export async function auditScan(
  key: DelegatedViewKey,
  announcements: ReadonlyArray<AuditScanAnnouncement>,
  options: AuditScanOptions,
): Promise<AuditScanSummary> {
  if (!hasPermission(key, ViewPermissions.SCAN)) {
    throw new Error("Delegated key missing SCAN permission");
  }
  if (!isDelegatedKeyValid(key)) {
    throw new Error("Delegated key has expired");
  }
  if (!key.spendingPubKeyCompressed || key.nullifyingKey == null) {
    throw new Error(
      "Delegated key missing spendingPubKey/nullifyingKey — re-export with a v2 key",
    );
  }
  if (options.tokenIds.length === 0) {
    throw new Error("auditScan requires at least one tokenId");
  }

  const effectiveFromSlot = options.fromSlot ?? key.fromSlot;
  const effectiveToSlot = options.toSlot ?? key.toSlot;

  const keyForRange: DelegatedViewKey = {
    ...key,
    fromSlot: effectiveFromSlot,
    toSlot: effectiveToSlot,
  };

  let outOfRangeSkipped = 0;
  let unscopedSkipped = 0;

  const inScope: AuditScanAnnouncement[] = [];
  for (const ann of announcements) {
    if (effectiveFromSlot != null || effectiveToSlot != null) {
      if (ann.slot == null) {
        unscopedSkipped++;
        continue;
      }
      if (!isSlotInDelegatedRange(keyForRange, ann.slot)) {
        outOfRangeSkipped++;
        continue;
      }
    }
    inScope.push(ann);
  }

  const viewOnly: ViewOnlyKeys = {
    viewingPrivKey: key.viewingPrivKey,
    spendingPubKey: babyJubDecompress(key.spendingPubKeyCompressed),
    nullifyingKey: key.nullifyingKey,
  };

  // Honor INCOMING_ONLY: when set, skip OUT records derived from sender memos.
  // The auditor still scans incoming announcements; just doesn't produce
  // outgoing-direction rows. Enforcement is honor-system (the key holder could
  // run auditScan locally with this branch removed), but the issuance contract
  // is that an INCOMING_ONLY delegation produces no OUT records under the
  // canonical SDK path.
  const incomingOnly = hasPermission(key, ViewPermissions.INCOMING_ONLY);

  const records: AuditRecord[] = [];
  const seenLeafIndex = new Set<number>();
  // Index inScope by leafIndex so we can recover slot after the inner scan,
  // which strips the slot field from its output.
  const slotByLeafIndex = new Map<number, number | undefined>();
  for (const ann of inScope) slotByLeafIndex.set(ann.leafIndex, ann.slot);

  for (const tokenId of options.tokenIds) {
    // Either the announcement explicitly targets this token, or its tokenId is
    // unknown and we try every requested token id (commitment match disambiguates).
    const subset = inScope.filter(
      (a) => a.tokenId == null || a.tokenId === tokenId,
    );
    if (subset.length === 0) continue;

    const matched = await scanAnnouncementsViewOnly(viewOnly, subset, tokenId);
    for (const m of matched) {
      if (seenLeafIndex.has(m.leafIndex)) continue;
      seenLeafIndex.add(m.leafIndex);
      records.push({
        slot: slotByLeafIndex.get(m.leafIndex) ?? 0,
        blockTime: m.blockTime ?? 0,
        leafIndex: m.leafIndex,
        direction: "IN",
        announcementType:
          subset.find((a) => a.leafIndex === m.leafIndex)?.announcementType ??
          ANNOUNCEMENT_TYPE_DEPOSIT,
        tokenId,
        amount: m.amount,
        commitmentHex: bytesToHex(m.commitment),
        ephemeralPubHex: bytesToHex(m.ephemeralPub),
      });
    }
  }

  const notForViewerSkipped = inScope.length - seenLeafIndex.size;

  // Sender memos (Phase 2): produce OUT records the user emitted.
  // Skipped entirely when the delegation is INCOMING_ONLY.
  if (!incomingOnly && options.senderMemos && options.senderMemos.length > 0) {
    for (const memo of options.senderMemos) {
      if (effectiveFromSlot != null || effectiveToSlot != null) {
        if (memo.slot == null) {
          unscopedSkipped++;
          continue;
        }
        if (!isSlotInDelegatedRange(keyForRange, memo.slot)) {
          outOfRangeSkipped++;
          continue;
        }
      }
      const plain = decryptSenderMemo(key.viewingPrivKey, memo);
      if (!plain) continue;
      // Sender memos are encrypted to the user's own viewing key, so the
      // primary sanity check is non-zero. The 8-byte field already caps amount at u64::MAX.
      if (plain.amount <= 0n) continue;
      // Token filter: respect the requested tokenIds set.
      if (!options.tokenIds.some((t) => t === plain.tokenId)) continue;

      records.push({
        slot: memo.slot ?? 0,
        blockTime: memo.blockTime ?? 0,
        leafIndex: memo.leafIndex,
        direction: "OUT",
        announcementType: -1, // distinct from deposit (0) / transfer (1)
        tokenId: plain.tokenId,
        amount: plain.amount,
        commitmentHex: bytesToHex(memo.commitment),
        ephemeralPubHex: "",
      });
    }
  }

  return {
    records,
    outOfRangeSkipped,
    unscopedSkipped,
    notForViewerSkipped: Math.max(0, notForViewerSkipped),
    effectiveFromSlot,
    effectiveToSlot,
  };
}

/**
 * Render audit records as CSV. Always returns a single trailing newline.
 *
 * Columns: slot, block_time_iso, leaf_index, direction, type, token_id, amount, commitment, ephemeral_pub
 */
export function auditRecordsToCsv(records: ReadonlyArray<AuditRecord>): string {
  const header =
    "slot,block_time_iso,leaf_index,direction,type,token_id,amount,commitment,ephemeral_pub";
  const lines = records.map((r) => {
    const ts = r.blockTime > 0 ? new Date(r.blockTime * 1000).toISOString() : "";
    const typeLabel =
      r.direction === "OUT"
        ? "sender-memo"
        : r.announcementType === ANNOUNCEMENT_TYPE_DEPOSIT
          ? "deposit"
          : "transfer";
    return [
      r.slot,
      ts,
      r.leafIndex,
      r.direction,
      typeLabel,
      r.tokenId.toString(),
      r.amount.toString(),
      r.commitmentHex,
      r.ephemeralPubHex,
    ].join(",");
  });
  return [header, ...lines].join("\n") + "\n";
}
