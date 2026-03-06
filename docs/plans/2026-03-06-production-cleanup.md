# Production Cleanup — Full Sweep Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove all deprecated, redundant, and dead code across all 5 components to prepare for production.

**Architecture:** Systematic bottom-up cleanup: backend (biggest mess — 7 duplicate module pairs) → contracts (minor dead code) → SDK (deprecated functions, redundant modules) → frontend (1 TODO). Each task is a self-contained commit.

**Tech Stack:** Rust (Pinocchio, Axum, Tokio), TypeScript (Next.js, snarkjs, @solana/kit)

---

## Phase 1: Backend — Remove Legacy Duplicate Modules

The backend has a new modular structure (`bitcoin/`, `solana/`, `common/`, `api/`) AND legacy flat modules coexisting. Legacy modules are imported by `main.rs`, `api_server.rs`, `redemption/`, `deposit_tracker/`, and 2 test binaries. The strategy: update all imports to use new modules, then delete legacy files.

### Task 1: Map all legacy imports and verify new module equivalents

**Files:**
- Read: `backend/src/lib.rs`
- Read: `backend/src/main.rs`
- Read: `backend/src/api_server.rs`
- Read: `backend/src/redemption/service.rs`, `signer.rs`, `builder.rs`, `watcher.rs`
- Read: `backend/src/deposit_tracker/sweeper.rs`
- Read: `backend/src/bin/redemption.rs`, `test_frost_redemption.rs`, `test_frost_sweep.rs`

**Step 1: Document exact import mapping**

Current legacy imports that need updating:

| File | Legacy Import | New Module Path |
|------|--------------|-----------------|
| `main.rs:17` | `use zkbtc::api_server as api` | Keep (api_server.rs is still the active API, `api/` is skeleton) |
| `main.rs:508` | `use zkbtc::taproot::{...}` | `use zkbtc::bitcoin::taproot::{...}` |
| `bin/redemption.rs:14` | `use zkbtc::sol_client::{SolClient, SolConfig}` | `use zkbtc::solana::client::{SolClient, SolConfig}` |
| `bin/test_frost_sweep.rs:18` | `use zkbtc::frost_client::FrostClient` | `use zkbtc::bitcoin::frost_client::FrostClient` |
| `bin/test_frost_redemption.rs:17` | `use zkbtc::frost_client::FrostClient` | `use zkbtc::bitcoin::frost_client::FrostClient` |
| `redemption/builder.rs:12` | `use crate::frost_client::SolanaVerification` | `use crate::bitcoin::frost_client::SolanaVerification` |
| `redemption/signer.rs:14` | `use crate::frost_client::{FrostClient, PrevoutInfo, SigningContext}` | `use crate::bitcoin::frost_client::{...}` |
| `redemption/service.rs:12` | `use crate::esplora::EsploraClient` | `use crate::bitcoin::client::EsploraClient` (verify name) |
| `redemption/service.rs:20` | `use crate::sol_client::SolClient` | `use crate::solana::client::SolClient` |
| `redemption/watcher.rs:6` | `use crate::sol_client::SolClient` | `use crate::solana::client::SolClient` |
| `deposit_tracker/sweeper.rs:26` | `use crate::frost_client::{FrostClient, PrevoutInfo, SigningContext}` | `use crate::bitcoin::frost_client::{...}` |

**Step 2: Verify new modules export the same types**

Check that `bitcoin::frost_client` exports `FrostClient`, `PrevoutInfo`, `SigningContext`, `SolanaVerification`.
Check that `bitcoin::client` exports an Esplora client (may be named differently than `esplora.rs`).
Check that `solana::client` exports `SolClient`, `SolConfig`.

**Step 3: Commit plan (no code changes yet)**

This is a research-only task.

---

### Task 2: Verify new `bitcoin::frost_client` has all types needed by consumers

**Files:**
- Read: `backend/src/bitcoin/frost_client.rs`
- Read: `backend/src/frost_client.rs` (legacy)
- Compare exports

**Step 1: Read both files and compare exported types/functions**

The legacy `frost_client.rs` (575 lines) and new `bitcoin/frost_client.rs` (352 lines) — verify the new one has: `FrostClient`, `PrevoutInfo`, `SigningContext`, `SolanaVerification`.

If the new module is missing types, copy them from legacy before proceeding.

**Step 2: Commit if any additions needed**

```bash
git add backend/src/bitcoin/frost_client.rs
git commit -m "backend: ensure bitcoin::frost_client exports all required types"
```

---

### Task 3: Verify new `solana::client` has all types needed by consumers

**Files:**
- Read: `backend/src/solana/client.rs` (new, 625 lines)
- Read: `backend/src/sol_client.rs` (legacy, 803 lines)
- Compare exports

**Step 1: Read both and verify new module has: `SolClient`, `SolConfig`, `SolError`, `DEVNET_RPC`, `generate_keypair`, `load_keypair_from_file`**

If the new module is missing types/functions used by consumers, copy them from legacy.

**Step 2: Commit if any additions needed**

```bash
git add backend/src/solana/client.rs
git commit -m "backend: ensure solana::client exports all required types"
```

---

### Task 4: Verify new `bitcoin::client` can replace `esplora.rs`

**Files:**
- Read: `backend/src/bitcoin/client.rs` (new, 296 lines)
- Read: `backend/src/esplora.rs` (legacy, ~100 lines)
- Compare: `redemption/service.rs` uses `EsploraClient` from legacy

**Step 1: Check if `bitcoin::client` exports `EsploraClient` with same API surface used by `redemption/service.rs`**

If not, add the required methods or re-export.

**Step 2: Commit if any additions needed**

---

### Task 5: Update all imports from legacy to new modules

**Files:**
- Modify: `backend/src/main.rs` — update `taproot` import
- Modify: `backend/src/bin/redemption.rs` — update `sol_client` import
- Modify: `backend/src/bin/test_frost_redemption.rs` — update `frost_client` import
- Modify: `backend/src/bin/test_frost_sweep.rs` — update `frost_client` import
- Modify: `backend/src/redemption/builder.rs` — update `frost_client` import
- Modify: `backend/src/redemption/signer.rs` — update `frost_client` import
- Modify: `backend/src/redemption/service.rs` — update `esplora` + `sol_client` imports
- Modify: `backend/src/redemption/watcher.rs` — update `sol_client` import
- Modify: `backend/src/deposit_tracker/sweeper.rs` — update `frost_client` import

**Step 1: Update each import line**

Replace `crate::frost_client` → `crate::bitcoin::frost_client`
Replace `crate::sol_client` → `crate::solana::client`
Replace `crate::esplora` → `crate::bitcoin::client` (adjust type name if needed)
Replace `zkbtc::frost_client` → `zkbtc::bitcoin::frost_client`
Replace `zkbtc::sol_client` → `zkbtc::solana::client`
Replace `zkbtc::taproot` → `zkbtc::bitcoin::taproot`

**Step 2: Build to verify**

```bash
cd backend && cargo check
```

**Step 3: Commit**

```bash
git add backend/src/main.rs backend/src/bin/ backend/src/redemption/ backend/src/deposit_tracker/sweeper.rs
git commit -m "backend: migrate all imports from legacy to new module paths"
```

---

### Task 6: Update `lib.rs` re-exports to use new modules

**Files:**
- Modify: `backend/src/lib.rs:63-120`

**Step 1: Update re-exports**

Change:
- `pub use btc_client::{...}` → `pub use bitcoin::signer::{...}` or `bitcoin::frost_client::{...}`
- `pub use sol_client::{...}` → `pub use solana::client::{...}`
- `pub use esplora::{...}` → `pub use bitcoin::client::{...}`
- `pub use btc_spv::{...}` → `pub use bitcoin::spv::{...}`
- `pub use taproot::{...}` → `pub use bitcoin::taproot::{...}`
- `pub use logging::{...}` → `pub use common::logging::{...}`
- `pub use middleware::{...}` → `pub use api::middleware::{...}`

**Step 2: Build to verify**

```bash
cd backend && cargo check
```

**Step 3: Commit**

```bash
git add backend/src/lib.rs
git commit -m "backend: update lib.rs re-exports to new module paths"
```

---

### Task 7: Delete legacy duplicate modules

**Files:**
- Delete: `backend/src/btc_client.rs`
- Delete: `backend/src/btc_spv.rs`
- Delete: `backend/src/frost_client.rs`
- Delete: `backend/src/logging.rs`
- Delete: `backend/src/middleware.rs`
- Delete: `backend/src/taproot.rs`
- Delete: `backend/src/esplora.rs`
- Modify: `backend/src/lib.rs` — remove `pub mod` declarations for deleted modules

**Step 1: Remove `pub mod` lines from lib.rs for each deleted module**

Remove these lines:
```rust
pub mod btc_client;
pub mod btc_spv;
pub mod esplora;
pub mod frost_client;
pub mod logging;
pub mod middleware;
pub mod taproot;
```

**Step 2: Delete the files**

**Step 3: Build to verify**

```bash
cd backend && cargo check
```

**Step 4: Commit**

```bash
git add -A backend/src/
git commit -m "backend: remove 7 legacy duplicate modules (btc_client, btc_spv, esplora, frost_client, logging, middleware, taproot)"
```

---

### Task 8: Consolidate `sol_client.rs` into `solana/client.rs`

**Files:**
- Read: `backend/src/sol_client.rs` (803 lines) — check for any functions NOT in `solana/client.rs`
- Modify: `backend/src/solana/client.rs` — add missing functions
- Delete: `backend/src/sol_client.rs`
- Modify: `backend/src/lib.rs` — remove `pub mod sol_client`

**Step 1: Diff the two files, identify functions in sol_client.rs not in solana/client.rs**

**Step 2: Copy missing functions to solana/client.rs**

**Step 3: Update lib.rs, remove sol_client module declaration**

**Step 4: Build and verify**

```bash
cd backend && cargo check
```

**Step 5: Commit**

```bash
git add backend/src/solana/client.rs backend/src/lib.rs
git rm backend/src/sol_client.rs
git commit -m "backend: consolidate sol_client.rs into solana/client.rs"
```

---

### Task 9: Remove `#[allow(dead_code)]` from backend and fix or remove dead code

**Files:**
- Grep for `#[allow(dead_code)]` in `backend/src/bitcoin/spv.rs`, `backend/src/bitcoin/taproot.rs`

**Step 1: For each instance, determine if the code is actually used**

- If used: remove the annotation (it will compile fine)
- If unused: delete the dead code entirely

**Step 2: Build and verify**

```bash
cd backend && cargo check
```

**Step 3: Commit**

```bash
git add backend/src/bitcoin/
git commit -m "backend: remove #[allow(dead_code)] annotations, delete unused code"
```

---

### Task 10: Clean up `units` module duplication

**Files:**
- Check: `backend/src/lib.rs:122-139` has inline `units` module
- Check: `backend/src/types/units.rs` exists with same functions

**Step 1: If `types/units.rs` exists and has the same functions, update lib.rs to re-export from there instead of defining inline**

**Step 2: Build and verify, commit**

```bash
git commit -m "backend: deduplicate units module"
```

---

## Phase 2: Contracts — Remove Dead Code

### Task 11: Determine if `state/deposit.rs` is used by any instruction

**Files:**
- Read: `contracts/programs/aegis/src/state/deposit.rs`
- Grep: `DepositRecord` usage across all instruction handlers

**Step 1: Search for any use of `DepositRecord` in instruction handlers**

From the grep results, `DepositRecord` is only referenced in:
- `state/deposit.rs` (definition)
- `state/mod.rs` (re-export)
- `utils/validation.rs:95` (comment only)

It is NOT used by any instruction handler. The deposit flow uses `StealthAnnouncement` + `CommitmentTree` directly.

**Step 2: Remove `deposit.rs` and its re-export**

- Delete: `contracts/programs/aegis/src/state/deposit.rs`
- Modify: `contracts/programs/aegis/src/state/mod.rs` — remove `pub mod deposit;` and `pub use deposit::*;` and the doc table entry

**Step 3: Build and verify**

```bash
cd contracts && cargo build-sbf --features devnet
```

**Step 4: Commit**

```bash
git add contracts/programs/aegis/src/state/
git commit -m "contracts: remove unused DepositRecord state (replaced by StealthAnnouncement)"
```

---

### Task 12: Remove `#[allow(dead_code)]` in btc-light-client

**Files:**
- Modify: `contracts/programs/btc-light-client/src/state/height_index.rs:16` — remove annotation
- Modify: `contracts/programs/btc-light-client/src/constants.rs:35-39` — remove annotations

**Step 1: Check if HeightIndex methods are used**

If unused, either delete or keep without the annotation (let compiler warn).
For constants: NETWORK_TESTNET3, NETWORK_TESTNET4, NETWORK_REGTEST — if they're valid network IDs used conditionally, keep them but remove the `#[allow(dead_code)]`.

**Step 2: Remove annotations, build**

```bash
cd contracts && cargo check -p btc-light-client
```

**Step 3: Commit**

```bash
git add contracts/programs/btc-light-client/src/
git commit -m "contracts: remove #[allow(dead_code)] in btc-light-client"
```

---

## Phase 3: SDK — Remove Deprecated Code and Redundant Modules

### Task 13: Remove deprecated `encodeClaimLink` overload

**Files:**
- Modify: `sdk/src/claim-link.ts:235-250` area

**Step 1: Check if the deprecated overload is used anywhere**

```bash
cd sdk && grep -r "encodeClaimLink" src/ --include="*.ts"
```

Also check `aegis-app/`:
```bash
grep -r "encodeClaimLink" ../aegis-app/src/ --include="*.ts" --include="*.tsx"
```

**Step 2: If only used internally, remove the deprecated overload and update callers**

**Step 3: Remove export from `sdk/src/index.ts:237` if the function is removed**

**Step 4: Build and test**

```bash
cd sdk && bun run build && bun test
```

**Step 5: Commit**

```bash
git add sdk/src/
git commit -m "sdk: remove deprecated encodeClaimLink overload"
```

---

### Task 14: Remove deprecated `createInstructionData` in chadbuffer.ts

**Files:**
- Modify: `sdk/src/chadbuffer.ts:120-140` area

**Step 1: Check if deprecated function is used**

```bash
cd sdk && grep -r "createInstructionData" src/ --include="*.ts"
```

**Step 2: If unused externally, remove the function**

**Step 3: Build and test**

```bash
cd sdk && bun run build && bun test
```

**Step 4: Commit**

```bash
git add sdk/src/chadbuffer.ts
git commit -m "sdk: remove deprecated createInstructionData from chadbuffer"
```

---

### Task 15: Audit `stealth-deposit.ts` vs `stealth/deposit.ts` redundancy

**Files:**
- Read: `sdk/src/stealth-deposit.ts`
- Read: `sdk/src/stealth/deposit.ts`

**Step 1: Determine if they serve different purposes or are truly redundant**

- `stealth-deposit.ts` — BTC deposit with OP_RETURN (32-byte commitment format)
- `stealth/deposit.ts` — Stealth deposit with ephemeral keys

If they serve different purposes, keep both but document clearly.
If one is a subset, consolidate into the other.

**Step 2: Check what imports from each**

```bash
grep -r "stealth-deposit" sdk/src/ aegis-app/src/ --include="*.ts" --include="*.tsx"
grep -r "stealth/deposit" sdk/src/ aegis-app/src/ --include="*.ts" --include="*.tsx"
```

**Step 3: Consolidate if possible, update imports, build and test**

**Step 4: Commit**

```bash
git commit -m "sdk: consolidate stealth deposit modules"
```

---

### Task 16: Audit `merkle.ts` vs `commitment-tree.ts` redundancy

**Files:**
- Read: `sdk/src/merkle.ts`
- Read: `sdk/src/commitment-tree.ts`

**Step 1: Determine roles**

- `merkle.ts` — proof structures, path utilities, constants (TREE_DEPTH, ZERO_VALUE, etc.)
- `commitment-tree.ts` — incremental tree from on-chain data, fetch/parse functions

These likely serve different purposes (proof helpers vs tree state). Verify and document.

**Step 2: If truly complementary, no action needed. If overlapping, consolidate.**

**Step 3: Commit if changes made**

---

## Phase 4: Frontend — Minor Cleanup

### Task 17: Resolve TODO in `lib/solana/instructions.ts:234`

**Files:**
- Read: `aegis-app/src/lib/solana/instructions.ts:230-240`

**Step 1: Read the TODO and determine if it's still relevant**

TODO: "Convert bech32 btcAddress to raw scriptPubKey bytes"

**Step 2: Either implement the TODO or remove it if already handled elsewhere**

**Step 3: Build**

```bash
cd aegis-app && bun run build
```

**Step 4: Commit**

```bash
git add aegis-app/src/lib/solana/instructions.ts
git commit -m "ui: resolve TODO in instruction builder"
```

---

## Phase 5: Final Verification

### Task 18: Full build verification across all components

**Step 1: Build backend**

```bash
cd backend && cargo check
```

**Step 2: Build contracts**

```bash
cd contracts && cargo build-sbf --features devnet
```

**Step 3: Build SDK**

```bash
cd sdk && bun run build
```

**Step 4: Build frontend**

```bash
cd aegis-app && bun run build
```

**Step 5: Run tests**

```bash
cd sdk && bun test
cd backend && cargo test
cd aegis-app && bun run test
```

**Step 6: Final commit (if any fixes needed)**

```bash
git commit -m "chore: full build verification after production cleanup"
```

---

## Summary

| Phase | Tasks | What's Removed |
|-------|-------|----------------|
| 1: Backend | Tasks 1-10 | 7 duplicate modules (~3,000 lines), dead code annotations |
| 2: Contracts | Tasks 11-12 | Unused DepositRecord state, dead_code annotations |
| 3: SDK | Tasks 13-16 | 2 deprecated functions, module redundancy audit |
| 4: Frontend | Task 17 | 1 TODO resolved |
| 5: Verify | Task 18 | Full build + test pass |

**Estimated commits:** 12-15
**Risk level:** Medium (import path changes can break builds; each task verifies with `cargo check` / `bun run build`)
