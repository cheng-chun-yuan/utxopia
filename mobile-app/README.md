# zVault Mobile App

Privacy-preserving Bitcoin wallet for iOS and Android using Zero-Knowledge proofs.

## Prerequisites

- **Node.js** 18+ or **Bun** 1.0+
- **Xcode** 15+ (for iOS)
- **Android Studio** (for Android)
- **EAS CLI** for cloud builds

## Quick Start

### 1. Install Dependencies

```bash
cd mobile-app
bun install
```

### 2. Build the SDK

The mobile app depends on the local SDK:

```bash
cd ../sdk
bun install
bun run build
cd ../mobile-app
```

### 3. Run Development Server

```bash
# Start Expo dev server
bun run start

# Or run directly on simulators
bun run ios      # iOS Simulator
bun run android  # Android Emulator
```

## Building for Production

### iOS (requires Mac + Xcode)

#### Local Build

```bash
# Generate native iOS project
bun run prebuild

# Open in Xcode
open ios/zvaultmobile.xcworkspace

# Build and run from Xcode
```

#### EAS Cloud Build

```bash
# Install EAS CLI
bun add -g eas-cli

# Login to Expo
eas login

# Build for iOS
eas build --platform ios
```

### Android

#### Local Build

```bash
# Generate native Android project
bun run prebuild

# Build APK
cd android
./gradlew assembleRelease

# APK location: android/app/build/outputs/apk/release/
```

#### EAS Cloud Build

```bash
eas build --platform android
```

## Project Structure

```
mobile-app/
├── app/                    # Expo Router screens
│   ├── (tabs)/            # Tab navigation
│   │   ├── index.tsx      # Home/Dashboard
│   │   ├── deposits.tsx   # Deposit list
│   │   ├── send.tsx       # Send options
│   │   └── settings.tsx   # Settings
│   ├── deposit/           # Deposit flow
│   ├── claim/             # Claim flow
│   ├── send/              # Send flows
│   └── onboarding/        # Wallet setup
├── lib/                   # Core utilities
│   ├── keys.ts           # BIP-39 + SDK key derivation
│   ├── storage.ts        # Secure storage + Face ID
│   ├── stealth.ts        # Stealth address operations
│   └── proof.ts          # ZK proof generation
├── components/           # Reusable components
└── contexts/             # React contexts
```

## Key Features

### Key Management (`lib/keys.ts`)

- BIP-39 mnemonic generation (12 or 24 words)
- SDK-based key derivation (Grumpkin + X25519)
- Stealth meta-address creation

```typescript
import { generateMnemonic, deriveKeysFromMnemonic, saveKeys } from './lib';

// Generate new wallet
const mnemonic = generateMnemonic();
const keys = deriveKeysFromMnemonic(mnemonic);
await saveKeys(keys);
```

### Secure Storage (`lib/storage.ts`)

- Face ID / Touch ID protection for spending keys
- Keychain storage for sensitive data
- AsyncStorage for cached data

### Stealth Transfers (`lib/stealth.ts`)

- Create deposits for recipients
- Scan announcements for incoming funds
- Prepare claim inputs for ZK proofs

### ZK Proofs (`lib/proof.ts`)

- Native Groth16 proof generation via `snarkjs`
- ~2-3 second proof times on modern devices
- Fallback to backend proving if needed

## Environment Setup

### iOS Development

1. Install Xcode from App Store
2. Install CocoaPods: `sudo gem install cocoapods`
3. Run: `cd ios && pod install`

### Android Development

1. Install Android Studio
2. Install Android SDK (API 33+)
3. Configure `ANDROID_HOME` environment variable

## Troubleshooting

### "Cannot find module '@zvault/sdk'"

Build the SDK first:
```bash
cd ../sdk && bun run build
```

### iOS Build Fails

```bash
cd ios
pod deintegrate
pod install
```

### Android Build Fails

```bash
cd android
./gradlew clean
```

### ZK Proofs Not Working

The `snarkjs` package requires native build. Run:
```bash
bun run prebuild
```

## Testing

```bash
# Run tests
bun test

# Type check
bun run tsc --noEmit
```

## Security Notes

- Mnemonic is stored with Face ID protection
- Spending key requires biometric auth
- Viewing key can be exported for delegation
- Screen capture is blocked on sensitive screens
