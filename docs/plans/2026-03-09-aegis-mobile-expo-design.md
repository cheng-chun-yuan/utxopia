# Aegis Mobile App — Expo + mopro Design

## Overview

Native mobile app for Aegis privacy bridge built with Expo. Same cyberpunk design, same `@aegis/sdk`, but **QR-code-only deposits** (no PSBT wallet integration) and **native passkey auth** (no Solana wallet adapter). ZK proof generation via `mopro-ffi` native Groth16 (Arkworks) — up to 20x faster than snarkjs WASM.

## Architecture

| Layer | Technology |
|-------|-----------|
| Framework | Expo SDK 53 + Expo Router v4 |
| Styling | NativeWind v5 (Tailwind CSS for React Native) |
| ZK Proofs | `mopro-ffi` via `uniffi-bindgen-react-native` (native Groth16) |
| Passkeys | `react-native-passkeys` (iOS 16+ / Android 14+) |
| Solana | `@solana/kit` (RPC only, no wallet adapter) |
| QR Display | `react-native-qrcode-svg` for BIP-21 deposit URIs |
| SDK | `@aegis/sdk` (`watcher/native.ts` + new `prover/mobile.ts`) |
| Storage | `expo-secure-store` (encrypted keys) + `@react-native-async-storage` (notes/cache) |

## Key Differences from Web

| Feature | Web | Mobile |
|---------|-----|--------|
| Deposit | PSBT wallet OR QR code | **QR code only** |
| BTC wallet | Xverse/UniSat/Leather | **None** — scan QR from any wallet app |
| Auth | Passkey OR Solana wallet | **Passkey only** (native WebAuthn) |
| ZK proving | snarkjs WASM (~30s) | mopro native Arkworks (~2-3s) |
| Circuit assets | Public URL fetch | Tier 1+2 bundled, tier 3+ from Cloudflare R2 |

## Circuit Asset Strategy

| Delivery | Circuits | Count | Size | Method |
|----------|----------|-------|------|--------|
| **Bundled** | Tier 1+2 (N+M ≤ 4) | 10 | ~88 MB | `react-native-asset` in app binary |
| **On-demand** | Tier 3+ (N+M > 4) | 81 | 10-40 MB each | Cloudflare R2 → download + cache on first use |

Bundled tier 1+2 circuits:
- `1x1` (6 MB) — minimal
- `1x2` (6.3 MB) — deposit claim
- `1x3` (6.5 MB), `1x4` (6.7 MB) — splits
- `2x1` (8.3 MB) — consolidation
- `2x2` (8.5 MB) — standard transfer
- `2x3` (8.8 MB) — transfer + split
- `3x1` (12 MB), `3x2` (12 MB) — consolidation
- `4x1` (14 MB) — large consolidation

On-demand circuits served from `https://circuits.aegis.xyz/groth16/<name>.zkey` (Cloudflare R2, zero egress fees).

Flow for on-demand:
1. User needs `5x3` circuit → check `RNFS.DocumentDirectoryPath`
2. Not found → fetch from R2 with progress bar
3. Cache permanently on device → instant next time

## mopro Integration

### Native Module Structure

```
aegis-mobile/
├── MoproBindings/                    # mopro-ffi native module
│   ├── Cargo.toml                   # References JoinSplit circuits
│   ├── src/lib.rs                   # set_circom_circuits! macro
│   ├── ubrn.config.yaml            # uniffi-bindgen-react-native config
│   ├── MoproFfiFramework.xcframework/  # Built iOS framework
│   └── android/                     # Built Android .so libs
```

### SDK Prover Integration

The existing `prover/mobile.ts` stub in `@aegis/sdk` gets implemented:

```typescript
import { generateCircomProof, verifyCircomProof, ProofLib } from 'mopro-ffi';
import RNFS from 'react-native-fs';

export async function generateProofMobile(
  circuitName: string,
  inputs: Record<string, string[]>
): Promise<{ proof: Uint8Array; publicSignals: string[] }> {
  const zkeyPath = await resolveZkeyPath(circuitName);
  const result = await generateCircomProof(
    zkeyPath,
    JSON.stringify(inputs),
    ProofLib.Arkworks
  );
  // Convert Groth16 {a,b,c} to 256-byte format for on-chain verifier
  return convertToOnChainFormat(result);
}
```

### Circuit Build Process

1. Compile circom circuits (existing `scripts/compile.sh`)
2. Generate `.zkey` files (existing `scripts/setup.sh`)
3. Build mopro native bindings: `cd MoproBindings && npm run ubrn:ios && npm run ubrn:android`
4. Bundle tier 1+2 `.zkey` files via `react-native-asset`
5. Upload tier 3+ to Cloudflare R2

## Passkey Flow

```
Register:
  react-native-passkeys → create credential with PRF extension
  → derive 32-byte seed from PRF output
  → deriveKeysFromSeedCircuit(seed) → spending/nullifying/viewing keys
  → encrypt keys with device-bound key → expo-secure-store

Login:
  react-native-passkeys → authenticate → PRF output → derive same seed
  → restore keys from expo-secure-store
```

No Solana wallet needed. Keys derived entirely from passkey.

## Screens

All screens match web design (cyberpunk dark theme via NativeWind).

### Tab Navigation (bottom tabs)

1. **Home** — Hero stats, feature cards, pool info
2. **Vault** — Stealth address card, shielded balance, quick actions
3. **Explorer** — Commitments, nullifiers, proofs browser

### Stack Navigation (within Vault tab)

- **Vault/Deposit** — Amount input → generate Taproot address → QR code (BIP-21) → poll status
- **Vault/Pay** — Recipient (.btcpro.sol resolver) → amount → native ZK proof → transact
- **Vault/Received** — Inbox with decrypted stealth notes
- **Vault/Activity** — Transaction history + withdrawal tracking
- **Vault/Claim** — Claim detected deposits with 1x2 proof

### Deposit Flow (QR-only)

1. User enters amount + optional refund BTC pubkey
2. `createNonInteractiveDeposit()` with `userRefundPubkey` → Taproot address
3. Call `registerDeposit()` API
4. Show QR code with `bitcoin:tb1p...?amount=0.001`
5. "Copy Address" button + amount details
6. Store merkleRoot + controlBlock locally (for 24h refund)
7. Poll deposit status → show confirmation progress
8. Auto-claim when verified on-chain

## Shared Code (reused from web)

- `@aegis/sdk` — all crypto, stealth, merkle, taproot, events, config, announcement-client
- Backend API — same endpoints, same WebSocket announcements
- Solana program — same on-chain instructions
- Design tokens — same color palette ported to NativeWind theme

## Project Structure

```
aegis-mobile/
├── app/                              # Expo Router pages
│   ├── _layout.tsx                  # Root layout + providers
│   ├── (tabs)/
│   │   ├── _layout.tsx              # Tab navigator
│   │   ├── index.tsx                # Home
│   │   ├── vault.tsx                # Vault dashboard
│   │   └── explorer.tsx             # Explorer
│   └── vault/
│       ├── deposit.tsx              # QR deposit flow
│       ├── pay.tsx                  # Send zkBTC
│       ├── received.tsx             # Inbox
│       ├── activity.tsx             # History
│       └── claim.tsx                # Claim deposits
├── components/
│   ├── ui/                          # Ported from web (NativeWind)
│   │   ├── Button.tsx
│   │   ├── Input.tsx
│   │   ├── Card.tsx
│   │   ├── AmountDisplay.tsx
│   │   └── ...
│   ├── QRDeposit.tsx                # QR code generation + BIP-21
│   ├── StealthAddressCard.tsx
│   ├── InboxList.tsx
│   └── ProofProgress.tsx            # Native proof generation UI
├── stores/
│   ├── aegis-store.ts               # Same Zustand store (adapted for RN)
│   └── notes-store.ts               # AsyncStorage persistence
├── hooks/
│   ├── use-passkey.ts               # react-native-passkeys wrapper
│   ├── use-prover.ts                # mopro-ffi proof generation
│   └── use-deposit-status.ts        # WebSocket deposit tracking
├── lib/
│   ├── circuit-loader.ts            # Bundled vs R2 circuit resolution
│   └── storage.ts                   # expo-secure-store + AsyncStorage adapters
├── MoproBindings/                   # mopro-ffi native module
├── assets/
│   └── circuits/                    # Tier 1+2 .zkey files (88 MB)
├── app.json                         # Expo config
├── tailwind.config.ts               # NativeWind theme (matching web)
└── package.json
```

## Dependencies

```json
{
  "dependencies": {
    "expo": "~53.0.0",
    "expo-router": "~4.0.0",
    "expo-secure-store": "~14.0.0",
    "expo-camera": "~16.0.0",
    "@react-native-async-storage/async-storage": "^2.1.0",
    "react-native-passkeys": "^3.0.0",
    "react-native-qrcode-svg": "^6.3.0",
    "react-native-fs": "^2.20.0",
    "react-native-svg": "^15.0.0",
    "nativewind": "^5.0.0",
    "mopro-ffi": "workspace:MoproBindings",
    "@aegis/sdk": "file:../sdk",
    "@solana/kit": "^5.5.0",
    "zustand": "^5.0.0",
    "lucide-react-native": "^0.500.0",
    "sonner-native": "^0.15.0"
  }
}
```

## What's NOT included (intentionally)

- **No Solana wallet adapter** — passkey-only auth
- **No Bitcoin wallet integration** — QR code deposits only
- **No PSBT signing** — users send from their own wallet app
- **No web fallback** — native-only (web stays on Next.js)
- **No light mode** — dark-only matching web

## Verification Checklist

1. `bunx expo prebuild` — generates native projects
2. `cd MoproBindings && npm run ubrn:ios` — builds mopro native module
3. `bunx expo run:ios` — runs on iOS simulator
4. Passkey register/login works
5. QR deposit generates correct Taproot address
6. Native Groth16 proof generates correctly (~2-3s)
7. Transfer flow end-to-end (pay → verify on-chain)
8. Inbox scanning with stealth announcements
9. On-demand circuit download from R2 with progress
10. Same visual appearance as web app
