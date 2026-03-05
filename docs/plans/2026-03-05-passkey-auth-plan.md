# Passkey Auth Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add WebAuthn passkey login as an equal alternative to Solana wallet connection for deriving Aegis privacy keys.

**Architecture:** WebAuthn PRF extension provides a deterministic 32-byte secret from biometric auth. This seed feeds into the existing `deriveKeysFromSeedCircuit()` to produce identical Aegis keys (spending, nullifying, viewing). No backend changes — everything client-side.

**Tech Stack:** WebAuthn API (navigator.credentials), PRF extension, `@simplewebauthn/browser` (thin wrapper), existing `@aegis/sdk` key derivation.

---

### Task 1: Install WebAuthn dependency

**Files:**
- Modify: `aegis-app/package.json`

**Step 1: Install @simplewebauthn/browser**

```bash
cd aegis-app && bun add @simplewebauthn/browser
```

This provides typed helpers for `navigator.credentials.create()` and `.get()` with PRF extension support. It's a thin client-only wrapper (~8KB) with no server component needed.

**Step 2: Commit**

```bash
git add aegis-app/package.json aegis-app/bun.lockb
git commit -m "feat(passkey): add @simplewebauthn/browser dependency"
```

---

### Task 2: Create usePasskey hook

**Files:**
- Create: `aegis-app/src/hooks/use-passkey.ts`

**Step 1: Write the hook**

This hook wraps WebAuthn PRF registration and authentication. Key behaviors:
- `register()`: Creates a new passkey with PRF extension, returns 32-byte seed
- `authenticate()`: Authenticates with existing passkey, returns same 32-byte seed
- `isSupported`: Checks browser support for WebAuthn + PRF
- Stores credential ID in localStorage for returning users
- Uses `salt` = SHA-256("aegis-passkey-prf-v1") for PRF evaluation

```typescript
"use client";

import { useState, useCallback, useEffect } from "react";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
} from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

const CREDENTIAL_STORAGE_KEY = "aegis:passkey_credential_id";
const PRF_SALT = sha256(new TextEncoder().encode("aegis-passkey-prf-v1"));

// RP (relying party) config — no server needed, uses client-only WebAuthn
const RP_NAME = "Aegis";
const RP_ID_CANDIDATES = [
  "aegis.amidoggy.xyz", // production
  "localhost",           // dev
];

function getRpId(): string {
  if (typeof window === "undefined") return "localhost";
  const hostname = window.location.hostname;
  return RP_ID_CANDIDATES.find(id => hostname.endsWith(id)) || hostname;
}

function getStoredCredentialId(): string | null {
  try {
    return localStorage.getItem(CREDENTIAL_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeCredentialId(id: string): void {
  try {
    localStorage.setItem(CREDENTIAL_STORAGE_KEY, id);
  } catch {
    // localStorage unavailable
  }
}

export function clearStoredCredential(): void {
  try {
    localStorage.removeItem(CREDENTIAL_STORAGE_KEY);
  } catch {
    // ignore
  }
}

/**
 * Extract PRF output from WebAuthn credential response.
 * Returns 32-byte Uint8Array seed.
 */
function extractPrfOutput(extensions: AuthenticationExtensionsClientOutputs | undefined): Uint8Array {
  if (!extensions) throw new Error("No extensions in credential response");

  const prf = (extensions as any).prf;
  if (!prf?.results?.first) {
    throw new Error(
      "PRF extension not supported by this browser/authenticator. " +
      "Please use Chrome 116+, Safari 18+, or Android Chrome 132+."
    );
  }

  // PRF output is an ArrayBuffer, hash it to get exactly 32 bytes
  return sha256(new Uint8Array(prf.results.first));
}

export interface UsePasskeyReturn {
  /** Whether WebAuthn is supported in this browser */
  isSupported: boolean;
  /** Whether user has a stored credential (returning user) */
  hasCredential: boolean;
  /** Loading state */
  isLoading: boolean;
  /** Error message */
  error: string | null;
  /** Register a new passkey, returns 32-byte seed */
  register: () => Promise<Uint8Array | null>;
  /** Authenticate with existing passkey, returns 32-byte seed */
  authenticate: () => Promise<Uint8Array | null>;
  /** Clear stored credential */
  clearCredential: () => void;
}

export function usePasskey(): UsePasskeyReturn {
  const [isSupported, setIsSupported] = useState(false);
  const [hasCredential, setHasCredential] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setIsSupported(browserSupportsWebAuthn());
    setHasCredential(!!getStoredCredentialId());
  }, []);

  const register = useCallback(async (): Promise<Uint8Array | null> => {
    setIsLoading(true);
    setError(null);
    try {
      const rpId = getRpId();

      // Generate a random user ID (not linked to any server account)
      const userId = new Uint8Array(32);
      crypto.getRandomValues(userId);

      const creationOptions: PublicKeyCredentialCreationOptionsJSON = {
        rp: { name: RP_NAME, id: rpId },
        user: {
          id: btoa(String.fromCharCode(...userId)).replace(/=/g, ""),
          name: "aegis-user",
          displayName: "Aegis User",
        },
        challenge: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/=/g, ""),
        pubKeyCredParams: [
          { alg: -7, type: "public-key" },   // ES256
          { alg: -257, type: "public-key" },  // RS256
        ],
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
        },
        extensions: {
          prf: {
            eval: { first: Array.from(PRF_SALT) },
          },
        } as any,
      };

      const credential = await startRegistration({ optionsJSON: creationOptions });

      // Extract PRF output
      const seed = extractPrfOutput(credential.clientExtensionResults);

      // Store credential ID for future authentication
      storeCredentialId(credential.id);
      setHasCredential(true);

      return seed;
    } catch (err) {
      if (err instanceof Error) {
        if (err.name === "NotAllowedError" || err.message.includes("cancelled")) {
          setError(null); // User cancelled, not an error
          return null;
        }
        setError(err.message);
      } else {
        setError("Failed to create passkey");
      }
      return null;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const authenticate = useCallback(async (): Promise<Uint8Array | null> => {
    setIsLoading(true);
    setError(null);
    try {
      const rpId = getRpId();
      const storedId = getStoredCredentialId();

      const requestOptions: PublicKeyCredentialRequestOptionsJSON = {
        rpId,
        challenge: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/=/g, ""),
        allowCredentials: storedId
          ? [{ id: storedId, type: "public-key" }]
          : [], // empty = discoverable credential (passkey picker)
        userVerification: "required",
        extensions: {
          prf: {
            eval: { first: Array.from(PRF_SALT) },
          },
        } as any,
      };

      const credential = await startAuthentication({ optionsJSON: requestOptions });

      // Extract PRF output
      const seed = extractPrfOutput(credential.clientExtensionResults);

      // Store credential ID if we didn't have one (discovered via picker)
      if (!storedId) {
        storeCredentialId(credential.id);
        setHasCredential(true);
      }

      return seed;
    } catch (err) {
      if (err instanceof Error) {
        if (err.name === "NotAllowedError" || err.message.includes("cancelled")) {
          setError(null);
          return null;
        }
        setError(err.message);
      } else {
        setError("Failed to authenticate with passkey");
      }
      return null;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const clearCredential = useCallback(() => {
    clearStoredCredential();
    setHasCredential(false);
  }, []);

  return {
    isSupported,
    hasCredential,
    isLoading,
    error,
    register,
    authenticate,
    clearCredential,
  };
}
```

**Step 2: Commit**

```bash
git add aegis-app/src/hooks/use-passkey.ts
git commit -m "feat(passkey): add usePasskey hook with WebAuthn PRF"
```

---

### Task 3: Add passkey key derivation to aegis-store

**Files:**
- Modify: `aegis-app/src/stores/aegis-store.ts`

**Step 1: Add passkey derive action to store**

Add a `deriveKeysFromPasskey` action alongside the existing `deriveKeys`. It takes a 32-byte PRF seed and calls the SDK's `deriveKeysFromSeedCircuit()`.

In the `AegisState` interface (around line 148), add:

```typescript
  deriveKeysFromPasskeySeed: (seed: Uint8Array) => Promise<void>;
```

In the store implementation (after the `deriveKeys` action, around line 234), add:

```typescript
  deriveKeysFromPasskeySeed: async (seed: Uint8Array) => {
    set({ isLoading: true, error: null });

    try {
      // Import dynamically to avoid loading circomlibjs WASM at module level
      const { deriveKeysFromSeedCircuit, createStealthMetaAddress, encodeStealthMetaAddress } = await import("@aegis/sdk");

      const derivedKeys = await deriveKeysFromSeedCircuit(seed);
      const meta = createStealthMetaAddress(derivedKeys);
      const encoded = encodeStealthMetaAddress(meta);

      // Persist with "passkey:" prefix instead of wallet pubkey
      const credentialId = localStorage.getItem("aegis:passkey_credential_id") || "default";
      persistKeys("passkey:" + credentialId, derivedKeys);

      set({
        keys: derivedKeys,
        stealthAddress: meta,
        stealthAddressEncoded: encoded,
        hasKeys: true,
        isLoading: false,
      });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Failed to derive keys from passkey",
        isLoading: false,
      });
    }
  },
```

**Step 2: Add passkey hydration to store**

Add a `hydratePasskeyKeys` action that loads keys from localStorage using the passkey credential ID.

In the `AegisState` interface, add:

```typescript
  hydratePasskeyKeys: () => boolean;
```

In the store implementation (after `hydrateKeys`), add:

```typescript
  hydratePasskeyKeys: () => {
    try {
      const credentialId = localStorage.getItem("aegis:passkey_credential_id");
      if (!credentialId) return false;

      const restored = loadKeys("passkey:" + credentialId, new Uint8Array(32));
      if (!restored) return false;

      const meta = createStealthMetaAddress(restored);
      const encoded = encodeStealthMetaAddress(meta);

      set({
        keys: restored,
        stealthAddress: meta,
        stealthAddressEncoded: encoded,
        hasKeys: true,
      });
      return true;
    } catch {
      return false;
    }
  },
```

**Step 3: Update clearKeys to handle passkey users**

Modify the existing `clearKeys` function to also clear passkey storage when called without a wallet pubkey:

```typescript
  clearKeys: (walletPubkey?: string) => {
    if (walletPubkey) {
      removeKeys(walletPubkey);
    }
    // Also clear passkey keys if present
    const credentialId = typeof window !== "undefined"
      ? localStorage.getItem("aegis:passkey_credential_id")
      : null;
    if (credentialId) {
      removeKeys("passkey:" + credentialId);
    }
    // ... rest of existing clearKeys logic
  },
```

**Step 4: Commit**

```bash
git add aegis-app/src/stores/aegis-store.ts
git commit -m "feat(passkey): add passkey key derivation and hydration to store"
```

---

### Task 4: Update StoreHydration for passkey users

**Files:**
- Modify: `aegis-app/src/stores/StoreHydration.tsx`

**Step 1: Add passkey auto-hydration**

Passkey users don't have a wallet, so hydration triggers when Poseidon is ready + a credential ID exists in localStorage + no keys loaded yet.

Add to the imports:

```typescript
import { useAegisStore } from "./aegis-store";
```

Add a new selector:

```typescript
const hydratePasskeyKeys = useAegisStore((s) => s.hydratePasskeyKeys);
```

Add a new useEffect after the existing wallet hydration effect:

```typescript
  // Auto-hydrate passkey keys (no wallet needed)
  useEffect(() => {
    if (isPoseidonReady && !keys && !walletPubkey && !hasHydratedRef.current) {
      hasHydratedRef.current = true;
      hydratePasskeyKeys();
    }
  }, [isPoseidonReady, keys, walletPubkey, hydratePasskeyKeys]);
```

**Step 2: Commit**

```bash
git add aegis-app/src/stores/StoreHydration.tsx
git commit -m "feat(passkey): auto-hydrate passkey keys on app load"
```

---

### Task 5: Update vault page with passkey login option

**Files:**
- Modify: `aegis-app/src/app/vault/page.tsx`

**Step 1: Add passkey UI to the vault page**

Replace the existing "Connect your wallet" prompt (the `!wallet.connected && !keys` state) with two equal options.

Add imports at top of file:

```typescript
import { usePasskey } from "@/hooks/use-passkey";
import { Fingerprint } from "lucide-react";
```

Inside `VaultPage()`, add the passkey hook:

```typescript
const {
  isSupported: passkeySupported,
  hasCredential: hasPasskeyCredential,
  isLoading: passkeyLoading,
  error: passkeyError,
  register: registerPasskey,
  authenticate: authenticatePasskey,
  clearCredential: clearPasskeyCredential,
} = usePasskey();

const deriveKeysFromPasskeySeed = useAegisStore((s) => s.deriveKeysFromPasskeySeed);
```

Add passkey handler functions:

```typescript
const handlePasskeyRegister = async () => {
  const seed = await registerPasskey();
  if (seed) {
    await deriveKeysFromPasskeySeed(seed);
  }
};

const handlePasskeyAuthenticate = async () => {
  const seed = await authenticatePasskey();
  if (seed) {
    await deriveKeysFromPasskeySeed(seed);
  }
};
```

Replace the `!wallet.connected` block (lines ~209-226) with a new block that shows both options when there are no keys:

```tsx
{!keys ? (
  <div className="text-center py-5">
    <p className="text-body2 text-gray mb-4">
      Choose how to access your private vault
    </p>
    {(error || passkeyError) && (
      <p className="text-caption text-red-400 mb-3">{error || passkeyError}</p>
    )}
    <div className="grid grid-cols-2 gap-3">
      {/* Passkey option */}
      {passkeySupported && (
        <button
          onClick={hasPasskeyCredential ? handlePasskeyAuthenticate : handlePasskeyRegister}
          disabled={passkeyLoading || isLoading}
          className={cn(
            "flex flex-col items-center gap-2 p-4 rounded-[12px]",
            "bg-privacy/10 hover:bg-privacy/20 border border-privacy/20",
            "hover:border-privacy/40 disabled:bg-gray/10 disabled:border-gray/20",
            "transition-all duration-200 cursor-pointer group"
          )}
        >
          <div className="p-2.5 rounded-[10px] bg-privacy/15 group-hover:bg-privacy/25 transition-colors">
            <Fingerprint className="w-5 h-5 text-privacy" />
          </div>
          <span className="text-body2-semibold text-privacy">
            {passkeyLoading ? "Verifying..." : hasPasskeyCredential ? "Sign in with Passkey" : "Create Passkey"}
          </span>
          <span className="text-caption text-gray">
            Face ID / Fingerprint
          </span>
        </button>
      )}

      {/* Wallet option */}
      <button
        onClick={wallet.connected ? deriveKeys : () => setVisible(true)}
        disabled={isLoading || passkeyLoading}
        className={cn(
          "flex flex-col items-center gap-2 p-4 rounded-[12px]",
          "bg-purple/10 hover:bg-purple/20 border border-purple/20",
          "hover:border-purple/40 disabled:bg-gray/10 disabled:border-gray/20",
          "transition-all duration-200 cursor-pointer group"
        )}
      >
        <div className="p-2.5 rounded-[10px] bg-purple/15 group-hover:bg-purple/25 transition-colors">
          <Wallet className="w-5 h-5 text-purple" />
        </div>
        <span className="text-body2-semibold text-purple">
          {isLoading ? "Signing..." : wallet.connected ? "Sign to Derive Keys" : "Connect Wallet"}
        </span>
        <span className="text-caption text-gray">
          Phantom, Solflare, etc.
        </span>
      </button>
    </div>

    {/* Sign out button for connected wallet users who haven't derived keys */}
    {wallet.connected && (
      <button
        onClick={() => wallet.disconnect().catch(() => {})}
        className={cn(
          "mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[8px]",
          "text-caption text-gray hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
        )}
      >
        <LogOut className="w-3 h-3" />
        Disconnect wallet
      </button>
    )}
  </div>
) : (
  // ... existing keys-present UI (stealth address, SNS, etc.)
)}
```

**Step 2: Update the Log out button to also clear passkey**

In the existing log out button (when `keys` is present), update the onClick:

```typescript
onClick={() => {
  clearKeys(wallet.publicKey?.toBase58());
  clearPasskeyCredential();
}}
```

**Step 3: Commit**

```bash
git add aegis-app/src/app/vault/page.tsx
git commit -m "feat(passkey): add passkey login option to vault page"
```

---

### Task 6: Update useAegis hook for passkey compatibility

**Files:**
- Modify: `aegis-app/src/hooks/use-aegis.tsx`

**Step 1: Update clear keys to handle passkey**

The `useAegis` hook currently clears keys on wallet disconnect. For passkey users (no wallet), we need to skip this behavior.

Update the wallet disconnect effect (lines 47-51) to check if keys were derived from a passkey:

```typescript
  // Clear keys when wallet disconnects — but only if using wallet auth (not passkey)
  useEffect(() => {
    if (!wallet.connected && store.keys?.solanaPublicKey.some(b => b !== 0)) {
      // solanaPublicKey is all zeros for passkey users, non-zero for wallet users
      store.clearKeys(wallet.publicKey?.toBase58());
    }
  }, [wallet.connected, wallet.publicKey, store.clearKeys, store.keys]);
```

The `solanaPublicKey` field is `new Uint8Array(32)` (all zeros) for passkey-derived keys (set in `deriveKeysFromSeedCircuit`), so this distinguishes wallet vs passkey users.

**Step 2: Commit**

```bash
git add aegis-app/src/hooks/use-aegis.tsx
git commit -m "feat(passkey): prevent wallet disconnect from clearing passkey keys"
```

---

### Task 7: Test end-to-end

**Files:** None (manual testing)

**Step 1: Start dev server**

```bash
cd aegis-app && bun run dev
```

**Step 2: Test passkey registration flow**

1. Open http://localhost:3000/vault
2. Verify two equal buttons appear: "Create Passkey" and "Connect Wallet"
3. Click "Create Passkey"
4. Complete biometric prompt (Touch ID / fingerprint)
5. Verify stealth address appears
6. Verify keys persist in localStorage under `aegis:keys_v2:passkey:...`

**Step 3: Test passkey re-authentication**

1. Refresh the page
2. Verify keys auto-hydrate from localStorage (no prompt needed)
3. Click "Log out"
4. Verify the button now says "Sign in with Passkey" (credential stored)
5. Click "Sign in with Passkey"
6. Complete biometric prompt
7. Verify SAME stealth address appears (deterministic PRF)

**Step 4: Test wallet flow still works**

1. Log out fully (clear passkey credential)
2. Click "Connect Wallet" → connect Phantom
3. Click "Sign to Derive Keys"
4. Verify keys derive as before

**Step 5: Test unsupported browser fallback**

1. Open in Firefox (no PRF support)
2. Verify only "Connect Wallet" button appears (passkey button hidden)

**Step 6: Commit all working changes**

```bash
git add -A
git commit -m "feat(passkey): complete passkey auth implementation"
```

---

### Task 8: Hide SNS registration for passkey users

**Files:**
- Modify: `aegis-app/src/app/vault/page.tsx`

**Step 1: Guard SNS UI behind wallet check**

SNS names are NFTs owned by a Solana wallet. Passkey users have no wallet, so SNS registration doesn't apply. Passkey-derived keys have `solanaPublicKey` set to all zeros.

Add a helper near the top of `VaultPage()`:

```typescript
const isPasskeyUser = keys && keys.solanaPublicKey.every(b => b === 0);
```

Wrap all SNS-related UI (the registered name badge, the register input, and the "Register a .btcpro.sol name" button) with `!isPasskeyUser &&`:

- The `{registeredSnsName && (...)}` block → `{!isPasskeyUser && registeredSnsName && (...)}`
- The `{!registeredSnsName && !showSnsInput && ...}` button → `{!isPasskeyUser && !registeredSnsName && ...}`
- The `{isLoadingSnsName && (...)}` block → `{!isPasskeyUser && isLoadingSnsName && (...)}`
- The `{showSnsInput && (...)}` block → `{!isPasskeyUser && showSnsInput && (...)}`

**Step 2: Commit**

```bash
git add aegis-app/src/app/vault/page.tsx
git commit -m "feat(passkey): hide SNS registration for passkey users"
```

---

## Summary

| Task | Description | Est. Complexity |
|------|-------------|----------------|
| 1 | Install dependency | Trivial |
| 2 | Create usePasskey hook | Core WebAuthn logic |
| 3 | Add passkey actions to store | Store integration |
| 4 | Update StoreHydration | Auto-hydration for passkey users |
| 5 | Update vault page UI | Two-button login UI |
| 6 | Update useAegis hook | Wallet disconnect guard |
| 7 | End-to-end testing | Manual verification |

**Key insight:** The SDK already has `deriveKeysFromSeedCircuit(seed)` which takes a 32-byte seed and produces circuit-compatible Aegis keys. The passkey PRF output is exactly a 32-byte seed. No SDK changes needed.
