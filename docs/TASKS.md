# Phase 1 Ika Pivot — Task Tracker

> **Branch:** `ika`. **Status as of 2026-05-10**: 10 of 13 tasks complete; 3 require live network exercise. See [docs/PHASE1_HANDOFF.md](PHASE1_HANDOFF.md) for the runbook.

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
| 9 | **Task 7: E2E on localnet (3× green)** | 🟡 **Pending — needs live exercise** | Requires Ika devnet DKG + funded payer. See [PHASE1_HANDOFF.md §7](PHASE1_HANDOFF.md). |
| 10 | **Task 8: Decommission FROST** | 🟡 **Pending — gated on Task 7** | Code path ready (`frost-legacy` feature flag). See [PHASE1_HANDOFF.md §8](PHASE1_HANDOFF.md). |
| 11 | Task 9: Web UX shows Ika custody | ✅ Done | `48cf0d1` |
| 12 | Task 10: Documentation | ✅ Done | `4db1f63` |
| 13 | **Final acceptance gate** | 🟡 **Pending — gated on Tasks 7+8** | `git tag v2.0.0-ika-phase1` + PR after E2E ×3 green. |

## Test gates at last verification

| Surface | Result |
|---|---|
| `cd contracts && cargo test -p privacy-coin` | **115/115** lib + 1 ignored Mollusk stub |
| `cd contracts && cargo build-sbf --features localnet --manifest-path programs/privacy-coin/Cargo.toml` | clean |
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
