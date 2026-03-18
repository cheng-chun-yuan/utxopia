# Multi-Token Fixes, Token Registry, E2E Step 8b & Deploy

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix on-chain compilation errors from multi-token migration, add token_id to UnshieldMeta event, fetch token registry from on-chain, redeploy contracts, build E2E step 8b, and run design review.

**Architecture:** The multi-token migration updated transact/unshield instructions to use 72-byte stealth data (including encrypted_token_id) but left redeem.rs and verify_deposit_v2.rs referencing a deleted `compute_deposit_commitment` function. The SDK still sends 40-byte stealth data. This plan fixes compilation, updates all layers, deploys, and completes the e2e suite.

**Tech Stack:** Pinocchio (Solana), circom/snarkjs, TypeScript SDK, Next.js frontend, Rust backend

---

## File Map

### On-chain (contracts/programs/aegis/src/)
- `utils/events.rs` — Add token_id to emit_unshield_meta (41→73 bytes)
- `utils/crypto.rs` — No changes needed (compute_commitment already exists)
- `instructions/redeem.rs` — Add token_config account, fix compile errors, use compute_commitment
- `instructions/verify_deposit_v2.rs` — Fix compute_deposit_commitment → compute_commitment, fix emit_stealth_announcement call
- `instructions/unshield.rs` — Pass token_id to updated emit_unshield_meta

### Backend (backend/src/)
- `event_indexer/parser.rs` — Add token_id field to UnshieldMetaEvent + parsers

### SDK (sdk/src/)
- `instructions.ts` — Update STEALTH_DATA_PER_OUTPUT from 40→72 for transact/unshield builders

### Frontend (aegis-app/src/)
- `app/api/unshield/route.ts` — Update STEALTH_DATA_PER_OUTPUT 40→72
- `app/api/redeem/route.ts` — Keep STEALTH_DATA_PER_OUTPUT=40 (redeem is BTC-only, no encrypted_token_id), add token_config account
- `lib/supported-tokens.ts` — Add dynamic token registry fetch from on-chain
- `stores/aegis-store.ts` — Wire up on-chain token registry

### E2E
- `scripts/e2e/step8b-complete-redemption.ts` — New file for BTC redemption completion

---

## Task 1: Fix on-chain compilation errors

### 1a: Add token_id to emit_unshield_meta

**Files:** `contracts/programs/aegis/src/utils/events.rs`

- [ ] Update `emit_unshield_meta` signature to include `token_id: &[u8; 32]`
- [ ] Update layout comment: disc(1) + amount(8) + recipient(32) + token_id(32) = 73 bytes
- [ ] Update event table comment at top of file

### 1b: Fix unshield.rs — pass token_id to emit_unshield_meta

**Files:** `contracts/programs/aegis/src/instructions/unshield.rs`

- [ ] Pass `&token_id` as third arg to `emit_unshield_meta` (line 335-338)

### 1c: Fix redeem.rs — add token_config, fix all compile errors

**Files:** `contracts/programs/aegis/src/instructions/redeem.rs`

- [ ] Add `token_config_info` as account 5 (after system_program)
- [ ] Change `FIXED_ACCOUNTS` from 5 to 6
- [ ] Add imports: `TokenConfig` from state
- [ ] Add token_config validation (program owner, enabled check)
- [ ] Read `token_id` from token_config
- [ ] Replace `compute_deposit_commitment` with `compute_commitment(&zero_npk, &token_id, redeem_amount)`
- [ ] Fix `emit_stealth_announcement` call: add `&token_id` as 6th argument
- [ ] Update `emit_unshield_meta` call: add `&token_id` as 3rd argument
- [ ] Update instruction docs/comments

### 1d: Fix verify_deposit_v2.rs — fix compile errors

**Files:** `contracts/programs/aegis/src/instructions/verify_deposit_v2.rs`

- [ ] Add `token_config_info` as account 12 (after deposit_receipt)
- [ ] Update min accounts check: `accounts.len() < 13`
- [ ] Add token_config validation + read token_id
- [ ] Replace `compute_deposit_commitment(&npk, amount_sats)` → `compute_commitment(&npk, &token_id, amount_sats)`
- [ ] Fix `emit_stealth_announcement` call: add `&token_id` as 6th argument
- [ ] Update import: `compute_deposit_commitment` → `compute_commitment`

### 1e: Build and verify compilation

- [ ] Run: `cd contracts && cargo build-sbf --features devnet`
- [ ] Verify: zero errors

---

## Task 2: Update backend event parser

**Files:** `backend/src/event_indexer/parser.rs`

- [ ] Add `token_id: [u8; 32]` field to `UnshieldMetaEvent` struct
- [ ] Update `parse_unshield_meta` (multi-segment): expect 4 segments, parse token_id from segments[3]
- [ ] Update `parse_unshield_meta_flat`: expect 73 bytes, parse token_id from data[41..73]
- [ ] Update test `test_parse_unshield_meta` for new layout
- [ ] Run: `cd backend && cargo test`

---

## Task 3: Update SDK instruction builders

**Files:** `sdk/src/instructions.ts`

- [ ] In `buildTransactInstructionData`: change `STEALTH_DATA_PER_OUTPUT` from 40 to 72
- [ ] In `buildUnshieldInstructionData`: change `STEALTH_DATA_PER_OUTPUT` from 40 to 72
- [ ] Run: `cd sdk && bun run build`

---

## Task 4: Update frontend API routes

**Files:**
- `aegis-app/src/app/api/unshield/route.ts`
- `aegis-app/src/app/api/redeem/route.ts`

- [ ] In unshield route: change `STEALTH_DATA_PER_OUTPUT` from 40 to 72
- [ ] In redeem route: keep `STEALTH_DATA_PER_OUTPUT` = 40 (redeem doesn't include encrypted_token_id)
- [ ] In redeem route: add token_config account at position 5 (after SystemProgram, before nullifiers)

---

## Task 5: Fetch token registry from on-chain

**Files:**
- `aegis-app/src/lib/supported-tokens.ts`

- [ ] Add `fetchTokenMints()` function that calls SDK's `fetchSupportedTokens()` on app load
- [ ] Merge on-chain mint addresses with static UI metadata (logos, colors, display rules)
- [ ] Replace env-var-based mint resolution with on-chain data
- [ ] Keep static UI config (logos, colors) — only mints and enabled status come from chain

---

## Task 6: Contract redeploy

- [ ] Build: `cd contracts && cargo build-sbf --features devnet`
- [ ] Deploy aegis program to devnet
- [ ] Re-register tokens (init script)
- [ ] Delete backend events DB: `rm backend/data/events.db`
- [ ] Restart backend

---

## Task 7: E2E Step 8b — Complete BTC Redemption

**Files:** `scripts/e2e/step8b-complete-redemption.ts`

Per `scripts/e2e/STEP8B-PLAN.md`:
- [ ] mark_processing (disc 17)
- [ ] Build BTC withdrawal tx from pool UTXO
- [ ] Broadcast to regtest + mine 6 blocks
- [ ] Relay headers (extend_blockchain)
- [ ] Upload BTC tx to ChadBuffer + verify_transaction
- [ ] complete_redemption (disc 6)
- [ ] Verify: pending_redemptions=0, total_shielded reduced, redemption PDA closed

---

## Task 8: Design review

- [ ] Run `/design-review` on the live site
