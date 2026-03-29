# Frontend API Cleanup Plan

## Context
Backend API was cleaned up: admin endpoints gated behind auth, announcements response trimmed, sync status added to /api/tree/status. Now the frontend needs to match — remove duplicate hooks, delete unused proxy routes, and consolidate data fetching.

## Current State

### 4 hooks that fetch explorer data (should be 1):
```
useExplorer()      → /api/explorer/transactions  ← PRIMARY (unified)
useDeposits()      → /api/explorer/deposits       ← DUPLICATE
useTransfers()     → /api/transfers               ← DUPLICATE
useRedemptions()   → /api/explorer/redemptions     ← DUPLICATE
```

### Consumers of duplicate hooks:
- useDeposits() → 4 files: deposits-tab.tsx, page.tsx, balance-view.tsx (x2)
- useTransfers() → 0 direct consumers (only re-exported)
- useRedemptions() → 1 file: withdrawals-tab.tsx (but it also fetches relayer/meta inline)

### 14 unused frontend proxy routes (no fetch() calls):
```
/api/announcements/status    — admin-only on backend now
/api/deposits/by-address/*   — never fetched
/api/header/init             — never fetched
/api/header/status/*         — never fetched
/api/indexer/status          — admin-only on backend now
/api/merkle/proof            — never fetched (SDK uses backend directly)
/api/pool/info               — admin-only on backend now
/api/solana/commitment-tree  — never fetched
/api/stealth/[id]            — never fetched
/api/stealth/announcements   — never fetched (uses /api/announcements)
/api/stealth/prepare         — never fetched from frontend
/api/tracker/retry/[id]      — admin-only
/api/nullifiers              — SDK fetches backend directly
/api/transfers               — duplicate of explorer/transactions
```

## Plan

### Step 1: Migrate useDeposits() consumers → useExplorer()
**Files:** deposits-tab.tsx, page.tsx, balance-view.tsx

The useDeposits() hook returns `{ deposits, transactions }`. The useExplorer() hook returns `{ transactions }` which already includes deposits (type="shield"). Migrate each consumer to filter `transactions.filter(t => t.type === "shield")`.

### Step 2: Remove duplicate hooks
**File:** hooks/use-explorer.ts

Delete: `useDeposits()`, `useTransfers()`, `useRedemptions()`
Keep: `useExplorer()` (unified), `fetchAnnouncements()`, `toIndexerLeaves()`

### Step 3: Delete unused frontend proxy routes
**Directory:** aegis-app/src/app/api/

Delete these route directories:
- announcements/status/
- deposits/by-address/
- header/init/
- header/status/
- indexer/status/
- merkle/proof/
- pool/info/
- solana/commitment-tree/
- stealth/[id]/
- stealth/announcements/
- stealth/prepare/
- tracker/retry/
- transfers/

Keep these (actively fetched):
- announcements/         (stealth scanning)
- deposits/              (deposit tracker)
- deposits/[id]/         (single deposit)
- explorer/deposits/     (keep until Step 2 migration done, then delete)
- explorer/redemptions/  (keep until Step 2 migration done, then delete)
- explorer/transactions/ (primary explorer endpoint)
- nullifiers/            (keep — SDK may use via frontend proxy)
- pool/stats/            (landing page TVL)
- relay/                 (submit JoinSplit tx)
- relayer/meta/          (fee config)
- verify/                (SPV proof submission)

### Step 4: Add sync status indicator
**File:** components (new or existing)

Use `/api/tree/status` response `synced` field to show a subtle "Syncing..." badge when backend indexer is catching up.

## Verification
1. `bun run build` — no import errors
2. Explorer page loads with all transaction types
3. Landing page shows TVL
4. Pay flow works (relayer meta, relay submission)
5. Stealth scanning works (announcements)
