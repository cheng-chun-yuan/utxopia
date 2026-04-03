# Plan: Event Indexer Refactor — Event-First Classification

## Problem

The backend event indexer (`backend/src/event_indexer/`) classifies transactions by parsing instruction discriminators from raw tx data. This is fragile because:

1. **Legacy programs emit wrong `ix_disc`** in nullifier events (disc=15 for both unshield and redemption)
2. **Same disc used for multiple operations** — disc=15 was old unshield, but redemptions also get classified as disc=15
3. **Instruction data layout differs** between old and new contract versions
4. **Garbage amounts** — parsing unshield data from redemption txs produces negative/overflow values
5. **"Amount pending re-index"** — redemption amounts can't be extracted because they're in a separate tx

## Solution: Event-First Classification

Use the **event type** (0x0E UnshieldMeta, 0x0D DepositVerified, 0x07 RedemptionCompleted, etc.) as the primary classifier instead of instruction disc. Events are authoritative — emitted by the contract with correct, typed data.

### Decision Tree

```
Backend receives tx with Privacy Coin program logs
    │
    ├── Has UnshieldMeta event (0x0E)?
    │   └── YES → UNSHIELD. Amount + recipient + token from event.
    │
    ├── Has DepositVerified event (0x0D)?
    │   └── YES → BTC DEPOSIT. sweep_txid + deposit_txid + amount from event.
    │
    ├── Has RedemptionCompleted event (0x07)?
    │   └── YES → COMPLETED REDEMPTION. Full accounting from event.
    │
    ├── Has RedemptionRequested event (0x08)?
    │   └── YES → REDEMPTION REQUEST. Amount + BTC script from event.
    │
    ├── Has RedemptionProcessing event (0x0A)?
    │   └── YES → MARK PROCESSING. Amount + slot from event.
    │
    ├── Has NullifierSpent/Batch?
    │   ├── ix_disc from event = 5 → REDEMPTION REQUEST (fallback)
    │   ├── op_type = 2 → PRIVATE TRANSFER. No amount.
    │   └── op_type = 0 + no UnshieldMeta → UNSHIELD (legacy, try ix data)
    │
    └── Has StealthAnnouncement only?
        ├── type = 0 → DEPOSIT (shield/demo/verify)
        └── type = 1 → TRANSFER output
```

### Key Changes

#### 1. `process_transaction()` — Event-first routing

**Current** (line ~280-290):
```rust
// Uses tx_data.instruction_disc to decide extraction method
let (unshield_amount, unshield_recipient) = match instruction_disc {
    Some(30) | Some(15) => extract_unshield_from_ix_data(...),
    Some(5) | Some(16) => extract_redeem_from_ix_data(...),
    _ => (None, None),
};
```

**Proposed**:
```rust
// Event-first: if UnshieldMeta exists, use it (already done at line 280)
// If not, DON'T try ix data extraction for non-unshield txs
// For redemptions, use RedemptionRequested event data
let (unshield_amount, unshield_recipient) = if unshield_meta.is_some() {
    // Already handled above
    (unshield_amount, unshield_recipient)
} else if redemption_requested.is_some() {
    let rr = redemption_requested.unwrap();
    let btc_addr = script_to_address(&rr.btc_script, network);
    (Some(rr.amount_sats as i64), Some(btc_addr))
} else {
    (None, None) // Private transfer — no amount
};
```

#### 2. `process_nullifier_tx()` — Remove instruction data parsing

**Current**: Tries to parse unshield/redeem data from raw instruction bytes using hardcoded disc checks.

**Proposed**: Only extract instruction_disc for metadata. Never try to parse amount/recipient from instruction data — that should come from events.

Remove:
- `extract_unshield_from_ix_data()` — replaced by UnshieldMeta event
- `extract_redeem_from_ix_data()` — replaced by RedemptionRequested event
- `extract_unshield_from_token_balances()` — fallback no longer needed

Keep:
- `extract_aegis_instruction_disc()` — still useful for metadata
- `extract_btc_txids()` — fallback for old txs without DepositVerified event

#### 3. Frontend `transfers-tab.tsx` — Simplified classification

**Current**: Complex disc-based `isRedeemType()` / `isUnshieldType()` with hardcoded disc values.

**Proposed**: Backend returns a `transfer_type` field directly:
```typescript
type TransferType = "private_transfer" | "unshield" | "redeem" | "deposit";
```

Backend computes this from events (authoritative), frontend just displays it.

#### 4. Redemption lifecycle tracking

Currently the backend doesn't link:
- `request_redemption` tx → `mark_processing` tx → `complete_redemption` tx

These are 3 separate transactions with different sigs. The link is the RedemptionRequest PDA (same `request_id`).

**Proposed**: Add a `redemptions` view that joins:
```sql
SELECT
    rr.request_id,
    rr.amount_sats,
    rr.btc_script,
    rr.tx_signature AS request_tx,
    rp.tx_signature AS processing_tx,
    rp.processing_slot,
    rc.tx_signature AS complete_tx,
    rc.btc_txid,
    rc.actual_received,
    rc.service_fee,
    rc.protocol_revenue
FROM redemption_requested rr
LEFT JOIN redemption_processing rp ON rr.request_id = rp.request_id
LEFT JOIN redemption_completed rc ON rr.request_id = rc.request_id
```

Frontend displays: Request → Processing → BTC Sent → Complete (with all tx links).

## On-Chain Event Reference

| Disc | Event | Key Data | Emitted By |
|------|-------|----------|------------|
| 0x02 | NullifierSpent | hash + op_type + ix_disc | transact, unshield, request_redemption |
| 0x03 | StealthAnnouncement | type + ephemeral + amount + commitment + leaf + token | ALL deposit/transfer instructions |
| 0x07 | RedemptionCompleted | requester + amounts + fees + btc_txid + script | complete_redemption |
| 0x08 | RedemptionRequested | requester + amount + request_id + fees + script | request_redemption |
| 0x0A | RedemptionProcessing | requester + amount + request_id + slot | mark_processing |
| 0x0B | NullifiersBatch | count + op_type + ix_disc + hashes[] | transact, unshield |
| 0x0C | AnnouncementsBatch | count + announcements[] | transact (multi-output) |
| 0x0D | DepositVerified | sweep_txid + deposit_txid + amount + leaf | verify_stealth_deposit |
| 0x0E | UnshieldMeta | amount + recipient + token_id | unshield |
| 0x0F | UtxoCreated | txid + vout + amount | verify_stealth_deposit, complete_redemption |
| 0x10 | UtxoConsumed | txid + vout + amount | complete_redemption |

## NullifierOperationType Enum

| Value | Name | Used By |
|-------|------|---------|
| 0 | FullWithdrawal | unshield (disc=30), request_redemption (disc=5) |
| 1 | PartialWithdrawal | (reserved) |
| 2 | PrivateTransfer | transact (disc=14) |
| 3 | Transfer | (reserved, 1-in-1-out) |
| 4 | Split | (reserved, 1-in-2-out) |
| 5 | Join | (reserved, 2-in-1-out) |

## Files to Change

| File | Change | Effort |
|------|--------|--------|
| `backend/src/event_indexer/service.rs` | Event-first classification, remove ix data parsing | Major |
| `backend/src/event_indexer/storage.rs` | Add redemption lifecycle tables, `transfer_type` field | Medium |
| `backend/src/event_indexer/routes.rs` | Add `transfer_type` to API, redemption lifecycle endpoint | Medium |
| `backend/src/event_indexer/parser.rs` | Ensure all event types are parsed (0x07, 0x08, 0x0A) | Small |
| `privacy-coin-app/src/app/explorer/components/transfers-tab.tsx` | Use `transfer_type` from backend | Small |
| `privacy-coin-app/src/hooks/use-explorer.ts` | Update types | Small |
| `privacy-coin-app/src/app/api/transfers/route.ts` | Pass through `transfer_type` | Small |

## Migration / Backwards Compat

- Old indexed data: re-index by clearing DB (`rm backend/data/events.db`)
- Old contract events: the parser already handles both old and new formats
- Frontend: check for `transfer_type` field, fall back to disc-based classification if absent

## Not in Scope

- Changing on-chain event formats (would require contract redeploy)
- Real-time WebSocket for redemption status updates (separate feature)
- Historical backfill of pre-existing redemptions (clear DB + rescan)
