# API Unification Plan

## Goal
1. Unify the indexer + deposit endpoints into a consistent, minimal API surface
2. Add a unified WebSocket endpoint that pushes **all** state changes (tree, nullifiers, announcements) so frontends can reactively update
3. Remove redundant endpoints, align response shapes

---

## Current State

### Backend: 39 endpoints, 3 separate WS endpoints
- `WS /ws/tree` — tree updates (leaf_inserted)
- `WS /ws/announcements` — stealth announcements
- `WS /ws/deposits/{id}` / `WS /ws/deposits` — deposit status
- **Missing:** No WS for nullifier events

### Frontend (web — aegis-app):
- Uses WS for deposits (`/ws/deposits/:id`) and tree (`/ws/tree`) with auto-reconnect
- SWR polling for explorer data (`/api/tree/leaves` every 30s)
- No WS for nullifiers or announcements

### Frontend (mobile — aegis-mobile):
- **Zero WebSocket connections** — all HTTP polling
- `useExplorer` hooks: SWR to `/tree/leaves`, `/events/nullifiers`, `/events/proofs`
- `useDepositStatus`: 10s polling via `setInterval`
- `usePoolStats`: SWR with 30s `refreshInterval`

### Pain Points
1. **Inconsistent patterns** — tree has `status`/`sync`/`reset`, nullifiers have `batch`/`{hash}`, announcements have `status` but no `sync`
2. **Redundant endpoints** — 6 deposit filter views, nullifier batch/individual lookups
3. **No nullifier WS** — nullifier events can't push to frontend
4. **Mobile is polling-only** — no real-time updates, 10-30s stale data
5. **3 separate WS connections** needed for full coverage — wasteful on mobile

---

## Phase 1: Backend — Unified WebSocket endpoint

### Step 1A: Add `/ws/events` — single multiplexed event stream

**Create:** A single WS endpoint that multiplexes all event types.

The backend already has `broadcast::Sender<TreeUpdate>` and `broadcast::Sender<AnnouncementUpdate>` on `TreeCache`. We add a `broadcast::Sender<NullifierUpdate>` and combine all three into one WS handler.

**Wire format** (JSON, one message per event):
```jsonc
// Tree update
{"type": "leaf_inserted", "leaf_index": 5, "commitment": "0xabc...", "new_root": "0xdef..."}

// Nullifier spent
{"type": "nullifier_spent", "nullifier_hash": "0xabc...", "slot": 12345}

// Stealth announcement
{"type": "stealth_announcement", "leaf_index": 5, "announcement_type": 0, "ephemeral_pub": "...", "encrypted_amount": "...", "commitment": "..."}

// Deposit status
{"type": "deposit_update", "deposit_id": "...", "status": "confirming", "confirmations": 3, ...}
```

**Backend changes:**
- `src/event_indexer/tree_cache.rs` — add `broadcast::Sender<NullifierUpdate>`, add `broadcast_nullifier()`, add `subscribe_nullifiers()`
- `src/event_indexer/solana_ws.rs` — call `tree_cache.broadcast_nullifier()` on NullifierSpent events
- `src/event_indexer/service.rs` — same for poll-based indexer
- `src/event_indexer/routes.rs` — add `WS /ws/events` handler that merges all 3 broadcast receivers + deposit broadcast into one WS stream using `tokio::select!`
- Keep existing `/ws/tree`, `/ws/announcements`, `/ws/deposits` for backwards compat

### Step 1B: Unify indexer REST endpoints

#### Nullifiers — remove batch/individual, add status/sync

**Remove:**
- `GET /api/nullifiers/{hash}` — clients match locally after sync-all
- `POST /api/nullifiers/batch` — same; sync-all is more efficient

**Keep:**
- `GET /api/nullifiers?since=<slot>` — returns all PDAs (incremental)

**Add:**
- `GET /api/nullifiers/status` — `{ count, latest_slot }`
- `POST /api/nullifiers/sync` — force re-scan

#### Announcements — add sync

**Keep:** all existing endpoints unchanged.

**Add:**
- `POST /api/announcements/sync` — force re-scan

#### Tree — remove redundant

**Remove:**
- `GET /api/tree/root` — redundant with `/api/tree/status`
- `GET /api/tree/leaves` — use `/api/announcements` instead (richer data)

**Keep:** `status`, `proof`, `sync`, `reset`

### Step 1C: Global sync/reset

- `POST /api/sync` — triggers sync for all resources
- `POST /api/reset` — clears and rebuilds everything

---

## Phase 2: Frontend — WebSocket-driven reactive updates

### Step 2A: Shared `useEventStream` hook (mobile)

**Create:** `aegis-mobile/hooks/use-event-stream.ts`

```typescript
/**
 * Connects to /ws/events and dispatches events to SWR mutators.
 * Single connection, auto-reconnect, multiplexed events.
 */
export function useEventStream() {
  // Connect to WS /ws/events
  // On "leaf_inserted" → mutate commitments SWR cache
  // On "nullifier_spent" → mutate nullifiers SWR cache
  // On "stealth_announcement" → mutate announcements SWR cache
  // On "deposit_update" → update deposit status state
  // Auto-reconnect with 5s backoff
}
```

This hook is mounted once at the app root (in `_layout.tsx` or `providers.tsx`). It doesn't render anything — it just keeps the SWR caches fresh by calling `mutate()` on the relevant keys when events arrive.

### Step 2B: Update existing hooks to be WS-aware

**`hooks/use-explorer.ts`** — Add SWR `mutate` integration:
- `useCommitments()` — SWR fetches initial data; WS `leaf_inserted` events call `mutate()` to append
- `useNullifiers()` — SWR fetches initial data; WS `nullifier_spent` events call `mutate()`
- Remove `useProofs()` (not a real resource — proofs are part of tree)

**`hooks/use-deposit-status.ts`** — Replace 10s polling with WS:
- On WS `deposit_update` matching the address, update state immediately
- Keep polling as fallback only when WS is disconnected

**`hooks/use-pool-stats.ts`** — Reduce polling to 60s (WS handles tree changes):
- On any `leaf_inserted` event, `mutate()` pool stats

### Step 2C: Update activity screen

**`app/(tabs)/activity.tsx`** — Mount `useEventStream()` and react to changes:
- Pull-to-refresh still works (calls `mutate()` on all keys)
- New items appear instantly via WS push
- Activity indicator shows WS connection status

---

## Phase 3: Simplify deposit endpoints + mempool

### Step 3A: Consolidate deposit queries

**Current (8 GET):**
```
GET /api/deposits                   → all
GET /api/deposits/{id}              → by ID
GET /api/deposits/verified          → filtered
GET /api/deposits/by-address/{addr} → by address
GET /api/tracker/pending            → filtered
GET /api/tracker/failed             → filtered
GET /api/tracker/stats              → stats
GET /api/tracker/health             → health
```

**Proposed (3 GET):**
```
GET /api/deposits?status=&address=  → all with filters
GET /api/deposits/{id}              → by ID
GET /api/deposits/status            → stats + health
```

### Step 3B: Add mempool-aware deposit detection

For `Pending` deposits, query Esplora `GET /address/{addr}/txs/mempool` to detect unconfirmed txs. Broadcast via WS immediately.

---

## Final API Surface

### Unified WebSocket
```
WS /ws/events  — multiplexed stream of ALL event types [NEW]
```

### Indexer
```
GET  /api/tree/status
GET  /api/tree/proof?commitment=
POST /api/tree/sync
POST /api/tree/reset
GET  /api/nullifiers?since=
GET  /api/nullifiers/status          [NEW]
POST /api/nullifiers/sync            [NEW]
GET  /api/announcements?since=
GET  /api/announcements/status
POST /api/announcements/sync         [NEW]
POST /api/sync                       [NEW]
POST /api/reset                      [NEW]
```

### Deposits
```
GET  /api/deposits?status=&address=
GET  /api/deposits/{id}
GET  /api/deposits/status            [NEW]
GET  /api/pool/info
POST /api/deposits                   (authed)
POST /api/tracker/retry/{id}         (authed)
```

### Legacy WS (keep for backward compat)
```
WS /ws/tree
WS /ws/announcements
WS /ws/deposits/{id}
WS /ws/deposits
```

### Stealth + Redemption (unchanged)
```
POST /api/stealth/prepare
GET  /api/stealth/status/{id}
POST /api/stealth/announce
GET  /api/stealth/health
POST /api/redeem
GET  /api/withdrawal/status/{id}
GET  /api/relayer/meta
GET  /api/health
```

---

## Frontend File Changes

### Mobile (aegis-mobile)
| File | Change |
|------|--------|
| `hooks/use-event-stream.ts` | **NEW** — unified WS connection, dispatches to SWR mutators |
| `hooks/use-explorer.ts` | Update endpoints, integrate WS-triggered `mutate()` |
| `hooks/use-deposit-status.ts` | Replace polling with WS primary, polling fallback |
| `hooks/use-pool-stats.ts` | Reduce refresh interval, WS-triggered revalidation |
| `app/(tabs)/activity.tsx` | Mount `useEventStream`, show connection indicator |
| `lib/api.ts` | **NEW** — shared API base URL + WS URL helpers |

### Web (aegis-app) — optional follow-up
| File | Change |
|------|--------|
| `src/lib/api/events.ts` | **NEW** — `subscribeToAllEvents()` using `/ws/events` |
| `src/hooks/use-explorer.ts` | Switch from SWR polling to WS-driven updates |

---

## Execution Order

```
Phase 1A: Backend /ws/events endpoint (unified WS)
Phase 1B: Backend REST cleanup (nullifier/tree/announcement alignment)
Phase 1C: Backend global sync/reset
Phase 2A: Mobile useEventStream hook
Phase 2B: Mobile hook updates (explorer, deposit, pool)
Phase 2C: Mobile activity screen update
Phase 3A: Backend deposit endpoint consolidation
Phase 3B: Backend mempool detection
```

Phase 1A is the critical enabler — once `/ws/events` exists, both frontends can adopt it independently.

**Estimated effort:** ~400 lines new code, ~300 lines removed, 1 new WS endpoint, 5 new REST endpoints, 10 removed REST endpoints.
