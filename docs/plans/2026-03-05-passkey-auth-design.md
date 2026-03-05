# Passkey Auth for Aegis

**Date**: 2026-03-05
**Status**: Approved

## Problem

Aegis requires a Solana wallet extension (Phantom, Solflare) to derive privacy keys. This blocks non-crypto users. Since all transactions go through a relayer (ZK-based), users don't actually need a Solana wallet — they only need their Aegis keys to generate proofs client-side.

## Solution

Add WebAuthn passkey as an equal alternative to wallet connection for key derivation. Both paths produce a 32-byte seed that feeds into the same key derivation pipeline.

## Architecture

```
Login Page (two equal options)
├── Passkey (Face ID / fingerprint / PIN)
│   └── WebAuthn PRF extension → 32-byte deterministic secret
└── Connect Wallet (Phantom, Solflare, etc.)
    └── Sign "Aegis key derivation v1" → SHA256(sig) → 32-byte seed

Both paths → deriveKeysFromSeed(seed: Uint8Array)
           → SHA256(seed + "spend")   → Baby Jubjub spending key
           → SHA256(seed + "nullify") → Nullifying key (BN254)
           → SHA256(seed + "view")    → Ed25519 viewing key
```

## Passkey Flow

### Registration (first time)
1. User clicks "Sign up with Passkey"
2. `navigator.credentials.create()` with PRF extension enabled
3. Browser prompts biometric/PIN → creates passkey
4. PRF returns 32-byte deterministic secret
5. Derive Aegis keys from seed
6. Store credential ID in localStorage (`aegis:passkey_credential`)
7. Encrypt keys in localStorage using PRF-derived encryption key

### Login (returning user)
1. User clicks "Sign in with Passkey"
2. `navigator.credentials.get()` with PRF extension + stored credential ID
3. Browser prompts biometric/PIN
4. PRF returns same 32-byte secret (deterministic)
5. Derive Aegis keys from seed
6. User enters vault

### Key Properties
- **Deterministic**: Same passkey always produces same Aegis keys (via PRF)
- **Cross-device**: Synced via iCloud Keychain / Google Password Manager
- **No backend**: No user database, no sessions, purely client-side
- **Recoverable**: Passkey sync handles device recovery

## Browser Support (PRF Extension)

| Platform | PRF Support |
|----------|------------|
| Chrome desktop | v116+ (Aug 2023) |
| Safari macOS | Safari 18+ (macOS Sequoia) |
| Safari iOS | iOS 18+ |
| Android Chrome | v132+ (Jan 2025) |
| Firefox | Not yet |

Fallback for unsupported browsers: show only the wallet option.

## SDK Changes

Refactor `deriveKeysFromSignature()` in `sdk/src/keys.ts`:

```
Current:  deriveKeysFromSignature(signature, walletPubKey)
                                    │
                         SHA256(sig) → 32-byte seed → key derivation

Refactored:
  deriveKeysFromSeed(seed: Uint8Array)     ← new shared function
  deriveKeysFromSignature(sig, pubKey)     ← calls deriveKeysFromSeed
  deriveKeysFromPasskey(prfOutput)         ← calls deriveKeysFromSeed
```

The core key derivation (SHA256 domain separators + circomlibjs EdDSA) stays identical.

## Components

| Component | Location | Description |
|-----------|----------|-------------|
| `deriveKeysFromSeed()` | `sdk/src/keys.ts` | Shared 32-byte seed → Aegis keys |
| `usePasskey` hook | `aegis-app/src/hooks/use-passkey.ts` | WebAuthn create/get with PRF |
| `PasskeyButton` | `aegis-app/src/components/ui/passkey-button.tsx` | Register/login UI |
| Updated vault page | `aegis-app/src/app/vault/page.tsx` | Two equal auth options |
| `aegis-store` updates | `aegis-app/src/stores/aegis-store.ts` | Add passkey derive path |
| `StoreHydration` updates | `aegis-app/src/stores/StoreHydration.tsx` | Auto-hydrate passkey users |

## Login Page UX

Two equal buttons side by side:

```
┌─────────────────────────────────────────┐
│         Welcome to Aegis                │
│                                          │
│   ┌─────────────┐  ┌─────────────────┐  │
│   │ 🔑 Passkey  │  │ 🔗 Wallet       │  │
│   └─────────────┘  └─────────────────┘  │
│                                          │
│   Use Face ID or     Connect Phantom,   │
│   fingerprint        Solflare, etc.     │
└─────────────────────────────────────────┘
```

## Key Storage

| Auth Method | Key Storage | Encryption |
|-------------|------------|------------|
| Passkey | `aegis:keys_v2:passkey:{credentialId}` | AES-GCM with PRF-derived key |
| Wallet | `aegis:keys_v2:{walletPubKey}` | Plaintext (as today) |

## No Backend Changes

- No user database needed
- No session management
- All ZK proofs generated client-side
- Relayer submits transactions (unchanged)
- SNS registration is the only user-initiated Solana tx (can be deferred or relayer-submitted)

## Out of Scope

- Native mobile app passkey support (web-only for now)
- Server-stored encrypted key blob fallback
- Linking passkey + wallet accounts together
- Firefox fallback (show wallet-only)
