# Redemption Watcher Design

**Date**: 2026-03-06
**Status**: Approved
**Goal**: Production-ready redemption pipeline that detects on-chain RedemptionRequest PDAs, sends BTC via FROST threshold signing, and completes redemptions with SPV verification.

## Architecture Overview

```
Solana WebSocket (programSubscribe)
    |
    v
PDA Scanner (getProgramAccounts, memcmp discriminator=0x04)
    |
    v
For each RedemptionRequest PDA:
    |
    +-- status=Pending -----> mark_processing (disc=2) --> FROST sign BTC tx --> broadcast --> store (pda -> btc_txid)
    |
    +-- status=Processing --> check BTC confirmed? --> check VerifiedTransaction PDA? --> check 6+ confirmations?
    |                              |                         |                                  |
    |                           NO: skip              NO: skip (header relay pending)      NO: skip
    |                                                                                           |
    |                                                                                      YES: all 3 pass
    |                                                                                           |
    |                                                                          complete_redemption (disc=6)
    |                                                                          SPV verify + burn zkBTC + close PDA
    |
    +-- PDA closed (complete) or Failed --> skip
```

## On-Chain Instructions (Already Implemented)

| Disc | Instruction | Accounts | What it does |
|------|-------------|----------|--------------|
| 2 | `mark_processing` | pool_state(w), redemption(w), authority(s) | Pending->Processing, records slot for timeout |
| 5 | `request_redemption` | (user-initiated) | Creates RedemptionRequest PDA (Pending) |
| 6 | `complete_redemption` | pool_state(w), redemption(w), authority(s), rent_recipient, verified_tx, light_client, tx_buffer, zkbtc_mint(w), pool_vault(w), token_program | SPV verify BTC tx, burn zkBTC, close PDA |
| 3 | `cancel_redemption` | (user-initiated) | User cancels if Pending or timed-out Processing |

### RedemptionRequest PDA Layout (90 bytes)

- Seeds: `["redemption", user_pubkey, nonce_bytes]`
- Discriminator: `0x04`
- Status: `0=Pending, 1=Processing, 2=Failed`
- Fields: requester(32), amount_sats(8), btc_script(34), processing_slot(4), request_id(8)

### Security Constants

- `REDEMPTION_TIMEOUT_SLOTS = 9000` (~1 hour) - user can cancel after timeout
- `REQUIRED_CONFIRMATIONS = 6` (on-chain enforcement in complete_redemption)
- `MAX_FEE_SATS = 50_000` - tolerance for miner fee deduction

## Components

### 1. PDA Scanner (replaces BurnWatcher stub)

**Purpose**: Fetch all RedemptionRequest PDAs from Solana, parse their state.

**Implementation**:
- `getProgramAccounts` with filters:
  - `dataSize: 90` (RedemptionRequest::LEN)
  - `memcmp offset:0, bytes:[0x04]` (discriminator)
- Parse each PDA: status, requester, amount_sats, btc_script, request_id, processing_slot
- Convert btc_script bytes to bech32 address for TxBuilder
- Return grouped by status: `Vec<PendingRedemption>`, `Vec<ProcessingRedemption>`

**Security**:
- Validate PDA owner is the Aegis program
- Validate PDA seeds match expected derivation
- Reject PDAs with invalid data length or discriminator

### 2. WebSocket Listener (event-driven trigger)

**Purpose**: Detect new RedemptionRequest PDAs in real-time, trigger immediate scan.

**Implementation**:
- Solana `programSubscribe` via WebSocket (devnet: `wss://api.devnet.solana.com`)
- Filter for account changes on the Aegis program ID
- On event: signal the main loop to run an immediate tick (via `tokio::sync::Notify`)
- Falls back to polling every 30s if WS disconnects
- Reconnect with exponential backoff (1s, 2s, 4s, max 60s)

**Security**:
- WS is notification-only; all state is re-read from RPC (no trusting WS data)
- Rate-limit: max 1 scan per 5 seconds even if WS fires rapidly

### 3. Local State Store (PDA -> BTC txid mapping)

**Purpose**: Track which PDAs have been processed and their BTC txids.

**Implementation**:
- `HashMap<String, RedemptionTracking>` wrapped in `Arc<RwLock<_>>`
- Persisted to `redemption_state.json` on disk (crash recovery)
- Fields: `pda_address, btc_txid, status, created_at, last_checked`
- On startup: load from disk, reconcile with on-chain state (PDAs that no longer exist = already completed)

**Why needed**: The on-chain PDA doesn't store the BTC txid. After FROST signing and broadcasting, the backend must remember which BTC tx corresponds to which PDA.

**Security**:
- File permissions: 0600 (owner read/write only)
- Atomic writes (write to temp file, rename)

### 4. SolClient Extensions (new methods)

**Purpose**: Send `mark_processing` and `complete_redemption` instructions.

#### `send_mark_processing(redemption_pda: &Pubkey) -> Result<String, SolError>`
- Accounts: pool_state(w), redemption_pda(w), authority(s)
- Data: `[0x02]` (disc=2, no additional data)
- Authority = relayer keypair (must be pool authority)

#### `send_complete_redemption(redemption_pda, btc_txid, tx_buffer, verified_tx_pda) -> Result<String, SolError>`
- Accounts: pool_state(w), redemption_pda(w), authority(s), rent_recipient, verified_tx_pda, light_client, tx_buffer, zkbtc_mint(w), pool_vault(w), token_program
- Data: `[0x06] + btc_txid(32) + tx_size(4)`
- Pre-checks before sending:
  1. VerifiedTransaction PDA exists and matches btc_txid
  2. Light client tip >= block_height + 6
  3. BTC tx confirmed via Esplora (belt-and-suspenders)

#### `fetch_redemption_pdas() -> Result<Vec<ParsedRedemption>, SolError>`
- `getProgramAccounts` with memcmp filters
- Parse 90-byte layout into typed struct

### 5. Redemption Pipeline (updated service.rs tick loop)

**Tick flow**:

```rust
async fn tick(&self) -> Result<TickResult> {
    // Phase 1: Scan PDAs
    let pdas = self.sol_client.fetch_redemption_pdas().await?;

    // Phase 2: Process Pending PDAs
    for pda in pdas.iter().filter(|p| p.status == Pending) {
        if self.tracking.contains(&pda.address) { continue; } // already handling

        // mark_processing on-chain (blocks user cancel)
        self.sol_client.send_mark_processing(&pda.address).await?;

        // Build + FROST sign + broadcast BTC tx
        let btc_txid = self.process_new_redemption(&pda).await?;

        // Store mapping
        self.tracking.insert(pda.address, btc_txid);
    }

    // Phase 3: Complete Processing PDAs
    for pda in pdas.iter().filter(|p| p.status == Processing) {
        let Some(btc_txid) = self.tracking.get(&pda.address) else { continue; };

        // Mandatory: check BTC tx confirmed (Esplora)
        let confs = self.esplora.get_confirmations(&btc_txid).await?;
        if confs < REQUIRED_CONFIRMATIONS { continue; }

        // Check VerifiedTransaction PDA exists
        let verified_tx_pda = self.derive_verified_tx_pda(&btc_txid);
        if !self.sol_client.account_exists(&verified_tx_pda).await? { continue; }

        // Check light client has enough confirmations
        if !self.sol_client.check_lc_confirmations(&btc_txid, 6).await? { continue; }

        // All 3 checks pass -> complete on-chain (SPV verify + burn + close PDA)
        self.sol_client.send_complete_redemption(&pda.address, &btc_txid, ...).await?;

        // Clean up local tracking
        self.tracking.remove(&pda.address);
    }
}
```

### 6. Error Handling & Recovery

| Scenario | Recovery |
|----------|----------|
| FROST signing fails | Log error, mark local status as `retry`, retry next tick (max 3 attempts) |
| BTC broadcast fails | Retry broadcast (tx may already be in mempool), check via Esplora |
| mark_processing fails (PDA already Processing) | Check if we have btc_txid for it; if not, skip (another relayer may be handling) |
| complete_redemption fails (insufficient confirmations) | Retry next tick, on-chain enforces this anyway |
| Backend crash mid-signing | On restart, load tracking from disk. Processing PDAs without btc_txid = stuck. After REDEMPTION_TIMEOUT_SLOTS, user can cancel. |
| Backend crash after broadcast | On restart, reconcile: check if btc_txid is confirmed, continue completion flow |
| Header relay behind | Wait. complete_redemption will fail on-chain if confirmations insufficient |

### 7. Security Checklist

- [ ] **No double-processing**: Check local tracking before processing a Pending PDA
- [ ] **Mandatory BTC confirmation**: 3 independent checks before complete_redemption (Esplora + VerifiedTransaction PDA + light client tip)
- [ ] **Timeout safety**: REDEMPTION_TIMEOUT_SLOTS (9000 slots) lets users cancel stuck Processing requests
- [ ] **Authority validation**: Only pool authority can call mark_processing and complete_redemption (on-chain enforced)
- [ ] **PDA validation**: Verify PDA owner is Aegis program, seeds match, discriminator correct
- [ ] **Idempotent operations**: Re-calling mark_processing on already-Processing PDA fails gracefully
- [ ] **Atomic state persistence**: Write tracking state to temp file then rename
- [ ] **Rate limiting**: Max 1 PDA scan per 5 seconds even under rapid WS events
- [ ] **Retry limits**: Max 3 FROST signing attempts per redemption before marking failed
- [ ] **Amount verification**: BTC output amount matches PDA amount (minus fee tolerance, enforced on-chain via MAX_FEE_SATS)
- [ ] **No fund loss**: If anything fails after mark_processing but before BTC broadcast, user can cancel after timeout

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `backend/src/redemption/watcher.rs` | **Rewrite** | PDA Scanner replacing stub BurnWatcher |
| `backend/src/redemption/ws_redemption.rs` | **New** | WebSocket listener for program account changes |
| `backend/src/redemption/tracking.rs` | **New** | Local state store (PDA -> btc_txid) with disk persistence |
| `backend/src/sol_client.rs` | **Extend** | Add fetch_redemption_pdas, send_mark_processing, send_complete_redemption, account_exists |
| `backend/src/redemption/service.rs` | **Rewrite tick()** | New tick loop with Phase 1/2/3 pipeline |
| `backend/src/redemption/types.rs` | **Extend** | Add ParsedRedemption, RedemptionTracking types |
| `backend/src/redemption/mod.rs` | **Update** | Export new modules |

## Configuration (env vars)

| Var | Default | Purpose |
|-----|---------|---------|
| `REDEMPTION_POLL_INTERVAL_SECS` | `30` | Fallback polling interval |
| `REDEMPTION_WS_ENABLED` | `true` | Enable Solana WebSocket for real-time detection |
| `REDEMPTION_MAX_RETRIES` | `3` | Max FROST signing attempts per redemption |
| `REDEMPTION_MIN_CONFIRMATIONS` | `6` | BTC confirmations before completing (backend pre-check) |
| `REDEMPTION_STATE_FILE` | `./redemption_state.json` | Persistence file path |
