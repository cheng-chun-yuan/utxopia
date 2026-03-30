# Frontend Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Break down oversized components, eliminate duplicate patterns, and improve code quality — no behavior changes.

**Architecture:** Extract state logic from two 1000+ line components (`pay-flow.tsx`, `shield-flow.tsx`) into focused custom hooks. Consolidate prop interfaces for `AuthModal` and `OutputRowCard`. Replace scattered `SUPPORTED_TOKENS.find()` calls with the existing `getTokenBySymbol()` helper. Move `tvlToUsd` to shared module.

**Tech Stack:** React 19, Next.js, TypeScript, Zustand, SWR, bun test

**Spec:** `docs/plans/frontend-optimization-design.md`

---

## File Map

### New Files
| File | Responsibility |
|------|---------------|
| `aegis-app/src/hooks/use-relayer-config.ts` | Fetch relayer meta + compute per-token fees |
| `aegis-app/src/hooks/use-pay-flow-auth.ts` | Auth modal state + passkey handlers |
| `aegis-app/src/hooks/use-pay-flow-notes.ts` | Note selection + secret phrase import |
| `aegis-app/src/hooks/use-token-balance.ts` | SOL/SPL balance fetching for shield flow |
| `aegis-app/src/hooks/use-btc-deposit.ts` | BTC deposit preview + sign flow |

### Modified Files
| File | Change |
|------|--------|
| `aegis-app/src/lib/supported-tokens.ts` | Enhance `getTokenBySymbol` to match shieldedSymbol; add `tvlToUsd` |
| `aegis-app/src/app/explorer/components/deposits-tab.tsx` | Replace 4 inline `.find()` with `getTokenBySymbol()` |
| `aegis-app/src/components/stealth-inbox/InboxItem.tsx` | Replace manual `.find()` with `getTokenBySymbol()` |
| `aegis-app/src/components/btc-widget/balance-view.tsx` | Replace manual `.find()` with `getTokenBySymbol()` |
| `aegis-app/src/app/vault/activity/page.tsx` | Replace manual `.find()` with `getTokenBySymbol()` |
| `aegis-app/src/app/page.tsx` | Remove inline `tvlToUsd`, import from supported-tokens |
| `aegis-app/src/app/explorer/page.tsx` | Import shared `tvlToUsd` |
| `aegis-app/src/components/auth-modal.tsx` | Consolidate props into `auth` object |
| `aegis-app/src/components/btc-widget/pay-flow/output-row-card.tsx` | Consolidate props into `handlers` + `config` |
| `aegis-app/src/components/btc-widget/pay-flow.tsx` | Replace extracted state with hook calls |
| `aegis-app/src/components/shield-flow.tsx` | Replace extracted state with hook calls |
| `aegis-app/package.json` | Remove `@vitejs/plugin-react` devDep |

---

## Task 1: Quick Wins — Token Lookup Consolidation

**Files:**
- Modify: `aegis-app/src/lib/supported-tokens.ts:229-232`
- Modify: `aegis-app/src/app/explorer/components/deposits-tab.tsx:303-306`
- Modify: `aegis-app/src/components/stealth-inbox/InboxItem.tsx:13-16`
- Modify: `aegis-app/src/components/btc-widget/balance-view.tsx:47-51`
- Modify: `aegis-app/src/app/vault/activity/page.tsx:30-32`

- [ ] **Step 1: Enhance `getTokenBySymbol` to also match `shieldedSymbol`**

In `aegis-app/src/lib/supported-tokens.ts`, update the existing function:

```typescript
/** Look up token config by symbol or shieldedSymbol */
export function getTokenBySymbol(symbol: string): SupportedToken | undefined {
  return SUPPORTED_TOKENS.find((t) => t.symbol === symbol || t.shieldedSymbol === symbol);
}
```

- [ ] **Step 2: Replace 4 inline lookups in deposits-tab.tsx**

Replace lines 303-306:
```typescript
const btcToken = SUPPORTED_TOKENS.find(t => t.symbol === "BTC")!;
const solToken = SUPPORTED_TOKENS.find(t => t.symbol === "SOL")!;
const usdcToken = SUPPORTED_TOKENS.find(t => t.symbol === "USDC")!;
const usdtToken = SUPPORTED_TOKENS.find(t => t.symbol === "USDT")!;
```

With:
```typescript
const btcToken = getTokenBySymbol("BTC")!;
const solToken = getTokenBySymbol("SOL")!;
const usdcToken = getTokenBySymbol("USDC")!;
const usdtToken = getTokenBySymbol("USDT")!;
```

Add `getTokenBySymbol` to the existing import from `@/lib/supported-tokens`.

- [ ] **Step 3: Replace manual lookup in InboxItem.tsx**

Replace the `getTokenForNote` function (lines 11-19):
```typescript
function getTokenForNote(note: InboxNote): SupportedToken {
  const sym = note.tokenSymbol;
  if (sym) {
    return getTokenBySymbol(sym) ?? SUPPORTED_TOKENS[0];
  }
  return SUPPORTED_TOKENS[0];
}
```

Update the import to add `getTokenBySymbol` from `@/lib/supported-tokens`.

- [ ] **Step 4: Replace manual lookup in balance-view.tsx**

Replace the `getDepositToken` function (lines 45-52):
```typescript
function getDepositToken(deposit: { token_symbol?: string }): SupportedToken {
  return (deposit.token_symbol ? getTokenBySymbol(deposit.token_symbol) : undefined) ?? SUPPORTED_TOKENS[0];
}
```

Add `getTokenBySymbol` to the existing import from `@/lib/supported-tokens`.

- [ ] **Step 5: Replace manual lookup in activity/page.tsx**

Replace the `getToken` function (lines 30-32):
```typescript
function getToken(sym: string): SupportedToken {
  return getTokenBySymbol(sym) ?? SUPPORTED_TOKENS[0];
}
```

Add `getTokenBySymbol` to the existing import from `@/lib/supported-tokens`.

- [ ] **Step 6: Verify**

Run: `bun run build && bun test`
Expected: Build passes, 88 tests pass.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "refactor: use getTokenBySymbol() consistently across frontend"
```

---

## Task 2: Quick Wins — Extract tvlToUsd + Remove Leftover DevDep

**Files:**
- Modify: `aegis-app/src/lib/supported-tokens.ts`
- Modify: `aegis-app/src/app/page.tsx:213-228`
- Modify: `aegis-app/src/app/explorer/page.tsx`
- Modify: `aegis-app/package.json`

- [ ] **Step 1: Add `tvlToUsd` to supported-tokens.ts**

Append to `aegis-app/src/lib/supported-tokens.ts`:

```typescript
/** Calculate total TVL in USD across all tokens */
export function tvlToUsd(
  tokenTVL: { symbol: string; totalShielded: bigint; decimals: number }[],
  prices: Record<string, number | null>,
): number {
  let total = 0;
  for (const t of tokenTVL) {
    const token = getTokenBySymbol(t.symbol);
    const priceKey = token?.priceKey ?? t.symbol.toLowerCase().replace("zk", "");
    const price = prices[priceKey as keyof typeof prices];
    if (price) {
      total += (Number(t.totalShielded) / (10 ** t.decimals)) * price;
    }
  }
  return total;
}
```

- [ ] **Step 2: Replace inline `tvlToUsd` in page.tsx**

Remove the `tvlToUsd` function definition (lines 213-228). Add import:
```typescript
import { tvlToUsd } from "@/lib/supported-tokens";
```

Update the call site — `tvlToUsd(stats!.tokenTVL, prices)` becomes `tvlToUsd(stats!.tokenTVL, prices as any)` since `TokenPrices` has named fields (`btc`, `sol`, `usdc`, `usdt`) that match `priceKey`.

Actually the signature takes a generic `Record<string, number | null>` so we need to convert. Simpler: keep the same call but build a price record:

At the call site on the page, the existing code passes `prices` which is `TokenPrices = { btc, sol, usdc, usdt }`. Since `tvlToUsd` now uses `token.priceKey` to look up, just pass `prices` directly — the keys match.

- [ ] **Step 3: Use shared `tvlToUsd` in explorer/page.tsx**

The explorer page has a similar inline TVL calculation. Replace it with the shared function by importing `tvlToUsd` from `@/lib/supported-tokens` and using it.

- [ ] **Step 4: Remove `@vitejs/plugin-react` from devDependencies**

Run: `bun remove @vitejs/plugin-react`

- [ ] **Step 5: Verify**

Run: `bun run build && bun test`

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor: extract tvlToUsd to shared module, remove vitest leftover dep"
```

---

## Task 3: Prop Consolidation — AuthModal

**Files:**
- Modify: `aegis-app/src/components/auth-modal.tsx:8-38`
- Modify: `aegis-app/src/components/btc-widget/pay-flow.tsx` (AuthModal call site)
- Modify: `aegis-app/src/app/vault/page.tsx` (AuthModal call site)

- [ ] **Step 1: Find all AuthModal consumers**

Search for `<AuthModal` across the codebase to find all call sites. Update the interface and all consumers together.

- [ ] **Step 2: Update AuthModal interface**

In `aegis-app/src/components/auth-modal.tsx`, replace the interface and destructuring:

```typescript
export interface AuthState {
  passkeySupported: boolean;
  hasPasskeyCredential: boolean;
  passkeyLoading: boolean;
  walletLoading: boolean;
  walletConnected: boolean;
  error: string | null;
  onPasskeyRegister: () => void;
  onPasskeyAuthenticate: () => void;
  onWalletConnect: () => void;
  onWalletDeriveKeys: () => void;
  onViewOnlyLogin?: (viewingKey: string) => void;
}

interface AuthModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  auth: AuthState;
}

export function AuthModal({ open, onOpenChange, auth }: AuthModalProps) {
  const {
    passkeySupported, hasPasskeyCredential, passkeyLoading,
    walletLoading, walletConnected, error,
    onPasskeyRegister, onPasskeyAuthenticate,
    onWalletConnect, onWalletDeriveKeys, onViewOnlyLogin,
  } = auth;
  const isLoading = passkeyLoading || walletLoading;
  // ... rest unchanged
```

- [ ] **Step 3: Update all call sites**

At each `<AuthModal` usage, wrap the individual props into an `auth` object:

```typescript
<AuthModal
  open={authModalOpen}
  onOpenChange={setAuthModalOpen}
  auth={{
    passkeySupported,
    hasPasskeyCredential,
    passkeyLoading,
    walletLoading: keysLoading,
    walletConnected: connected,
    error: passkeyError,
    onPasskeyRegister: handlePasskeyRegister,
    onPasskeyAuthenticate: handlePasskeyAuthenticate,
    onWalletConnect: () => setWalletModalVisible(true),
    onWalletDeriveKeys: deriveKeys,
    onViewOnlyLogin: ...,
  }}
/>
```

- [ ] **Step 4: Verify**

Run: `bun run build && bun test`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor: consolidate AuthModal props into auth object"
```

---

## Task 4: Prop Consolidation — OutputRowCard

**Files:**
- Modify: `aegis-app/src/components/btc-widget/pay-flow/output-row-card.tsx:22-37`
- Modify: `aegis-app/src/components/btc-widget/pay-flow.tsx` (OutputRowCard call site)

- [ ] **Step 1: Update OutputRowCard interface**

In `output-row-card.tsx`, replace the interface:

```typescript
export interface OutputRowHandlers {
  onUpdate: (update: Partial<OutputRow>) => void;
  onRemove: () => void;
}

export interface OutputRowConfig {
  defaultAddress: string;
  disablePublic?: boolean;
  disableBtc?: boolean;
  selfMeta?: StealthMetaAddress | null;
  maxAmount: number;
  serviceFeeSats?: number;
  serviceFeeBps?: number;
  tokenUnit?: string;
  tokenSymbol?: string;
}

export interface OutputRowCardProps {
  output: OutputRow;
  index: number;
  canRemove: boolean;
  handlers: OutputRowHandlers;
  config: OutputRowConfig;
}
```

- [ ] **Step 2: Update destructuring inside OutputRowCard**

Replace the destructured props with the grouped shape. The body references like `onUpdate(...)` become `handlers.onUpdate(...)`, and `maxAmount` becomes `config.maxAmount`. Use destructuring at the top:

```typescript
export function OutputRowCard({ output, index, canRemove, handlers, config }: OutputRowCardProps) {
  const { onUpdate, onRemove } = handlers;
  const { defaultAddress, disablePublic, disableBtc, selfMeta, maxAmount, serviceFeeSats, serviceFeeBps, tokenUnit, tokenSymbol } = config;
  // ... rest unchanged — all variable names remain the same
```

- [ ] **Step 3: Update call site in pay-flow.tsx**

Find `<OutputRowCard` and restructure:

```typescript
<OutputRowCard
  output={o}
  index={i}
  canRemove={outputs.length > 1}
  handlers={{
    onUpdate: (update) => updateOutput(o.id, update),
    onRemove: () => removeOutput(o.id),
  }}
  config={{
    defaultAddress: publicKey?.toBase58() ?? "",
    disablePublic: hasImportedNotes,
    disableBtc: hasImportedNotes || selectedToken.symbol !== "BTC",
    selfMeta: stealthAddress,
    maxAmount: totalInputSats - effectiveRelayerFee,
    serviceFeeSats: effectiveServiceFee,
    serviceFeeBps: effectiveServiceFeeBps,
    tokenUnit: selectedToken.unit,
    tokenSymbol: selectedToken.shieldedSymbol,
  }}
/>
```

- [ ] **Step 4: Verify**

Run: `bun run build && bun test`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor: consolidate OutputRowCard props into handlers + config"
```

---

## Task 5: Extract `useRelayerConfig` Hook

**Files:**
- Create: `aegis-app/src/hooks/use-relayer-config.ts`
- Modify: `aegis-app/src/components/btc-widget/pay-flow.tsx`

- [ ] **Step 1: Create the hook**

Create `aegis-app/src/hooks/use-relayer-config.ts`:

```typescript
"use client";

import { useState, useEffect } from "react";
import { SERVICE_FEE_SATS, RELAYER_FEE_SATS, type PayToken } from "@/components/btc-widget/pay-flow/helpers";

export interface RelayerMeta {
  stealthMeta: string | null;
  relayerFeeSats: number;
  relayerFees: Record<string, number>;
  serviceFeeSats: number;
  serviceFeeBps: number;
}

export function useRelayerConfig(selectedToken: PayToken) {
  const [relayerMeta, setRelayerMeta] = useState<RelayerMeta | null>(null);

  useEffect(() => {
    fetch("/api/relayer/meta").then(r => r.ok ? r.json() : null).catch(() => null)
      .then((data) => {
        if (!data) return;
        setRelayerMeta({
          stealthMeta: data.stealth_meta || null,
          relayerFeeSats: data.relayer_fee_sats ?? RELAYER_FEE_SATS,
          relayerFees: data.relayer_fees ?? {},
          serviceFeeSats: data.service_fee_base ?? SERVICE_FEE_SATS,
          serviceFeeBps: data.service_fee_bps ?? 0,
        });
      });
  }, []);

  const relayerMetaLoaded = relayerMeta !== null;
  const effectiveRelayerFee = relayerMetaLoaded
    ? (relayerMeta.relayerFees[selectedToken.shieldedSymbol] ?? selectedToken.relayerFee)
    : 0;
  const effectiveServiceFee = relayerMeta?.serviceFeeSats ?? 0;
  const effectiveServiceFeeBps = relayerMeta?.serviceFeeBps ?? 0;

  return { relayerMeta, relayerMetaLoaded, effectiveRelayerFee, effectiveServiceFee, effectiveServiceFeeBps };
}
```

- [ ] **Step 2: Use the hook in pay-flow.tsx**

Replace lines 176-214 (the `relayerMeta` state, useEffect, and derived values) with:

```typescript
import { useRelayerConfig } from "@/hooks/use-relayer-config";
// ...
const { relayerMeta, relayerMetaLoaded, effectiveRelayerFee, effectiveServiceFee, effectiveServiceFeeBps } = useRelayerConfig(selectedToken);
```

Remove: `RELAYER_FEE_SATS`, `SERVICE_FEE_SATS` from the pay-flow helpers import (if no longer used directly).

- [ ] **Step 3: Verify**

Run: `bun run build && bun test`

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "refactor: extract useRelayerConfig hook from PayFlow"
```

---

## Task 6: Extract `usePayFlowAuth` Hook

**Files:**
- Create: `aegis-app/src/hooks/use-pay-flow-auth.ts`
- Modify: `aegis-app/src/components/btc-widget/pay-flow.tsx`

- [ ] **Step 1: Create the hook**

Create `aegis-app/src/hooks/use-pay-flow-auth.ts`:

```typescript
"use client";

import { useState, useEffect, useRef } from "react";
import { usePasskey } from "@/hooks/use-passkey";
import { useAegisStore } from "@/stores/aegis-store";

export function usePayFlowAuth(hasKeys: boolean) {
  const {
    isSupported: passkeySupported,
    hasCredential: hasPasskeyCredential,
    isLoading: passkeyLoading,
    error: passkeyError,
    register: registerPasskey,
    authenticate: authenticatePasskey,
  } = usePasskey();
  const deriveKeysFromPasskeySeed = useAegisStore((s) => s.deriveKeysFromPasskeySeed);
  const [authModalOpen, setAuthModalOpen] = useState(false);

  const handlePasskeyRegister = async () => {
    const seed = await registerPasskey();
    if (seed) {
      await deriveKeysFromPasskeySeed(seed);
      setAuthModalOpen(false);
    }
  };

  const handlePasskeyAuthenticate = async () => {
    const seed = await authenticatePasskey();
    if (seed) {
      await deriveKeysFromPasskeySeed(seed);
      setAuthModalOpen(false);
    }
  };

  // Auto-open auth modal when no keys
  const authAutoOpenedRef = useRef(false);
  useEffect(() => {
    if (!hasKeys && !authAutoOpenedRef.current) {
      authAutoOpenedRef.current = true;
      setAuthModalOpen(true);
    }
    if (hasKeys) authAutoOpenedRef.current = false;
  }, [hasKeys]);

  return {
    authModalOpen,
    setAuthModalOpen,
    passkeySupported,
    hasPasskeyCredential,
    passkeyLoading,
    passkeyError,
    handlePasskeyRegister,
    handlePasskeyAuthenticate,
  };
}
```

- [ ] **Step 2: Use the hook in pay-flow.tsx**

Replace lines 106-142 with:

```typescript
import { usePayFlowAuth } from "@/hooks/use-pay-flow-auth";
// ...
const {
  authModalOpen, setAuthModalOpen,
  passkeySupported, hasPasskeyCredential, passkeyLoading, passkeyError,
  handlePasskeyRegister, handlePasskeyAuthenticate,
} = usePayFlowAuth(hasKeys);
```

Remove: `usePasskey` import, `useAegisStore` selector for `deriveKeysFromPasskeySeed`, the `authAutoOpenedRef`, and the two handler functions.

- [ ] **Step 3: Verify**

Run: `bun run build && bun test`

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "refactor: extract usePayFlowAuth hook from PayFlow"
```

---

## Task 7: Extract `usePayFlowNotes` Hook

**Files:**
- Create: `aegis-app/src/hooks/use-pay-flow-notes.ts`
- Modify: `aegis-app/src/components/btc-widget/pay-flow.tsx`

- [ ] **Step 1: Create the hook**

Create `aegis-app/src/hooks/use-pay-flow-notes.ts`:

```typescript
"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useAegis, type InboxNote } from "@/hooks/use-aegis";
import { scanSecretPhrase, type ScannedSecretNote } from "@/lib/claim-utils";
import { autoSelectNotes, type PayToken } from "@/components/btc-widget/pay-flow/helpers";

interface PreselectedNote {
  commitment: string;
  leafIndex: number;
  amount: bigint;
}

export function usePayFlowNotes(
  selectedToken: PayToken,
  totalOutputSats: number,
  hasKeys: boolean,
  initialSecretPhrase?: string,
  preselectedNote?: PreselectedNote,
  onPreselected?: () => void,
) {
  const { inboxNotes, inboxLoading, refreshInbox } = useAegis();

  // Note selection
  const [selectedNoteIds, setSelectedNoteIds] = useState<Set<string>>(new Set());
  const [showNoteSelector, setShowNoteSelector] = useState(false);
  const notePreselectedRef = useRef(false);

  // Import state
  const [showImportInput, setShowImportInput] = useState(!!initialSecretPhrase);
  const [importPhrase, setImportPhrase] = useState(initialSecretPhrase || "");
  const [importedNotes, setImportedNotes] = useState<ScannedSecretNote[]>([]);
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const importAutoTriggered = useRef(false);

  // Available unspent notes — filtered by selected token
  const availableNotes = useMemo(() => {
    return inboxNotes.filter((n) => n.amount > 0n && !n.isSpent && n.tokenSymbol === selectedToken.shieldedSymbol);
  }, [inboxNotes, selectedToken.shieldedSymbol]);

  // Selected notes
  const selectedNotes = useMemo(() => {
    return availableNotes.filter((n) => selectedNoteIds.has(n.id));
  }, [availableNotes, selectedNoteIds]);

  // Active unspent imported notes
  const activeImportedNotes = useMemo(() =>
    importedNotes.filter(n => !n.isSpent),
  [importedNotes]);
  const hasImportedNotes = activeImportedNotes.length > 0;

  // Total input sats
  const totalInputSats = useMemo(() => {
    if (hasImportedNotes) return activeImportedNotes.reduce((sum, n) => sum + n.amount, 0);
    return selectedNotes.reduce((sum, n) => sum + Number(n.amount), 0);
  }, [selectedNotes, activeImportedNotes, hasImportedNotes]);

  // Pre-select note from props
  useEffect(() => {
    if (notePreselectedRef.current || inboxLoading || !preselectedNote) return;
    const matchingNote = availableNotes.find(
      (n) => n.commitmentHex === preselectedNote.commitment
    );
    if (matchingNote) {
      setSelectedNoteIds(new Set([matchingNote.id]));
      notePreselectedRef.current = true;
      onPreselected?.();
    }
  }, [preselectedNote, availableNotes, inboxLoading, hasKeys]);

  // Auto-select notes when total output changes
  useEffect(() => {
    if (notePreselectedRef.current) return;
    if (totalOutputSats > 0 && availableNotes.length > 0) {
      setSelectedNoteIds(autoSelectNotes(availableNotes, totalOutputSats));
    }
  }, [totalOutputSats, availableNotes]);

  // Auto-import note from ?note= URL param
  useEffect(() => {
    if (!initialSecretPhrase || importAutoTriggered.current || !hasKeys) return;
    importAutoTriggered.current = true;
    handleImportScan(initialSecretPhrase);
  }, [initialSecretPhrase, hasKeys]);

  // Import scan handler
  const handleImportScan = useCallback(async (phrase?: string) => {
    const p = (phrase || importPhrase).trim();
    if (p.length < 8) {
      setImportError("Secret phrase must be at least 8 characters");
      return;
    }
    setImportLoading(true);
    setImportError(null);
    try {
      const results = await scanSecretPhrase(p);
      setImportedNotes(results);
      setSelectedNoteIds(new Set());
      notePreselectedRef.current = true;
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Failed to scan phrase");
    } finally {
      setImportLoading(false);
    }
  }, [importPhrase]);

  // Clear imported notes
  const clearImportedNote = useCallback(() => {
    setImportedNotes([]);
    setImportPhrase("");
    setImportError(null);
    setShowImportInput(false);
    notePreselectedRef.current = false;
  }, []);

  // Unified refresh
  const handleRefresh = useCallback(async () => {
    refreshInbox();
    if (importPhrase.trim().length >= 8) {
      try {
        const results = await scanSecretPhrase(importPhrase.trim());
        setImportedNotes(results);
      } catch { /* keep existing */ }
    }
  }, [refreshInbox, importPhrase]);

  return {
    availableNotes,
    selectedNotes,
    selectedNoteIds,
    setSelectedNoteIds,
    activeImportedNotes,
    hasImportedNotes,
    totalInputSats,
    inboxLoading,
    showNoteSelector,
    setShowNoteSelector,
    showImportInput,
    setShowImportInput,
    importPhrase,
    setImportPhrase,
    importLoading,
    importError,
    handleImportScan,
    clearImportedNote,
    handleRefresh,
  };
}
```

- [ ] **Step 2: Use the hook in pay-flow.tsx**

Replace lines 152-360 (all note state, selectors, effects, and handlers) with:

```typescript
import { usePayFlowNotes } from "@/hooks/use-pay-flow-notes";
// ...
const {
  availableNotes, selectedNotes, selectedNoteIds, setSelectedNoteIds,
  activeImportedNotes, hasImportedNotes, totalInputSats, inboxLoading,
  showNoteSelector, setShowNoteSelector,
  showImportInput, setShowImportInput,
  importPhrase, setImportPhrase, importLoading, importError,
  handleImportScan, clearImportedNote, handleRefresh,
} = usePayFlowNotes(selectedToken, totalOutputSats, hasKeys, initialSecretPhrase, preselectedNote, () => {
  if (hasKeys) setStep("compose");
});
```

Remove the extracted useState calls, useMemo calls, useEffects, and useCallbacks from pay-flow.tsx. Keep `inboxNotes` and `refreshInbox` from useAegis only if still referenced directly — otherwise remove them from the destructuring too.

- [ ] **Step 3: Verify**

Run: `bun run build && bun test`

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "refactor: extract usePayFlowNotes hook from PayFlow"
```

---

## Task 8: Extract `useTokenBalance` Hook

**Files:**
- Create: `aegis-app/src/hooks/use-token-balance.ts`
- Modify: `aegis-app/src/components/shield-flow.tsx`

- [ ] **Step 1: Create the hook**

Create `aegis-app/src/hooks/use-token-balance.ts`:

```typescript
"use client";

import { useState, useEffect, useCallback } from "react";
import { PublicKey, LAMPORTS_PER_SOL, type Connection } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { getConfig } from "@aegis/sdk";
import { BTC_MINER_FEE_ESTIMATE } from "@/lib/btc-constants";
import type { SupportedToken } from "@/lib/supported-tokens";

export function useTokenBalance(
  selectedToken: SupportedToken,
  publicKey: PublicKey | null,
  connection: Connection,
  btcBalance: number | null,
) {
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [splBalance, setSplBalance] = useState<number | null>(null);

  // Fetch SOL balance when SOL is selected
  useEffect(() => {
    if (!publicKey || !selectedToken.isSOL) {
      setSolBalance(null);
      return;
    }
    let cancelled = false;
    connection.getBalance(publicKey).then((bal) => {
      if (!cancelled) setSolBalance(bal);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [publicKey, selectedToken.isSOL, connection]);

  // Fetch SPL token balance for non-SOL, non-BTC tokens
  useEffect(() => {
    if (!publicKey || selectedToken.isSOL || selectedToken.isBtcNative || !selectedToken.mint) {
      setSplBalance(null);
      return;
    }
    let cancelled = false;
    const mintPubkey = new PublicKey(selectedToken.mint || getConfig().zkbtcMint);
    connection.getTokenAccountsByOwner(publicKey, {
      mint: mintPubkey,
      programId: TOKEN_2022_PROGRAM_ID,
    }).then((accounts) => {
      if (cancelled) return;
      if (accounts.value.length === 0) { setSplBalance(0); return; }
      const data = accounts.value[0].account.data;
      const view = new DataView(data.buffer, data.byteOffset + 64, 8);
      setSplBalance(Number(view.getBigUint64(0, true)));
    }).catch(() => { if (!cancelled) setSplBalance(0); });
    return () => { cancelled = true; };
  }, [publicKey, selectedToken, connection]);

  const handleMax = useCallback(() => {
    // Returns the max amount string for the current token
    if (selectedToken.isBtcNative && btcBalance !== null) {
      const maxSats = Math.max(0, btcBalance - BTC_MINER_FEE_ESTIMATE);
      return (maxSats / 1e8).toFixed(8);
    } else if (selectedToken.isSOL && solBalance !== null) {
      const maxLamports = Math.max(0, solBalance - 0.01 * LAMPORTS_PER_SOL);
      return (maxLamports / LAMPORTS_PER_SOL).toFixed(9);
    } else if (!selectedToken.isSOL && !selectedToken.isBtcNative && splBalance !== null) {
      const value = splBalance / (10 ** selectedToken.decimals);
      return value.toFixed(selectedToken.decimals);
    }
    return "0";
  }, [selectedToken, solBalance, splBalance, btcBalance]);

  return { solBalance, splBalance, handleMax };
}
```

- [ ] **Step 2: Use the hook in shield-flow.tsx**

Replace the two balance useEffects (lines 122-154) and `handleMax` (lines 156-171) with:

```typescript
import { useTokenBalance } from "@/hooks/use-token-balance";
// ...
const { solBalance, splBalance, handleMax } = useTokenBalance(selectedToken, publicKey, connection, btcWallet.balance);
```

Update `handleMax` usage — the hook version returns the string directly instead of calling setAmount/setBtcAmount. In the component, wire it:

```typescript
const onMax = useCallback(() => {
  const max = handleMax();
  if (selectedToken.isBtcNative) setBtcAmount(max);
  else setAmount(max);
}, [handleMax, selectedToken.isBtcNative]);
```

- [ ] **Step 3: Verify**

Run: `bun run build && bun test`

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "refactor: extract useTokenBalance hook from ShieldFlow"
```

---

## Task 9: Extract `useBtcDeposit` Hook

**Files:**
- Create: `aegis-app/src/hooks/use-btc-deposit.ts`
- Modify: `aegis-app/src/components/shield-flow.tsx`

- [ ] **Step 1: Create the hook**

Create `aegis-app/src/hooks/use-btc-deposit.ts`. This is the largest extraction — contains all BTC-specific state and logic from ShieldFlow:

```typescript
"use client";

import { useState, useCallback, useRef } from "react";
import {
  bytesToHex,
  hexToBytes,
  createNonInteractiveDeposit,
  buildDepositPsbt,
  selectUtxos,
  getConfig,
} from "@aegis/sdk";
import type { StealthMetaAddress } from "@aegis/sdk";
import { useBitcoinWalletStore, type WalletUtxo } from "@/stores/bitcoin-wallet-store";
import { useNotesStore } from "@/stores/notes-store";
import { registerDeposit } from "@/lib/api/deposits";
import { getBtcSignerNetwork } from "@/lib/btc-network";
import { notifyError } from "@/lib/notifications";
import { BTC_DUST_LIMIT } from "@/lib/btc-constants";

interface DepositPreview {
  depositAddress: string;
  depositAmountSats: number;
  opReturnHex: string;
  opReturnPayload: Uint8Array;
  cachedUtxos: WalletUtxo[];
}

interface WalletDepositResult {
  txid: string;
  depositAddress: string;
  opReturnHex: string;
}

export function useBtcDeposit(
  stealthAddress: StealthMetaAddress | null,
  resolvedMeta: StealthMetaAddress | null,
  onStatusChange: (status: "done" | "error") => void,
  onError: (msg: string) => void,
) {
  const btcWallet = useBitcoinWalletStore();

  const [btcAmount, setBtcAmount] = useState("");
  const [walletDepositing, setWalletDepositing] = useState(false);
  const [walletDepositResult, setWalletDepositResult] = useState<WalletDepositResult | null>(null);
  const [depositPreview, setDepositPreview] = useState<DepositPreview | null>(null);
  const [buildingPreview, setBuildingPreview] = useState(false);
  const [selectedUtxoKeys, setSelectedUtxoKeys] = useState<Set<string>>(new Set());
  const [showUtxoList, setShowUtxoList] = useState(false);
  const [editingUtxos, setEditingUtxos] = useState(false);
  const [showOpReturn, setShowOpReturn] = useState(false);
  const [copiedBtcAddr, setCopiedBtcAddr] = useState(false);
  const [showWalletPicker, setShowWalletPicker] = useState(false);
  const walletPickerRef = useRef<HTMLDivElement>(null);

  const resetBtcFlow = useCallback(() => {
    onError("");
    setBtcAmount("");
    setWalletDepositResult(null);
    setDepositPreview(null);
  }, []);

  const buildTxPreview = useCallback(async () => {
    if (!resolvedMeta || !btcWallet.connected) return;
    const amountSats = Math.floor(parseFloat(btcAmount || "0") * 1e8);
    if (!amountSats || amountSats < BTC_DUST_LIMIT) { notifyError(`Amount must be at least ${BTC_DUST_LIMIT} sats`); return; }

    setBuildingPreview(true);
    setDepositPreview(null);

    try {
      const config = getConfig();
      const groupPubKey = hexToBytes(config.groupPubKey);

      const [deposit, utxos] = await Promise.all([
        createNonInteractiveDeposit(resolvedMeta, groupPubKey, getBtcSignerNetwork()),
        btcWallet.getPaymentUtxos(),
      ]);

      if (utxos.length === 0) throw new Error("No confirmed UTXOs available in wallet");

      const autoSelected = selectUtxos(
        utxos.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, scriptPubkeyHex: u.scriptPubkeyHex })),
        amountSats,
        2,
      );
      setSelectedUtxoKeys(new Set(autoSelected.map((u) => `${u.txid}:${u.vout}`)));
      setShowUtxoList(false);
      setEditingUtxos(false);

      setDepositPreview({
        depositAddress: deposit.btcAddress,
        depositAmountSats: amountSats,
        opReturnHex: bytesToHex(deposit.opReturnPayload),
        opReturnPayload: deposit.opReturnPayload,
        cachedUtxos: utxos,
      });
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to generate deposit");
    } finally {
      setBuildingPreview(false);
    }
  }, [resolvedMeta, btcAmount, btcWallet]);

  const confirmAndSign = useCallback(async () => {
    if (!depositPreview) return;
    setWalletDepositing(true);

    try {
      const selected = depositPreview.cachedUtxos
        .filter((u) => selectedUtxoKeys.has(`${u.txid}:${u.vout}`))
        .map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, scriptPubkeyHex: u.scriptPubkeyHex }));
      if (selected.length === 0) throw new Error("No UTXOs selected");

      const totalSelected = selected.reduce((sum, u) => sum + u.value, 0);
      if (totalSelected < depositPreview.depositAmountSats)
        throw new Error(`Selected UTXOs (${totalSelected} sats) insufficient for deposit (${depositPreview.depositAmountSats} sats)`);

      const psbtResult = buildDepositPsbt({
        senderUtxos: selected,
        depositAddress: depositPreview.depositAddress,
        depositAmountSats: depositPreview.depositAmountSats,
        opReturnPayload: depositPreview.opReturnPayload,
        changeAddress: btcWallet.address!,
        feeRate: 2,
        network: getBtcSignerNetwork(),
      });

      const { txid } = await btcWallet.signAndBroadcastPsbt(psbtResult.psbtBase64);

      const opReturnHex = depositPreview.opReturnHex;
      useNotesStore.getState().saveNote({
        commitment: opReturnHex,
        noteExport: txid,
        amountSats: depositPreview.depositAmountSats,
        taprootAddress: depositPreview.depositAddress,
        expiresAt: Math.floor(Date.now() / 1000) + 86400 * 30,
      });

      // Register with backend (fire-and-forget with retry)
      const ephemeralPubHex = opReturnHex.slice(0, 64);
      const npkHex = opReturnHex.slice(64);
      (async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const res = await registerDeposit(depositPreview.depositAddress, npkHex, depositPreview.depositAmountSats, ephemeralPubHex);
            if (res.deposit_id) useNotesStore.getState().updateNote(opReturnHex, { depositId: res.deposit_id });
            return;
          } catch (err) {
            if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
            else notifyError("Failed to register deposit with backend. Your deposit may not be tracked automatically.");
          }
        }
      })();

      setWalletDepositResult({ txid, depositAddress: depositPreview.depositAddress, opReturnHex });
      setDepositPreview(null);
      btcWallet.refreshBalance();
      onStatusChange("done");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Wallet deposit failed");
      onStatusChange("error");
    } finally {
      setWalletDepositing(false);
    }
  }, [depositPreview, selectedUtxoKeys, btcWallet]);

  return {
    btcWallet,
    btcAmount, setBtcAmount,
    walletDepositing,
    walletDepositResult,
    depositPreview,
    buildingPreview,
    selectedUtxoKeys, setSelectedUtxoKeys,
    showUtxoList, setShowUtxoList,
    editingUtxos, setEditingUtxos,
    showOpReturn, setShowOpReturn,
    copiedBtcAddr, setCopiedBtcAddr,
    showWalletPicker, setShowWalletPicker,
    walletPickerRef,
    resetBtcFlow,
    buildTxPreview,
    confirmAndSign,
  };
}
```

- [ ] **Step 2: Use the hook in shield-flow.tsx**

Replace all BTC-specific state (lines 83-101), `resetBtcFlow`, `buildTxPreview`, and `confirmAndSign` with:

```typescript
import { useBtcDeposit } from "@/hooks/use-btc-deposit";
// ...
const btcDeposit = useBtcDeposit(stealthAddress, resolvedMeta, setStatus, setError);
```

Then destructure or access via `btcDeposit.btcAmount`, `btcDeposit.buildTxPreview`, etc. in the render.

Remove: `useBitcoinWalletStore` import, `useNotesStore` import, `registerDeposit` import, `getBtcSignerNetwork` import, `BTC_DUST_LIMIT` import (if no longer used directly).

- [ ] **Step 3: Verify**

Run: `bun run build && bun test`

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "refactor: extract useBtcDeposit hook from ShieldFlow"
```

---

## Task 10: Final Verification

- [ ] **Step 1: Full build check**

Run: `bun run build`

- [ ] **Step 2: Full test suite**

Run: `bun test`
Expected: 88 tests pass, 9 files pass.

- [ ] **Step 3: Line count check**

Verify the big components are smaller:
```bash
wc -l aegis-app/src/components/btc-widget/pay-flow.tsx aegis-app/src/components/shield-flow.tsx
```
Expected: pay-flow.tsx ~600 lines (was 1,851), shield-flow.tsx ~400 lines (was 1,035).

- [ ] **Step 4: Commit any remaining cleanup**

```bash
git add -A && git commit -m "chore: frontend optimization complete"
```
