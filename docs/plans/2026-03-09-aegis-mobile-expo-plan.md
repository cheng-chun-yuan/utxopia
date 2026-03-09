# Aegis Mobile App (Expo) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a native mobile app with Expo that mirrors the web app's cyberpunk design, using passkey-only auth, QR-code-only deposits, and mopro native Groth16 proving.

**Architecture:** Expo Router v4 with tab navigation (Home/Vault/Explorer). Shares `@aegis/sdk` for all crypto. NativeWind v5 for Tailwind-compatible styling. `mopro-ffi` for native ZK proofs. `react-native-passkeys` for auth. No Solana wallet adapter, no BTC wallet integration.

**Tech Stack:** Expo SDK 53, Expo Router v4, NativeWind v5, mopro-ffi (Groth16 Arkworks), react-native-passkeys, @aegis/sdk, Zustand, react-native-qrcode-svg, expo-secure-store, Cloudflare R2

**Design doc:** `docs/plans/2026-03-09-aegis-mobile-expo-design.md`

---

## Task 1: Expo Project Scaffolding

**Files:**
- Create: `aegis-mobile/package.json`
- Create: `aegis-mobile/app.json`
- Create: `aegis-mobile/tsconfig.json`
- Create: `aegis-mobile/babel.config.js`
- Create: `aegis-mobile/metro.config.js`
- Create: `aegis-mobile/.gitignore`
- Create: `aegis-mobile/nativewind-env.d.ts`
- Create: `aegis-mobile/global.css`

**Step 1: Initialize Expo project**

```bash
cd /Users/chengchunyuan/project/hackathon/private_bitcoin_bridge/aegis-mobile
bunx create-expo-app@latest . --template tabs
```

**Step 2: Install core dependencies**

```bash
cd aegis-mobile
bun install nativewind@^5.0.0 tailwindcss@^4.0.0
bun install zustand@^5.0.0
bun install @aegis/sdk@file:../sdk
bun install @solana/kit@^5.5.0
bun install expo-secure-store @react-native-async-storage/async-storage
bun install react-native-qrcode-svg react-native-svg
bun install react-native-passkeys
bun install lucide-react-native
bun install sonner-native
bun install react-native-fs
bun install @noble/hashes @noble/curves @scure/base
bun install swr
```

**Step 3: Configure NativeWind**

Create `global.css` with the Aegis cyberpunk theme colors ported from `aegis-app/src/app/globals.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --color-background: #0f0f12;
  --color-foreground: #f1f0f3;
  --color-card: #202027;
  --color-muted: #16161b;
  --color-secondary: #2c2c36;
  --color-gray: #8b8a9e;
  --color-gray-light: #c7c5d1;
  --color-btc: #f7931a;
  --color-privacy: #14f195;
  --color-sol: #9945ff;
  --color-purple: #ffabfe;
  --color-success: #4ade80;
  --color-warning: #ffb546;
  --color-error: #ef4444;
  --color-cyan: #00ffff;
  --color-border: rgba(139, 138, 158, 0.2);
}
```

Update `babel.config.js`:

```js
module.exports = function (api) {
  api.cache(true);
  return {
    presets: [["babel-preset-expo", { jsxImportSource: "nativewind" }]],
    plugins: ["nativewind/babel"],
  };
};
```

Update `metro.config.js`:

```js
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");
const path = require("path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "..");

const config = getDefaultConfig(projectRoot);

// Watch the SDK workspace
config.watchFolders = [monorepoRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(monorepoRoot, "node_modules"),
];

module.exports = withNativeWind(config, { input: "./global.css" });
```

Create `nativewind-env.d.ts`:

```typescript
/// <reference types="nativewind/types" />
```

**Step 4: Configure app.json**

```json
{
  "expo": {
    "name": "Aegis",
    "slug": "aegis-mobile",
    "version": "0.1.0",
    "orientation": "portrait",
    "icon": "./assets/images/icon.png",
    "scheme": "aegis",
    "userInterfaceStyle": "dark",
    "newArchEnabled": true,
    "ios": {
      "supportsTablet": true,
      "bundleIdentifier": "xyz.aegis.mobile"
    },
    "android": {
      "adaptiveIcon": {
        "foregroundImage": "./assets/images/adaptive-icon.png",
        "backgroundColor": "#0f0f12"
      },
      "package": "xyz.aegis.mobile"
    },
    "plugins": [
      "expo-secure-store",
      "expo-camera"
    ]
  }
}
```

**Step 5: Verify project builds**

```bash
bunx expo prebuild
bunx expo run:ios --simulator
```

**Step 6: Commit**

```bash
git add aegis-mobile/
git commit -m "feat(mobile): scaffold Expo project with NativeWind + dependencies"
```

---

## Task 2: Theme & Base UI Components

**Files:**
- Create: `aegis-mobile/lib/utils.ts`
- Create: `aegis-mobile/components/ui/Button.tsx`
- Create: `aegis-mobile/components/ui/Input.tsx`
- Create: `aegis-mobile/components/ui/Card.tsx`
- Create: `aegis-mobile/components/ui/AmountDisplay.tsx`
- Create: `aegis-mobile/components/ui/Spinner.tsx`
- Create: `aegis-mobile/components/ui/CopyButton.tsx`
- Create: `aegis-mobile/components/ui/index.ts`

**Step 1: Create utility helpers**

`lib/utils.ts`:

```typescript
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatSats(sats: number): string {
  return (sats / 100_000_000).toFixed(8);
}

export function truncateAddress(addr: string, chars = 6): string {
  if (addr.length <= chars * 2 + 3) return addr;
  return `${addr.slice(0, chars)}...${addr.slice(-chars)}`;
}
```

**Step 2: Create Button component** (port from web `aegis-app/src/components/ui/button.tsx`)

`components/ui/Button.tsx`:

```tsx
import { Pressable, Text, ActivityIndicator, type PressableProps } from "react-native";
import { cn } from "@/lib/utils";

type ButtonVariant = "primary" | "secondary" | "tertiary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends PressableProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  children: string;
  className?: string;
  textClassName?: string;
}

const variantBg: Record<ButtonVariant, string> = {
  primary: "bg-[#14f195]",
  secondary: "bg-[#16161b] border border-[#8b8a9e4d]",
  tertiary: "bg-transparent border border-[#8b8a9e33]",
  ghost: "bg-transparent",
  danger: "bg-red-500/10 border border-red-500/20",
};

const variantText: Record<ButtonVariant, string> = {
  primary: "text-[#0f0f12] font-semibold",
  secondary: "text-[#f1f0f3]",
  tertiary: "text-[#c7c5d1]",
  ghost: "text-[#c7c5d1]",
  danger: "text-red-400",
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: "px-3 py-1.5",
  md: "px-4 py-2.5",
  lg: "px-6 py-3.5",
};

const sizeText: Record<ButtonSize, string> = {
  sm: "text-xs",
  md: "text-sm",
  lg: "text-base",
};

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  disabled,
  children,
  className,
  textClassName,
  ...props
}: ButtonProps) {
  const isDisabled = disabled || loading;

  return (
    <Pressable
      className={cn(
        "flex-row items-center justify-center rounded-[10px]",
        variantBg[variant],
        sizeStyles[size],
        isDisabled && "opacity-50",
        className
      )}
      disabled={isDisabled}
      {...props}
    >
      {loading && <ActivityIndicator size="small" className="mr-2" color="#0f0f12" />}
      <Text className={cn(variantText[variant], sizeText[size], textClassName)}>
        {children}
      </Text>
    </Pressable>
  );
}
```

**Step 3: Create Input component**

`components/ui/Input.tsx`:

```tsx
import { TextInput, View, Text, type TextInputProps } from "react-native";
import { cn } from "@/lib/utils";

interface InputProps extends TextInputProps {
  label?: string;
  error?: string;
  containerClassName?: string;
}

export function Input({ label, error, containerClassName, className, ...props }: InputProps) {
  return (
    <View className={cn("gap-1.5", containerClassName)}>
      {label && <Text className="text-xs text-[#8b8a9e]">{label}</Text>}
      <TextInput
        className={cn(
          "bg-[#16161b] border border-[#8b8a9e33] rounded-[10px]",
          "px-4 py-3 text-[#f1f0f3] text-sm",
          "placeholder:text-[#8b8a9e]",
          error && "border-red-500/50",
          className
        )}
        placeholderTextColor="#8b8a9e"
        {...props}
      />
      {error && <Text className="text-xs text-red-400">{error}</Text>}
    </View>
  );
}
```

**Step 4: Create Card component**

`components/ui/Card.tsx`:

```tsx
import { View, type ViewProps } from "react-native";
import { cn } from "@/lib/utils";

interface CardProps extends ViewProps {
  variant?: "default" | "btc" | "privacy";
}

export function Card({ variant = "default", className, children, ...props }: CardProps) {
  const variantStyles = {
    default: "bg-[#202027] border-[#8b8a9e1a]",
    btc: "bg-[#f7931a0d] border-[#f7931a33]",
    privacy: "bg-[#14f1950d] border-[#14f19533]",
  };

  return (
    <View
      className={cn(
        "rounded-2xl border p-4",
        variantStyles[variant],
        className
      )}
      {...props}
    >
      {children}
    </View>
  );
}
```

**Step 5: Create remaining UI components**

`components/ui/AmountDisplay.tsx` — formatted BTC/sats display
`components/ui/Spinner.tsx` — loading spinner with privacy-green color
`components/ui/CopyButton.tsx` — copy-to-clipboard with haptic feedback
`components/ui/index.ts` — barrel exports

**Step 6: Verify components render**

Create a test screen that renders all components. Run on simulator.

**Step 7: Commit**

```bash
git add aegis-mobile/components/ aegis-mobile/lib/
git commit -m "feat(mobile): port base UI components with NativeWind theme"
```

---

## Task 3: Navigation & Layout

**Files:**
- Create: `aegis-mobile/app/_layout.tsx`
- Create: `aegis-mobile/app/(tabs)/_layout.tsx`
- Create: `aegis-mobile/app/(tabs)/index.tsx`
- Create: `aegis-mobile/app/(tabs)/vault.tsx`
- Create: `aegis-mobile/app/(tabs)/explorer.tsx`
- Create: `aegis-mobile/app/vault/_layout.tsx`
- Create: `aegis-mobile/app/vault/deposit.tsx`
- Create: `aegis-mobile/app/vault/pay.tsx`
- Create: `aegis-mobile/app/vault/received.tsx`
- Create: `aegis-mobile/app/vault/activity.tsx`
- Create: `aegis-mobile/app/vault/claim.tsx`
- Create: `aegis-mobile/app/providers.tsx`

**Step 1: Create root layout**

`app/_layout.tsx`:

```tsx
import "../global.css";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Providers } from "./providers";

export default function RootLayout() {
  return (
    <Providers>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: "#0f0f12" },
          headerTintColor: "#f1f0f3",
          headerTitleStyle: { fontWeight: "600" },
          contentStyle: { backgroundColor: "#0f0f12" },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="vault" options={{ headerShown: false }} />
      </Stack>
    </Providers>
  );
}
```

**Step 2: Create providers** (no Solana wallet adapter — passkey only)

`app/providers.tsx`:

```tsx
import { useEffect } from "react";
import { initPoseidon } from "@aegis/sdk";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { setAsyncStorage } from "@aegis/sdk/watcher/native";

export function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // Initialize SDK
    setAsyncStorage(AsyncStorage);
    initPoseidon().catch(console.error);
  }, []);

  return <>{children}</>;
}
```

**Step 3: Create tab layout**

`app/(tabs)/_layout.tsx`:

```tsx
import { Tabs } from "expo-router";
import { Home, Shield, Search } from "lucide-react-native";

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarStyle: {
          backgroundColor: "#0f0f12",
          borderTopColor: "rgba(139, 138, 158, 0.15)",
        },
        tabBarActiveTintColor: "#14f195",
        tabBarInactiveTintColor: "#8b8a9e",
        headerStyle: { backgroundColor: "#0f0f12" },
        headerTintColor: "#f1f0f3",
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: ({ color, size }) => <Home size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="vault"
        options={{
          title: "Vault",
          tabBarIcon: ({ color, size }) => <Shield size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="explorer"
        options={{
          title: "Explorer",
          tabBarIcon: ({ color, size }) => <Search size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}
```

**Step 4: Create stub screens** (Home, Vault, Explorer + vault sub-screens)

Each stub screen: dark background, title text, placeholder content.

**Step 5: Verify navigation works**

```bash
bunx expo run:ios --simulator
```
Tap through all tabs and vault sub-screens.

**Step 6: Commit**

```bash
git add aegis-mobile/app/
git commit -m "feat(mobile): add Expo Router navigation with tab + stack layout"
```

---

## Task 4: Passkey Auth (Native)

**Files:**
- Create: `aegis-mobile/hooks/use-passkey.ts`
- Create: `aegis-mobile/stores/aegis-store.ts`
- Create: `aegis-mobile/lib/storage.ts`
- Create: `aegis-mobile/components/AuthScreen.tsx`

**Step 1: Create secure storage adapter**

`lib/storage.ts`:

```typescript
import * as SecureStore from "expo-secure-store";

const CREDENTIAL_KEY = "aegis:passkey_cred_id";
const SEED_KEY = "aegis:passkey_seed";

export async function getStoredCredentialId(): Promise<string | null> {
  return SecureStore.getItemAsync(CREDENTIAL_KEY);
}

export async function storeCredentialId(id: string): Promise<void> {
  await SecureStore.setItemAsync(CREDENTIAL_KEY, id);
}

export async function storeSeed(seed: Uint8Array): Promise<void> {
  const hex = Array.from(seed).map(b => b.toString(16).padStart(2, "0")).join("");
  await SecureStore.setItemAsync(SEED_KEY, hex);
}

export async function loadSeed(): Promise<Uint8Array | null> {
  const hex = await SecureStore.getItemAsync(SEED_KEY);
  if (!hex) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export async function clearAll(): Promise<void> {
  await SecureStore.deleteItemAsync(CREDENTIAL_KEY);
  await SecureStore.deleteItemAsync(SEED_KEY);
}
```

**Step 2: Create native passkey hook**

`hooks/use-passkey.ts`:

Port from web `aegis-app/src/hooks/use-passkey.ts` but replace:
- `@simplewebauthn/browser` → `react-native-passkeys` (`create()` / `get()`)
- `localStorage` → `expo-secure-store` via `lib/storage.ts`
- Same PRF extraction logic, same fallback seed pattern
- `getRpId()` returns app bundle ID instead of `window.location.hostname`

Key differences:
```typescript
import { Passkey } from "react-native-passkeys";

// Registration
const credential = await Passkey.create({
  rp: { name: "Aegis", id: "aegis.xyz" },
  user: { id: userId, name: "aegis-user", displayName: "Aegis User" },
  challenge: challengeBase64,
  pubKeyCredParams: [{ alg: -7, type: "public-key" }],
  authenticatorSelection: {
    residentKey: "required",
    userVerification: "required",
  },
});

// Authentication
const assertion = await Passkey.get({
  rpId: "aegis.xyz",
  challenge: challengeBase64,
  allowCredentials: credentialId ? [{ id: credentialId, type: "public-key" }] : [],
  userVerification: "required",
});
```

**Step 3: Create Zustand store** (port from `aegis-app/src/stores/aegis-store.ts`)

`stores/aegis-store.ts`:

Port the web store with these changes:
- Remove `"use client"` directive
- Replace `localStorage` → `AsyncStorage` (for notes cache)
- Replace `crypto.subtle` key encryption → `expo-secure-store` (simpler)
- Remove `@solana/web3.js` connection — use `@solana/kit` RPC directly
- Remove Solana wallet adapter dependency (`deriveKeysFromWallet` → not needed)
- Keep `deriveKeysFromPasskeySeed` (passkey-only flow)
- Keep `refreshInbox`, `startRealtimeInbox` (same WebSocket logic)
- Keep `AnnouncementClient` from SDK

**Step 4: Create AuthScreen component**

`components/AuthScreen.tsx`:

Full-screen auth gate with:
- Aegis logo + "Private Bitcoin Bridge" title
- "Create Account" button → passkey register → derive keys
- "Sign In" button → passkey authenticate → restore keys
- Dark background matching web theme

**Step 5: Wire auth into vault tab**

Vault tab checks `aegis-store.keys` — if null, show `<AuthScreen />`.

**Step 6: Test passkey flow on device** (passkeys require physical device or iOS 16+ simulator)

**Step 7: Commit**

```bash
git add aegis-mobile/hooks/ aegis-mobile/stores/ aegis-mobile/lib/storage.ts aegis-mobile/components/AuthScreen.tsx
git commit -m "feat(mobile): native passkey auth with expo-secure-store key persistence"
```

---

## Task 5: Home Screen

**Files:**
- Modify: `aegis-mobile/app/(tabs)/index.tsx`
- Create: `aegis-mobile/components/PoolStats.tsx`
- Create: `aegis-mobile/components/FeatureCard.tsx`
- Create: `aegis-mobile/hooks/use-pool-stats.ts`

**Step 1: Create pool stats hook** (reuse from web `aegis-app/src/hooks/use-pool-stats.tsx`)

Fetch pool state from backend API `/api/pool/info`.

**Step 2: Create FeatureCard component**

Port from web's `feature-card.tsx` — glassmorphism card with icon, title, description. Variants: btc (orange), privacy (teal), sol (purple).

**Step 3: Build Home screen**

- Hero section: "Aegis" title with gradient text, subtitle
- Pool stats: Total shielded, deposit count, formatted BTC amounts
- Feature cards: "Private Deposits", "Shielded Transfers", "Anonymous Withdrawals"
- Dark background `bg-[#0f0f12]`

**Step 4: Verify on simulator**

**Step 5: Commit**

```bash
git add aegis-mobile/app/\(tabs\)/index.tsx aegis-mobile/components/ aegis-mobile/hooks/
git commit -m "feat(mobile): home screen with pool stats and feature cards"
```

---

## Task 6: Vault Dashboard

**Files:**
- Modify: `aegis-mobile/app/(tabs)/vault.tsx`
- Create: `aegis-mobile/components/StealthAddressCard.tsx`
- Create: `aegis-mobile/components/BalanceCard.tsx`
- Create: `aegis-mobile/components/QuickActions.tsx`

**Step 1: Create StealthAddressCard**

Port from web — shows encoded stealth meta-address, .btcpro.sol name if registered, copy button.

**Step 2: Create BalanceCard**

Shows shielded zkBTC balance (from inbox notes), formatted in BTC with sats.

**Step 3: Create QuickActions**

Row of action buttons: Deposit, Send, Received, Activity — each navigates to vault sub-screen via `router.push("/vault/deposit")` etc.

**Step 4: Compose vault dashboard**

```tsx
<ScrollView className="flex-1 bg-[#0f0f12] px-4 pt-4">
  <StealthAddressCard />
  <BalanceCard />
  <QuickActions />
  {/* Recent activity preview */}
</ScrollView>
```

**Step 5: Commit**

```bash
git add aegis-mobile/app/\(tabs\)/vault.tsx aegis-mobile/components/
git commit -m "feat(mobile): vault dashboard with stealth address, balance, quick actions"
```

---

## Task 7: QR Code Deposit Flow

**Files:**
- Modify: `aegis-mobile/app/vault/deposit.tsx`
- Create: `aegis-mobile/components/QRDeposit.tsx`
- Create: `aegis-mobile/hooks/use-deposit-status.ts`

**Step 1: Create deposit status hook**

Port from web `use-deposit-status.ts` — polls backend `/api/deposits/status/:txid` or uses WebSocket.

**Step 2: Create QRDeposit component**

Flow:
1. Amount input (sats) + optional refund BTC pubkey (64 hex chars)
2. Call `createNonInteractiveDeposit()` with `userRefundPubkey` from SDK
3. Call backend `POST /api/deposits/register` with `{ ephemeralPub, npk, refundPubkey }`
4. Generate QR code with BIP-21 URI: `bitcoin:tb1p...?amount=0.0001`
5. Show QR + "Copy Address" + amount details
6. Poll deposit status → show progress (Detected → Confirmed → Verified → Claimable)

```tsx
import QRCode from "react-native-qrcode-svg";

// BIP-21 URI
const btcAmount = (amountSats / 100_000_000).toFixed(8);
const uri = `bitcoin:${depositAddress}?amount=${btcAmount}`;

<QRCode
  value={uri}
  size={240}
  backgroundColor="#0f0f12"
  color="#f1f0f3"
/>
```

**Step 3: Wire into deposit screen**

`app/vault/deposit.tsx` renders `<QRDeposit />` inside a ScrollView with the standard layout.

**Step 4: Test QR generation**

Verify QR code is scannable by a BTC wallet app (e.g., Blue Wallet on testnet4).

**Step 5: Commit**

```bash
git add aegis-mobile/app/vault/deposit.tsx aegis-mobile/components/QRDeposit.tsx aegis-mobile/hooks/
git commit -m "feat(mobile): QR code deposit flow with BIP-21 URI and status tracking"
```

---

## Task 8: mopro Native ZK Prover

**Files:**
- Create: `aegis-mobile/MoproBindings/Cargo.toml`
- Create: `aegis-mobile/MoproBindings/src/lib.rs`
- Create: `aegis-mobile/MoproBindings/ubrn.config.yaml`
- Create: `aegis-mobile/MoproBindings/package.json`
- Create: `aegis-mobile/lib/circuit-loader.ts`
- Create: `aegis-mobile/hooks/use-prover.ts`
- Modify: `sdk/src/prover/mobile.ts` (implement the stub)

**Step 1: Set up mopro-ffi native bindings**

`MoproBindings/Cargo.toml`:

```toml
[package]
name = "mopro-aegis-bindings"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "staticlib"]
name = "mopro_aegis_bindings"

[dependencies]
mopro-ffi = { version = "0.3", features = ["circom"] }

[build-dependencies]
mopro-ffi = { version = "0.3", features = ["circom"] }
```

`MoproBindings/src/lib.rs`:

```rust
use mopro_ffi::app_config;

app_config!();
```

`MoproBindings/ubrn.config.yaml`:

```yaml
rust:
  directory: .
  manifestPath: Cargo.toml

android:
  apiLevel: 28
  useSharedLibrary: true
```

`MoproBindings/package.json`: (based on zkmopro/react-native-app pattern)

```json
{
  "name": "mopro-ffi",
  "version": "0.1.0",
  "description": "Aegis mopro-ffi native bindings",
  "main": "./lib/module/index.js",
  "types": "./lib/typescript/src/index.d.ts",
  "scripts": {
    "ubrn:ios": "ubrn build ios --and-generate --release",
    "ubrn:android": "ubrn build android --and-generate --release --targets aarch64-linux-android"
  },
  "dependencies": {
    "uniffi-bindgen-react-native": "^0.29.3-1"
  },
  "peerDependencies": {
    "react": "*",
    "react-native": "*"
  }
}
```

**Step 2: Build native bindings**

```bash
cd aegis-mobile/MoproBindings
npm install
npm run ubrn:ios
```

**Step 3: Create circuit loader**

`lib/circuit-loader.ts`:

```typescript
import RNFS from "react-native-fs";
import { Platform } from "react-native";

const R2_BASE = "https://circuits.aegis.xyz/groth16";

// Tier 1+2 circuits are bundled in the app binary
const BUNDLED_CIRCUITS = new Set([
  "joinsplit_1x1", "joinsplit_1x2", "joinsplit_1x3", "joinsplit_1x4",
  "joinsplit_2x1", "joinsplit_2x2", "joinsplit_2x3",
  "joinsplit_3x1", "joinsplit_3x2", "joinsplit_4x1",
]);

export async function resolveZkeyPath(
  circuitName: string,
  onProgress?: (progress: number) => void,
): Promise<string> {
  const fileName = `${circuitName}.zkey`;
  const docPath = `${RNFS.DocumentDirectoryPath}/${fileName}`;

  // Check if already cached in documents
  if (await RNFS.exists(docPath)) return docPath;

  if (BUNDLED_CIRCUITS.has(circuitName)) {
    // Copy from app bundle to documents (mopro needs file path)
    const bundlePath = Platform.OS === "ios"
      ? `${RNFS.MainBundlePath}/${fileName}`
      : `custom/${fileName}`;

    if (Platform.OS === "android") {
      await RNFS.copyFileAssets(bundlePath, docPath);
    } else {
      await RNFS.copyFile(bundlePath, docPath);
    }
    return docPath;
  }

  // On-demand download from Cloudflare R2
  const url = `${R2_BASE}/${circuitName}/${fileName}`;
  const download = RNFS.downloadFile({
    fromUrl: url,
    toFile: docPath,
    progress: (res) => {
      if (onProgress && res.contentLength > 0) {
        onProgress(res.bytesWritten / res.contentLength);
      }
    },
  });

  const result = await download.promise;
  if (result.statusCode !== 200) {
    throw new Error(`Failed to download circuit ${circuitName}: HTTP ${result.statusCode}`);
  }

  return docPath;
}
```

**Step 4: Implement SDK mobile prover**

Update `sdk/src/prover/mobile.ts` to use mopro-ffi:

```typescript
/**
 * Mobile Prover using mopro-ffi (native Groth16 Arkworks)
 *
 * This module is imported by React Native apps that have
 * mopro-ffi native bindings installed.
 */

// These types are dynamically imported when mopro-ffi is available
let moproModule: any = null;

export type { MerkleProofInput, ProofData, CircuitType, JoinSplitProofInputs } from "./web";

import type { JoinSplitProofInputs, ProofData, CircuitType } from "./web";

// Injected by the mobile app
let circuitResolver: ((name: string, onProgress?: (p: number) => void) => Promise<string>) | null = null;

export function setCircuitResolver(resolver: typeof circuitResolver): void {
  circuitResolver = resolver;
}

export async function initProver(): Promise<void> {
  try {
    moproModule = require("mopro-ffi");
  } catch {
    throw new Error("mopro-ffi native module not found. Run MoproBindings build first.");
  }
}

export async function isProverAvailable(): Promise<boolean> {
  try {
    require("mopro-ffi");
    return true;
  } catch {
    return false;
  }
}

export async function generateJoinSplitProof(
  inputs: JoinSplitProofInputs,
  circuitType?: CircuitType,
  onProgress?: (progress: number) => void,
): Promise<ProofData> {
  if (!moproModule) await initProver();
  if (!circuitResolver) throw new Error("Circuit resolver not set. Call setCircuitResolver() first.");

  const nIn = inputs.nullifiers?.length || inputs.inputNullifiers?.length || 1;
  const nOut = inputs.commitments?.length || inputs.outputCommitments?.length || 2;
  const circuitName = circuitType || `joinsplit_${nIn}x${nOut}`;

  const zkeyPath = await circuitResolver(circuitName, onProgress);

  // Format inputs for mopro (flat JSON string mapping)
  const flatInputs = formatCircuitInputs(inputs);

  const result = await moproModule.generateCircomProof(
    zkeyPath,
    JSON.stringify(flatInputs),
    moproModule.ProofLib.Arkworks,
  );

  return convertMoproResult(result);
}

export function proofToBytes(proof: ProofData): Uint8Array {
  // Convert Groth16 proof to 256-byte on-chain format
  // a(64) + b(128) + c(64) = 256 bytes
  const bytes = new Uint8Array(256);
  // ... conversion from mopro proof format
  return bytes;
}

export async function circuitExists(circuitType: string): Promise<boolean> {
  if (!circuitResolver) return false;
  try {
    await circuitResolver(circuitType);
    return true;
  } catch {
    return false;
  }
}

export async function cleanup(): Promise<void> {
  moproModule = null;
}

function formatCircuitInputs(inputs: JoinSplitProofInputs): Record<string, string[]> {
  // Convert JoinSplitProofInputs to flat string map for mopro
  // Each field becomes string[] (mopro convention)
  const flat: Record<string, string[]> = {};
  // ... map each field from inputs to string array
  return flat;
}

function convertMoproResult(result: any): ProofData {
  // Convert mopro CircomProofResult to ProofData format
  // ... extract a, b, c points and public signals
  return {} as ProofData;
}
```

**Step 5: Create prover hook**

`hooks/use-prover.ts`:

```typescript
import { useState, useCallback, useRef } from "react";
import { resolveZkeyPath } from "@/lib/circuit-loader";

export function useProver() {
  const [isInitialized, setIsInitialized] = useState(false);
  const [isProving, setIsProving] = useState(false);
  const [progress, setProgress] = useState(0);
  const proverRef = useRef<any>(null);

  const initialize = useCallback(async () => {
    const { initProver, setCircuitResolver } = await import("@aegis/sdk/prover/mobile");
    setCircuitResolver(resolveZkeyPath);
    await initProver();
    setIsInitialized(true);
  }, []);

  const generateProof = useCallback(async (inputs: any, circuitType?: string) => {
    if (!isInitialized) await initialize();
    setIsProving(true);
    setProgress(0);
    try {
      const { generateJoinSplitProof } = await import("@aegis/sdk/prover/mobile");
      const proof = await generateJoinSplitProof(inputs, circuitType, setProgress);
      return proof;
    } finally {
      setIsProving(false);
      setProgress(1);
    }
  }, [isInitialized, initialize]);

  return { isInitialized, isProving, progress, initialize, generateProof };
}
```

**Step 6: Bundle tier 1+2 circuit .zkey files**

Configure `react-native.config.js` or `react-native-asset` to bundle the 10 tier 1+2 `.zkey` files (88 MB total):

```js
// react-native.config.js
module.exports = {
  assets: ["./assets/circuits"],
};
```

Copy circuit files:
```bash
mkdir -p aegis-mobile/assets/circuits
for c in 1x1 1x2 1x3 1x4 2x1 2x2 2x3 3x1 3x2 4x1; do
  cp ../aegis-app/public/circuits/groth16/joinsplit_${c}/joinsplit_${c}.zkey aegis-mobile/assets/circuits/
done
```

**Step 7: Test proof generation on device**

Run on physical device (proof generation is CPU-intensive):
```bash
bunx expo run:ios --device
```

**Step 8: Commit**

```bash
git add aegis-mobile/MoproBindings/ aegis-mobile/lib/circuit-loader.ts aegis-mobile/hooks/use-prover.ts sdk/src/prover/mobile.ts
git commit -m "feat(mobile): mopro native Groth16 prover with circuit loader + R2 fallback"
```

---

## Task 9: Send zkBTC (Pay Flow)

**Files:**
- Modify: `aegis-mobile/app/vault/pay.tsx`
- Create: `aegis-mobile/components/PayFlow.tsx`
- Create: `aegis-mobile/hooks/use-send.ts`

**Step 1: Create send hook**

Handles: resolve recipient (.btcpro.sol or raw stealth address) → select notes → generate JoinSplit proof → build transact instruction → submit to Solana.

Uses SDK: `resolveSnsToStealthMeta()`, `createNonInteractiveTransfer()`, `generateJoinSplitProof()` (mobile prover), `buildTransactInstruction()`.

**Step 2: Create PayFlow component**

Flow screens:
1. **Recipient** — input .btcpro.sol name or paste stealth address
2. **Amount** — input sats, show available balance
3. **Confirm** — summary card showing recipient + amount + fee
4. **Proving** — progress bar during native Groth16 (~2-3s)
5. **Result** — success with TX signature link

**Step 3: Wire into pay screen**

**Step 4: Commit**

```bash
git add aegis-mobile/app/vault/pay.tsx aegis-mobile/components/PayFlow.tsx aegis-mobile/hooks/use-send.ts
git commit -m "feat(mobile): send zkBTC flow with native ZK proving"
```

---

## Task 10: Inbox & Activity

**Files:**
- Modify: `aegis-mobile/app/vault/received.tsx`
- Modify: `aegis-mobile/app/vault/activity.tsx`
- Create: `aegis-mobile/components/InboxList.tsx`
- Create: `aegis-mobile/components/InboxItem.tsx`

**Step 1: Create InboxList + InboxItem**

Port from web's stealth-inbox components. FlatList with note items showing:
- Amount (formatted BTC)
- Timestamp
- Status (unspent/spent via nullifier check)
- "Claim" button for deposit notes

**Step 2: Build received screen**

Uses `aegis-store.inboxNotes` filtered to unspent.

**Step 3: Build activity screen**

Shows all notes (spent + unspent) + active withdrawals.

**Step 4: Commit**

```bash
git add aegis-mobile/app/vault/ aegis-mobile/components/
git commit -m "feat(mobile): inbox and activity screens with note display"
```

---

## Task 11: Claim Deposits

**Files:**
- Modify: `aegis-mobile/app/vault/claim.tsx`
- Create: `aegis-mobile/hooks/use-claim.ts`

**Step 1: Create claim hook**

Port from web `use-claim-flow.ts`:
- Detect claimable deposits (verified on-chain but not yet claimed)
- Generate 1x2 JoinSplit proof (1 input → 2 outputs: recipient note + change)
- Submit transact instruction

**Step 2: Build claim screen**

List of claimable deposits with "Claim" button. Shows proof generation progress.

**Step 3: Commit**

```bash
git add aegis-mobile/app/vault/claim.tsx aegis-mobile/hooks/use-claim.ts
git commit -m "feat(mobile): deposit claim flow with native 1x2 proof"
```

---

## Task 12: Explorer Screen

**Files:**
- Modify: `aegis-mobile/app/(tabs)/explorer.tsx`
- Create: `aegis-mobile/hooks/use-explorer.ts`

**Step 1: Create explorer hook**

Port from web — fetches commitments, nullifiers, proofs from backend API.

**Step 2: Build explorer screen**

Tabbed view (Commitments / Nullifiers / Proofs) with FlatList. Each item shows truncated hash + timestamp + link to Solscan.

**Step 3: Commit**

```bash
git add aegis-mobile/app/\(tabs\)/explorer.tsx aegis-mobile/hooks/use-explorer.ts
git commit -m "feat(mobile): explorer screen with commitments, nullifiers, proofs"
```

---

## Task 13: Cloudflare R2 Circuit CDN

**Files:**
- Create: `scripts/upload-circuits-r2.sh`

**Step 1: Create R2 bucket**

```bash
# Using Cloudflare Wrangler CLI
npx wrangler r2 bucket create aegis-circuits
```

**Step 2: Upload all circuit .zkey files**

`scripts/upload-circuits-r2.sh`:

```bash
#!/bin/bash
CIRCUIT_DIR="aegis-app/public/circuits/groth16"

for dir in $CIRCUIT_DIR/joinsplit_*/; do
  name=$(basename "$dir")
  zkey="$dir/${name}.zkey"
  if [ -f "$zkey" ]; then
    echo "Uploading $name..."
    npx wrangler r2 object put "aegis-circuits/groth16/${name}/${name}.zkey" \
      --file "$zkey" \
      --content-type "application/octet-stream"
  fi
done
```

**Step 3: Configure custom domain**

Map `circuits.aegis.xyz` to R2 bucket via Cloudflare dashboard (or Worker).

**Step 4: Test download**

```bash
curl -I https://circuits.aegis.xyz/groth16/joinsplit_5x5/joinsplit_5x5.zkey
```

**Step 5: Commit**

```bash
git add scripts/upload-circuits-r2.sh
git commit -m "feat: R2 upload script for on-demand circuit delivery"
```

---

## Task 14: Polish & Integration Testing

**Files:**
- Various component refinements
- Create: `aegis-mobile/app.config.ts` (if needed for EAS Build)

**Step 1: Add haptic feedback**

Install `expo-haptics`, add feedback on button presses, proof completion, deposit detection.

**Step 2: Add pull-to-refresh**

Vault dashboard and inbox — RefreshControl on ScrollView/FlatList.

**Step 3: Add error boundaries**

Wrap each screen in error boundary with retry button.

**Step 4: Test full flow end-to-end**

1. Open app → passkey register → keys derived
2. Home screen shows pool stats
3. Vault shows stealth address
4. Deposit → enter amount → QR code → scan from Blue Wallet → send BTC
5. Poll status → deposit detected → confirmed → verified
6. Claim → native 1x2 proof (~2-3s) → submit
7. Send → enter .btcpro.sol → amount → 2x2 proof → submit
8. Check inbox → note appears
9. Explorer shows new commitment + nullifier

**Step 5: Final commit**

```bash
git add aegis-mobile/
git commit -m "feat(mobile): polish, haptics, error boundaries, integration testing"
```

---

## Summary

| Task | Description | Key Files |
|------|-------------|-----------|
| 1 | Expo scaffolding + NativeWind | package.json, global.css, metro.config.js |
| 2 | Theme + base UI components | components/ui/*.tsx |
| 3 | Navigation layout | app/_layout.tsx, app/(tabs)/ |
| 4 | Passkey auth (native) | hooks/use-passkey.ts, stores/aegis-store.ts |
| 5 | Home screen | app/(tabs)/index.tsx |
| 6 | Vault dashboard | app/(tabs)/vault.tsx |
| 7 | QR deposit flow | components/QRDeposit.tsx |
| 8 | mopro native prover | MoproBindings/, sdk/src/prover/mobile.ts |
| 9 | Send zkBTC | components/PayFlow.tsx |
| 10 | Inbox + activity | components/InboxList.tsx |
| 11 | Claim deposits | hooks/use-claim.ts |
| 12 | Explorer | app/(tabs)/explorer.tsx |
| 13 | Cloudflare R2 CDN | scripts/upload-circuits-r2.sh |
| 14 | Polish + E2E testing | Haptics, error boundaries, full flow test |
