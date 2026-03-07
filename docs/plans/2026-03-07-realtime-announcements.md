# Real-Time Stealth Announcements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Production-grade real-time stealth announcement delivery: Solana `logsSubscribe` for sub-second push, event indexer poll for catch-up, REST+WS serving from backend, SDK client with fallback chain (backend WS → backend REST → direct RPC).

**Architecture:** Backend subscribes to Solana `logsSubscribe` for real-time disc=0x03 events, stores in SQLite alongside existing leaf/nullifier events, broadcasts via axum WebSocket. The existing poll loop acts as catch-up for missed events during WS reconnections. SDK provides `AnnouncementClient` with automatic fallback: backend WS (primary) → backend REST (on WS disconnect) → direct Solana RPC (last resort). Frontend store uses the SDK client instead of raw fetch.

**Tech Stack:** Rust (tokio-tungstenite, axum WS), TypeScript SDK, Zustand store

---

## Task 1: Backend Parser — Add StealthAnnouncement Event

**Files:**
- Modify: `backend/src/event_indexer/parser.rs`
- Modify: `backend/src/event_indexer/mod.rs`

**Step 1: Add `StealthAnnouncementEvent` type and parser to `parser.rs`**

After `EVENT_NULLIFIER_SPENT`:
```rust
const EVENT_STEALTH_ANNOUNCEMENT: u8 = 0x03;
```

New struct:
```rust
#[derive(Debug, Clone, serde::Serialize)]
pub struct StealthAnnouncementEvent {
    pub announcement_type: u8,    // 0=deposit, 1=transfer
    pub ephemeral_pub: [u8; 32],
    pub encrypted_amount: [u8; 8],
    pub commitment: [u8; 32],
    pub leaf_index: u32,
}
```

Add to `ProgramEvent` enum:
```rust
StealthAnnouncement(StealthAnnouncementEvent),
```

Add match arm in `parse_program_events`:
```rust
EVENT_STEALTH_ANNOUNCEMENT => {
    if let Some(event) = parse_stealth_announcement(&segments) {
        events.push(ProgramEvent::StealthAnnouncement(event));
    }
}
```

Parser function:
```rust
fn parse_stealth_announcement(segments: &[Vec<u8>]) -> Option<StealthAnnouncementEvent> {
    // disc(1) + type(1) + ephemeral_pub(32) + encrypted_amount(8) + commitment(32) + leaf_index(4)
    if segments.len() < 6 { return None; }
    if segments[1].len() != 1 || segments[2].len() != 32 || segments[3].len() != 8
       || segments[4].len() != 32 || segments[5].len() != 4 {
        return None;
    }
    let mut ephemeral_pub = [0u8; 32];
    ephemeral_pub.copy_from_slice(&segments[2]);
    let mut encrypted_amount = [0u8; 8];
    encrypted_amount.copy_from_slice(&segments[3]);
    let mut commitment = [0u8; 32];
    commitment.copy_from_slice(&segments[4]);
    let leaf_index = u32::from_le_bytes(segments[5][..4].try_into().ok()?);

    Some(StealthAnnouncementEvent {
        announcement_type: segments[1][0],
        ephemeral_pub, encrypted_amount, commitment, leaf_index,
    })
}
```

**Step 2: Add test for stealth announcement parsing**

```rust
#[test]
fn test_parse_stealth_announcement() {
    let ephemeral = [0xAAu8; 32];
    let amount = 5000u64.to_le_bytes();
    let commitment = [0xBBu8; 32];
    let leaf_index = 42u32.to_le_bytes();

    let log = encode_segments(&[
        &[EVENT_STEALTH_ANNOUNCEMENT], &[1u8], &ephemeral, &amount, &commitment, &leaf_index,
    ]);
    let events = parse_program_events(&[log]);
    assert_eq!(events.len(), 1);
    match &events[0] {
        ProgramEvent::StealthAnnouncement(e) => {
            assert_eq!(e.announcement_type, 1);
            assert_eq!(e.ephemeral_pub, ephemeral);
            assert_eq!(e.leaf_index, 42);
        }
        _ => panic!("wrong event type"),
    }
}
```

**Step 3: Update `mod.rs` exports**

Add `StealthAnnouncementEvent` to the `pub use parser::` line.

**Step 4: Run tests**

```bash
cd backend && cargo test event_indexer::parser -- --nocapture
```

**Step 5: Commit**

```bash
git add backend/src/event_indexer/parser.rs backend/src/event_indexer/mod.rs
git commit -m "feat(indexer): parse stealth announcement events (disc=0x03)"
```

---

## Task 2: Backend Storage — SQLite Table for Announcements

**Files:**
- Modify: `backend/src/event_indexer/storage.rs`

**Step 1: Add migration for `stealth_announcements` table**

In `run_migrations()`, append:
```sql
CREATE TABLE IF NOT EXISTS stealth_announcements (
    leaf_index INTEGER PRIMARY KEY,
    announcement_type INTEGER NOT NULL,
    ephemeral_pub BLOB NOT NULL,
    encrypted_amount BLOB NOT NULL,
    commitment BLOB NOT NULL,
    tx_signature TEXT NOT NULL,
    slot INTEGER NOT NULL
);
```

**Step 2: Add `AnnouncementRow` struct**

```rust
#[derive(Debug, Clone, serde::Serialize)]
pub struct AnnouncementRow {
    pub leaf_index: i64,
    pub announcement_type: i64,
    pub ephemeral_pub: String,   // hex
    pub encrypted_amount: String, // hex
    pub commitment: String,       // hex
    pub tx_signature: String,
    pub slot: i64,
}
```

**Step 3: Add `insert_announcement` and `get_announcements` methods**

```rust
pub fn insert_announcement(
    &self,
    event: &StealthAnnouncementEvent,
    tx_signature: &str,
    slot: i64,
) -> Result<bool, String> {
    let conn = self.conn()?;
    let result = conn.execute(
        "INSERT OR IGNORE INTO stealth_announcements
         (leaf_index, announcement_type, ephemeral_pub, encrypted_amount, commitment, tx_signature, slot)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            event.leaf_index as i64,
            event.announcement_type as i64,
            event.ephemeral_pub.as_slice(),
            event.encrypted_amount.as_slice(),
            event.commitment.as_slice(),
            tx_signature,
            slot,
        ],
    );
    match result {
        Ok(n) => Ok(n > 0),
        Err(e) => Err(format!("insert announcement error: {}", e)),
    }
}

pub fn get_announcements(&self, since_leaf_index: Option<i64>) -> Result<Vec<AnnouncementRow>, String> {
    let conn = self.conn()?;
    let (sql, params_vec): (&str, Vec<i64>) = if let Some(since) = since_leaf_index {
        ("SELECT leaf_index, announcement_type, ephemeral_pub, encrypted_amount, commitment, tx_signature, slot
          FROM stealth_announcements WHERE leaf_index > ?1 ORDER BY leaf_index", vec![since])
    } else {
        ("SELECT leaf_index, announcement_type, ephemeral_pub, encrypted_amount, commitment, tx_signature, slot
          FROM stealth_announcements ORDER BY leaf_index", vec![])
    };

    let mut stmt = conn.prepare(sql).map_err(|e| format!("query error: {}", e))?;
    let rows = if let Some(since) = since_leaf_index {
        stmt.query_map(params![since], Self::map_announcement_row)
    } else {
        stmt.query_map([], Self::map_announcement_row)
    }.map_err(|e| format!("query error: {}", e))?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("row error: {}", e))
}

pub fn get_announcement_count(&self) -> Result<i64, String> {
    let conn = self.conn()?;
    conn.query_row("SELECT COUNT(*) FROM stealth_announcements", [], |row| row.get(0))
        .map_err(|e| format!("query error: {}", e))
}

pub fn get_latest_announcement_leaf_index(&self) -> Result<Option<i64>, String> {
    let conn = self.conn()?;
    let result = conn.query_row(
        "SELECT MAX(leaf_index) FROM stealth_announcements", [], |row| row.get(0),
    ).map_err(|e| format!("query error: {}", e))?;
    Ok(result)
}

fn map_announcement_row(row: &rusqlite::Row) -> rusqlite::Result<AnnouncementRow> {
    let ephemeral_blob: Vec<u8> = row.get(2)?;
    let amount_blob: Vec<u8> = row.get(3)?;
    let commitment_blob: Vec<u8> = row.get(4)?;
    Ok(AnnouncementRow {
        leaf_index: row.get(0)?,
        announcement_type: row.get(1)?,
        ephemeral_pub: hex::encode(&ephemeral_blob),
        encrypted_amount: hex::encode(&amount_blob),
        commitment: hex::encode(&commitment_blob),
        tx_signature: row.get(5)?,
        slot: row.get(6)?,
    })
}
```

**Step 4: Add tests**

```rust
#[test]
fn test_insert_and_query_announcements() {
    let store = EventStore::in_memory().unwrap();
    let event = StealthAnnouncementEvent {
        announcement_type: 1,
        ephemeral_pub: [0xAA; 32],
        encrypted_amount: [0x01; 8],
        commitment: [0xBB; 32],
        leaf_index: 5,
    };
    assert!(store.insert_announcement(&event, "sig1", 100).unwrap());
    assert!(!store.insert_announcement(&event, "sig1", 100).unwrap()); // dup

    let rows = store.get_announcements(None).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].leaf_index, 5);
    assert_eq!(rows[0].announcement_type, 1);

    let rows_since = store.get_announcements(Some(5)).unwrap();
    assert_eq!(rows_since.len(), 0);

    assert_eq!(store.get_announcement_count().unwrap(), 1);
    assert_eq!(store.get_latest_announcement_leaf_index().unwrap(), Some(5));
}
```

**Step 5: Run tests and commit**

```bash
cd backend && cargo test event_indexer::storage -- --nocapture
git add backend/src/event_indexer/storage.rs
git commit -m "feat(indexer): SQLite storage for stealth announcements"
```

---

## Task 3: Backend Service — Index Stealth Announcements + Broadcast

**Files:**
- Modify: `backend/src/event_indexer/service.rs`
- Modify: `backend/src/event_indexer/tree_cache.rs`

**Step 1: Add announcement broadcast channel to `TreeCache`**

Add a second broadcast sender for announcements in `TreeCache`:
```rust
use super::parser::StealthAnnouncementEvent;

#[derive(Debug, Clone, serde::Serialize)]
pub struct AnnouncementUpdate {
    #[serde(rename = "type")]
    pub update_type: String, // "stealth_announcement"
    pub announcement_type: u8,
    pub ephemeral_pub: String,
    pub encrypted_amount: String,
    pub commitment: String,
    pub leaf_index: u32,
}
```

In `TreeCache` struct, add:
```rust
announcement_tx: broadcast::Sender<AnnouncementUpdate>,
```

In `TreeCache::new()`, init:
```rust
let (announcement_tx, _) = broadcast::channel(256);
```

Add methods:
```rust
pub fn broadcast_announcement(&self, event: &StealthAnnouncementEvent) {
    let update = AnnouncementUpdate {
        update_type: "stealth_announcement".to_string(),
        announcement_type: event.announcement_type,
        ephemeral_pub: hex::encode(event.ephemeral_pub),
        encrypted_amount: hex::encode(event.encrypted_amount),
        commitment: hex::encode(event.commitment),
        leaf_index: event.leaf_index,
    };
    let _ = self.announcement_tx.send(update);
}

pub fn subscribe_announcements(&self) -> broadcast::Receiver<AnnouncementUpdate> {
    self.announcement_tx.subscribe()
}
```

**Step 2: Handle `StealthAnnouncement` events in `service.rs`**

In `process_transaction`, add match arm after `NullifierSpent`:
```rust
ProgramEvent::StealthAnnouncement(e) => {
    let inserted = self.store.insert_announcement(&e, signature, slot)?;
    if inserted {
        if let Some(ref cache) = self.tree_cache {
            cache.broadcast_announcement(&e);
        }
    }
    tracing::debug!(leaf_index = e.leaf_index, "Indexed stealth announcement");
}
```

**Step 3: Run full backend tests and commit**

```bash
cd backend && cargo test -- --nocapture
git add backend/src/event_indexer/service.rs backend/src/event_indexer/tree_cache.rs
git commit -m "feat(indexer): index + broadcast stealth announcement events"
```

---

## Task 4: Backend Solana `logsSubscribe` — Real-Time Event Push

**Files:**
- Create: `backend/src/event_indexer/solana_ws.rs`
- Modify: `backend/src/event_indexer/mod.rs`
- Modify: `backend/src/main.rs`

**Step 1: Create `solana_ws.rs` — Solana logsSubscribe client**

This module connects to Solana's WebSocket RPC, subscribes to program logs, parses events in real-time, stores them, and broadcasts via TreeCache.

Key design:
- Exponential backoff reconnection (1s → 60s max)
- On reconnect, does NOT backfill (the poll loop handles that)
- Parses the `logsNotification` JSON format
- Deduplicates via `INSERT OR IGNORE` in SQLite

```rust
//! Solana logsSubscribe WebSocket client for real-time event detection.
//!
//! Subscribes to program log events, parses disc=0x01/0x02/0x03,
//! stores in SQLite, and broadcasts via TreeCache channels.
//! The existing poll loop in service.rs acts as catch-up for any
//! events missed during WS reconnections.

use std::sync::Arc;
use std::time::Duration;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use super::parser::{parse_program_events, ProgramEvent};
use super::storage::EventStore;
use super::tree_cache::TreeCache;

pub struct SolanaWsConfig {
    pub ws_url: String,           // e.g. wss://api.devnet.solana.com
    pub program_id: String,
}

pub struct SolanaWsSubscriber {
    config: SolanaWsConfig,
    store: Arc<EventStore>,
    tree_cache: Arc<TreeCache>,
}
```

The `run()` loop:
1. Connect to `ws_url`
2. Send `logsSubscribe` JSON-RPC: `{"jsonrpc":"2.0","id":1,"method":"logsSubscribe","params":[{"mentions":["<program_id>"]},{"commitment":"confirmed"}]}`
3. On each `logsNotification`, extract `result.value.logs` array
4. Call `parse_program_events(logs)` (same parser as poll loop)
5. For each event: insert into store, broadcast via tree_cache
6. On disconnect: exponential backoff, reconnect

**Step 2: Wire into `main.rs`**

After `indexer_service` is created, spawn `SolanaWsSubscriber`:
```rust
let solana_ws_url = env::var("SOLANA_WS_URL")
    .unwrap_or_else(|_| solana_rpc.replace("https://", "wss://").replace("http://", "ws://"));

let ws_subscriber = SolanaWsSubscriber::new(
    SolanaWsConfig { ws_url: solana_ws_url, program_id: aegis_program_id.clone() },
    event_store.clone(),
    tree_cache.clone(),
);
tokio::spawn(async move { ws_subscriber.run().await; });
```

**Step 3: Update `mod.rs` exports**

Add `pub mod solana_ws;` and re-export.

**Step 4: Build and verify**

```bash
cd backend && cargo build
```

**Step 5: Commit**

```bash
git add backend/src/event_indexer/solana_ws.rs backend/src/event_indexer/mod.rs backend/src/main.rs
git commit -m "feat(indexer): Solana logsSubscribe for real-time event push"
```

---

## Task 5: Backend REST + WS Routes for Announcements

**Files:**
- Modify: `backend/src/event_indexer/routes.rs`

**Step 1: Add REST endpoints**

New types:
```rust
#[derive(Debug, Deserialize)]
pub struct AnnouncementsQuery {
    pub since: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct AnnouncementsResponse {
    pub success: bool,
    pub announcements: Vec<super::storage::AnnouncementRow>,
    pub count: usize,
    pub latest_leaf_index: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct AnnouncementsStatusResponse {
    pub count: i64,
    pub latest_leaf_index: Option<i64>,
    pub tree_next_index: u64,
}
```

New handlers:
```rust
async fn get_announcements(
    State(state): State<IndexerAppState>,
    Query(params): Query<AnnouncementsQuery>,
) -> Json<AnnouncementsResponse> {
    match state.store.get_announcements(params.since) {
        Ok(announcements) => {
            let count = announcements.len();
            let latest = state.store.get_latest_announcement_leaf_index().ok().flatten();
            Json(AnnouncementsResponse { success: true, announcements, count, latest_leaf_index: latest })
        }
        Err(e) => {
            tracing::error!(error = %e, "Failed to get announcements");
            Json(AnnouncementsResponse { success: true, announcements: vec![], count: 0, latest_leaf_index: None })
        }
    }
}

async fn get_announcements_status(
    State(state): State<IndexerAppState>,
) -> Json<AnnouncementsStatusResponse> {
    let count = state.store.get_announcement_count().unwrap_or(0);
    let latest = state.store.get_latest_announcement_leaf_index().ok().flatten();
    let tree_status = state.tree_cache.get_status().await;
    Json(AnnouncementsStatusResponse { count, latest_leaf_index: latest, tree_next_index: tree_status.next_index })
}
```

**Step 2: Add WS endpoint `/ws/announcements`**

```rust
async fn ws_announcements_handler(
    ws: WebSocketUpgrade,
    State(state): State<IndexerAppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_announcements_socket(socket, state.tree_cache))
}

async fn handle_announcements_socket(socket: WebSocket, tree_cache: Arc<TreeCache>) {
    let (mut sender, mut receiver) = socket.split();
    let mut rx = tree_cache.subscribe_announcements();

    let send_task = tokio::spawn(async move {
        while let Ok(update) = rx.recv().await {
            let json = match serde_json::to_string(&update) {
                Ok(j) => j,
                Err(_) => continue,
            };
            if sender.send(Message::Text(json.into())).await.is_err() {
                break;
            }
        }
    });

    let recv_task = tokio::spawn(async move {
        while let Some(msg) = receiver.next().await {
            match msg {
                Ok(Message::Close(_)) => break,
                Err(_) => break,
                _ => {}
            }
        }
    });

    tokio::select! {
        _ = send_task => {},
        _ = recv_task => {},
    }
}
```

**Step 3: Register routes in `event_indexer_router`**

Add to the router chain:
```rust
.route("/api/announcements", get(get_announcements))
.route("/api/announcements/status", get(get_announcements_status))
.route("/ws/announcements", get(ws_announcements_handler))
```

**Step 4: Build, verify, commit**

```bash
cd backend && cargo build
git add backend/src/event_indexer/routes.rs
git commit -m "feat(indexer): REST + WS endpoints for stealth announcements"
```

---

## Task 6: SDK — `AnnouncementClient` with Fallback Chain

**Files:**
- Create: `sdk/src/announcement-client.ts`
- Modify: `sdk/src/index.ts`

**Step 1: Create `AnnouncementClient`**

The client manages three data sources with automatic fallback:
1. **Backend WS** (primary) — sub-second real-time push
2. **Backend REST** (secondary) — on WS disconnect or initial load
3. **Direct Solana RPC** (last resort) — if backend is unavailable

Key features:
- Consistency check: compare backend's `latestLeafIndex` vs on-chain `nextIndex`
- If backend is behind by >2 leaves, supplement with direct RPC scan for the gap
- Timeout-based fallback: REST timeout 5s, WS reconnect after 10s disconnect
- Exponential backoff WS reconnection (1s → 30s)
- Event emitter for new announcements (frontend subscribes)

```typescript
export interface AnnouncementClientConfig {
  /** Backend REST URL, e.g. "http://localhost:8080" */
  backendUrl: string;
  /** Backend WS URL, e.g. "ws://localhost:8080" */
  backendWsUrl?: string;
  /** Solana RPC URL (fallback) */
  solanaRpcUrl: string;
  /** Aegis program ID (for direct RPC fallback) */
  programId: string;
  /** REST timeout in ms (default 5000) */
  restTimeoutMs?: number;
  /** WS reconnect max delay in ms (default 30000) */
  wsMaxReconnectMs?: number;
  /** Max leaves backend can be behind before supplementing with RPC (default 2) */
  maxLagLeaves?: number;
}

export type AnnouncementListener = (announcements: OnChainStealthAnnouncement[]) => void;

export class AnnouncementClient {
  private ws: WebSocket | null = null;
  private wsReconnectDelay = 1000;
  private wsConnected = false;
  private listeners: Set<AnnouncementListener> = new Set();
  private cachedAnnouncements: OnChainStealthAnnouncement[] = [];
  private latestLeafIndex = -1;
  private backendHealthy = true;
  private closed = false;

  constructor(private config: AnnouncementClientConfig) {}

  /** Start WebSocket connection and initial data load */
  async start(): Promise<void>;

  /** Fetch all announcements (uses fallback chain) */
  async fetchAll(): Promise<OnChainStealthAnnouncement[]>;

  /** Subscribe to new announcement events */
  onAnnouncement(listener: AnnouncementListener): () => void;

  /** Stop client, close WS */
  close(): void;

  // Internal methods:
  private async fetchFromBackend(since?: number): Promise<OnChainStealthAnnouncement[]>;
  private async fetchFromRpc(since?: number): Promise<OnChainStealthAnnouncement[]>;
  private async checkConsistency(): Promise<void>;
  private connectWs(): void;
  private scheduleReconnect(): void;
}
```

The `fetchAll()` method:
1. Try backend REST with timeout
2. If success, check consistency (compare `latestLeafIndex` from backend vs on-chain `nextIndex`)
3. If backend behind by > `maxLagLeaves`, supplement gap from direct RPC
4. If backend REST fails entirely, fall to direct RPC

The WS connection:
1. Connect to `${backendWsUrl}/ws/announcements`
2. On message: parse `AnnouncementUpdate`, convert to `OnChainStealthAnnouncement`, emit to listeners, update cache
3. On close: schedule reconnect with exponential backoff
4. On reconnect: fetch missed announcements via REST `?since=latestLeafIndex`

**Step 2: Export from `sdk/src/index.ts`**

```typescript
export { AnnouncementClient, type AnnouncementClientConfig, type AnnouncementListener } from "./announcement-client";
```

**Step 3: Build SDK**

```bash
cd sdk && bun run build
```

**Step 4: Commit**

```bash
git add sdk/src/announcement-client.ts sdk/src/index.ts
git commit -m "feat(sdk): AnnouncementClient with WS + REST + RPC fallback chain"
```

---

## Task 7: Frontend Store — Use `AnnouncementClient`

**Files:**
- Modify: `aegis-app/src/stores/aegis-store.ts`

**Step 1: Initialize `AnnouncementClient` as module-level singleton**

```typescript
import { AnnouncementClient } from "@aegis/sdk";

let announcementClient: AnnouncementClient | null = null;

function getAnnouncementClient(): AnnouncementClient {
  if (!announcementClient) {
    const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8080";
    const wsUrl = backendUrl.replace("http://", "ws://").replace("https://", "wss://");
    announcementClient = new AnnouncementClient({
      backendUrl,
      backendWsUrl: wsUrl,
      solanaRpcUrl: process.env.NEXT_PUBLIC_HELIUS_RPC_URL || "https://api.devnet.solana.com",
      programId: DEVNET_CONFIG.aegisProgramId,
    });
  }
  return announcementClient;
}
```

**Step 2: Update `refreshInbox` to use client**

Replace the `fetch("/api/stealth/announcements")` block with:
```typescript
const client = getAnnouncementClient();
const announcements = await client.fetchAll();
```

The rest of `refreshInbox` (scanning, nullifier checks) stays the same.

**Step 3: Subscribe to real-time updates**

Add a `startRealtimeInbox()` action that:
1. Gets the `AnnouncementClient`
2. Calls `client.start()` to open WS
3. Subscribes `client.onAnnouncement(...)` → triggers `refreshInbox()` on new announcements
4. Returns unsubscribe function for cleanup

**Step 4: Build and verify**

```bash
cd aegis-app && bun run build
```

**Step 5: Commit**

```bash
git add aegis-app/src/stores/aegis-store.ts
git commit -m "feat(frontend): real-time announcement updates via AnnouncementClient"
```

---

## Task 8: Update Next.js Announcements Route as RPC Fallback

**Files:**
- Modify: `aegis-app/src/app/api/stealth/announcements/route.ts`

**Step 1: Simplify to pure RPC fallback**

The Next.js route now serves as the last-resort fallback when the backend is unavailable. It already fetches from both PDAs (legacy deposits) and tx log events (new transfers). No changes needed to the route itself — it was updated in the previous session.

**Step 2: Add backend proxy mode**

Add logic at the top of the GET handler: try to proxy to the backend first, fall back to direct RPC if backend is down. This gives the Next.js route the same fallback behavior as the SDK:

```typescript
// Try backend first (faster, has full history)
try {
  const backendUrl = process.env.BACKEND_URL || "http://localhost:8080";
  const backendResp = await fetch(`${backendUrl}/api/announcements`, {
    signal: AbortSignal.timeout(3000),
  });
  if (backendResp.ok) {
    const data = await backendResp.json();
    return NextResponse.json({
      success: true,
      announcements: data.announcements,
      count: data.count,
      cachedAt: Date.now(),
      cacheAge: 0,
      source: "backend",
    });
  }
} catch {
  console.warn("[StealthAPI] Backend unavailable, falling back to direct RPC");
}
// ... existing RPC fallback code ...
```

**Step 3: Commit**

```bash
git add aegis-app/src/app/api/stealth/announcements/route.ts
git commit -m "feat(api): proxy announcements through backend with RPC fallback"
```

---

## Task 9: Integration Test

**Step 1: Verify backend compiles and starts**

```bash
cd backend && cargo build
```

**Step 2: Verify SDK compiles**

```bash
cd sdk && bun run build
```

**Step 3: Verify frontend compiles**

```bash
cd aegis-app && bun run build
```

**Step 4: Manual integration test**

1. Start backend: `cd backend && cargo run`
2. Verify endpoints:
   - `curl http://localhost:8080/api/announcements` → `{"success":true,"announcements":[],...}`
   - `curl http://localhost:8080/api/announcements/status` → `{"count":0,...}`
3. Connect to WS: `wscat -c ws://localhost:8080/ws/announcements` → connection holds open
4. Start frontend: `cd aegis-app && bun run dev` → inbox loads via backend

**Step 5: Final commit**

```bash
git add -A
git commit -m "feat: production real-time announcement system with fallback chain"
```

---

## Data Flow Summary

```
Solana TX confirmed
    ├── logsSubscribe (sub-second) ──→ parser ──→ SQLite + broadcast
    │                                                      ↓
    └── poll loop (5-10s catch-up) ──→ parser ──→ SQLite + broadcast
                                                           ↓
                                            ┌──────────────┴──────────────┐
                                            │                             │
                                    /ws/announcements              /api/announcements
                                    (real-time push)               (REST, initial load)
                                            │                             │
                                            └──────────┬──────────────────┘
                                                       ↓
                                              SDK AnnouncementClient
                                         (WS primary → REST → RPC fallback)
                                                       ↓
                                               Frontend Zustand Store
                                         (scan locally → display inbox)
```

## Failure Modes & Recovery

| Failure | Detection | Recovery |
|---------|-----------|----------|
| Solana WS drop | `on_close` callback | Exponential backoff reconnect; poll loop fills gap |
| Backend WS drop | Client `onclose` | Exponential backoff; fetch missed via REST `?since=` |
| Backend REST down | Timeout (5s) | Fall to direct Solana RPC (Next.js route) |
| Backend indexing lag | Consistency check: `latestLeafIndex` < `nextIndex - 2` | Supplement gap from direct RPC |
| SQLite corruption | Insert errors | Logged; poll loop retries; WS still broadcasts |
