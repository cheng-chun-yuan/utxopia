# Mobile Compatibility: SDK + React Native Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `@aegis/sdk` work in React Native by eliminating Node.js built-in dependencies and configuring Metro polyfills.

**Architecture:** The SDK main entry (`index.ts`) re-exports from `prover/web` which pulls `snarkjs` (Node.js-heavy). Mobile app already imports `@aegis/sdk/prover/mobile` for proofs, but the main `@aegis/sdk` import still drags in snarkjs transitively. Fix: (1) replace `Buffer` usage with `Uint8Array` helpers throughout SDK, (2) split prover exports so main entry is prover-agnostic, (3) add minimal polyfills in mobile app's Metro config.

**Tech Stack:** TypeScript, Metro bundler, Expo SDK 55, NativeWind v4

---

### Task 1: Add cross-platform `Buffer` replacement helpers to SDK

**Files:**
- Create: `sdk/src/utils/encoding.ts`

**Step 1: Create encoding utilities**

```typescript
// sdk/src/utils/encoding.ts
/**
 * Cross-platform encoding utilities.
 * Replaces Node.js Buffer usage with Uint8Array-based helpers
 * that work in Browser, Node.js, and React Native.
 */

/** Convert Uint8Array to hex string */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Convert hex string to Uint8Array */
export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.substring(i, i + 2), 16);
  }
  return bytes;
}

/** Decode base64 string to Uint8Array (works in all environments) */
export function fromBase64(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  // Node.js fallback
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/** Decode base64 to binary string (for RPC compatibility) */
export function base64ToBinaryString(b64: string): string {
  if (typeof atob === "function") {
    return atob(b64);
  }
  return Buffer.from(b64, "base64").toString("binary");
}

/** Allocate a zero-filled Uint8Array (replaces Buffer.alloc) */
export function allocBytes(size: number): Uint8Array {
  return new Uint8Array(size);
}
```

**Step 2: Verify SDK builds**

Run: `cd sdk && bun run build`
Expected: PASS (new file, no breaking changes yet)

**Step 3: Commit**

```bash
git add sdk/src/utils/encoding.ts
git commit -m "feat(sdk): add cross-platform encoding utilities replacing Buffer"
```

---

### Task 2: Replace Buffer usage in SDK source files

**Files:**
- Modify: `sdk/src/merkle.ts` (lines 95, 98 — Buffer.from for hex)
- Modify: `sdk/src/events.ts` (line 219 — Buffer.from for base64)
- Modify: `sdk/src/explorer.ts` (line 126 — Buffer.from for base64)
- Modify: `sdk/src/chadbuffer.ts` (lines 91, 102, 117, 283 — Buffer.alloc/from)
- Modify: `sdk/src/solana/connection.ts` (lines 85, 149 — Buffer.from for base64)

**Step 1: Replace Buffer in merkle.ts**

Replace `Buffer.from(el).toString("hex")` with `toHex(el)` and `Buffer.from(proof.root).toString("hex")` with `toHex(proof.root)`.

Import: `import { toHex } from "./utils/encoding";`

**Step 2: Replace Buffer in events.ts**

Replace `new Uint8Array(Buffer.from(b64, "base64"))` with `fromBase64(b64)`.

Import: `import { fromBase64 } from "./utils/encoding";`

**Step 3: Replace Buffer in explorer.ts**

Same pattern as events.ts — replace Buffer.from base64 with `fromBase64()`.

**Step 4: Replace Buffer in chadbuffer.ts**

- `Buffer.alloc(N)` → `new Uint8Array(N)` (already zero-filled)
- `Buffer.from([...])` → `new Uint8Array([...])`
- `Buffer.from(data, "base64")` → `fromBase64(data)`

Import: `import { fromBase64, allocBytes } from "./utils/encoding";`

**Step 5: Replace Buffer in solana/connection.ts**

Replace `Buffer.from(base64Data, "base64").toString("binary")` with `base64ToBinaryString(base64Data)`.

Import: `import { base64ToBinaryString } from "../utils/encoding";`

**Step 6: Verify SDK builds and tests pass**

Run: `cd sdk && bun run build && bun test`
Expected: PASS

**Step 7: Commit**

```bash
git add sdk/src/merkle.ts sdk/src/events.ts sdk/src/explorer.ts sdk/src/chadbuffer.ts sdk/src/solana/connection.ts
git commit -m "refactor(sdk): replace Buffer with cross-platform Uint8Array helpers"
```

---

### Task 3: Make SDK main entry prover-agnostic

The main `sdk/src/index.ts` currently re-exports from `./prover/web` which pulls in snarkjs. The mobile app imports `@aegis/sdk` for non-prover functions (keys, poseidon, etc.) but gets snarkjs dragged in.

**Files:**
- Modify: `sdk/src/index.ts` (lines 243-259 — prover exports)

**Step 1: Export only types and prover-agnostic utilities from main entry**

Replace the prover export block in `sdk/src/index.ts`:

```typescript
// Before:
export {
  initProver, isProverAvailable, setCircuitPath, getCircuitPath,
  proofToBytes, cleanup as cleanupProver, ...
  generateJoinSplitProof, circuitExists,
} from "./prover/web";

// After:
// Re-export only types and utilities that don't pull in snarkjs
export type {
  ProofData, MerkleProofInput, CircuitType, JoinSplitProofInputs,
} from "./prover/web";

export {
  buildVerifyInstructionData,
} from "./prover/web";

// For prover functions, import from:
// - @aegis/sdk/prover/web    (browser/Node.js — snarkjs)
// - @aegis/sdk/prover/mobile (React Native — mopro-ffi)
```

This ensures `import { deriveKeysFromSeed } from "@aegis/sdk"` does NOT pull in snarkjs.

**Step 2: Verify SDK builds**

Run: `cd sdk && bun run build`
Expected: PASS

**Step 3: Verify aegis-app (web) still works**

Check if aegis-app imports `generateJoinSplitProof` from `@aegis/sdk` or from `@aegis/sdk/prover/web`. If from main entry, update to explicit `@aegis/sdk/prover/web` import.

Run: `grep -r "generateJoinSplitProof" aegis-app/`

**Step 4: Commit**

```bash
git add sdk/src/index.ts
git commit -m "refactor(sdk): make main entry prover-agnostic for React Native compat"
```

---

### Task 4: Handle circomlibjs/keys.ts Buffer dependency

**Files:**
- Modify: `sdk/src/keys.ts` (lines 190, 215, 218, 224, 256 — Buffer.from for circomlibjs)

**Step 1: Replace Buffer.from with Uint8Array in circomlibjs calls**

circomlibjs's `eddsa.prv2pub()` and `eddsa.signPoseidon()` accept both `Buffer` and `Uint8Array`. Replace `Buffer.from(seed)` with just `seed` (already Uint8Array) or `new Uint8Array(seed)`.

For the `pruneBuffer` capture on line 218: `capturedBuff = Buffer.from(result)` → `capturedBuff = new Uint8Array(result)`.

**Step 2: Verify key derivation tests pass**

Run: `cd sdk && bun test src/keys`
Expected: PASS

**Step 3: Commit**

```bash
git add sdk/src/keys.ts
git commit -m "refactor(sdk): remove Buffer usage from keys.ts for RN compat"
```

---

### Task 5: Configure Metro polyfills for mobile app

**Files:**
- Modify: `aegis-mobile/metro.config.js`
- Modify: `aegis-mobile/package.json` (add polyfill deps)

**Step 1: Install minimal polyfills**

```bash
cd aegis-mobile && bun add buffer process
```

`buffer` is needed for any remaining transitive dependencies (circomlibjs internals).
`process` for `process.env` checks in SDK config.

**Step 2: Create globals polyfill file**

Create `aegis-mobile/polyfills.js`:

```javascript
import { Buffer } from "buffer";
global.Buffer = Buffer;
if (typeof process === "undefined") {
  global.process = { env: {} };
}
```

**Step 3: Update Metro config to load polyfills**

Add to `aegis-mobile/metro.config.js`:

```javascript
// Add resolver for Node.js built-ins that might be referenced
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  assert: require.resolve("assert"),
  buffer: require.resolve("buffer"),
};
```

**Step 4: Add polyfill import to app entry**

In `aegis-mobile/app/_layout.tsx` (or the root layout), add at the very top:

```typescript
import "../polyfills";
```

**Step 5: Test mobile app starts without module resolution errors**

Run: `cd aegis-mobile && bun run start --clear`
Expected: Metro bundles without "Unable to resolve module" errors.

**Step 6: Commit**

```bash
git add aegis-mobile/metro.config.js aegis-mobile/polyfills.js aegis-mobile/package.json aegis-mobile/app/_layout.tsx
git commit -m "fix(mobile): add Buffer/process polyfills for SDK compatibility"
```

---

### Task 6: Rebuild SDK and verify mobile app loads

**Step 1: Rebuild SDK**

```bash
cd sdk && bun run build
```

**Step 2: Clear Metro cache and start**

```bash
cd aegis-mobile && bun run start --clear
```

**Step 3: Verify these SDK imports work without errors**

- `initPoseidon` — WASM init (circomlibjs)
- `deriveKeysFromSeedCircuit` — key derivation
- `createStealthMetaAddress` — stealth address encoding
- `@aegis/sdk/prover/mobile` — mobile prover (will warn about mopro-ffi not installed, which is expected until native build is set up)

**Step 4: Commit if any fixes were needed**

---

## Execution Order

1. Task 1 — encoding utilities (new file, no risk)
2. Task 2 — replace Buffer in SDK (mechanical replacements)
3. Task 4 — keys.ts Buffer (needs careful testing with circomlibjs)
4. Task 3 — make main entry prover-agnostic (may need web app updates)
5. Task 5 — Metro polyfills (mobile app changes)
6. Task 6 — integration verification

## Out of Scope (Future)

- mopro-ffi native build setup (requires Expo Dev Client, Rust cross-compilation)
- Circuit .zkey asset bundling for mobile
- `circomlibjs` WASM initialization testing on actual iOS/Android device
