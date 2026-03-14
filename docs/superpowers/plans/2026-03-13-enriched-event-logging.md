# Enriched Event Logging Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add missing data to on-chain sol_log_data events so the backend indexer (and frontend RPC fallback) can reconstruct all explorer fields from logs alone — no instruction data parsing, no mempool API, no tracker dependency.

**Architecture:** Three new/modified events close all explorer data gaps: (1) new `DepositVerified` event (0x0D) carries sweep/deposit txids + amount, emitted by verify_stealth_deposit and verify_deposit_v2; (2) `NullifierSpent`/`NullifiersBatch` gain an `instruction_disc` byte so indexer knows transact vs unshield vs redeem without parsing ix data; (3) new `UnshieldMeta` event (0x0E) carries unshield_amount + recipient, emitted by unshield and redeem instructions.

**Tech Stack:** Rust (Pinocchio), Solana sol_log_data, Backend Rust parser + storage

---

## Gap Analysis — What This Fixes

| # | Explorer gap | Current workaround | Fix |
|---|---|---|---|
| 1 | `btc_deposit_txid` / `btc_sweep_txid` null after backfill | Parse instruction data bytes [0..32] and [48..80] from verify_stealth_deposit | New `DepositVerified` event (0x0D) |
| 2 | `btc_deposit_amount_sats` null when mempool API down | HTTP call to mempool.space `/tx/{sweep_txid}` | Include `amount_sats` in `DepositVerified` event |
| 3 | `instruction_disc` unknown in fallback (always 14) | Parse first byte of Aegis instruction data from account keys | Add `instruction_disc` to `NullifierSpent` / `NullifiersBatch` |
| 4 | `isDemo` always false in RPC fallback | Need `instruction_disc` to distinguish disc=1/25 (SPV) vs disc=13 (demo) | Solved by 0x0D event existing = verified; absence = demo |
| 5 | `unshield_amount` / `unshield_recipient` null in fallback | Parse from instruction data or token balance delta | New `UnshieldMeta` event (0x0E) |
| 6 | `serviceFee` null for completed redemptions | PDA closed, fee data lost | Already in `RedemptionCompleted` event (0x07) — no change needed |

## Event Catalog (After Changes)

| Disc | Name | Layout | Changed? |
|------|------|--------|----------|
| 0x02 | NullifierSpent | disc(1) + hash(32) + op_type(1) + **ix_disc(1)** | **+1 byte** |
| 0x03 | StealthAnnouncement | disc(1) + type(1) + eph(32) + amt(8) + com(32) + idx(4) | unchanged |
| 0x07 | RedemptionCompleted | disc(1) + requester(32) + amt(8) + recv(8) + fee(8) + rid(8) + txid(32) + script_len(1) + script(var) | unchanged |
| 0x08 | RedemptionRequested | disc(1) + requester(32) + amt(8) + rid(8) + script_len(1) + script(var) | unchanged |
| 0x0A | RedemptionProcessing | disc(1) + requester(32) + amt(8) + rid(8) + slot(4) | unchanged |
| 0x0B | NullifiersBatch | disc(1) + count(1) + op_type(1) + **ix_disc(1)** + [hash(32)]×N | **+1 byte** |
| 0x0C | AnnouncementsBatch | disc(1) + count(1) + [type(1)+eph(32)+amt(8)+com(32)+idx(4)]×N | unchanged |
| **0x0D** | **DepositVerified** | **disc(1) + sweep_txid(32) + deposit_txid(32) + amount_sats(8) + leaf_index(4)** | **NEW (77 bytes)** |
| **0x0E** | **UnshieldMeta** | **disc(1) + amount(8) + recipient(32)** | **NEW (41 bytes)** |

## File Map

### Contract (Solana program)
| File | Action | Responsibility |
|------|--------|----------------|
| `contracts/programs/aegis/src/utils/events.rs` | Modify | Add 0x0D, 0x0E emitters; update 0x02/0x0B signatures |
| `contracts/programs/aegis/src/instructions/verify_stealth_deposit.rs` | Modify | Emit `DepositVerified` after announcement |
| `contracts/programs/aegis/src/instructions/verify_deposit_v2.rs` | Modify | Emit `DepositVerified` after announcement |
| `contracts/programs/aegis/src/instructions/transact.rs` | Modify | Pass `ix_disc=14` to nullifiers emit |
| `contracts/programs/aegis/src/instructions/unshield.rs` | Modify | Pass `ix_disc=15` to nullifiers emit; emit `UnshieldMeta` |
| `contracts/programs/aegis/src/instructions/redeem.rs` | Modify | Pass `ix_disc=16` to nullifiers emit; emit `UnshieldMeta` (redeem amount) |
| `contracts/programs/aegis/src/instructions/request_redemption.rs` | Modify | Pass `ix_disc=5` to nullifier emit |
| `contracts/programs/aegis/src/instructions/add_demo_stealth.rs` | No change | Demo deposits don't emit DepositVerified (that's how indexer distinguishes them) |

### Backend (Rust indexer)
| File | Action | Responsibility |
|------|--------|----------------|
| `backend/src/event_indexer/parser.rs` | Modify | Parse 0x0D, 0x0E; update 0x02/0x0B for ix_disc byte |
| `backend/src/event_indexer/service.rs` | Modify | Use parsed events instead of instruction data extraction |
| `backend/src/event_indexer/storage.rs` | No change | Columns already exist (btc_deposit_txid, instruction_disc, unshield_amount, etc.) |

---

## Chunk 1: Contract Event Changes

### Task 1: Update NullifierSpent / NullifiersBatch to include instruction_disc

**Files:**
- Modify: `contracts/programs/aegis/src/utils/events.rs`

- [ ] **Step 1: Update `emit_nullifier_spent` signature and layout**

Add `instruction_disc: u8` parameter. New layout: disc(1) + hash(32) + op_type(1) + ix_disc(1) = 35 bytes.

```rust
/// Emit when a nullifier is spent.
///
/// Layout: disc(1) + nullifier_hash(32) + op_type(1) + ix_disc(1) = 35 bytes
pub fn emit_nullifier_spent(
    nullifier_hash: &[u8; 32],
    operation_type: u8,
    instruction_disc: u8,
) {
    let disc = [EVENT_NULLIFIER_SPENT];
    let op = [operation_type];
    let ix = [instruction_disc];
    sol_log_data(&[&disc, nullifier_hash.as_ref(), &op, &ix]);
}
```

- [ ] **Step 2: Update `emit_nullifiers_batch` signature and layout**

Add `instruction_disc: u8` parameter. New layout: disc(1) + count(1) + op_type(1) + ix_disc(1) + [hash(32)]×N.

```rust
/// Layout: disc(1) + count(1) + op_type(1) + ix_disc(1) + [nullifier_hash(32)] x count
pub fn emit_nullifiers_batch(
    nullifiers: &[&[u8; 32]],
    operation_type: u8,
    instruction_disc: u8,
) {
    // For single nullifier, use the non-batch version
    if nullifiers.len() == 1 {
        emit_nullifier_spent(nullifiers[0], operation_type, instruction_disc);
        return;
    }

    let disc = [EVENT_NULLIFIERS_BATCH];
    let count = [nullifiers.len() as u8];
    let op = [operation_type];
    let ix = [instruction_disc];

    // Build slice array: disc + count + op_type + ix_disc + N hashes
    let mut slices: [&[u8]; 4 + MAX_BATCH] = [&[0u8; 0]; 4 + MAX_BATCH];
    slices[0] = &disc;
    slices[1] = &count;
    slices[2] = &op;
    slices[3] = &ix;
    let n = nullifiers.len().min(MAX_BATCH);
    for i in 0..n {
        slices[4 + i] = nullifiers[i].as_ref();
    }
    sol_log_data(&slices[..4 + n]);
}
```

- [ ] **Step 3: Update doc comment at top of file**

Update the event table in the module doc comment:
```
//! - 0x02 NullifierSpent: disc(1) + nullifier_hash(32) + op_type(1) + ix_disc(1) = 35 bytes
//! - 0x0B NullifiersBatch: disc(1) + count(1) + op_type(1) + ix_disc(1) + [hash(32)] x N
```

### Task 2: Add DepositVerified event (0x0D)

**Files:**
- Modify: `contracts/programs/aegis/src/utils/events.rs`

- [ ] **Step 1: Add constant and emitter function**

```rust
/// Event discriminator: deposit verified via SPV (carries BTC txids + amount)
const EVENT_DEPOSIT_VERIFIED: u8 = 0x0D;

/// Emit when a BTC deposit is SPV-verified on-chain.
///
/// Layout: disc(1) + sweep_txid(32) + deposit_txid(32) + amount_sats(8) + leaf_index(4) = 77 bytes
///
/// This event eliminates the need to parse instruction data or call mempool API
/// to recover BTC txids and deposit amounts during backfill.
pub fn emit_deposit_verified(
    sweep_txid: &[u8; 32],
    deposit_txid: &[u8; 32],
    amount_sats: u64,
    leaf_index: u32,
) {
    let disc = [EVENT_DEPOSIT_VERIFIED];
    let amt = amount_sats.to_le_bytes();
    let li = leaf_index.to_le_bytes();
    sol_log_data(&[&disc, sweep_txid, deposit_txid, &amt, &li]);
}
```

- [ ] **Step 2: Add to module doc comment**

```
//! - 0x0D DepositVerified: disc(1) + sweep_txid(32) + deposit_txid(32) + amount_sats(8) + leaf_index(4) = 77 bytes
```

### Task 3: Add UnshieldMeta event (0x0E)

**Files:**
- Modify: `contracts/programs/aegis/src/utils/events.rs`

- [ ] **Step 1: Add constant and emitter function**

```rust
/// Event discriminator: unshield/redeem metadata (amount + recipient)
const EVENT_UNSHIELD_META: u8 = 0x0E;

/// Emit unshield/redeem metadata so indexer doesn't need to parse instruction data.
///
/// Layout: disc(1) + amount(8) + recipient(32) = 41 bytes
///
/// Emitted by unshield (disc=15) and redeem (disc=16) instructions.
pub fn emit_unshield_meta(
    amount: u64,
    recipient: &[u8; 32],
) {
    let disc = [EVENT_UNSHIELD_META];
    let amt = amount.to_le_bytes();
    sol_log_data(&[&disc, &amt, recipient]);
}
```

- [ ] **Step 2: Add to module doc comment**

```
//! - 0x0E UnshieldMeta: disc(1) + amount(8) + recipient(32) = 41 bytes
```

### Task 4: Update all instruction call sites for new signatures

**Files:**
- Modify: `contracts/programs/aegis/src/instructions/transact.rs`
- Modify: `contracts/programs/aegis/src/instructions/unshield.rs`
- Modify: `contracts/programs/aegis/src/instructions/redeem.rs`
- Modify: `contracts/programs/aegis/src/instructions/request_redemption.rs`
- Modify: `contracts/programs/aegis/src/instructions/verify_stealth_deposit.rs`
- Modify: `contracts/programs/aegis/src/instructions/verify_deposit_v2.rs`

- [ ] **Step 1: transact.rs — pass ix_disc=14**

At `emit_nullifiers_batch` call (~line 311):
```rust
crate::utils::events::emit_nullifiers_batch(
    &null_hashes[..n_inputs],
    NullifierOperationType::PrivateTransfer as u8,
    14, // instruction::TRANSACT
);
```

- [ ] **Step 2: unshield.rs — pass ix_disc=15 + emit UnshieldMeta**

At `emit_nullifiers_batch` call (~line 323):
```rust
crate::utils::events::emit_nullifiers_batch(
    &nullifiers[..n_inputs],
    NullifierOperationType::FullWithdrawal as u8,
    15, // instruction::UNSHIELD
);
```

After the tree insertion loop, before the token transfer (~line 355), emit:
```rust
// Emit unshield metadata for indexer
crate::utils::events::emit_unshield_meta(
    unshield_amount,
    unshield_address,
);
```

Where `unshield_address` is the 32-byte pubkey already parsed from instruction data. The variable `unshield_amount` is already a `u64`. Check exact variable names in unshield.rs — the recipient pubkey is parsed as `unshield_address: &[u8; 32]` from instruction data.

- [ ] **Step 3: redeem.rs — pass ix_disc=16 + emit UnshieldMeta**

At `emit_nullifiers_batch` call (~line 335):
```rust
crate::utils::events::emit_nullifiers_batch(
    &nullifiers[..n_inputs],
    NullifierOperationType::FullWithdrawal as u8,
    16, // instruction::REDEEM
);
```

After tree insertion loop, before RedemptionRequest PDA creation, emit:
```rust
// Emit redeem metadata for indexer (amount going to BTC withdrawal)
crate::utils::events::emit_unshield_meta(
    redeem_amount,
    user.key().as_ref().try_into().unwrap(),
);
```

Here `redeem_amount` is the BTC amount being redeemed, and `user.key()` is the requester.

- [ ] **Step 4: request_redemption.rs — pass ix_disc=5**

At `emit_nullifier_spent` call (~line 273):
```rust
crate::utils::events::emit_nullifier_spent(
    &ix_data.nullifier_hash,
    NullifierOperationType::FullWithdrawal as u8,
    5, // instruction::REQUEST_REDEMPTION
);
```

- [ ] **Step 5: verify_stealth_deposit.rs — emit DepositVerified**

After the existing `emit_stealth_announcement` call (~line 344), add:
```rust
// Emit deposit verified event (carries BTC txids + amount for indexer backfill)
crate::utils::events::emit_deposit_verified(
    &sweep_txid,
    &deposit_txid,
    amount_sats,
    leaf_index as u32,
);
```

The variables `sweep_txid: [u8; 32]`, `deposit_txid: [u8; 32]`, and `amount_sats: u64` are already parsed from instruction data earlier in the function. `leaf_index` is returned from `tree.insert_leaf()`.

- [ ] **Step 6: verify_deposit_v2.rs — emit DepositVerified**

Same pattern as verify_stealth_deposit. After `emit_stealth_announcement`, add `emit_deposit_verified`. Check exact variable names — should be similar.

- [ ] **Step 7: Build contract**

```bash
cd contracts && cargo build-sbf --features devnet
```
Expected: compiles with zero errors.

- [ ] **Step 8: Run contract tests**

```bash
cd contracts && cargo test
```
Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add contracts/programs/aegis/src/utils/events.rs \
        contracts/programs/aegis/src/instructions/transact.rs \
        contracts/programs/aegis/src/instructions/unshield.rs \
        contracts/programs/aegis/src/instructions/redeem.rs \
        contracts/programs/aegis/src/instructions/request_redemption.rs \
        contracts/programs/aegis/src/instructions/verify_stealth_deposit.rs \
        contracts/programs/aegis/src/instructions/verify_deposit_v2.rs
git commit -m "feat(contract): add DepositVerified(0x0D), UnshieldMeta(0x0E) events, add ix_disc to nullifier events"
```

---

## Chunk 2: Backend Parser + Service Changes

### Task 5: Update parser for new event formats

**Files:**
- Modify: `backend/src/event_indexer/parser.rs`

- [ ] **Step 1: Add new event structs**

```rust
/// Parsed deposit verified event (BTC txids + amount from SPV verification)
#[derive(Debug, Clone, serde::Serialize)]
pub struct DepositVerifiedEvent {
    pub sweep_txid: [u8; 32],
    pub deposit_txid: [u8; 32],
    pub amount_sats: u64,
    pub leaf_index: u32,
}

/// Parsed unshield/redeem metadata event
#[derive(Debug, Clone, serde::Serialize)]
pub struct UnshieldMetaEvent {
    pub amount: u64,
    pub recipient: [u8; 32],
}
```

- [ ] **Step 2: Add `instruction_disc` field to NullifierSpentEvent**

```rust
pub struct NullifierSpentEvent {
    pub nullifier_hash: [u8; 32],
    pub operation_type: u8,
    pub instruction_disc: Option<u8>, // New: None for old events without this field
}
```

- [ ] **Step 3: Add variants to ProgramEvent enum**

```rust
pub enum ProgramEvent {
    NullifierSpent(NullifierSpentEvent),
    StealthAnnouncement(StealthAnnouncementEvent),
    RedemptionCompleted(RedemptionCompletedEvent),
    RedemptionRequested(RedemptionRequestedEvent),
    RedemptionProcessing(RedemptionProcessingEvent),
    DepositVerified(DepositVerifiedEvent),
    UnshieldMeta(UnshieldMetaEvent),
}
```

- [ ] **Step 4: Add constants**

```rust
const EVENT_DEPOSIT_VERIFIED: u8 = 0x0D;
const EVENT_UNSHIELD_META: u8 = 0x0E;
```

- [ ] **Step 5: Update `parse_nullifier_spent` for optional ix_disc**

```rust
fn parse_nullifier_spent(segments: &[Vec<u8>]) -> Option<NullifierSpentEvent> {
    if segments.len() < 3 {
        return None;
    }
    if segments[1].len() != 32 || segments[2].len() != 1 {
        return None;
    }

    let mut nullifier_hash = [0u8; 32];
    nullifier_hash.copy_from_slice(&segments[1]);

    // ix_disc is optional (backwards compat with old events)
    let instruction_disc = if segments.len() >= 4 && segments[3].len() == 1 {
        Some(segments[3][0])
    } else {
        None
    };

    Some(NullifierSpentEvent {
        nullifier_hash,
        operation_type: segments[2][0],
        instruction_disc,
    })
}
```

- [ ] **Step 6: Update `parse_nullifiers_batch` (flat) for ix_disc**

New layout: disc(1) + count(1) + op_type(1) + ix_disc(1) + [hash(32)]×N

```rust
fn parse_nullifiers_batch(data: &[u8]) -> Vec<NullifierSpentEvent> {
    if data.len() < 4 {
        return Vec::new();
    }

    let count = data[1] as usize;
    let op_type = data[2];
    let ix_disc = data[3];

    let expected_len = 4 + count * 32;
    if data.len() < expected_len {
        // Backwards compat: try old format (3 + count * 32)
        let old_expected = 3 + count * 32;
        if data.len() >= old_expected {
            // Old format without ix_disc
            let mut events = Vec::with_capacity(count);
            for i in 0..count {
                let offset = 3 + i * 32;
                let mut nullifier_hash = [0u8; 32];
                nullifier_hash.copy_from_slice(&data[offset..offset + 32]);
                events.push(NullifierSpentEvent {
                    nullifier_hash,
                    operation_type: op_type,
                    instruction_disc: None,
                });
            }
            return events;
        }
        return Vec::new();
    }

    let mut events = Vec::with_capacity(count);
    for i in 0..count {
        let offset = 4 + i * 32;
        let mut nullifier_hash = [0u8; 32];
        nullifier_hash.copy_from_slice(&data[offset..offset + 32]);
        events.push(NullifierSpentEvent {
            nullifier_hash,
            operation_type: op_type,
            instruction_disc: Some(ix_disc),
        });
    }

    events
}
```

- [ ] **Step 7: Update `parse_nullifiers_batch_segments` for ix_disc**

New layout: segments[0]=disc, segments[1]=count, segments[2]=op_type, segments[3]=ix_disc, segments[4..]=hashes

```rust
fn parse_nullifiers_batch_segments(segments: &[Vec<u8>]) -> Vec<NullifierSpentEvent> {
    // New format: disc(1) + count(1) + op_type(1) + ix_disc(1) + [hash(32)]×N
    if segments.len() < 5 && segments.len() >= 4 {
        // Could be old format (no ix_disc), 3 header segments + hashes
        if segments[1].len() == 1 && segments[2].len() == 1 && segments.get(3).map_or(false, |s| s.len() == 32) {
            let count = segments[1][0] as usize;
            let op_type = segments[2][0];
            let mut events = Vec::with_capacity(count);
            for i in 0..count {
                let idx = 3 + i;
                if idx >= segments.len() || segments[idx].len() != 32 { break; }
                let mut nullifier_hash = [0u8; 32];
                nullifier_hash.copy_from_slice(&segments[idx]);
                events.push(NullifierSpentEvent { nullifier_hash, operation_type: op_type, instruction_disc: None });
            }
            return events;
        }
        return Vec::new();
    }
    if segments.len() < 5 { return Vec::new(); }
    if segments[1].len() != 1 || segments[2].len() != 1 || segments[3].len() != 1 { return Vec::new(); }

    let count = segments[1][0] as usize;
    let op_type = segments[2][0];
    let ix_disc = segments[3][0];

    let mut events = Vec::with_capacity(count);
    for i in 0..count {
        let idx = 4 + i;
        if idx >= segments.len() || segments[idx].len() != 32 { break; }
        let mut nullifier_hash = [0u8; 32];
        nullifier_hash.copy_from_slice(&segments[idx]);
        events.push(NullifierSpentEvent { nullifier_hash, operation_type: op_type, instruction_disc: Some(ix_disc) });
    }

    events
}
```

- [ ] **Step 8: Add parsers for 0x0D and 0x0E**

```rust
fn parse_deposit_verified(segments: &[Vec<u8>]) -> Option<DepositVerifiedEvent> {
    // disc(1) + sweep_txid(32) + deposit_txid(32) + amount_sats(8) + leaf_index(4)
    if segments.len() < 5 { return None; }
    if segments[1].len() != 32 || segments[2].len() != 32 || segments[3].len() != 8 || segments[4].len() != 4 {
        return None;
    }
    Some(DepositVerifiedEvent {
        sweep_txid: read_bytes32(&segments[1])?,
        deposit_txid: read_bytes32(&segments[2])?,
        amount_sats: read_u64(&segments[3])?,
        leaf_index: u32::from_le_bytes(segments[4][..4].try_into().ok()?),
    })
}

fn parse_unshield_meta(segments: &[Vec<u8>]) -> Option<UnshieldMetaEvent> {
    // disc(1) + amount(8) + recipient(32)
    if segments.len() < 3 { return None; }
    if segments[1].len() != 8 || segments[2].len() != 32 { return None; }
    Some(UnshieldMetaEvent {
        amount: read_u64(&segments[1])?,
        recipient: read_bytes32(&segments[2])?,
    })
}
```

- [ ] **Step 9: Add match arms in `parse_program_events`**

In the `match disc` block:
```rust
EVENT_DEPOSIT_VERIFIED => {
    if let Some(event) = parse_deposit_verified(&segments) {
        events.push(ProgramEvent::DepositVerified(event));
    }
}
EVENT_UNSHIELD_META => {
    if let Some(event) = parse_unshield_meta(&segments) {
        events.push(ProgramEvent::UnshieldMeta(event));
    }
}
```

- [ ] **Step 10: Add unit tests**

```rust
#[test]
fn test_parse_deposit_verified() {
    let sweep = [0xAAu8; 32];
    let deposit = [0xBBu8; 32];
    let amount = 50000u64.to_le_bytes();
    let leaf_idx = 7u32.to_le_bytes();

    let log = encode_segments(&[&[0x0D], &sweep, &deposit, &amount, &leaf_idx]);
    let events = parse_program_events(&[log]);
    assert_eq!(events.len(), 1);
    match &events[0] {
        ProgramEvent::DepositVerified(e) => {
            assert_eq!(e.sweep_txid, sweep);
            assert_eq!(e.deposit_txid, deposit);
            assert_eq!(e.amount_sats, 50000);
            assert_eq!(e.leaf_index, 7);
        }
        _ => panic!("wrong event type"),
    }
}

#[test]
fn test_parse_unshield_meta() {
    let amount = 100000u64.to_le_bytes();
    let recipient = [0xCCu8; 32];

    let log = encode_segments(&[&[0x0E], &amount, &recipient]);
    let events = parse_program_events(&[log]);
    assert_eq!(events.len(), 1);
    match &events[0] {
        ProgramEvent::UnshieldMeta(e) => {
            assert_eq!(e.amount, 100000);
            assert_eq!(e.recipient, recipient);
        }
        _ => panic!("wrong event type"),
    }
}

#[test]
fn test_parse_nullifier_with_ix_disc() {
    let hash = [0xCDu8; 32];
    let log = encode_segments(&[&[0x02], &hash, &[1u8], &[15u8]]);
    let events = parse_program_events(&[log]);
    assert_eq!(events.len(), 1);
    match &events[0] {
        ProgramEvent::NullifierSpent(e) => {
            assert_eq!(e.operation_type, 1);
            assert_eq!(e.instruction_disc, Some(15));
        }
        _ => panic!("wrong event type"),
    }
}

#[test]
fn test_parse_nullifier_without_ix_disc_backwards_compat() {
    let hash = [0xCDu8; 32];
    let log = encode_segments(&[&[0x02], &hash, &[1u8]]);
    let events = parse_program_events(&[log]);
    assert_eq!(events.len(), 1);
    match &events[0] {
        ProgramEvent::NullifierSpent(e) => {
            assert_eq!(e.operation_type, 1);
            assert_eq!(e.instruction_disc, None);
        }
        _ => panic!("wrong event type"),
    }
}
```

- [ ] **Step 11: Run backend tests**

```bash
cd backend && cargo test
```
Expected: all tests pass (including new ones).

- [ ] **Step 12: Commit**

```bash
git add backend/src/event_indexer/parser.rs
git commit -m "feat(backend): parse DepositVerified(0x0D), UnshieldMeta(0x0E), and ix_disc in nullifier events"
```

### Task 6: Update service.rs to use parsed events instead of instruction data extraction

**Files:**
- Modify: `backend/src/event_indexer/service.rs`

- [ ] **Step 1: Handle new events in `process_transaction`**

In the event loop (around line 232), add arms for the new events:

```rust
ProgramEvent::DepositVerified(e) => {
    // Override btc txids from event (more reliable than instruction data parsing)
    btc_deposit_txid_from_event = Some(Self::btc_internal_to_hex(&e.deposit_txid));
    btc_sweep_txid_from_event = Some(Self::btc_internal_to_hex(&e.sweep_txid));
    btc_deposit_amount_from_event = Some(e.amount_sats as i64);
    deposit_verified_leaf_index = Some(e.leaf_index);
}
ProgramEvent::UnshieldMeta(e) => {
    unshield_amount_from_event = Some(e.amount as i64);
    unshield_recipient_from_event = Some(bs58::encode(&e.recipient).into_string());
}
```

Declare these variables before the loop:
```rust
let mut btc_deposit_txid_from_event: Option<String> = None;
let mut btc_sweep_txid_from_event: Option<String> = None;
let mut btc_deposit_amount_from_event: Option<i64> = None;
let mut deposit_verified_leaf_index: Option<u32> = None;
let mut unshield_amount_from_event: Option<i64> = None;
let mut unshield_recipient_from_event: Option<String> = None;
```

- [ ] **Step 2: Prefer event data over instruction data extraction**

After the event loop, when passing data to `insert_announcement`, prefer event-sourced values:

```rust
// Prefer event-sourced BTC txids (0x0D) over instruction data extraction
let final_deposit_txid = btc_deposit_txid_from_event.as_deref()
    .or(tx_data.btc_deposit_txid.as_deref());
let final_sweep_txid = btc_sweep_txid_from_event.as_deref()
    .or(tx_data.btc_sweep_txid.as_deref());
let final_deposit_amount = btc_deposit_amount_from_event
    .or(tx_data.btc_deposit_amount_sats);
```

Use `final_*` in the `insert_announcement` call.

- [ ] **Step 3: Use event instruction_disc for nullifiers**

When inserting nullifiers, prefer the event's `instruction_disc` over the extracted one:

```rust
let null_disc = null.instruction_disc.or(instruction_disc);
```

Similarly, prefer event-sourced unshield data:
```rust
let final_unshield_amount = unshield_amount_from_event.or(tx_data.unshield_amount);
let final_unshield_recipient = unshield_recipient_from_event.as_deref()
    .or(tx_data.unshield_recipient.as_deref());
```

- [ ] **Step 4: Update is_verified logic**

Now `is_verified` can also be determined by presence of `DepositVerified` event:

```rust
let is_verified = matches!(tx_data.instruction_disc, Some(1) | Some(25))
    || btc_deposit_txid_from_event.is_some();
```

- [ ] **Step 5: Build and test**

```bash
cd backend && cargo build && cargo test
```
Expected: compiles, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/event_indexer/service.rs
git commit -m "feat(backend): prefer event-sourced data over instruction data extraction"
```

---

## Chunk 3: Frontend RPC Fallback (Optional Enhancement)

The frontend `rpc-fallback.ts` currently can't parse these new events because it only understands 0x03 (StealthAnnouncement). With the new events, the RPC fallback could also extract:
- `isDemo`: presence of 0x0D event = verified deposit
- `instruction_disc`: from 0x02/0x0B events
- `unshield_amount` / `unshield_recipient`: from 0x0E events

This is a lower priority since the backend handles most parsing. Skip this task unless explicitly requested.

---

## Verification

After deploying the updated contract and restarting the backend:

1. **Resync**: `POST /api/tree/reset` to re-index all transactions
2. **Check deposits**: `GET /api/announcements` — verified deposits should now have `btc_deposit_txid`, `btc_sweep_txid`, `btc_deposit_amount_sats` from the 0x0D event
3. **Check transfers**: `GET /api/transfers` — should have `instruction_disc` from events (14=transact, 15=unshield, 16=redeem)
4. **Check unshields**: Transfers with `instruction_disc=15` should have `unshield_amount` and `unshield_recipient` from the 0x0E event
5. **Compare old vs new**: For existing verified deposits, the event-sourced txids should match what instruction data extraction produces

## CU Budget Impact

| Event | Size | Est. CU cost |
|-------|------|-------------|
| NullifierSpent +1 byte | 35 bytes | +~5 CU (negligible) |
| NullifiersBatch +1 byte | +1 byte header | +~5 CU |
| DepositVerified (new) | 77 bytes | ~300 CU (one sol_log_data call) |
| UnshieldMeta (new) | 41 bytes | ~200 CU (one sol_log_data call) |

All well within Solana's 200K CU default limit. The verify_stealth_deposit instruction already uses significant CU for Poseidon hashing and Merkle insertion; 300 CU for one extra event is negligible.
