# Backend Data Integrity & Code Quality Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 3 data integrity bugs (frontend heuristic matching, deposit TOCTOU, missing PDA scan), migrate tracking store from JSON to SQLite, consolidate redemption API, DRY up test helpers.

**Architecture:** Migrate the in-memory JSON tracking store to SQLite (same DB as event_indexer), add `fetchExplorerRedemptions` to SDK, consolidate 7 frontend API calls into 1 backend endpoint, extract shared test utilities.

**Tech Stack:** Rust (SQLite via rusqlite), TypeScript SDK, Next.js API routes

---

## Data Flow (After Changes)

```
On-chain Program Events (sol_log_data)
         │
         ▼
Backend Event Indexer (parser.rs → storage.rs)
    ├── leaf_events           (PK: leaf_index)
    ├── nullifier_events      (PK: nullifier_hash)
    ├── stealth_announcements (PK: leaf_index)
    ├── redemption_requested  (PK: requester + request_id)
    ├── redemption_processing (PK: requester + request_id)
    └── redemption_completed  (PK: request_id)
         │
         ▼
Backend Redemption Service (watcher → service)
    └── redemption_tracking   (PK: pda_address, UNIQUE: request_id)  ← NEW: SQLite
         │
         ▼
Backend /api/redemption/all   ← NEW: consolidated endpoint
    JOIN tracking + events + on-chain PDA scan
         │
         ▼
Frontend /api/explorer/redemptions
    Single fetch → dedup by request_id only (no heuristic)
```

---

## Task 1: Migrate tracking.rs from JSON to SQLite

**Files:**
- Modify: `backend/src/redemption/tracking.rs`
- Modify: `backend/src/redemption/service.rs` (update all tracking calls)
- Modify: `backend/src/redemption/mod.rs` (update TrackingStore construction)
- Test: `backend/src/redemption/tracking.rs` (inline #[cfg(test)])

### Schema

```sql
CREATE TABLE IF NOT EXISTS redemption_tracking (
    pda_address TEXT PRIMARY KEY,
    request_id INTEGER,
    requester TEXT,
    amount_sats INTEGER,
    btc_script TEXT,
    btc_txid TEXT,
    local_status TEXT NOT NULL DEFAULT 'Pending',
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_updated INTEGER NOT NULL,
    error TEXT,
    verified_tx_pda TEXT,
    buffer_pubkey TEXT,
    tx_size INTEGER,
    simulated INTEGER NOT NULL DEFAULT 0,
    consumed_utxo_pdas TEXT,
    pool_script_hex TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tracking_request_id
    ON redemption_tracking(request_id) WHERE request_id IS NOT NULL;
```

- [x] **Step 1:** Create new `TrackingStore` backed by SQLite (rusqlite)
  - Constructor takes `db_path: &str`, creates table if not exists
  - Methods: `upsert()`, `get_by_pda()`, `get_by_request_id()`, `remove()`, `reconcile()`, `list_all()`
  - `consumed_utxo_pdas` stored as JSON string (comma-separated)
  - All operations are synchronous (rusqlite is sync; wrap in `spawn_blocking` if needed)

- [x] **Step 2:** Write unit tests
  - test_insert_and_get
  - test_upsert_updates_existing
  - test_get_by_request_id
  - test_reconcile_removes_stale
  - test_concurrent_insert_same_pda (should upsert, not error)
  - test_list_all

- [x] **Step 3:** Update `service.rs` to use new TrackingStore
  - Replace `self.tracking.get()` → `self.tracking.get_by_pda()`
  - Replace `self.tracking.upsert()` → pass `request_id` field
  - Replace `self.tracking.remove()` → same API
  - Remove old JSON file operations

- [x] **Step 4:** Update API route `/api/redemption/tracking`
  - Returns `list_all()` results (same JSON format as before)

- [x] **Step 5:** Delete old JSON tracking file logic

---

## Task 2: Add fetchExplorerRedemptions to SDK

**Files:**
- Modify: `sdk/src/explorer.ts`
- Modify: `sdk/src/index.ts` (export)
- Build: `sdk/` (tsc)

- [x] **Step 1:** Add `fetchExplorerRedemptions()` to `sdk/src/explorer.ts`
  - Uses `getProgramAccounts` with `memcmp` filter for disc=0x04
  - Parses RedemptionRequest layout: disc(1) + status(1) + request_id(8) + requester(32) + amount_sats(8) + service_fee(8) + btc_script_len(1) + btc_script(0-62)
  - Returns `ExplorerRedemption[]` with: pubkey, requestId, status, requester, amountSats, serviceFee, btcScript

- [x] **Step 2:** Export from `sdk/src/index.ts`

- [x] **Step 3:** Rebuild SDK: `bun run build`

---

## Task 3: Fix deposit tracker TOCTOU + add txid unique index

**Files:**
- Modify: `backend/src/deposit_tracker/sqlite_db.rs`

- [x] **Step 1:** Change `insert()` to use `INSERT OR IGNORE`
  - Return existing record if conflict on taproot_address
  - No more explicit `get_by_address()` before insert

- [x] **Step 2:** Add migration for deposit_txid unique index
  ```sql
  CREATE UNIQUE INDEX IF NOT EXISTS idx_deposit_txid
      ON deposits(deposit_txid) WHERE deposit_txid IS NOT NULL;
  ```

- [x] **Step 3:** Handle conflict on deposit_txid in update methods

---

## Task 4: Add consolidated /api/redemption/all endpoint

**Files:**
- Modify: `backend/src/redemption/mod.rs` or API routes file
- Modify: `aegis-app/src/app/api/explorer/redemptions/route.ts`

- [x] **Step 1:** Add backend endpoint `GET /api/redemption/all`
  - Joins: tracking table + requested events + processing events + completed events
  - Returns unified JSON with all redemption data in one response
  - Each entry has: request_id, requester, amount_sats, btc_script, status, tracking_status, btc_txid, timestamps, service_fee info

- [x] **Step 2:** Update frontend `redemptions/route.ts`
  - Replace 7 parallel fetches with single `/api/redemption/all` call
  - Keep on-chain PDA scan via new SDK `fetchExplorerRedemptions` (from Task 2)
  - Merge: PDA scan (authoritative for active status) + backend all (enrichment + history)
  - Dedup by `request_id` only — remove (requester, amount_sats) heuristic

---

## Task 5: DRY up test helpers into shared.ts

**Files:**
- Modify: `scripts/e2e/shared.ts`
- Modify: `scripts/e2e/step3-btc-deposit.ts` (remove inline function)
- Modify: `scripts/e2e/step4-btc-deposit-2.ts` (remove inline function)
- Modify: `scripts/e2e/step6-transfer.ts` (remove inline buildTree)
- Modify: `scripts/e2e/step7-unshield.ts` (remove inline buildTree)
- Modify: `scripts/e2e/step7b-unshield-btc.ts` (remove inline buildTree)
- Modify: `scripts/e2e/step7c-multi-unshield.ts` (remove inline buildTree)
- Modify: `scripts/e2e/step8c-multi-redeem.ts` (remove inline buildTree)

- [x] **Step 1:** Add `parseStealthAnnouncementFromLogs()` to shared.ts
  - Move from step3/step4, export as shared function

- [x] **Step 2:** Add `buildMerkleTree()` to shared.ts
  - Takes `leaves: bigint[]`, returns `{ root, getProof(idx) }`
  - Uses ZERO_HASHES from shared (already exported)

- [x] **Step 3:** Update all 7 test files to import from shared.ts
  - Remove inline copies of parseStealthAnnouncementFromLogs and buildTree

---

## Task 6: Verify everything

- [x] **Step 1:** `cargo test` — all Rust tests pass (including new tracking tests)
- [x] **Step 2:** `bun run build` in SDK — TypeScript compiles
- [x] **Step 3:** `bun test sdk/test/unit/bound-params.test.ts` — cross-language parity
- [x] **Step 4:** `bun run scripts/e2e/run-all.ts` — all 14 e2e steps pass
- [x] **Step 5:** Manual check: `curl http://localhost:3000/api/explorer/redemptions` shows correct statuses

---

## Failure Modes

| Codepath | Failure | Test? | Error handling? | Silent? |
|----------|---------|-------|-----------------|---------|
| SQLite tracking insert | DB locked | Unit test | Returns error | No — logged |
| fetchExplorerRedemptions | RPC timeout | No | .catch → [] | **Yes — shows Cancelled** |
| Deposit INSERT OR IGNORE | Duplicate address | Unit test | Returns existing | No |
| /api/redemption/all | Backend down | No | Frontend falls back to events-only | No — shows stale |
| Multi-output same amount | Wrong match | Fixed by removing heuristic | N/A | N/A — fixed |

**Critical gap:** `fetchExplorerRedemptions` RPC timeout silently degrades to showing "Cancelled". Should log a warning and show "Unknown" instead of "Cancelled". Will address in Task 4 Step 2.
