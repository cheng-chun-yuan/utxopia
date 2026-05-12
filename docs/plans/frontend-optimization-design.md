# Frontend Optimization Design

## Goal

Break down oversized components, eliminate remaining duplication, and improve code quality across the utxopia-app frontend. No behavior changes — pure structural refactoring.

## Context

After the API cleanup (frontend-api-cleanup.md), the codebase has clean data fetching but two major components remain bloated: `pay-flow.tsx` (1,851 lines, 21 useState) and `shield-flow.tsx` (1,035 lines, 23 useState). Several smaller issues remain: prop drilling, manual token lookups, and scattered utility functions.

---

## Section 1: PayFlow Decomposition (1,851 → ~600 lines)

### Hook: `usePayFlowAuth()`

**File:** `hooks/use-pay-flow-auth.ts`

Extracts auth modal state + passkey handlers from PayFlow:
- State: `authModalOpen`
- Logic: `handlePasskeyRegister`, `handlePasskeyAuthenticate`, auto-open effect
- Deps: `usePasskey()`, `useUTXOpiaStore` (deriveKeysFromPasskeySeed), `hasKeys`
- Returns: `{ authModalOpen, setAuthModalOpen, handlePasskeyRegister, handlePasskeyAuthenticate }`

### Hook: `usePayFlowNotes(selectedToken, totalOutputSats, initialSecretPhrase?, preselectedNote?)`

**File:** `hooks/use-pay-flow-notes.ts`

Extracts note selection + secret phrase import logic:
- State: `selectedNoteIds`, `showNoteSelector`, `importPhrase`, `importedNotes`, `importLoading`, `importError`, `showImportInput`
- Logic: auto-select notes when output changes, pre-select from props, `handleImportScan`, `clearImportedNote`, `handleRefresh`
- Deps: `useUTXOpia()` (inboxNotes, refreshInbox), `scanSecretPhrase`
- Returns: `{ selectedNotes, availableNotes, totalInputSats, activeImportedNotes, hasImportedNotes, handleImportScan, clearImportedNote, handleRefresh, showNoteSelector, setShowNoteSelector, showImportInput, setShowImportInput, importPhrase, setImportPhrase, importLoading, importError }`

### Hook: `useRelayerConfig(selectedToken)`

**File:** `hooks/use-relayer-config.ts`

Extracts relayer fee fetching:
- State: `relayerMeta`
- Logic: fetch `/api/relayer/meta` on mount, compute per-token fees
- Returns: `{ relayerMeta, relayerMetaLoaded, effectiveRelayerFee, effectiveServiceFee, effectiveServiceFeeBps }`

### What stays in PayFlow

- UI state: `step`, `error`, `loading`, `outputs`, `showAdvanced`, `showTokenPicker`, `selectedToken`, `requestId`, `changeAmountSats`, `proofStatus`
- `handleSend` function (touches all state groups, ~200 lines)
- Render logic (~300 lines)
- Output row handlers (`updateOutput`, `addOutput`, `removeOutput`)

---

## Section 2: ShieldFlow Decomposition (1,035 → ~400 lines)

### Hook: `useTokenBalance(selectedToken, publicKey, connection)`

**File:** `hooks/use-token-balance.ts`

Extracts SOL/SPL balance fetching:
- State: `solBalance`, `splBalance`
- Logic: two useEffects for fetching balances on token/wallet change, `handleMax`
- Returns: `{ solBalance, splBalance, handleMax }`

### Hook: `useBtcDeposit(stealthAddress)`

**File:** `hooks/use-btc-deposit.ts`

Extracts BTC-specific deposit flow:
- State: `btcAmount`, `walletDepositing`, `walletDepositResult`, `depositPreview`, `buildingPreview`, `selectedUtxoKeys`, `showUtxoList`, `editingUtxos`, `showOpReturn`, `copiedBtcAddr`, `showWalletPicker`
- Logic: `resetBtcFlow`, `handleBuildPreview`, `handleWalletDeposit`, UTXO selection
- Deps: `useBitcoinWalletStore`, `useNotesStore`, `registerDeposit`
- Returns: `{ btcAmount, setBtcAmount, depositPreview, walletDepositResult, walletDepositing, handleBuildPreview, handleWalletDeposit, resetBtcFlow, selectedUtxoKeys, setSelectedUtxoKeys, showUtxoList, setShowUtxoList, editingUtxos, setEditingUtxos, showOpReturn, setShowOpReturn, copiedBtcAddr, setCopiedBtcAddr, showWalletPicker, setShowWalletPicker, buildingPreview }`

### What stays in ShieldFlow

- UI state: `selectedToken`, `dropdownOpen`, `amount`, `resolvedMeta`, `resolvedName`, `status`, `error`, `txSig`, `copiedAddr`
- SPL shield handler (`handleShieldSpl`)
- Token dropdown + render logic

---

## Section 3: Prop Consolidation

### AuthModal (11 → 3 props)

```typescript
interface AuthModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  auth: {
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
  };
}
```

### OutputRowCard (14 → 5 props)

```typescript
interface OutputRowCardProps {
  output: OutputRow;
  index: number;
  canRemove: boolean;
  handlers: {
    onUpdate: (update: Partial<OutputRow>) => void;
    onRemove: () => void;
  };
  config: {
    defaultAddress: string;
    disablePublic?: boolean;
    disableBtc?: boolean;
    selfMeta?: StealthMetaAddress | null;
    maxAmount: number;
    serviceFeeSats?: number;
    serviceFeeBps?: number;
    tokenUnit?: string;
    tokenSymbol?: string;
  };
}
```

---

## Section 4: Quick Wins

### 4a. Use getTokenBySymbol() consistently

`getTokenBySymbol()` already exists in `supported-tokens.ts`. Replace all manual `SUPPORTED_TOKENS.find()` calls with it:
- `deposits-tab.tsx` — 4 inline `.find()` calls → `getTokenBySymbol("BTC")!` etc.
- `InboxItem.tsx` — manual `.find()` → `getTokenBySymbol()`
- `balance-view.tsx` — manual `.find()` → `getTokenBySymbol()`
- `activity/page.tsx` — manual `.find()` → `getTokenBySymbol()`

No new constants needed — the existing helper handles all tokens including jupUSD and future additions.

### 4b. Extract tvlToUsd

Move `tvlToUsd()` from `app/page.tsx` to `lib/supported-tokens.ts`. Same function, just exported for reuse. Both `page.tsx` and `explorer/page.tsx` have similar TVL display logic.

### 4c. Remove leftover devDep

Remove `@vitejs/plugin-react` from `package.json` devDependencies (was only used by vitest, now removed).

---

## Execution Order

1. **Quick wins** (Section 4) — lowest risk, build passes after each change
2. **Prop consolidation** (Section 3) — 2 components, mechanical refactor
3. **ShieldFlow hooks** (Section 2) — smaller component, validates approach
4. **PayFlow hooks** (Section 1) — largest component, same pattern

## Verification

After each step:
- `bun run build` — no import errors
- `bun test` — all 88 tests pass
- Manual: vault deposit flow, pay flow, explorer page still work
