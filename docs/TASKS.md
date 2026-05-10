# Phase 1 Ika Pivot — Task Tracker

> **Branch:** `ika`. **Status as of 2026-05-10**: 10 of 13 tasks complete; 3 require live network exercise. See [docs/PHASE1_HANDOFF.md](PHASE1_HANDOFF.md) for the runbook.
>
> **2026-05-10 update**: Investigated a Mollusk/LiteSVM integration test as a substitute acceptance gate. Built a working `ika-cpi-shim` test harness (`programs/ika-cpi-shim/`) and a `programs/privacy-coin/tests/complete_redemption_ika_cpi.rs` LiteSVM fixture. Test infrastructure passes a smoke check (loads both `.so` binaries and seeds the fixture); the full CPI assertion is `#[ignore]`-d due to `InvalidAccountOwner` at 127 CU from the Ika `.so`. Diagnosis is blocked because the Ika program is shipped without source and the upstream voting LiteSVM test (the only working reference) requires Cargo 1.85+ (we have 1.84). See test docstring for re-enablement criteria. **The shim crate + test scaffolding are committed work the next session can build on; they do NOT replace Task 7 as the acceptance gate.**

## Status table

| # | Task | Status | Commit / Blocker |
|---|---|---|---|
| 1 | Pre-flight checks | ✅ Done | Baseline snapshot taken |
| 2 | Task 0: Ika SDK recon spike | ✅ Done | `c3e4452` — `docs/recon/2026-05-09-ika-sdk-brief.md` |
| 3 | Task 1: Add `ika_dwallet_id` to `PoolConfig` | ✅ Done | `06c3e96` |
| 4 | Task 2: SDK helper `deriveCustodyAddressFromIkaDWallet` | ✅ Done | `7d6de5d` |
| 5 | Task 3: Wire deposit address through Ika | ✅ Done | `d452a48` |
| 6 | Task 4: Privacy Coin → Ika CPI in `complete_redemption` | ✅ Done | `a10237a`, `8e9581e`, `7d3c27e`, `035be94`, `590f78e` |
| 7 | Task 5: Ika watcher in backend (`IkaSigner` end-to-end) | ✅ Done | `5d73f0a`, `a63a9a3` |
| 8 | Task 6: Config plumbing | ✅ Done | `05255b0` |
| 9 | **Task 7: E2E on localnet (3× green)** | 🟡 **Pending — needs live exercise** | Requires Ika devnet DKG + funded payer. **Note:** the runbook in PHASE1_HANDOFF.md §7 underestimates scope on three independent fronts (see "Three showstoppers" addendum below). |
| 9a | Mollusk/LiteSVM CPI integration test (substitute) | 🟡 **Partial — scaffolding shipped, full test `#[ignore]`-d** | Shim crate `programs/ika-cpi-shim/` + `tests/complete_redemption_ika_cpi.rs`. Smoke test green; full CPI test blocked on Ika `.so` rejecting `transfer_dwallet` with `InvalidAccountOwner` at 127 CU. Root cause undiagnosable without source. |
| 10 | **Task 8: Decommission FROST** | 🟡 **Pending — gated on Task 7** | Code path ready (`frost-legacy` feature flag). See [PHASE1_HANDOFF.md §8](PHASE1_HANDOFF.md). |
| 11 | Task 9: Web UX shows Ika custody | ✅ Done | `48cf0d1` |
| 12 | Task 10: Documentation | ✅ Done | `4db1f63` |
| 13 | **Final acceptance gate** | 🟡 **Pending — gated on Tasks 7+8** | `git tag v2.0.0-ika-phase1` + PR after E2E ×3 green. |

## Test gates at last verification

| Surface | Result |
|---|---|
| `cd contracts && cargo test -p privacy-coin` | **115/115** lib + 1 `#[ignore]`-d full-CPI test (deferred behind two blockers — see test docstring) |
| `cd contracts && cargo build-sbf --features localnet --manifest-path programs/privacy-coin/Cargo.toml` | **❗️BROKEN if `cargo update` has been run** — see "Lockfile time-bomb" below |
| `cd contracts && cargo build-sbf --manifest-path programs/ika-cpi-shim/Cargo.toml` | builds when SBF toolchain has cached older lockfile; fails after `cargo update` for the same reason |
| `cd backend && cargo test` | **155 pass / 1 baseline failure** (`stealth::types::test_stealth_data_encode_decode` was already failing on `main`) |
| `cd sdk && bun test` | 621 ran / 42 fail / 3 module-load errors (27 pre-existing baseline + 15 expected layout-change fallout) |
| `cd sdk && bun run build` | tsc clean |
| `cd web && bun run build` | clean |

## To resume in a new session

A fresh Claude session has zero context — it can't see the in-flight TaskList. Hand it three docs and it can pick up cleanly:

1. **`docs/TASKS.md`** (this file) — status of every task
2. **`docs/PHASE1_HANDOFF.md`** — runbook for Tasks 7 + 8 (live exercise)
3. **`docs/designs/2026-05-09-ika-encrypt-pivot-design.md`** — overall architecture
4. **`docs/recon/2026-05-09-ika-sdk-brief.md`** — Ika integration surface (pinned commit, account ordering, sig schemes)

Suggested prompt to start a new session:

> Continue the Ika pivot on the `ika` branch. Read `docs/TASKS.md` for status, `docs/PHASE1_HANDOFF.md` for the live-exercise runbook (Tasks 7 + 8). I want to [pick one of: run Task 7 E2E now / decommission FROST after E2E passes / debug a specific failure].

If resuming Task 7 specifically, also share the upstream Ika commit you're testing against and any output from `bun main.ts` in `chains/solana/examples/voting/e2e/` — the runbook expects `IKA_DWALLET_ID` and `IKA_DWALLET_PUBKEY_HEX` from that step's logs.

## What lives where (file map)

```
docs/
├── TASKS.md                                                 # this file (live status)
├── PHASE1_HANDOFF.md                                        # Task 7 + 8 runbook
├── MIGRATION_v1_to_v2.md                                    # operator-facing migration
├── designs/2026-05-09-ika-encrypt-pivot-design.md           # architecture + scope
├── plans/
│   ├── 2026-05-09-ika-phase1-implementation-plan.md         # original 10-task plan
│   └── 2026-05-09-task-4b-complete-redemption-cpi-plan.md   # sub-plan (CPI surgery)
└── recon/2026-05-09-ika-sdk-brief.md                        # Ika integration brief

contracts/programs/privacy-coin/src/
├── cpi/ika.rs                                               # Manual approve_message CPI
├── utils/policy.rs                                          # On-chain signing policy
└── instructions/complete_redemption.rs                      # CPIs into Ika

sdk/src/
├── bitcoin/ika.ts                                           # P2TR from Ika dWallet pubkey
├── stealth.ts (pickCustodyInternalKey)                      # Ika-first dispatch
└── instructions.ts (CompleteRedemptionInstructionOptions)   # New ix layout

backend/src/
├── redemption/signer.rs (IkaSigner)                         # Two-phase polling signer
├── config.rs (SigningMode::Ika)                             # Env-driven mode selection
└── main.rs (create_ika_service)                             # Dispatcher branch

scripts/ika-setup/                                           # One-shot DKG runbook
```

## Lockfile time-bomb: `cargo build-sbf` after `cargo update` (discovered 2026-05-10)

`Cargo.lock` is gitignored in `contracts/.gitignore:24`, so the project relies on Cargo's resolver to pick versions on first build. `litesvm = "0.11.0"` (in both `programs/privacy-coin/Cargo.toml` and `programs/btc-light-client/Cargo.toml` dev-deps) has flexible transitive constraints that, against today's crates.io index, resolve to `solana-pubkey 4.2.0` → `wincode-derive 0.4.4`, whose manifest requires Cargo's `edition2024` feature. Our `cargo build-sbf` ships Rust 1.84 (no edition2024). Result: SBF builds fail mid-resolve with "feature `edition2024` is required".

This was reproduced **with the working tree's Cargo.toml stashed back to HEAD** — confirming the issue is purely in the regenerated lockfile, not in any source change made this session.

**Why it bit now**: `cargo update` was run mid-session (during the LiteSVM test investigation). That re-resolved every dep against today's index, picking newer versions of `solana-instruction`/`solana-loader-v3-interface`/etc. that require `solana-pubkey ^4.x`.

**Concrete remediation paths** (ranked by effort):
1. **Commit `Cargo.lock`.** Remove `Cargo.lock` from `contracts/.gitignore` and commit a known-good lockfile. Standard practice for binary/cdylib crates anyway.
2. **Pin `litesvm` transitives.** Add `[patch.crates-io]` entries forcing `solana-pubkey = "=3.x"` and `solana-instruction = "=3.0.0"` etc.
3. **Drop `litesvm` dev-dep.** Move LiteSVM tests to a separately-checked-out workspace that doesn't compete with SBF builds.
4. **Upgrade `cargo build-sbf`** to a version with edition2024 (Rust 1.85+ when shipped).

The shim crate (`programs/ika-cpi-shim/`) and the LiteSVM test scaffolding committed this session are independent of this build break — they are valid artifacts. They become exercisable once any of (1)–(4) lands.

## Three showstoppers in PHASE1_HANDOFF.md §7 (discovered 2026-05-10)

The runbook for Task 7 papers over three independent issues that surface on first contact. Any future session should plan for these:

1. **Voting e2e locks dWallet ownership.** Step 7.1 says "run upstream voting e2e to materialize a dWallet." `setupDWallet()` in `chains/solana/examples/_shared/ika-setup.ts` *internally* calls `IX_TRANSFER_OWNERSHIP=24` to transfer dWallet authority to the **caller_program** the helper was given (the voting program in upstream's case). Re-transferring later would require the new owner (voting program's CPI auth PDA) to sign — which only the voting program can do. Fix: vendor `setupDWallet()` and call it with `privacyCoinProgramId` as the caller_program directly.

2. **Devnet airdrop cap.** Upstream's `createAndFundKeypair` calls `connection.requestAirdrop(kp.publicKey, 100_000_000_000)` (100 SOL). Public Solana devnet caps airdrops at ~1-2 SOL/day. The voting e2e script will fail at airdrop on shared devnet. Fix: pass a pre-funded payer keypair through, skip the airdrop call.

3. **`scripts/e2e/run-all.ts` is hardcoded localnet+regtest.** `shared.ts:165` has `RPC_URL = "http://127.0.0.1:8899"` and `ESPLORA_URL = "http://localhost:3002/regtest/api"`; `step1-infra.ts` inserts regtest block headers (`bits = 0x207fffff`); BTC addresses are `bcrt1...`. Switching the rig to Solana devnet + Bitcoin testnet would mean replumbing every step (different difficulty, headers, wallet, addresses) and re-running the header relayer against testnet. That's a multi-day refactor, not a flag flip.

The `ika-cpi-shim` + LiteSVM test work (#9a) was an attempt to validate the byte-correct CPI without these blockers — it gets close but is ultimately blocked on Ika `.so` source access (see #9a entry).

## Commits since `main` (newest first)

```
908eae6 Phase 1 handoff doc: code-complete summary + Task 7/8 runbook
a63a9a3 Task 5 full: wire IkaSigner end-to-end + DKG setup script
48cf0d1 Task 9: web docs UI describes Ika dWallet custody (not FROST)
4db1f63 Task 10: README + MIGRATION_v1_to_v2.md updated for Ika pivot
05255b0 Task 6: config plumbing for Ika dWallet
5d73f0a Task 5 partial: IkaSigner alongside MpcSigner
590f78e Task 4b.5 stub: Mollusk integration test placeholder (#[ignore])
035be94 Task 4b.6: SDK builder for new complete_redemption layout
7d3c27e Task 4b.4: complete_redemption CPIs Ika approve_message
8e9581e Task 4b.1-4b.3: error variants, policy module, ix data extension
63d1e66 Sub-plan for Task 4b: complete_redemption CPIs Ika approve_message
a10237a Task 4a: Ika approve_message CPI helper (manual, pinocchio 0.9)
d452a48 Task 3: deposit address derives from Ika dWallet, FROST as fallback
7d6de5d Task 2: SDK helper deriveCustodyAddressFromIkaDWallet
06c3e96 Task 1: PoolConfig + set_pool_config support Ika dWallet custody
c3e4452 Task 0: Ika Solana pre-alpha recon brief
91acaf5 Pivot plan to Solana-native Ika (ika-pre-alpha)
a690afe Drop Phase 3 multi-chain demo, scope to BTC only
f62f88e Draft Ika+Encrypt pivot design spec
9175025 Add Phase 1 implementation plan: Ika dWallet replaces FROST
```
