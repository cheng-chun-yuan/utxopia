# Pay-Wizard Merge — Phase 1 (Lite-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Subagents in this project are plan-only; the main agent executes. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the user-facing Lite slice of the unified `/send` page: replace the four `/vault/pay/{transfer,unshield,withdraw,cashout}` routes (and the Lite/Pro mode toggle) with a single 1-page progressive form, plus a `/settings` route stub for the future Advanced toggle.

**Architecture:** New top-level `/send` route renders a single `<SendForm>` orchestrator with progressive disclosure (recipient → token → amount → fee → review). A pure `recipient-detect` function dispatches one of four ix paths via `build-tx`. A new `/settings` route holds the Advanced-send toggle (disabled, "Coming soon" until Phase 2). Old `/vault/pay/*` routes and the `payment-wizard/` + `pay-flow/` directories are deleted; useful sub-components (`note-links`, `proving-steps`) are lifted into `components/send/_lifted/` first.

**Tech stack:** Next.js 14 App Router, React 18, TypeScript, `@privacy-coin/sdk`, `bun test` + `@testing-library/react` + `@happy-dom`, `lucide-react`, `framer-motion`, Tailwind, Radix Dialog, existing hooks (`usePrivacyCoin`, `usePayFlowAuth`, `useProver`, `useTokenBalance`, `useTokenPrices`, `useStealthInbox`).

**Spec:** [docs/designs/2026-05-10-pay-wizard-merge-design.md](../designs/2026-05-10-pay-wizard-merge-design.md). This plan implements Phase 1 only; Phases 2–4 (Advanced multi-output, custom BTC fee rate, coin control) are separate plans.

**Phase 1 acceptance:**
- `/send` covers BTC withdraw, stealth transfer (SNS + meta), SPL unshield, and claim-link in one page.
- `/settings` exists with a disabled Advanced toggle.
- Old `/vault/pay/*` routes return 404.
- `bun test` green for new pure-logic tests.
- `bun run build` clean.
- Manual QA checklist (8 items) passes.

---

## File-Structure Map

| File | Status | Responsibility |
|---|---|---|
| `web/src/components/send/_lifted/note-links.tsx` | **NEW (lift)** | Render claim-link UI. Lifted verbatim from `web/src/components/btc-widget/pay-flow/note-links.tsx`. |
| `web/src/components/send/_lifted/proving-steps.tsx` | **NEW (lift)** | ZK proof progress indicator. Lifted from `web/src/components/btc-widget/pay-flow/proving-steps.tsx`. |
| `web/src/components/send/_lifted/output-row-card.tsx` | **NEW (lift)** | Single-output row card. Lifted for Phase 2 use; not imported in Phase 1 but needs to survive the deletion of `pay-flow/`. |
| `web/src/components/send/recipient-detect.ts` | **NEW** | Pure function: `detectRecipient(input) => { type, confidence, reason? }`. No deps. |
| `web/src/components/send/build-tx.ts` | **NEW** | Pure dispatch: `(state) → SendIntent { kind, ix-builder-args }`. Switches on recipient type. |
| `web/src/components/send/recipient-input.tsx` | **NEW** | Smart-paste field with status row. Uses `recipient-detect` + SNS resolution. |
| `web/src/components/send/token-source-picker.tsx` | **NEW** | "From" dropdown filtered by recipient type. |
| `web/src/components/send/amount-field.tsx` | **NEW** | Token/USD amount input + Max button. |
| `web/src/components/send/fee-summary.tsx` | **NEW** | Network + service fee display, BTC privacy warning. |
| `web/src/components/send/review-modal.tsx` | **NEW** | Final review with HoldButton. |
| `web/src/components/send/claim-link-modal.tsx` | **NEW** | Generate claim link UI. Uses `_lifted/note-links.tsx`. |
| `web/src/components/send/send-form.tsx` | **NEW** | Orchestrator. `useReducer` state. Progressive disclosure. |
| `web/src/app/send/page.tsx` | **NEW** | Route — wraps `SendForm` in `FlowPageLayout`. |
| `web/src/hooks/use-ui-mode.ts` | **NEW** | localStorage `aegis-ui-mode` + React context broadcast. |
| `web/src/components/ui/advanced-mode-badge.tsx` | **NEW** | Header badge when Advanced active. Returns null in Phase 1 (Advanced is disabled). |
| `web/src/components/settings/preferences-form.tsx` | **NEW** | Toggle list. One disabled toggle in Phase 1. |
| `web/src/app/settings/page.tsx` | **NEW** | Route — wraps `PreferencesForm` in `FlowPageLayout`. |
| `web/src/components/site-header.tsx` | **MODIFY** | Add gear icon link to `/settings`; mount `<AdvancedModeBadge />`. |
| `web/src/app/vault/page.tsx` | **MODIFY** | Replace four pay-related cards/links with one "Send" link to `/send`. |
| `web/src/app/vault/pay/transfer/page.tsx` | **DELETE** | |
| `web/src/app/vault/pay/unshield/page.tsx` | **DELETE** | |
| `web/src/app/vault/pay/withdraw/page.tsx` | **DELETE** | |
| `web/src/app/vault/pay/cashout/page.tsx` | **DELETE** | |
| `web/src/components/payment-wizard/` (whole dir) | **DELETE** | After old routes are gone. |
| `web/src/components/btc-widget/pay-flow.tsx` | **DELETE** | After SendForm has subsumed its function. |
| `web/src/components/btc-widget/pay-flow/` (whole dir) | **DELETE** | After lifts are done. |
| `web/src/components/send/recipient-detect.test.ts` | **NEW (test)** | Table-style fuzz of detection rules. |
| `web/src/components/send/build-tx.test.ts` | **NEW (test)** | Per-recipient ix dispatch with mocked SDK. |
| `web/src/components/send/recipient-input.test.tsx` | **NEW (test)** | Component smoke + interaction. |
| `web/src/components/send/token-source-picker.test.tsx` | **NEW (test)** | Coupling table. |
| `web/src/components/send/amount-field.test.tsx` | **NEW (test)** | Max, dust, USD toggle. |
| `web/src/components/send/send-form.test.tsx` | **NEW (test)** | Progressive reveal smoke test. |
| `web/src/hooks/__tests__/use-ui-mode.test.tsx` | **NEW (test)** | localStorage round-trip + context broadcast. |

---

## Tasks

> **Convention:** Each task is one focused change ending in a commit. TDD where the unit is testable; smoke tests for UI-heavy components. Test imports: `import { describe, it, expect, beforeEach, mock } from "bun:test"` and `import { renderHook, render, fireEvent, screen, act } from "@testing-library/react"`. Test files include `/** @happy-dom */` at the top to opt into the DOM env. Run tests with `cd web && bun test path/to/file.test.tsx -t "test name"`.

### Task 1: Lift kept components from `pay-flow/` to `send/_lifted/`

**Files:**
- Create: `web/src/components/send/_lifted/note-links.tsx`
- Create: `web/src/components/send/_lifted/proving-steps.tsx`
- Create: `web/src/components/send/_lifted/output-row-card.tsx`

- [ ] **Step 1: Copy each file verbatim**

```bash
mkdir -p web/src/components/send/_lifted
cp web/src/components/btc-widget/pay-flow/note-links.tsx web/src/components/send/_lifted/note-links.tsx
cp web/src/components/btc-widget/pay-flow/proving-steps.tsx web/src/components/send/_lifted/proving-steps.tsx
cp web/src/components/btc-widget/pay-flow/output-row-card.tsx web/src/components/send/_lifted/output-row-card.tsx
```

- [ ] **Step 2: Adjust relative imports if any**

Each lifted file may import from `./helpers` or `../helpers`. After lift, those imports become `../../btc-widget/pay-flow/helpers` (still works while old files exist). Keep them; we'll fix in Task 20 right before the source dir is deleted.

Run `cd web && bun run build` to verify the project still builds.
Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/send/_lifted
git commit -m "Lift note-links/proving-steps/output-row-card into send/_lifted/

Pre-deletion move so SendForm and the future Phase 2 multi-output flow
keep working components. Imports still point at the old helpers.ts
location; fixed in the deletion task once everything is in place."
```

---

### Task 2: `recipient-detect.ts` — pure detection (TDD)

**Files:**
- Create: `web/src/components/send/recipient-detect.ts`
- Create: `web/src/components/send/recipient-detect.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// web/src/components/send/recipient-detect.test.ts
/** @happy-dom */
import { describe, it, expect } from "bun:test";
import { detectRecipient } from "./recipient-detect";

describe("detectRecipient", () => {
  it("returns 'empty' for empty / whitespace input", () => {
    expect(detectRecipient("").type).toBe("empty");
    expect(detectRecipient("   ").type).toBe("empty");
  });

  it("detects .btcpro.sol as stealth_sns", () => {
    const r = detectRecipient("alice.btcpro.sol");
    expect(r.type).toBe("stealth_sns");
    expect(r.confidence).toBe("high");
  });

  it("detects bech32 BTC mainnet addresses (bc1...)", () => {
    const r = detectRecipient("bc1q9d4ywgfnd8h70q4thlsclpw0ymmqfumzgxlhpe");
    expect(r.type).toBe("btc");
    expect(r.confidence).toBe("high");
  });

  it("detects bech32 testnet (tb1...) and regtest (bcrt1...)", () => {
    expect(detectRecipient("tb1pelu63s2nzxvj5ezr05jxdf9dyq9pgkn3qzxq6jgcvwhg2vu0d62qq6yg2j").type).toBe("btc");
    expect(detectRecipient("bcrt1pdsvdn95vcdsjwz92tc4x5y8w026hur8ud7nvae65y4rvsjsqe8fq5j9s56").type).toBe("btc");
  });

  it("detects legacy P2PKH ('1...') and P2SH ('3...') as btc with medium confidence", () => {
    const r1 = detectRecipient("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa");
    expect(r1.type).toBe("btc");
    expect(r1.confidence).toBe("medium");
    const r3 = detectRecipient("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy");
    expect(r3.type).toBe("btc");
  });

  it("detects Solana base58 pubkey (44 chars) as spl_wallet", () => {
    // Real on-curve Solana pubkey
    const r = detectRecipient("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
    expect(r.type).toBe("spl_wallet");
    expect(r.confidence).toBe("medium");
  });

  it("detects stealth meta-address (hex prefix 'pcoin:')", () => {
    // Format: 'pcoin:' + 64 hex chars (spending pub) + 64 hex chars (viewing pub)
    const meta = "pcoin:" + "01".repeat(32) + "02".repeat(32);
    const r = detectRecipient(meta);
    expect(r.type).toBe("stealth_meta");
    expect(r.confidence).toBe("high");
  });

  it("returns invalid for garbage input", () => {
    expect(detectRecipient("not a valid address").type).toBe("invalid");
    expect(detectRecipient("xxxxxxxxxxxxxx").type).toBe("invalid");
  });

  it("returns invalid for almost-valid bech32 (off-by-one)", () => {
    // Truncated bech32 — invalid checksum
    const r = detectRecipient("bc1q9d4ywgfnd8h70q4thlsclpw0ymmqfumzgxlhp");
    expect(r.type).toBe("invalid");
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `cd web && bun test src/components/send/recipient-detect.test.ts`
Expected: FAIL — module `./recipient-detect` not found.

- [ ] **Step 3: Implement the detector**

```ts
// web/src/components/send/recipient-detect.ts
/**
 * Pure recipient-type detection.
 *
 * Detection is a first-match-wins ladder; see
 * docs/designs/2026-05-10-pay-wizard-merge-design.md "Detection rules".
 */

export type RecipientType =
  | "btc"
  | "stealth_sns"
  | "stealth_meta"
  | "spl_wallet";

export type DetectionResult = {
  type: RecipientType | "invalid" | "ambiguous" | "empty";
  confidence: "high" | "medium" | "low";
  reason?: string;
};

const SNS_SUFFIX = ".btcpro.sol";
const STEALTH_META_PREFIX = "pcoin:";
const STEALTH_META_HEX_LEN = 64 + 64; // 32-byte spending pub + 32-byte viewing pub

const BECH32_PREFIXES = ["bc1", "tb1", "bcrt1"];

const BASE58_ALPHABET =
  /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;

function looksLikeBech32(input: string): boolean {
  const lower = input.toLowerCase();
  if (!BECH32_PREFIXES.some((p) => lower.startsWith(p))) return false;
  // Bech32 is a-z + 0-9 except 1, b, i, o (we don't fully validate the
  // checksum here — that's the SDK's job downstream; we only need a
  // type-detection signal sharp enough to avoid false positives).
  return /^[a-z0-9]+$/.test(lower) && lower.length >= 26 && lower.length <= 90;
}

function looksLikeBase58(input: string, minLen: number, maxLen: number): boolean {
  return (
    input.length >= minLen &&
    input.length <= maxLen &&
    BASE58_ALPHABET.test(input)
  );
}

function looksLikeLegacyBtc(input: string): boolean {
  if (!(input.startsWith("1") || input.startsWith("3"))) return false;
  return looksLikeBase58(input, 26, 35);
}

function looksLikeSolanaPubkey(input: string): boolean {
  // Solana base58 is 32-44 chars; on-curve verification is the SDK's job.
  return looksLikeBase58(input, 32, 44) && input.length >= 43;
}

function looksLikeStealthMeta(input: string): boolean {
  if (!input.startsWith(STEALTH_META_PREFIX)) return false;
  const rest = input.slice(STEALTH_META_PREFIX.length);
  return rest.length === STEALTH_META_HEX_LEN && /^[0-9a-fA-F]+$/.test(rest);
}

export function detectRecipient(rawInput: string): DetectionResult {
  const input = rawInput.trim();
  if (input.length === 0) {
    return { type: "empty", confidence: "high" };
  }

  if (input.toLowerCase().endsWith(SNS_SUFFIX)) {
    return {
      type: "stealth_sns",
      confidence: "high",
      reason: "Looks like a .btcpro.sol name",
    };
  }

  if (looksLikeBech32(input)) {
    return { type: "btc", confidence: "high", reason: "Bech32 Bitcoin address" };
  }

  if (looksLikeLegacyBtc(input)) {
    return { type: "btc", confidence: "medium", reason: "Legacy Bitcoin address" };
  }

  if (looksLikeStealthMeta(input)) {
    return { type: "stealth_meta", confidence: "high", reason: "Stealth meta-address" };
  }

  if (looksLikeSolanaPubkey(input)) {
    return { type: "spl_wallet", confidence: "medium", reason: "Solana wallet address" };
  }

  return { type: "invalid", confidence: "low", reason: "Not a recognized address format" };
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `cd web && bun test src/components/send/recipient-detect.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/send/recipient-detect.ts web/src/components/send/recipient-detect.test.ts
git commit -m "Add recipient-detect pure function for /send wizard

First-match-wins ladder: empty → SNS → bech32 BTC → legacy BTC →
stealth meta → Solana pubkey → invalid. Confidence is high for
checksum-bearing formats, medium for length-only heuristics. Full
on-curve / checksum validation is the SDK's job downstream — this
function only needs to be sharp enough to drive the type indicator."
```

---

### Task 3: `use-ui-mode` hook (TDD)

**Files:**
- Create: `web/src/hooks/use-ui-mode.ts`
- Create: `web/src/hooks/__tests__/use-ui-mode.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/hooks/__tests__/use-ui-mode.test.tsx
/** @happy-dom */
import { describe, it, expect, beforeEach } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { UiModeProvider, useUiMode } from "../use-ui-mode";
import type { ReactNode } from "react";

const wrapper = ({ children }: { children: ReactNode }) => (
  <UiModeProvider>{children}</UiModeProvider>
);

describe("useUiMode", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to 'lite' when no localStorage value", () => {
    const { result } = renderHook(() => useUiMode(), { wrapper });
    expect(result.current.mode).toBe("lite");
    expect(result.current.isAdvanced).toBe(false);
  });

  it("reads existing localStorage value", () => {
    localStorage.setItem("aegis-ui-mode", "advanced");
    const { result } = renderHook(() => useUiMode(), { wrapper });
    expect(result.current.mode).toBe("advanced");
    expect(result.current.isAdvanced).toBe(true);
  });

  it("setMode updates localStorage and broadcasts", () => {
    const { result } = renderHook(() => useUiMode(), { wrapper });
    act(() => result.current.setMode("advanced"));
    expect(result.current.mode).toBe("advanced");
    expect(localStorage.getItem("aegis-ui-mode")).toBe("advanced");
  });

  it("ignores invalid localStorage values (falls back to lite)", () => {
    localStorage.setItem("aegis-ui-mode", "garbage");
    const { result } = renderHook(() => useUiMode(), { wrapper });
    expect(result.current.mode).toBe("lite");
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `cd web && bun test src/hooks/__tests__/use-ui-mode.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hook**

```tsx
// web/src/hooks/use-ui-mode.ts
"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type UiMode = "lite" | "advanced";

const STORAGE_KEY = "aegis-ui-mode";

type UiModeContextValue = {
  mode: UiMode;
  isAdvanced: boolean;
  setMode: (next: UiMode) => void;
};

const UiModeContext = createContext<UiModeContextValue | null>(null);

function readInitial(): UiMode {
  if (typeof window === "undefined") return "lite";
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === "advanced" ? "advanced" : "lite";
}

export function UiModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<UiMode>(() => readInitial());

  // Sync across tabs/windows.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== STORAGE_KEY) return;
      setModeState(e.newValue === "advanced" ? "advanced" : "lite");
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const value = useMemo<UiModeContextValue>(
    () => ({
      mode,
      isAdvanced: mode === "advanced",
      setMode: (next) => {
        setModeState(next);
        window.localStorage.setItem(STORAGE_KEY, next);
      },
    }),
    [mode],
  );

  return <UiModeContext.Provider value={value}>{children}</UiModeContext.Provider>;
}

export function useUiMode(): UiModeContextValue {
  const ctx = useContext(UiModeContext);
  if (!ctx) {
    // Allow hook calls outside the provider in tests / SSR — return lite.
    return { mode: "lite", isAdvanced: false, setMode: () => {} };
  }
  return ctx;
}
```

- [ ] **Step 4: Mount provider in `app/providers.tsx`**

Read `web/src/app/providers.tsx` first to find the right place. Wrap the existing provider tree with `<UiModeProvider>`.

- [ ] **Step 5: Run tests to confirm pass**

Run: `cd web && bun test src/hooks/__tests__/use-ui-mode.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add web/src/hooks/use-ui-mode.ts web/src/hooks/__tests__/use-ui-mode.test.tsx web/src/app/providers.tsx
git commit -m "Add use-ui-mode hook for Lite/Advanced send mode preference

localStorage-backed (key: aegis-ui-mode), default 'lite'. Cross-tab
broadcast via 'storage' event. Provider mounted in app/providers.tsx
so /send and the future /settings page can both read it."
```

---

### Task 4: `recipient-input.tsx` component

**Files:**
- Create: `web/src/components/send/recipient-input.tsx`
- Create: `web/src/components/send/recipient-input.test.tsx`

- [ ] **Step 1: Write smoke + interaction tests**

```tsx
// web/src/components/send/recipient-input.test.tsx
/** @happy-dom */
import { describe, it, expect } from "bun:test";
import { render, fireEvent, screen } from "@testing-library/react";
import { RecipientInput } from "./recipient-input";

describe("RecipientInput", () => {
  it("renders an empty input with placeholder", () => {
    render(<RecipientInput value="" onChange={() => {}} />);
    expect(
      screen.getByPlaceholderText(/paste address or .btcpro.sol/i),
    ).toBeInTheDocument();
  });

  it("shows a green status row for a valid BTC address", () => {
    const { rerender } = render(<RecipientInput value="" onChange={() => {}} />);
    rerender(
      <RecipientInput
        value="bc1q9d4ywgfnd8h70q4thlsclpw0ymmqfumzgxlhpe"
        onChange={() => {}}
      />,
    );
    expect(screen.getByText(/Bech32 Bitcoin address/i)).toBeInTheDocument();
  });

  it("shows a red status row for invalid input", () => {
    render(<RecipientInput value="garbage" onChange={() => {}} />);
    expect(screen.getByText(/not a recognized/i)).toBeInTheDocument();
  });

  it("calls onChange when typing", () => {
    let captured = "";
    render(
      <RecipientInput
        value=""
        onChange={(v) => {
          captured = v;
        }}
      />,
    );
    const input = screen.getByPlaceholderText(/paste address/i);
    fireEvent.change(input, { target: { value: "alice.btcpro.sol" } });
    expect(captured).toBe("alice.btcpro.sol");
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `cd web && bun test src/components/send/recipient-input.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

```tsx
// web/src/components/send/recipient-input.tsx
"use client";

import { Check, X, Loader2, Clipboard } from "lucide-react";
import { useCallback } from "react";
import { cn } from "@/lib/utils";
import { detectRecipient, type DetectionResult } from "./recipient-detect";

export interface RecipientInputProps {
  value: string;
  onChange: (next: string) => void;
  /** True while async resolution (SNS) is in flight. */
  resolving?: boolean;
  className?: string;
}

function statusFor(value: string, resolving: boolean): {
  detection: DetectionResult;
  tone: "neutral" | "ok" | "warn" | "bad";
  label: string;
} {
  if (resolving) {
    return {
      detection: { type: "empty", confidence: "low" },
      tone: "warn",
      label: "Resolving SNS name…",
    };
  }
  const detection = detectRecipient(value);
  if (detection.type === "empty") return { detection, tone: "neutral", label: "" };
  if (detection.type === "invalid") {
    return { detection, tone: "bad", label: detection.reason ?? "Not a valid recipient" };
  }
  if (detection.type === "ambiguous") {
    return { detection, tone: "warn", label: "Ambiguous — try a longer or clearer address" };
  }
  return { detection, tone: "ok", label: detection.reason ?? "Looks valid" };
}

export function RecipientInput({
  value,
  onChange,
  resolving = false,
  className,
}: RecipientInputProps) {
  const { tone, label } = statusFor(value, resolving);

  const onPasteFromClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      onChange(text.trim());
    } catch {
      // ignore — clipboard permission denied
    }
  }, [onChange]);

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="relative">
        <input
          aria-label="Recipient"
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Paste address or .btcpro.sol name"
          className={cn(
            "w-full px-3 py-3 pr-10 rounded-lg",
            "bg-muted/40 border text-sm font-mono",
            "focus:outline-none focus:ring-2 focus:ring-privacy/40",
            tone === "bad" && "border-red-500/40",
            tone === "ok" && "border-privacy/30",
            tone === "warn" && "border-yellow-500/30",
            tone === "neutral" && "border-gray/15",
          )}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          onClick={onPasteFromClipboard}
          aria-label="Paste from clipboard"
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded hover:bg-muted/60 text-muted-foreground"
        >
          <Clipboard className="w-4 h-4" />
        </button>
      </div>
      {label && (
        <div
          className={cn(
            "flex items-center gap-1.5 text-xs",
            tone === "ok" && "text-privacy",
            tone === "warn" && "text-yellow-500",
            tone === "bad" && "text-red-500",
          )}
        >
          {tone === "ok" && <Check className="w-3 h-3" />}
          {tone === "warn" && <Loader2 className="w-3 h-3 animate-spin" />}
          {tone === "bad" && <X className="w-3 h-3" />}
          <span>{label}</span>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `cd web && bun test src/components/send/recipient-input.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/send/recipient-input.tsx web/src/components/send/recipient-input.test.tsx
git commit -m "Add RecipientInput smart-paste field

Drives the type indicator off recipient-detect. Shows green/yellow/red
status row underneath. Includes a paste-from-clipboard button."
```

---

### Task 5: `token-source-picker.tsx` component

**Files:**
- Create: `web/src/components/send/token-source-picker.tsx`
- Create: `web/src/components/send/token-source-picker.test.tsx`

- [ ] **Step 1: Write coupling-table tests**

```tsx
// web/src/components/send/token-source-picker.test.tsx
/** @happy-dom */
import { describe, it, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
import { TokenSourcePicker } from "./token-source-picker";

describe("TokenSourcePicker", () => {
  it("is disabled when recipient type is btc, locked to zkBTC", () => {
    render(
      <TokenSourcePicker
        recipientType="btc"
        selected="zkBTC"
        onSelect={() => {}}
      />,
    );
    expect(screen.getByRole("button")).toBeDisabled();
    expect(screen.getByText(/zkBTC/i)).toBeInTheDocument();
  });

  it("is enabled for stealth_sns (any shielded token)", () => {
    render(
      <TokenSourcePicker
        recipientType="stealth_sns"
        selected="zkBTC"
        onSelect={() => {}}
      />,
    );
    expect(screen.getByRole("button")).not.toBeDisabled();
  });

  it("is enabled for spl_wallet", () => {
    render(
      <TokenSourcePicker
        recipientType="spl_wallet"
        selected="zkBTC"
        onSelect={() => {}}
      />,
    );
    expect(screen.getByRole("button")).not.toBeDisabled();
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `cd web && bun test src/components/send/token-source-picker.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the picker**

```tsx
// web/src/components/send/token-source-picker.tsx
"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { VAULT_TOKENS } from "@/lib/supported-tokens";
import type { RecipientType } from "./recipient-detect";

export interface TokenSourcePickerProps {
  recipientType: RecipientType | "claim_link" | null;
  selected: string;
  onSelect: (symbol: string) => void;
  className?: string;
}

function allowedFor(recipientType: TokenSourcePickerProps["recipientType"]) {
  if (recipientType === "btc") {
    return VAULT_TOKENS.filter((t) => t.shieldedSymbol === "zkBTC");
  }
  // stealth_sns | stealth_meta | spl_wallet | claim_link | null → any vault token
  return VAULT_TOKENS;
}

export function TokenSourcePicker({
  recipientType,
  selected,
  onSelect,
  className,
}: TokenSourcePickerProps) {
  const [open, setOpen] = useState(false);
  const tokens = allowedFor(recipientType);
  const disabled = recipientType === "btc";
  const current = tokens.find((t) => t.shieldedSymbol === selected) ?? tokens[0];

  return (
    <div className={cn("relative", className)}>
      <label className="block text-xs text-muted-foreground mb-1.5">From</label>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "w-full flex items-center justify-between px-3 py-2.5 rounded-lg",
          "bg-muted/40 border border-gray/15 text-sm",
          disabled && "opacity-60 cursor-not-allowed",
          !disabled && "hover:border-privacy/30",
        )}
        title={
          disabled
            ? "Bitcoin addresses can only receive zkBTC. To send other tokens, use a Solana wallet or stealth address."
            : undefined
        }
      >
        <span className="flex items-center gap-2">
          <span className="font-medium">{current?.shieldedSymbol ?? "zkBTC"}</span>
          <span className="text-muted-foreground text-xs">{current?.name ?? "Bitcoin"}</span>
        </span>
        {!disabled && <ChevronDown className="w-4 h-4 text-muted-foreground" />}
      </button>

      {open && !disabled && (
        <div className="absolute z-10 mt-1 w-full bg-background border border-gray/20 rounded-lg shadow-lg overflow-hidden">
          {tokens.map((t) => (
            <button
              key={t.shieldedSymbol}
              type="button"
              onClick={() => {
                onSelect(t.shieldedSymbol);
                setOpen(false);
              }}
              className={cn(
                "w-full text-left px-3 py-2 flex items-center gap-2 text-sm",
                "hover:bg-muted/60",
                t.shieldedSymbol === selected && "bg-privacy/10 text-privacy",
              )}
            >
              <span className="font-medium">{t.shieldedSymbol}</span>
              <span className="text-muted-foreground text-xs">{t.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `cd web && bun test src/components/send/token-source-picker.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/send/token-source-picker.tsx web/src/components/send/token-source-picker.test.tsx
git commit -m "Add TokenSourcePicker — coupling table for recipient type → tokens

BTC recipient locks to zkBTC (disabled with tooltip). All other
recipient types open the full vault token list."
```

---

### Task 6: `amount-field.tsx` component

**Files:**
- Create: `web/src/components/send/amount-field.tsx`
- Create: `web/src/components/send/amount-field.test.tsx`

- [ ] **Step 1: Write tests**

```tsx
// web/src/components/send/amount-field.test.tsx
/** @happy-dom */
import { describe, it, expect } from "bun:test";
import { render, fireEvent, screen } from "@testing-library/react";
import { AmountField } from "./amount-field";

describe("AmountField", () => {
  it("renders with placeholder '0'", () => {
    render(
      <AmountField
        value=""
        onChange={() => {}}
        decimals={8}
        unit="BTC"
        availableBaseUnits={100_000_000n}
        usdPerUnit={50000}
      />,
    );
    expect(screen.getByPlaceholderText("0")).toBeInTheDocument();
  });

  it("Max button fills the available amount minus a fee buffer", () => {
    let captured = "";
    render(
      <AmountField
        value=""
        onChange={(v) => (captured = v)}
        decimals={8}
        unit="BTC"
        availableBaseUnits={100_000_000n}
        feeBufferBaseUnits={1000n}
        usdPerUnit={50000}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /max/i }));
    // (100_000_000 - 1_000) / 1e8 = 0.99999
    expect(captured).toBe("0.99999");
  });

  it("rejects characters that aren't digits or a single dot", () => {
    let captured = "";
    render(
      <AmountField
        value=""
        onChange={(v) => (captured = v)}
        decimals={8}
        unit="BTC"
        availableBaseUnits={100_000_000n}
        usdPerUnit={50000}
      />,
    );
    const input = screen.getByPlaceholderText("0");
    fireEvent.change(input, { target: { value: "0.1abc" } });
    expect(captured).toBe(""); // rejected, onChange not called with bad
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd web && bun test src/components/send/amount-field.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the field**

```tsx
// web/src/components/send/amount-field.tsx
"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";

export interface AmountFieldProps {
  /** Display value as a decimal string (e.g. "0.001"). */
  value: string;
  onChange: (next: string) => void;
  /** Number of decimals in the underlying base unit (sats=8, USDC=6, etc). */
  decimals: number;
  /** Display unit shown to the right of the amount ("BTC", "USDC", etc.). */
  unit: string;
  /** Total available in base units (sats / minor units). */
  availableBaseUnits: bigint;
  /** Subtracted from availableBaseUnits when "Max" is pressed. */
  feeBufferBaseUnits?: bigint;
  /** USD value of one whole unit (used for the "≈ $X" preview). */
  usdPerUnit: number | null;
  className?: string;
}

const VALID_DECIMAL = /^[0-9]*\.?[0-9]*$/;

function baseUnitsToDecimal(base: bigint, decimals: number): string {
  if (decimals === 0) return base.toString();
  const s = base.toString().padStart(decimals + 1, "0");
  const intPart = s.slice(0, -decimals);
  const fracPart = s.slice(-decimals).replace(/0+$/, "");
  return fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
}

function decimalToFloat(s: string): number {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

export function AmountField({
  value,
  onChange,
  decimals,
  unit,
  availableBaseUnits,
  feeBufferBaseUnits = 0n,
  usdPerUnit,
  className,
}: AmountFieldProps) {
  const usdPreview = useMemo(() => {
    if (usdPerUnit == null) return null;
    const v = decimalToFloat(value);
    if (v <= 0) return null;
    const usd = v * usdPerUnit;
    return usd > 0 ? `≈ $${usd.toFixed(2)}` : null;
  }, [value, usdPerUnit]);

  const onMaxClick = () => {
    const usable =
      availableBaseUnits > feeBufferBaseUnits
        ? availableBaseUnits - feeBufferBaseUnits
        : 0n;
    onChange(baseUnitsToDecimal(usable, decimals));
  };

  const handleChange = (raw: string) => {
    if (!VALID_DECIMAL.test(raw)) return; // reject — stays at last valid
    onChange(raw);
  };

  return (
    <div className={cn("space-y-1.5", className)}>
      <label className="block text-xs text-muted-foreground">Amount</label>
      <div className="relative">
        <input
          aria-label="Amount"
          type="text"
          inputMode="decimal"
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          placeholder="0"
          className={cn(
            "w-full px-3 py-3 pr-32 rounded-lg",
            "bg-muted/40 border border-gray/15 text-sm font-mono",
            "focus:outline-none focus:ring-2 focus:ring-privacy/40",
          )}
          autoComplete="off"
          spellCheck={false}
        />
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{unit}</span>
          <button
            type="button"
            onClick={onMaxClick}
            className="text-xs px-2 py-1 rounded bg-privacy/10 text-privacy hover:bg-privacy/15"
          >
            Max
          </button>
        </div>
      </div>
      {usdPreview && (
        <div className="text-xs text-muted-foreground">{usdPreview}</div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `cd web && bun test src/components/send/amount-field.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/send/amount-field.tsx web/src/components/send/amount-field.test.tsx
git commit -m "Add AmountField — decimal input, Max, USD preview

Pure-controlled component. 'Max' subtracts an optional fee buffer.
Rejects non-numeric input at change time. USD preview uses caller-
supplied usdPerUnit (caller threads it from useTokenPrices)."
```

---

### Task 7: `fee-summary.tsx` component

**Files:**
- Create: `web/src/components/send/fee-summary.tsx`

> No automated test — pure presentational. Smoke-checked via `send-form.test.tsx` later.

- [ ] **Step 1: Implement**

```tsx
// web/src/components/send/fee-summary.tsx
"use client";

import { AlertTriangle } from "lucide-react";
import type { RecipientType } from "./recipient-detect";

export interface FeeSummaryProps {
  recipientType: RecipientType | "claim_link" | null;
  networkFeeLabel: string; // e.g. "≈ 120 sats"
  serviceFeeLabel: string; // e.g. "≈ 5 sats"
}

export function FeeSummary({
  recipientType,
  networkFeeLabel,
  serviceFeeLabel,
}: FeeSummaryProps) {
  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">Network fee</span>
        <span className="font-mono">{networkFeeLabel}</span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">Service fee</span>
        <span className="font-mono">{serviceFeeLabel}</span>
      </div>
      {recipientType === "btc" && (
        <div className="mt-2 flex items-start gap-1.5 px-2 py-1.5 rounded bg-yellow-500/10 text-yellow-600 dark:text-yellow-400">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span className="text-[11px]">
            This will reveal your Bitcoin withdrawal address on-chain.
          </span>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Build check**

Run: `cd web && bun run build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/send/fee-summary.tsx
git commit -m "Add FeeSummary — network + service fee + BTC privacy warning"
```

---

### Task 8: `review-modal.tsx` component

**Files:**
- Create: `web/src/components/send/review-modal.tsx`

> No automated test for the modal itself; the HoldButton it uses already has unit tests; integration covered in `send-form.test.tsx`.

- [ ] **Step 1: Implement**

```tsx
// web/src/components/send/review-modal.tsx
"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { HoldButton } from "@/components/ui/hold-button";

export interface ReviewModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recipientLabel: string;
  amountLabel: string;
  feeLabel: string;
  onConfirm: () => Promise<void> | void;
  /** Optional warning row (e.g. BTC privacy notice). */
  warning?: string;
}

export function ReviewModal({
  open,
  onOpenChange,
  recipientLabel,
  amountLabel,
  feeLabel,
  onConfirm,
  warning,
}: ReviewModalProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[420px] max-w-[calc(100vw-32px)] bg-background border border-gray/20 rounded-2xl p-5 shadow-xl">
          <div className="flex items-center justify-between mb-4">
            <Dialog.Title className="text-base font-semibold">Review send</Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              className="p-1 rounded hover:bg-muted/60 text-muted-foreground"
            >
              <X className="w-4 h-4" />
            </Dialog.Close>
          </div>

          <div className="space-y-3 text-sm">
            <Row label="To" value={recipientLabel} />
            <Row label="Amount" value={amountLabel} />
            <Row label="Total fees" value={feeLabel} />
          </div>

          {warning && (
            <div className="mt-3 px-2 py-1.5 rounded bg-yellow-500/10 text-yellow-600 text-xs">
              {warning}
            </div>
          )}

          <div className="mt-5">
            <HoldButton onComplete={onConfirm} label="Hold to send" />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      <span className="font-mono text-xs text-right break-all">{value}</span>
    </div>
  );
}
```

> Note: this assumes `HoldButton` has the signature `{ onComplete: () => Promise<void> | void; label: string }`. Verify by reading `web/src/components/ui/hold-button.tsx` before commit; if its API differs, adapt the call site (e.g., it may use `onConfirm` or `onClick` and require different prop names). Adjust without changing the component itself.

- [ ] **Step 2: Build check**

Run: `cd web && bun run build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/send/review-modal.tsx
git commit -m "Add ReviewModal — Radix dialog + existing HoldButton confirmation"
```

---

### Task 9: `claim-link-modal.tsx` component

**Files:**
- Create: `web/src/components/send/claim-link-modal.tsx`

- [ ] **Step 1: Implement (skeleton — wire SDK call in send-form)**

```tsx
// web/src/components/send/claim-link-modal.tsx
"use client";

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Copy, Check, X, Loader2 } from "lucide-react";
import { TokenSourcePicker } from "./token-source-picker";
import { AmountField } from "./amount-field";

export interface ClaimLinkResult {
  url: string;
  secret: string;
}

export interface ClaimLinkModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Caller does the SDK work; modal only orchestrates UI. */
  onGenerate: (input: {
    sourceToken: string;
    amount: string;
  }) => Promise<ClaimLinkResult>;
  availableBaseUnits: bigint;
  decimals: number;
  unit: string;
  usdPerUnit: number | null;
  defaultToken?: string;
}

export function ClaimLinkModal({
  open,
  onOpenChange,
  onGenerate,
  availableBaseUnits,
  decimals,
  unit,
  usdPerUnit,
  defaultToken = "zkBTC",
}: ClaimLinkModalProps) {
  const [sourceToken, setSourceToken] = useState(defaultToken);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ClaimLinkResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const handleGenerate = async () => {
    setBusy(true);
    setErr(null);
    try {
      setResult(await onGenerate({ sourceToken, amount }));
    } catch (e: any) {
      setErr(e?.message ?? "Couldn't generate link");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[460px] max-w-[calc(100vw-32px)] bg-background border border-gray/20 rounded-2xl p-5 shadow-xl">
          <div className="flex items-center justify-between mb-4">
            <Dialog.Title className="text-base font-semibold">Send via claim link</Dialog.Title>
            <Dialog.Close className="p-1 rounded hover:bg-muted/60 text-muted-foreground">
              <X className="w-4 h-4" />
            </Dialog.Close>
          </div>

          {!result ? (
            <div className="space-y-4">
              <TokenSourcePicker
                recipientType={"claim_link"}
                selected={sourceToken}
                onSelect={setSourceToken}
              />
              <AmountField
                value={amount}
                onChange={setAmount}
                decimals={decimals}
                unit={unit}
                availableBaseUnits={availableBaseUnits}
                usdPerUnit={usdPerUnit}
              />
              {err && <div className="text-xs text-red-500">{err}</div>}
              <button
                type="button"
                disabled={busy || !amount || amount === "0"}
                onClick={handleGenerate}
                className="w-full px-4 py-2.5 rounded-lg bg-privacy text-background text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                Generate claim link
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <CopyRow label="Link" value={result.url} />
              <CopyRow label="Secret" value={result.secret} />
              <p className="text-[11px] text-muted-foreground">
                Share both. The recipient pastes the link, the secret unlocks the funds.
              </p>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="w-full px-4 py-2.5 rounded-lg bg-muted/60 text-sm font-medium"
              >
                Done
              </button>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div>
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <button
        type="button"
        onClick={onCopy}
        className="w-full px-3 py-2 rounded-lg bg-muted/40 border border-gray/15 text-xs font-mono text-left flex items-center justify-between gap-2 hover:border-privacy/30"
      >
        <span className="truncate">{value}</span>
        {copied ? (
          <Check className="w-3.5 h-3.5 text-privacy shrink-0" />
        ) : (
          <Copy className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        )}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Build check**

Run: `cd web && bun run build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/send/claim-link-modal.tsx
git commit -m "Add ClaimLinkModal — generate + copy/share link UI

UI-only; the SDK call is delegated to onGenerate (wired in SendForm)."
```

---

### Task 10: `build-tx.ts` dispatch (TDD)

**Files:**
- Create: `web/src/components/send/build-tx.ts`
- Create: `web/src/components/send/build-tx.test.ts`

- [ ] **Step 1: Write tests**

```ts
// web/src/components/send/build-tx.test.ts
/** @happy-dom */
import { describe, it, expect } from "bun:test";
import { buildSendIntent } from "./build-tx";

describe("buildSendIntent", () => {
  it("dispatches BTC recipient to redeem kind", () => {
    const intent = buildSendIntent({
      recipientType: "btc",
      recipientValue: "bc1q9d4ywgfnd8h70q4thlsclpw0ymmqfumzgxlhpe",
      sourceToken: "zkBTC",
      amount: "0.001",
    });
    expect(intent.kind).toBe("redeem");
  });

  it("dispatches stealth_sns to transact kind", () => {
    const intent = buildSendIntent({
      recipientType: "stealth_sns",
      recipientValue: "alice.btcpro.sol",
      sourceToken: "zkBTC",
      amount: "0.001",
    });
    expect(intent.kind).toBe("transact");
  });

  it("dispatches stealth_meta to transact kind", () => {
    const intent = buildSendIntent({
      recipientType: "stealth_meta",
      recipientValue: "pcoin:" + "01".repeat(32) + "02".repeat(32),
      sourceToken: "zkBTC",
      amount: "0.001",
    });
    expect(intent.kind).toBe("transact");
  });

  it("dispatches spl_wallet to unshield kind", () => {
    const intent = buildSendIntent({
      recipientType: "spl_wallet",
      recipientValue: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      sourceToken: "zkBTC",
      amount: "0.001",
    });
    expect(intent.kind).toBe("unshield");
  });

  it("rejects BTC source token mismatch", () => {
    expect(() =>
      buildSendIntent({
        recipientType: "btc",
        recipientValue: "bc1q9d4ywgfnd8h70q4thlsclpw0ymmqfumzgxlhpe",
        sourceToken: "tUSDC",
        amount: "0.001",
      }),
    ).toThrow(/zkBTC/i);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd web && bun test src/components/send/build-tx.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the dispatcher**

```ts
// web/src/components/send/build-tx.ts
import type { RecipientType } from "./recipient-detect";

export type SendIntentKind = "redeem" | "transact" | "unshield" | "claim_link";

export interface SendIntent {
  kind: SendIntentKind;
  recipientType: RecipientType | "claim_link";
  recipientValue: string;
  sourceToken: string;
  amount: string;
}

export interface BuildSendIntentInput {
  recipientType: RecipientType | "claim_link";
  recipientValue: string;
  sourceToken: string;
  amount: string;
}

/**
 * Pure dispatch: maps wizard state → which on-chain ix kind to build.
 * Caller threads the resulting `kind` to the right SDK builder.
 *
 * Validation is intentionally minimal — only the cross-field constraints
 * the wizard's own UI doesn't already enforce visually.
 */
export function buildSendIntent(input: BuildSendIntentInput): SendIntent {
  const { recipientType, sourceToken } = input;

  if (recipientType === "btc" && sourceToken !== "zkBTC") {
    throw new Error(
      "Bitcoin recipients can only receive zkBTC — pick zkBTC as the source token.",
    );
  }

  let kind: SendIntentKind;
  switch (recipientType) {
    case "btc":
      kind = "redeem";
      break;
    case "stealth_sns":
    case "stealth_meta":
      kind = "transact";
      break;
    case "spl_wallet":
      kind = "unshield";
      break;
    case "claim_link":
      kind = "claim_link";
      break;
  }

  return {
    kind,
    recipientType,
    recipientValue: input.recipientValue,
    sourceToken,
    amount: input.amount,
  };
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `cd web && bun test src/components/send/build-tx.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/send/build-tx.ts web/src/components/send/build-tx.test.ts
git commit -m "Add buildSendIntent — pure dispatch from wizard state to ix kind

Maps recipient type → redeem/transact/unshield/claim_link. Enforces
BTC↔zkBTC source coupling. Caller threads the kind to the right SDK
builder; this function does not call the SDK itself."
```

---

### Task 11: `send-form.tsx` orchestrator

**Files:**
- Create: `web/src/components/send/send-form.tsx`
- Create: `web/src/components/send/send-form.test.tsx`

- [ ] **Step 1: Write smoke tests**

```tsx
// web/src/components/send/send-form.test.tsx
/** @happy-dom */
import { describe, it, expect } from "bun:test";
import { render, fireEvent, screen } from "@testing-library/react";
import { SendForm } from "./send-form";

// Stub the hooks the form depends on so the test stays unit-scoped.
import { mock } from "bun:test";

mock.module("@/hooks/use-token-balance", () => ({
  useTokenBalance: () => ({ balance: 100_000_000n, isLoading: false }),
}));
mock.module("@/hooks/use-token-prices", () => ({
  useTokenPrices: () => ({ prices: { btc: 50000 } }),
}));
mock.module("@/hooks/use-privacy-coin", () => ({
  usePrivacyCoin: () => ({ client: null, ready: true }),
}));

describe("SendForm", () => {
  it("renders the recipient input first; amount and review hidden until valid", () => {
    render(<SendForm />);
    expect(screen.getByPlaceholderText(/paste address/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/amount/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^send$/i })).not.toBeInTheDocument();
  });

  it("reveals the amount field after a valid recipient is entered", () => {
    render(<SendForm />);
    fireEvent.change(screen.getByPlaceholderText(/paste address/i), {
      target: { value: "bc1q9d4ywgfnd8h70q4thlsclpw0ymmqfumzgxlhpe" },
    });
    expect(screen.getByLabelText(/amount/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd web && bun test src/components/send/send-form.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the orchestrator**

```tsx
// web/src/components/send/send-form.tsx
"use client";

import { useReducer, useState, useMemo } from "react";
import { Send, LinkIcon, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { detectRecipient } from "./recipient-detect";
import { buildSendIntent } from "./build-tx";
import { RecipientInput } from "./recipient-input";
import { TokenSourcePicker } from "./token-source-picker";
import { AmountField } from "./amount-field";
import { FeeSummary } from "./fee-summary";
import { ReviewModal } from "./review-modal";
import { ClaimLinkModal, type ClaimLinkResult } from "./claim-link-modal";
import { useTokenBalance } from "@/hooks/use-token-balance";
import { useTokenPrices } from "@/hooks/use-token-prices";

type Action =
  | { type: "set_recipient"; value: string }
  | { type: "set_token"; value: string }
  | { type: "set_amount"; value: string }
  | { type: "open_review" }
  | { type: "close_review" }
  | { type: "reset" };

type State = {
  recipient: string;
  sourceToken: string;
  amount: string;
  reviewOpen: boolean;
};

const initial: State = {
  recipient: "",
  sourceToken: "zkBTC",
  amount: "",
  reviewOpen: false,
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "set_recipient":
      return { ...state, recipient: action.value };
    case "set_token":
      return { ...state, sourceToken: action.value };
    case "set_amount":
      return { ...state, amount: action.value };
    case "open_review":
      return { ...state, reviewOpen: true };
    case "close_review":
      return { ...state, reviewOpen: false };
    case "reset":
      return initial;
  }
}

export function SendForm() {
  const [state, dispatch] = useReducer(reducer, initial);
  const [linkOpen, setLinkOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detection = useMemo(() => detectRecipient(state.recipient), [state.recipient]);

  // For BTC recipient, force zkBTC source.
  const effectiveToken = detection.type === "btc" ? "zkBTC" : state.sourceToken;

  // Stub: pull the user's balance for the chosen token. The real selector
  // accepts the token symbol; adapt to whatever the existing hook expects.
  const { balance } = useTokenBalance(effectiveToken);
  const { prices } = useTokenPrices();
  const usdPerUnit = prices?.btc ?? null; // simplification: BTC-only Phase 1 price

  const recipientValid =
    detection.type !== "empty" &&
    detection.type !== "invalid" &&
    detection.type !== "ambiguous";

  const amountNum = parseFloat(state.amount || "0");
  const amountValid = recipientValid && amountNum > 0;

  const onSend = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const intent = buildSendIntent({
        recipientType: detection.type as any,
        recipientValue: state.recipient.trim(),
        sourceToken: effectiveToken,
        amount: state.amount,
      });

      // TODO(Phase 1.x): wire intent.kind to the right SDK builder
      // (prepareTransactInputs / prepareUnshieldInputs / prepareRedemptionInputs).
      // Phase 1 ships the orchestration; the SDK calls reuse usePayFlow* hooks.
      // For the scaffold commit, we just close the review.
      void intent;
      dispatch({ type: "close_review" });
    } catch (e: any) {
      setError(e?.message ?? "Send failed");
    } finally {
      setSubmitting(false);
    }
  };

  const onGenerateClaimLink = async (_input: {
    sourceToken: string;
    amount: string;
  }): Promise<ClaimLinkResult> => {
    // Wired in a follow-up commit (lifts existing logic from PayFlow).
    throw new Error("Claim-link generation not yet wired — Phase 1.1.");
  };

  return (
    <div className="space-y-4">
      <RecipientInput
        value={state.recipient}
        onChange={(v) => dispatch({ type: "set_recipient", value: v })}
      />

      {recipientValid && (
        <>
          <TokenSourcePicker
            recipientType={detection.type as any}
            selected={effectiveToken}
            onSelect={(s) => dispatch({ type: "set_token", value: s })}
          />
          <AmountField
            value={state.amount}
            onChange={(v) => dispatch({ type: "set_amount", value: v })}
            decimals={8}
            unit="BTC"
            availableBaseUnits={balance ?? 0n}
            usdPerUnit={usdPerUnit}
          />
        </>
      )}

      {amountValid && (
        <FeeSummary
          recipientType={detection.type as any}
          networkFeeLabel="≈ 120 sats"
          serviceFeeLabel="≈ 5 sats"
        />
      )}

      {error && <div className="text-xs text-red-500">{error}</div>}

      {amountValid && (
        <button
          type="button"
          onClick={() => dispatch({ type: "open_review" })}
          className="w-full px-4 py-3 rounded-lg bg-privacy text-background text-sm font-medium flex items-center justify-center gap-2"
        >
          <Send className="w-4 h-4" />
          Send
        </button>
      )}

      <div className="text-center text-xs text-muted-foreground">— or —</div>

      <button
        type="button"
        onClick={() => setLinkOpen(true)}
        className="w-full px-4 py-3 rounded-lg bg-muted/40 border border-gray/15 text-sm font-medium flex items-center justify-center gap-2 hover:border-privacy/30"
      >
        <LinkIcon className="w-4 h-4" />
        Send via claim link
      </button>

      <ReviewModal
        open={state.reviewOpen}
        onOpenChange={(o) => dispatch({ type: o ? "open_review" : "close_review" })}
        recipientLabel={state.recipient.trim()}
        amountLabel={`${state.amount} ${effectiveToken}`}
        feeLabel="≈ 125 sats"
        warning={
          detection.type === "btc"
            ? "This will reveal your Bitcoin withdrawal address on-chain."
            : undefined
        }
        onConfirm={onSend}
      />

      <ClaimLinkModal
        open={linkOpen}
        onOpenChange={setLinkOpen}
        onGenerate={onGenerateClaimLink}
        availableBaseUnits={balance ?? 0n}
        decimals={8}
        unit="BTC"
        usdPerUnit={usdPerUnit}
        defaultToken={effectiveToken}
      />

      {submitting && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="w-3 h-3 animate-spin" />
          Submitting…
        </div>
      )}
    </div>
  );
}
```

> Note: the `TODO(Phase 1.x)` line wires up the actual SDK calls. The
> orchestration shape ships in this task; the wiring is **Task 12** so
> review of the form structure is uncluttered by SDK plumbing.

- [ ] **Step 4: Run to confirm pass**

Run: `cd web && bun test src/components/send/send-form.test.tsx`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/send/send-form.tsx web/src/components/send/send-form.test.tsx
git commit -m "Add SendForm orchestrator with progressive disclosure

useReducer state. Recipient → token → amount → fee → review unfold
as each field becomes valid. Send button + 'Send via claim link'
button at the bottom. SDK plumbing is a TODO threaded in the next
task to keep this commit reviewable."
```

---

### Task 12: Wire SendForm to SDK ix builders

**Files:**
- Modify: `web/src/components/send/send-form.tsx`

> The structure exists from Task 11; this task fills the `onSend` and `onGenerateClaimLink` bodies by adapting the relevant SDK calls used by the deleted PayFlow.

- [ ] **Step 1: Read the existing PayFlow's send paths**

Read these files for the patterns to lift:
- `web/src/components/btc-widget/pay-flow.tsx` — main `handleSend` function
- `web/src/components/payment-wizard/payment-wizard.tsx` — single-output Lite paths
- `web/src/hooks/use-pay-flow-notes.ts` — proof preparation
- `web/src/hooks/use-pay-flow-auth.ts` — signing

Identify the exact SDK call sequence for each of:
- `redeem` (BTC withdraw)
- `transact` (stealth transfer; both SNS and meta — SNS resolves first via `useSnsName`)
- `unshield` (SPL wallet)

Each path fundamentally is: prepare inputs → run `useProver` → assemble Solana ix → sign + submit via `usePayFlowAuth` + `usePrivacyCoin`.

- [ ] **Step 2: Implement `onSend`**

Replace the placeholder body. Pseudocode (real code mirrors what the PayFlow's switch does):

```ts
const onSend = async () => {
  setError(null);
  setSubmitting(true);
  try {
    const intent = buildSendIntent({ /* ... */ });
    switch (intent.kind) {
      case "redeem":
        await runRedeem(intent);
        break;
      case "transact":
        await runTransact(intent);
        break;
      case "unshield":
        await runUnshield(intent);
        break;
      case "claim_link":
        // unreachable from main Send button
        throw new Error("claim_link must go through ClaimLinkModal");
    }
    // Success: reset form, navigate to /vault/activity.
    dispatch({ type: "reset" });
    router.push("/vault/activity");
  } catch (e: any) {
    setError(e?.message ?? "Send failed");
  } finally {
    setSubmitting(false);
  }
};
```

For `runRedeem`, `runTransact`, `runUnshield` — copy the bodies from `pay-flow.tsx`'s switch arms, adapted to read from `intent` instead of from PayFlow's local state. SNS resolution for `stealth_sns` happens at the start of `runTransact` using `useSnsName`'s lookup function (which already exists in the codebase); the resolved stealth meta-address feeds into `prepareTransactInputs`.

- [ ] **Step 3: Implement `onGenerateClaimLink`**

Lift from PayFlow's "Link" mode. The result is `{ url, secret }` — `url` is built via the existing helper in `_lifted/note-links.tsx` if it exposes one, else assemble manually as `${origin}/claim?n=<note_index>&s=<secret_hex>`.

- [ ] **Step 4: Manual smoke check (devnet/localnet)**

Run `cd web && bun run dev`. Open `/send`. Walk through each recipient type to the review modal — actual signing not required, just check that the form reaches the review state without console errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/send/send-form.tsx
git commit -m "Wire SendForm to SDK builders for redeem/transact/unshield/claim_link

Lifts the existing PayFlow switch arms into per-kind run* functions
parameterized by SendIntent. SNS resolution happens at the top of
runTransact via useSnsName. Success: reset + navigate to /vault/activity.
Failure: inline error, form preserved for retry."
```

---

### Task 13: `/send` route page

**Files:**
- Create: `web/src/app/send/page.tsx`

- [ ] **Step 1: Implement**

```tsx
// web/src/app/send/page.tsx
"use client";

import { Send } from "lucide-react";
import { FlowPageLayout } from "@/components/ui/flow-page-layout";
import { SendForm } from "@/components/send/send-form";

export default function SendPage() {
  return (
    <FlowPageLayout
      backHref="/vault"
      backLabel="Back"
      width={460}
      badges={[{ icon: <Send className="w-full h-full" />, label: "Send", color: "privacy" }]}
      titleIcon={<Send className="w-full h-full" />}
      title="Send"
      description="Pay a Bitcoin address, a Solana wallet, a stealth address, or a claim link."
    >
      <SendForm />
    </FlowPageLayout>
  );
}
```

- [ ] **Step 2: Build check + manual visit**

Run `cd web && bun run dev` then visit `http://localhost:3000/send`. Expected: page renders without console errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/app/send/page.tsx
git commit -m "Add /send route — top-level wrapper for SendForm

Lives at /send (not /vault/send) for shorter shareable URLs and
deep-link compat with future ?to=...&amount=... query params."
```

---

### Task 14: `advanced-mode-badge.tsx` (Phase 1: returns null)

**Files:**
- Create: `web/src/components/ui/advanced-mode-badge.tsx`

- [ ] **Step 1: Implement (Phase 1 stub)**

```tsx
// web/src/components/ui/advanced-mode-badge.tsx
"use client";

import { useUiMode } from "@/hooks/use-ui-mode";

export function AdvancedModeBadge() {
  const { isAdvanced } = useUiMode();
  if (!isAdvanced) return null;
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-privacy/10 text-privacy text-[10px] font-medium uppercase tracking-wide">
      Advanced
    </span>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/components/ui/advanced-mode-badge.tsx
git commit -m "Add AdvancedModeBadge — header chip when isAdvanced

Returns null in Phase 1 (Advanced toggle is disabled in /settings)
but lives in the header so Phase 2 only flips the toggle, not a
new mount point."
```

---

### Task 15: `preferences-form.tsx`

**Files:**
- Create: `web/src/components/settings/preferences-form.tsx`

- [ ] **Step 1: Implement**

```tsx
// web/src/components/settings/preferences-form.tsx
"use client";

import { useUiMode } from "@/hooks/use-ui-mode";
import { cn } from "@/lib/utils";

export function PreferencesForm() {
  const { isAdvanced } = useUiMode();

  // Phase 1: toggle is read-only, labeled "Coming soon".
  // Flip to interactive in Phase 2 when multi-output ships.
  const advancedDisabled = true;

  return (
    <div className="space-y-4">
      <div
        className={cn(
          "flex items-start justify-between gap-4 p-4 rounded-xl border",
          "border-gray/15 bg-muted/20",
          advancedDisabled && "opacity-70",
        )}
      >
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium">Advanced send</h3>
            {advancedDisabled && (
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded">
                Coming soon
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Multi-output sends (batch to multiple recipients in one ZK proof),
            custom Bitcoin fee rate, and manual coin selection.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={isAdvanced}
          disabled={advancedDisabled}
          className={cn(
            "shrink-0 w-10 h-6 rounded-full p-0.5 transition-colors",
            isAdvanced ? "bg-privacy" : "bg-muted",
            advancedDisabled && "cursor-not-allowed",
          )}
        >
          <span
            className={cn(
              "block w-5 h-5 rounded-full bg-background transition-transform",
              isAdvanced ? "translate-x-4" : "translate-x-0",
            )}
          />
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/components/settings/preferences-form.tsx
git commit -m "Add PreferencesForm — single Advanced-send toggle (disabled in Phase 1)"
```

---

### Task 16: `/settings` route page

**Files:**
- Create: `web/src/app/settings/page.tsx`

- [ ] **Step 1: Implement**

```tsx
// web/src/app/settings/page.tsx
"use client";

import { Settings as SettingsIcon } from "lucide-react";
import { FlowPageLayout } from "@/components/ui/flow-page-layout";
import { PreferencesForm } from "@/components/settings/preferences-form";

export default function SettingsPage() {
  return (
    <FlowPageLayout
      backHref="/vault"
      backLabel="Back"
      width={460}
      badges={[
        { icon: <SettingsIcon className="w-full h-full" />, label: "Settings", color: "privacy" },
      ]}
      titleIcon={<SettingsIcon className="w-full h-full" />}
      title="Preferences"
      description="Account-level preferences. Stored locally."
    >
      <PreferencesForm />
    </FlowPageLayout>
  );
}
```

- [ ] **Step 2: Manual visit**

Visit `http://localhost:3000/settings`. Expected: page renders, Advanced toggle visible and disabled.

- [ ] **Step 3: Commit**

```bash
git add web/src/app/settings/page.tsx
git commit -m "Add /settings route — wraps PreferencesForm

Single new route. Advanced toggle is disabled in Phase 1; flips
to interactive when Phase 2 (multi-output) ships."
```

---

### Task 17: Mount gear icon + AdvancedModeBadge in site-header

**Files:**
- Modify: `web/src/components/site-header.tsx`

- [ ] **Step 1: Read the file**

Read `web/src/components/site-header.tsx` to find the right slot for the gear icon (likely next to existing wallet/profile UI in the header right area).

- [ ] **Step 2: Add the imports + JSX**

In the imports block:

```tsx
import { Settings as SettingsIcon } from "lucide-react";
import Link from "next/link";
import { AdvancedModeBadge } from "@/components/ui/advanced-mode-badge";
```

In the right-side header element (typically a flex row with the wallet button), add the badge and gear icon (badge first, gear second):

```tsx
<AdvancedModeBadge />
<Link
  href="/settings"
  aria-label="Settings"
  className="p-2 rounded-lg hover:bg-muted/60 text-muted-foreground"
>
  <SettingsIcon className="w-4 h-4" />
</Link>
```

- [ ] **Step 3: Build + manual visit**

`cd web && bun run dev`. Confirm gear icon appears in header on every page; clicking lands on `/settings`.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/site-header.tsx
git commit -m "Mount gear icon + AdvancedModeBadge in site header

Gear links to /settings. Badge slot is empty in Phase 1 (returns null
because isAdvanced is always false until Phase 2 flips the toggle)."
```

---

### Task 18: Update `/vault` dashboard

**Files:**
- Modify: `web/src/app/vault/page.tsx`

> Goal: replace the four pay-related links (transfer / unshield / withdraw / cashout) with a single "Send" link to `/send`. Leave Deposit, Receive, Activity, and explorer/portfolio cards in place — those are out of scope for this PR.

- [ ] **Step 1: Read the file and locate the existing pay-related cards/links**

Read `web/src/app/vault/page.tsx`. Find the section that renders cards/CTAs for transfer/unshield/withdraw/cashout. Likely a `featureCards` array or inline JSX block.

- [ ] **Step 2: Replace with one Send link**

Substitute the four link entries with one entry to `/send`:

```tsx
import { Send } from "lucide-react";
// ...
{
  href: "/send",
  icon: <Send className="w-4 h-4" />,
  title: "Send",
  description: "Pay a Bitcoin address, Solana wallet, stealth address, or claim link.",
}
```

The Receive / Deposit / Activity entries stay unchanged.

- [ ] **Step 3: Build + manual visit**

`cd web && bun run dev`. Visit `/vault` — only one Send entry should appear; clicking it lands on `/send`.

- [ ] **Step 4: Commit**

```bash
git add web/src/app/vault/page.tsx
git commit -m "Vault dashboard: replace 4 pay-related cards with a single Send card

Transfer/Unshield/Withdraw/Cashout entries collapsed into one Send
link to /send. Receive/Deposit/Activity/etc. unchanged. Old pay
routes are deleted in a follow-up commit; this commit alone breaks
nothing because we still have the old routes (just not advertised
on the dashboard)."
```

---

### Task 19: Delete old `/vault/pay/*` routes

**Files:**
- Delete: `web/src/app/vault/pay/transfer/page.tsx`
- Delete: `web/src/app/vault/pay/unshield/page.tsx`
- Delete: `web/src/app/vault/pay/withdraw/page.tsx`
- Delete: `web/src/app/vault/pay/cashout/page.tsx`
- Delete: `web/src/app/vault/pay/` (the empty directory after route deletes)

- [ ] **Step 1: Delete the four route files**

```bash
git rm web/src/app/vault/pay/transfer/page.tsx
git rm web/src/app/vault/pay/unshield/page.tsx
git rm web/src/app/vault/pay/withdraw/page.tsx
git rm web/src/app/vault/pay/cashout/page.tsx
rmdir web/src/app/vault/pay/transfer web/src/app/vault/pay/unshield web/src/app/vault/pay/withdraw web/src/app/vault/pay/cashout web/src/app/vault/pay
```

- [ ] **Step 2: Build to surface any orphaned imports**

Run: `cd web && bun run build`
Expected: clean. If imports break (something other than the 4 deleted routes still imports `payment-wizard/` or `pay-flow.tsx`), fix and rerun.

- [ ] **Step 3: Manual check that old URLs 404**

`cd web && bun run dev`. Visit `/vault/pay/transfer` — expect Next.js 404.

- [ ] **Step 4: Commit**

```bash
git commit -m "Delete /vault/pay/{transfer,unshield,withdraw,cashout} routes

Replaced by the unified /send route. Old URLs return 404 (per the
Aggressive merge spec — no redirects)."
```

---

### Task 20: Delete `payment-wizard/` and `pay-flow/` directories + fix lifted imports

**Files:**
- Delete: `web/src/components/payment-wizard/` (whole directory)
- Delete: `web/src/components/btc-widget/pay-flow.tsx`
- Delete: `web/src/components/btc-widget/pay-flow/` (whole directory)
- Modify: `web/src/components/send/_lifted/note-links.tsx` (fix relative imports)
- Modify: `web/src/components/send/_lifted/proving-steps.tsx` (fix relative imports)
- Modify: `web/src/components/send/_lifted/output-row-card.tsx` (fix relative imports)

- [ ] **Step 1: Re-point lifted imports**

In each lifted file, find `import ... from "../helpers"` (or similar `pay-flow/`-relative paths) and re-point them. Either:
- Lift `helpers.ts` too (preferred — it's small) into `_lifted/helpers.ts` and adjust each lifted file's import to `./helpers`.
- Or inline the small set of constants/types each file actually uses.

```bash
cp web/src/components/btc-widget/pay-flow/helpers.ts web/src/components/send/_lifted/helpers.ts
```

Then in each lifted file:

```diff
- import { ... } from "../helpers";
+ import { ... } from "./helpers";
```

- [ ] **Step 2: Verify nothing else still imports from `pay-flow/` or `payment-wizard/`**

Run: `cd web && grep -rln "btc-widget/pay-flow\|components/payment-wizard" src 2>/dev/null`
Expected: no output (or only test files we haven't deleted yet — if so, they were already deleted in Task 19).

- [ ] **Step 3: Delete the directories**

```bash
git rm -r web/src/components/payment-wizard
git rm web/src/components/btc-widget/pay-flow.tsx
git rm -r web/src/components/btc-widget/pay-flow
```

- [ ] **Step 4: Build to surface anything remaining**

Run: `cd web && bun run build`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add -A web/src/components/send/_lifted
git commit -m "Delete payment-wizard/ and pay-flow/ directories

Re-points the lifted note-links/proving-steps/output-row-card
imports to a co-located _lifted/helpers.ts so they survive the
deletion."
```

---

### Task 21: Final verification

- [ ] **Step 1: Run all web tests**

Run: `cd web && bun test`
Expected: all green. Existing baseline failures (if any) unchanged from `main`.

- [ ] **Step 2: Run web build**

Run: `cd web && bun run build`
Expected: clean.

- [ ] **Step 3: Run web lint**

Run: `cd web && bun run lint`
Expected: clean (or only pre-existing warnings unchanged from `main`).

- [ ] **Step 4: Manual QA checklist (the spec's acceptance gate)**

Spin up devnet/localnet (per CLAUDE.md). Then in `/send`:

1. Paste a Bitcoin Taproot address → recipient indicator turns green → amount field appears → enter 0.0001 → review opens → Hold to confirm → tx submits.
2. Paste a `.btcpro.sol` name → resolves → review → confirm → recipient's `/vault/received` updates.
3. Click "Send via claim link" → enter token + amount → Generate → modal shows link + secret → open `/claim?...` in another tab → secret unlocks the funds.
4. Paste a Solana wallet address → review → confirm → recipient SPL wallet shows balance.
5. Paste a Bitcoin address → withdraw 0.0001 BTC → redemption row appears in `/vault/activity`.
6. `/settings`: Advanced toggle visible, disabled, "Coming soon" label.
7. Header: gear icon present on every page; clicking goes to `/settings`. AdvancedModeBadge slot empty.
8. `/vault/pay/transfer` (and the other three) returns 404.

- [ ] **Step 5: Final commit (if anything was tweaked during QA)**

If the QA pass surfaced fixes, commit them with `chore: post-QA fixes for /send Phase 1`. Otherwise skip.

---

## Out-of-scope (later plans)

- **Phase 2 plan:** Advanced multi-output. Lift `output-row-card.tsx` into `send-form.tsx`'s `isAdvanced` branch, add "Add another recipient" button, cap at 14 outputs (1 BTC max).
- **Phase 3 plan:** Custom BTC fee rate. Requires either an on-chain `RedemptionRequest.fee_rate` field (Pinocchio change) or a backend-only signal — decision deferred.
- **Phase 4 plan:** Coin control. Powered by `useStealthInbox`. Collapsible panel under amount field.
- Auth-modal simplification, dashboard further reduction, OP_RETURN wallet precheck, address book — all separate slices.

## Risks (cross-reference spec §"Risks and known gaps")

1. **Lifted-helpers coupling.** Task 20 lifts `helpers.ts` from `pay-flow/`. If any other code outside `send/` still imports from `btc-widget/pay-flow/helpers`, Task 20's grep step catches it. If grep misses (e.g., dynamic imports), the build step in Task 20.4 fails — fix and retry.
2. **`useTokenBalance` return type.** The mock in `send-form.test.tsx` assumes `{ balance: bigint }`. Verify against the actual hook before the test runs; adapt mock shape to match.
3. **`HoldButton` API shape.** Task 8 calls `<HoldButton onComplete={...} label="Hold to send" />`. Read the actual component first; adapt the prop names if they differ. Don't change the component itself — adapt the call site.
4. **Existing PayFlow tests.** If any test files reference deleted files, they're deleted alongside in Task 20. Re-run `bun test` in Task 21 to surface any surviving references.
