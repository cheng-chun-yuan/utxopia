# CLAUDE.md - zVault Wallet

This file provides guidance to Claude Code when working with the mobile wallet app.

## Quick Start

```bash
# Install dependencies
bun install

# Start development server
bun run start

# Run on iOS simulator (requires dev client build)
bun run ios

# Run on Android emulator (requires dev client build)
bun run android

# Prebuild native code (required for Phantom SDK and snarkjs)
npx expo prebuild --clean
```

**Important**: This app uses native modules (Phantom SDK, snarkjs) and cannot run in Expo Go. You must build a development client first.

## Project Overview

Expo SDK 54 mobile wallet for zVault - a privacy-preserving Bitcoin-to-Solana bridge. Features:

- **Phantom Wallet Integration**: Login and sign transactions via Phantom embedded wallet SDK
- **ZK Proof Generation**: Groth16 proof generation via snarkjs
- **Expo Router**: File-based navigation

## Directory Structure

```
zvault-wallet/
├── app/                    # Expo Router screens
│   ├── _layout.tsx        # Root layout with providers
│   ├── index.tsx          # Home screen (wallet connect)
│   └── sign.tsx           # Sign message screen
├── components/            # Shared UI components
│   └── useColorScheme.tsx # Theme hook
├── contexts/              # React contexts
│   └── PhantomContext.tsx # Phantom wallet provider
├── lib/                   # Core utilities
│   ├── polyfills.ts      # Buffer/crypto polyfills (import first!)
│   └── proof.ts          # ZK proof generation (snarkjs)
├── assets/               # Images, fonts
└── types/                # TypeScript type definitions
```

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `@phantom/react-native-wallet-sdk` | Phantom embedded wallet |
| `snarkjs` | Groth16 ZK proving via snarkjs |
| `@solana/web3.js` | Solana blockchain interaction |
| `expo-router` | File-based navigation |
| `zustand` | State management |

## Polyfills

The app requires polyfills for React Native. Import order matters:

```typescript
// In _layout.tsx - MUST be first import
import '@/lib/polyfills';
```

The polyfills provide:
- `react-native-get-random-values` for crypto
- `Buffer` global
- `crypto-browserify` and `web-streams-polyfill` via metro config

## Phantom Wallet Integration

### Setup
The app is wrapped with `PhantomWalletProvider`:

```typescript
import { PhantomWalletProvider } from '@/contexts/PhantomContext';

<PhantomWalletProvider>
  <App />
</PhantomWalletProvider>
```

### Usage
```typescript
import { usePhantom } from '@phantom/react-native-wallet-sdk';

const { phantom, isLoggedIn, addresses, showLoginOptions, logout } = usePhantom();

// Connect
await showLoginOptions();

// Sign message
const result = await phantom.providers.solana.signMessage(encodedMessage);

// Sign transaction
const signed = await phantom.providers.solana.signTransaction(transaction);
```

## ZK Proof Generation

Groth16 proving via snarkjs:

```typescript
import { generateProof, CIRCUITS } from '@/lib/proof';

const result = await generateProof(CIRCUITS.CLAIM, {
  nullifier: '0x...',
  secret: '0x...',
  amount: '1000000',
  // ... other inputs
});

if (result.success) {
  console.log(result.proof, result.publicInputs);
}
```

**Note**: Circuit files (.json) and SRS must be bundled with the app or downloaded at runtime.

## Development Notes

- **Package Manager**: Always use `bun` instead of `npm`
- **Expo SDK 54**: React 19, React Compiler enabled, New Architecture default
- **Native Modules**: Requires `npx expo prebuild` before running
- **Deep Linking**: Configured for `zvaultwallet://` scheme

## Building for Device

```bash
# iOS
npx expo prebuild --platform ios
npx expo run:ios

# Android
npx expo prebuild --platform android
npx expo run:android

# EAS Build (cloud)
eas build --platform ios
eas build --platform android
```

## Troubleshooting

### Metro bundler issues
```bash
npx expo start --clear
```

### Native module not found
```bash
# Rebuild native code
npx expo prebuild --clean
```

### Phantom redirect issues
Ensure `scheme` in app.json matches Linking.createURL() base.
