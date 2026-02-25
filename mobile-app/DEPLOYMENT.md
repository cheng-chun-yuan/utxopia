# zVault Wallet - Deployment & Testing Guide

This guide covers how to build and test the zVault Wallet app on your mobile device.

> **Important**: This app uses native modules (Phantom SDK, snarkjs) and **cannot run in Expo Go**. You must build a development client.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Quick Start (Simulator/Emulator)](#quick-start)
3. [Testing on Physical Device](#testing-on-physical-device)
4. [EAS Build (Cloud)](#eas-build-cloud)
5. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### 1. Install Required Tools

```bash
# Install Node.js (v18+) and Bun
brew install node bun

# Install Expo CLI
npm install -g expo-cli eas-cli

# Verify installations
node --version    # Should be v18+
bun --version     # Should be v1.0+
expo --version
eas --version
```

### 2. iOS Development (Mac only)

```bash
# Install Xcode from App Store, then:
xcode-select --install

# Install CocoaPods
sudo gem install cocoapods

# Accept Xcode license
sudo xcodebuild -license accept
```

### 3. Android Development

```bash
# Install Android Studio from https://developer.android.com/studio
# Then set up environment variables in ~/.zshrc or ~/.bashrc:

export ANDROID_HOME=$HOME/Library/Android/sdk
export PATH=$PATH:$ANDROID_HOME/emulator
export PATH=$PATH:$ANDROID_HOME/tools
export PATH=$PATH:$ANDROID_HOME/tools/bin
export PATH=$PATH:$ANDROID_HOME/platform-tools
```

### 4. Install Project Dependencies

```bash
cd mobile-app
bun install
```

---

## Quick Start

### Run on iOS Simulator

```bash
# 1. Generate native iOS project
npx expo prebuild --platform ios

# 2. Build and run on simulator
npx expo run:ios

# Or specify a simulator
npx expo run:ios --device "iPhone 15 Pro"
```

### Run on Android Emulator

```bash
# 1. Start an Android emulator from Android Studio
# Or via command line:
emulator -avd Pixel_7_API_34

# 2. Generate native Android project
npx expo prebuild --platform android

# 3. Build and run on emulator
npx expo run:android
```

---

## Testing on Physical Device

### Option A: Local Build (Recommended for Development)

#### iOS (Requires Mac + Apple Developer Account)

```bash
# 1. Prebuild the project
npx expo prebuild --platform ios --clean

# 2. Open in Xcode
open ios/zvaultwallet.xcworkspace

# 3. In Xcode:
#    - Select your physical device from the device dropdown
#    - Go to Signing & Capabilities
#    - Select your Team (Apple Developer account)
#    - Click the Play button to build and run
```

**Free Apple Account (No $99/year membership):**
- You can still test on your device for 7 days
- Go to Xcode → Settings → Accounts → Add your Apple ID
- Select "Personal Team" for signing

#### Android

```bash
# 1. Enable Developer Mode on your Android phone:
#    Settings → About Phone → Tap "Build Number" 7 times

# 2. Enable USB Debugging:
#    Settings → Developer Options → USB Debugging → On

# 3. Connect phone via USB and verify:
adb devices

# 4. Build and install
npx expo run:android --device
```

### Option B: EAS Build (Cloud Build)

This is the easiest way to get an app on your physical device.

---

## EAS Build (Cloud)

EAS Build compiles your app in the cloud and provides an installable file.

### 1. Setup EAS

```bash
# Login to Expo account (create one at expo.dev if needed)
eas login

# Initialize EAS in your project
eas build:configure
```

### 2. Build Development Client

#### iOS (TestFlight or Direct Install)

```bash
# Build for iOS device (development)
eas build --platform ios --profile development

# Or build for internal distribution (ad-hoc)
eas build --platform ios --profile preview
```

After the build completes:
- For development builds: Scan the QR code or download the `.ipa` file
- For preview builds: Install via TestFlight or direct download

#### Android (APK)

```bash
# Build APK for Android
eas build --platform android --profile preview

# This produces an APK you can download and install directly
```

### 3. EAS Configuration

Create/update `eas.json` in the project root:

```json
{
  "cli": {
    "version": ">= 5.0.0"
  },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal",
      "ios": {
        "simulator": false
      }
    },
    "preview": {
      "distribution": "internal",
      "android": {
        "buildType": "apk"
      }
    },
    "production": {
      "autoIncrement": true
    }
  },
  "submit": {
    "production": {}
  }
}
```

### 4. Install on Device

#### iOS
1. After EAS build completes, you'll get a QR code
2. Scan with your iPhone camera
3. Follow prompts to install the app
4. Go to Settings → General → VPN & Device Management
5. Trust the developer certificate

#### Android
1. Download the APK from the build page
2. Transfer to your phone or scan QR code
3. Enable "Install from unknown sources" if prompted
4. Install the APK

---

## Development Workflow

Once you have a development client installed:

```bash
# Start the development server
bun run start

# Or with cache clearing
bun run start --clear

# The app on your device will connect to this server
# Changes will hot-reload automatically
```

### Connect Device to Dev Server

1. Make sure your phone and computer are on the **same WiFi network**
2. Start the dev server: `bun run start`
3. Open the development client app on your phone
4. It should automatically detect the server
5. If not, shake your device to open the dev menu and enter the URL manually

---

## Testing Deep Links

### iOS Simulator

```bash
# Test payment request deep link
xcrun simctl openurl booted "zvaultwallet://send?to=abc123...&amount=0.001"
```

### Android Emulator

```bash
# Test payment request deep link
adb shell am start -a android.intent.action.VIEW -d "zvaultwallet://send?to=abc123...&amount=0.001"
```

### Physical Device

1. Send yourself a message/email with the link
2. Tap the link to open in the app

---

## Production Build

### iOS App Store

```bash
# Build for App Store submission
eas build --platform ios --profile production

# Submit to App Store
eas submit --platform ios
```

### Google Play Store

```bash
# Build for Play Store (AAB format)
eas build --platform android --profile production

# Submit to Play Store
eas submit --platform android
```

---

## Troubleshooting

### Common Issues

#### "No development build available"
```bash
# Rebuild the development client
npx expo prebuild --clean
npx expo run:ios  # or run:android
```

#### iOS Signing Issues
```bash
# Reset iOS build
rm -rf ios
npx expo prebuild --platform ios --clean
```

#### Android Build Failures
```bash
# Clean Android build
cd android && ./gradlew clean && cd ..
npx expo run:android
```

#### Metro Bundler Issues
```bash
# Clear all caches
npx expo start --clear
# Or manually:
rm -rf node_modules/.cache
watchman watch-del-all
```

#### CocoaPods Issues
```bash
cd ios
pod deintegrate
pod install
cd ..
```

### Check Native Module Installation

```bash
# Verify native modules are linked
npx expo-doctor
```

### Logs

```bash
# iOS logs (simulator)
npx react-native log-ios

# Android logs
adb logcat | grep -E "(ReactNative|zVault)"
```

---

## Quick Reference

| Command | Description |
|---------|-------------|
| `bun run start` | Start dev server |
| `bun run ios` | Run on iOS simulator |
| `bun run android` | Run on Android emulator |
| `npx expo prebuild --clean` | Regenerate native code |
| `eas build --platform ios --profile development` | Cloud build for iOS |
| `eas build --platform android --profile preview` | Cloud build for Android (APK) |

---

## Environment Requirements Summary

| Tool | Minimum Version |
|------|-----------------|
| Node.js | 18.0+ |
| Bun | 1.0+ |
| Xcode | 15.0+ (iOS) |
| Android Studio | Hedgehog+ |
| CocoaPods | 1.14+ |
| EAS CLI | 5.0+ |

---

## Need Help?

- [Expo Documentation](https://docs.expo.dev/)
- [EAS Build Docs](https://docs.expo.dev/build/introduction/)
- [React Native Troubleshooting](https://reactnative.dev/docs/troubleshooting)
