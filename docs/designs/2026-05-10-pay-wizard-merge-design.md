# Pay-wizard merge: unified `/send` — design spec

> **Branch:** `ika-ux`. **Date:** 2026-05-10. **Author:** brainstormed via the superpowers `brainstorming` skill, captured here as the source of truth before plan/implementation.
>
> **Goal:** consolidate the four divergent pay flows (`/vault/pay/{transfer,unshield,withdraw,cashout}`) plus the Lite/Pro mode toggle into one user-friendly `/send` page. Pro features survive behind an opt-in preference at `/settings`.

## Why

Today's UX has six distinct verbs for what users think of as "send" and "deposit": *Shield, Unshield, Transfer, Withdraw, Cash Out, Pay.* It also exposes a Lite/Pro mode toggle on individual pay pages, an explicit auth fan-out (passkey vs wallet vs view-only), and a `.utxopia.sol` registration prompt before any value moves. The result is a high concept-count product that asks new users to learn the system before they can move money.

This spec covers only the pay-wizard merge — the highest-leverage piece. Dashboard simplification, auth-modal redesign, and SNS deferral are tracked as separate slices.

## Scope

| In scope | Out of scope |
|---|---|
| New `/send` route (top-level, not under `/vault`) | Dashboard `/vault/page.tsx` redesign |
| New `/settings` route with single Advanced-send preference | Auth modal simplification |
| Delete `/vault/pay/{transfer,unshield,withdraw,cashout}` and `payment-wizard/` and `pay-flow/` directories | `.utxopia.sol` registration deferral |
| Preserve all existing send capabilities, including claim-link and Pro-mode multi-output | Visual / brand redesign |
| Header gear icon and Advanced-mode badge | OP_RETURN-support precheck on the deposit flow (separate slice) |

## Architecture

### Routes

| Route | Status | Purpose |
|---|---|---|
| `/send` | **new** | Single page replacing all four pay routes |
| `/settings` | **new** | Preferences (Advanced send toggle for now; expandable) |
| `/vault/pay/transfer` | **delete** | hard-deleted; old links 404 (per the "Aggressive" merge choice) |
| `/vault/pay/unshield` | **delete** | same |
| `/vault/pay/withdraw` | **delete** | same |
| `/vault/pay/cashout` | **delete** | same |
| `/vault` | modified | Replace four pay-related cards with one "Send" link to `/send` |
| `/vault/deposit` | unchanged | Shield (inbound) — separate concept |
| `/claim`, `/explorer`, `/docs`, `/prove`, `/vault/{received,activity}` | unchanged | |

### New components (under `web/src/components/send/`)

- **`send-form.tsx`** — orchestrator (~200 LOC). Single `useReducer` state. Progressive disclosure: each section renders only once its predecessor is valid.
- **`recipient-input.tsx`** — smart-paste field with type detection. Status row underneath.
- **`recipient-detect.ts`** — pure detection function (see Detection rules below).
- **`token-source-picker.tsx`** — "From" dropdown, filtered by recipient type per the coupling table.
- **`amount-field.tsx`** — sats/decimal input with Max button, USD ↔ token toggle.
- **`fee-summary.tsx`** — network + service fee. Privacy warning when recipient is BTC. Custom fee-rate field in Advanced mode.
- **`review-modal.tsx`** — final review with HoldButton.
- **`claim-link-modal.tsx`** — alternate flow when the user clicks "Send via claim link" (parallel to the recipient input, not a recipient type).
- **`build-tx.ts`** — pure dispatch: `(state) → SendIntent { ix, proverInputs, signWith }`. One switch on recipient type.

### Settings infrastructure

- **`web/src/app/settings/page.tsx`** — preferences list.
- **`web/src/components/settings/preferences-form.tsx`** — toggle UI.
- **`web/src/hooks/use-ui-mode.ts`** — `utxopia-ui-mode` localStorage key with React context broadcast. Exposes `{ mode: "lite" | "advanced", setMode, isAdvanced }`.
- **`web/src/components/ui/advanced-mode-badge.tsx`** — small chip in the header user-area when Advanced is active.
- **`web/src/components/site-header.tsx`** — modified: gear icon → `/settings`; mount badge slot.

### Deletions

- `web/src/app/vault/pay/transfer/page.tsx`
- `web/src/app/vault/pay/unshield/page.tsx`
- `web/src/app/vault/pay/withdraw/page.tsx`
- `web/src/app/vault/pay/cashout/page.tsx`
- `web/src/components/payment-wizard/` (whole directory)
- `web/src/components/btc-widget/pay-flow.tsx` and `pay-flow/` (the Pro-mode component)

### Reused infrastructure

- `web/src/components/btc-widget/{deposit-flow.tsx, balance-view, manual-verify, withdrawal-status, widget.tsx}` — Receive-side pieces, untouched.
- `web/src/components/shield-flow.tsx` — `/vault/deposit` keeps using this.
- Hooks: `usePayFlowAuth` (rename → `useSendAuth`), `useProver`, `useUTXOpia`, `usePayFlowNotes` (rename → `useSendNotes`), `useStealthInbox`, `useTokenBalance`, `useTokenPrices`.
- `note-links.tsx`, `proving-steps.tsx`, `output-row-card.tsx` — lifted out of the deleted `pay-flow/` directory before deletion. Keep their working state.
- `HoldButton` (`web/src/components/ui/hold-button.tsx`) — used in review modal.
- `AuthModal` — used unchanged when auth not initialized at signing time.

## Detection rules (`recipient-detect.ts`)

Order matters; first match wins.

1. Trimmed input is empty → `empty`.
2. Ends with `.utxopia.sol` → `stealth_sns` (high confidence).
3. Bech32(m) prefix `bc1`/`tb1`/`bcrt1` and decode succeeds → `btc` (high).
4. Base58check prefix `1` or `3`, valid checksum → `btc` (medium).
5. Stealth meta-address format (specific hex prefix and length per SDK) → `stealth_meta` (high).
6. Solana base58 pubkey (44 chars, on-curve) → `spl_wallet` (medium).
7. Otherwise → `invalid`.

Output type: `{ type: RecipientType | "invalid" | "ambiguous" | "empty"; confidence; reason? }`.

## Source-token coupling table

| Recipient type   | Picker state | Default token | Allowed tokens                              |
|------------------|--------------|---------------|---------------------------------------------|
| `btc`            | disabled     | zkBTC         | zkBTC only                                  |
| `spl_wallet`     | enabled      | First match   | tokens user holds AND has matching SPL mint |
| `stealth_sns`    | enabled      | zkBTC         | any shielded token in user's vault          |
| `stealth_meta`   | enabled      | zkBTC         | any shielded token                          |
| (claim link)     | enabled      | zkBTC         | any shielded token                          |

Disabled state shows tooltip: *"Bitcoin addresses can only receive zkBTC. To send other tokens, use a Solana wallet or stealth address."*

## Per-recipient ix dispatch

| Recipient type   | Solana ix                                          | SDK call                                        |
|------------------|----------------------------------------------------|-------------------------------------------------|
| `btc`            | `REQUEST_REDEMPTION` (disc 16). Backend Ika watcher signs BTC tx async. | `prepareRedemptionInputs` → `buildRedeemInstruction` |
| `stealth_*`      | `TRANSACT` (disc 13) — JoinSplit with stealth output | `prepareTransactInputs` → `buildTransactInstruction` |
| `spl_wallet`     | `UNSHIELD` (disc 14) — JoinSplit with SPL output    | `prepareUnshieldInputs` → `buildUnshieldInstruction` |
| (claim link)     | `TRANSACT` (disc 13) with output for ephemeral pubkey derived from random secret | `prepareTransactInputs` with link metadata |

## Advanced (Pro) mode

Stored as `utxopia-ui-mode = "advanced"` in localStorage; toggled at `/settings`. Default `lite`. Phased delivery (separate commits / reviewable slices recommended in the implementation plan):

1. **Lite-only ship.** New `/send`, deletes old routes, header gear stub. `/settings` exists with the toggle disabled and labeled "Coming soon."
2. **Advanced multi-output** + mode badge.
3. **Advanced custom fee rate (BTC withdraw).**
4. **Advanced coin control.**

### Multi-output

State: `recipients: Output[]`. Renders `output-row-card.tsx` per output. "Add another recipient" button caps at 14 (JoinSplit `N+M ≤ 14` constraint). Mixing stealth + SPL unshield + claim-link in a single proof is fine — handled by the existing `buildTransactInstruction`. **At most one BTC output per send** (redemption-side commitment binding constraint); UI tooltips this on the add button.

### Custom BTC fee rate

A `feeRateSatVbyte` field on the BTC `Output`, surfaced in `fee-summary.tsx` when Advanced + BTC. Validated 1–500 sat/vbyte. **Backend implication flagged**: the on-chain `RedemptionRequest` PDA today has `service_fee` but no `fee_rate` field — the implementation plan must include a backend change to honor the user-supplied rate end-to-end, or document the limitation.

### Coin control

Collapsible "Choose which notes to spend" panel. Powered by `useStealthInbox`. Notes shown as a list with checkboxes. Send disabled if `sum(selected) < sum(outputs) + fee`.

### Mode badge

`advanced-mode-badge.tsx` rendered in `site-header.tsx`'s user area when `isAdvanced`. Pure visual signal.

## Data flow

```
recipient input ──▶ detectRecipient() ──▶ resolvedRecipient
                                              │
                                              ▼
                                  token picker (filtered)
                                              │
                                              ▼
                                       amount field
                                              │
                                  ┌───────────┴────────────┐
                                  ▼                        ▼
                          [Send] (review modal)   [Send via claim link] (modal)
                                  │                        │
                                  ▼                        ▼
                           buildSendTx(state)        buildClaimLinkTx(state)
                                  │                        │
                                  └────────────┬───────────┘
                                               ▼
                                       sign (passkey OR wallet)
                                               │
                                               ▼
                                      submit to Solana RPC
                                               │
                                       ┌───────┴────────┐
                                       ▼                ▼
                                  result.ok        result.error
                                       │                │
                                       ▼                ▼
                            success state         inline error
                          (reset form, redirect    (preserve state,
                            to /vault/activity      offer retry)
                            or render link UI)
```

## Error handling

| Layer | Class | UX | Recovery |
|---|---|---|---|
| Input | format / validation | inline status row, red text + icon | edit and continue |
| Pre-signing | balance / circuit constraints | disabled send button + tooltip | fix the offending field |
| Signing | user cancel / hw timeout | toast (yellow); form preserved | "Try again" — same draft |
| Submission | RPC / sim failure | toast (red) + docs link; auto-retry 3× for network; manual for sim | retry button |
| Async settlement | redemption stuck / no confirm | banner on `/vault/activity` row | "Refresh status" |

Specific cases (full enumeration in section 4 of the brainstorming transcript): ambiguous-input chooser; SNS-resolution timeout with one auto-retry; empty-state CTA when no compatible token (link to `/vault/deposit`); BTC dust-limit and 1-BTC-cap inline errors; multi-output cap (14) and one-BTC-output cap; coin-control insufficient-selection check; auth-not-initialized falls into existing `AuthModal`; concurrent edits resolved by nullifier uniqueness on chain.

Deliberately not handled: locking concurrent tabs (last-write-wins), network partition during signing (tx idempotent), insufficient SOL for tx fee (pre-flight check + inline message; no auto-fund).

## Testing

Test infra is `bun test` + `@testing-library/jest-dom`. No E2E framework today.

### Unit tests

| Subject | Coverage |
|---|---|
| `recipient-detect.ts` | Table-style fuzz: known-good BTC mainnet/testnet/regtest, valid SNS, valid stealth metas, Solana pubkeys, near-misses (off-by-one bech32, wrong-length base58). |
| `build-tx.ts` | Per recipient type × (single/multi) output: correct ix discriminator, account list, source-token coupling enforced. SDK calls mocked. |
| `use-ui-mode.ts` | localStorage round-trip, context broadcast, default lite. |

### Component tests

`recipient-input.tsx`, `token-source-picker.tsx`, `amount-field.tsx`, `review-modal.tsx`, `send-form.tsx` — see Section 5 of the brainstorming transcript for per-component checks.

### Manual QA checklist (acceptance gate)

One pass required before merging:

1. Each recipient type reaches the review modal from a paste.
2. Stealth transfer end-to-end on devnet/localnet; receiver `/vault/received` updates.
3. Claim-link round trip (generate, copy, claim in another tab).
4. SPL unshield → recipient wallet shows balance.
5. BTC withdraw → redemption row in `/vault/activity`, mempool link works.
6. Toggle Advanced in `/settings` → multi-output add/remove → coin control → submit.
7. Cancel signing → retry succeeds.
8. Network drop during submission → 3 retries → manual retry → succeeds.

Out of scope: real-RPC integration tests (lives in `scripts/e2e/run-all.ts`, localnet only, outside `web/`); visual regression; prover load.

## Risks and known gaps

1. **Custom BTC fee-rate plumbing.** The on-chain `RedemptionRequest` lacks a `fee_rate` field. Plan must either (a) add it (Pinocchio change + watcher change) or (b) ship Advanced custom-fee as a UI-only override that the watcher ignores, with an honest "best-effort" tooltip. Decision deferred to the implementation plan.
2. **Claim-link recoverability after modal close.** Need to verify the SDK can re-render a link from an existing sent-by-link note (so the "if you close, the link is lost" warning can be softened to "the funds wait for you to regenerate the link"). If unsupported, the warning becomes hard-block.
3. **Lite-first phasing.** If reviewers push back and demand all four Advanced features in one PR, the diff size becomes hard to land in this hackathon's window. The plan should explicitly carve the four phases as separable PRs and label `/settings` Advanced toggle as "Coming soon" until phase 2 lands.
4. **Lockfile time-bomb (cross-cutting).** Documented separately in `docs/TASKS.md`. Not blocking this UI work directly but the same `Cargo.lock` regeneration that broke `cargo build-sbf` could surface during a dependency bump in this PR. Worth checking after dep changes.

## Out of scope (future slices)

- `/vault` dashboard simplification (Balance + Receive + Send + Activity).
- Auth modal: passkey-default, secondary "Use a wallet instead" link, view-only behind `/restore`.
- `.utxopia.sol` registration deferral until first incoming transfer.
- OP_RETURN-support precheck on `/vault/deposit`.
- Address book / "save recipient" feature.
- Visual/brand redesign.

## Acceptance

- All four old `/vault/pay/*` routes are deleted (404 on access).
- New `/send` covers all four old flows plus claim-link.
- `/settings` exists with the Advanced toggle.
- Manual QA checklist passes on devnet/localnet.
- `bun test` passes.
- `bun run build` clean.
