# Frontend Final Cleanup Plan

**Goal:** Clean up all remaining code quality issues — debug logging, `any` types, hardcoded URLs, large components, and React anti-patterns.

**Scope:** 6 tasks, all mechanical refactoring, no behavior changes.

---

## Task 1: Console.log Cleanup

Remove or gate ~85 debug console statements across 24 files. Production users should not see debug output in browser console.

**Approach:** Delete `console.log` calls that are pure debug. Keep `console.error` for actual error handling. Keep `console.warn` for deprecation warnings.

**Files (top offenders):**
- `src/lib/commitment-index.ts` (15 instances)
- `src/components/btc-widget/pay-flow.tsx` (6)
- `src/components/btc-widget/manual-verify.tsx` (6)
- `src/hooks/use-sns-name.tsx` (5)
- `src/stores/privacy-coin-store.ts` (4)
- `src/app/api/verify/route.ts` (13) — server-side, keep as structured logs
- `src/app/api/relay/route.ts` (8) — server-side, keep
- `src/app/api/merkle/proof/route.ts` (6) — server-side, keep
- All other component/hook files with stray console.log

**Rule:** Client-side code (components, hooks, stores, lib/) → delete debug logs. Server-side code (app/api/) → keep (server logs are useful).

---

## Task 2: Replace `any` Types (71 occurrences)

Add proper type annotations to replace `any` in API route files and components.

**Priority files:**
- `src/app/api/explorer/redemptions/route.ts` (9 `any`)
- `src/app/docs/page.tsx` (8)
- `src/app/api/transfers/route.ts` (6)
- `src/app/api/explorer/transactions/route.ts` (4)
- `src/stores/bitcoin-wallet-store.ts` (3)
- `src/lib/api/rpc-fallback.ts` (3)
- Other files (1-2 each)

**Approach:** For API routes, type the backend response shapes. For components, type event handlers and callback params.

---

## Task 3: Centralize Hardcoded URLs

Extract hardcoded API URLs into config constants.

**URLs to centralize:**
- Binance/CoinGecko price API URLs in `use-token-prices.ts`
- Solana RPC fallback `https://api.devnet.solana.com` scattered across files
- Zeus Network URLs in footer/layout (3 instances)
- Backend URL hardcoded in `app/api/explorer/transactions/route.ts`

**Approach:** Add URL constants to existing config files (`lib/btc-network.ts`, `lib/api/constants.ts`, `lib/solana-network.ts`).

---

## Task 4: Extract deposit-flow.tsx Hooks

`deposit-flow.tsx` (729 lines, 13 useState) — same pattern as pay-flow/shield-flow extractions.

**Extract:**
- `useDepositStatus()` — deposit polling + status state
- Keep UI rendering in the component

---

## Task 5: Split transfers-tab.tsx Detail Views

`transfers-tab.tsx` (838 lines) has 4 large detail view components inline:
- `ShieldDetails` (~90 lines)
- `RedeemDetails` (~90 lines)
- `UnshieldDetails` (~70 lines)
- `StandardTransferDetails` (~50 lines)

**Approach:** Move each to `app/explorer/components/transfer-details/` directory.

---

## Task 6: Fix React Anti-Patterns

- Replace index-based `.map()` keys with stable IDs where applicable
- Remove unused imports (if any remain)

---

## Verification

After each task:
- `bun run build` — no errors
- `bun test` — 88 tests pass
