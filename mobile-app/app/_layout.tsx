/**
 * Root Layout
 *
 * Simple wallet app with Phantom integration and tab navigation.
 * Initializes zVault SDK on startup.
 */

// Import polyfills first
import '@/lib/polyfills';

import FontAwesome from '@expo/vector-icons/FontAwesome';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import 'react-native-reanimated';

import { useColorScheme } from '@/components/useColorScheme';
import { PhantomWalletProvider } from '@/contexts/PhantomContext';
import { WalletProvider } from '@/contexts/WalletContext';
import { SDKProvider } from '@/contexts/SDKContext';
import { PaymentRequestProvider } from '@/contexts/PaymentRequestContext';
import { initSDK, isSDKReady } from '@/lib/sdk-init';

export { ErrorBoundary } from 'expo-router';

export const unstable_settings = {
  initialRouteName: '(tabs)',
};

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

function RootLayoutNav() {
  const colorScheme = useColorScheme();

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
      </Stack>
    </ThemeProvider>
  );
}

export default function RootLayout() {
  const [sdkReady, setSdkReady] = useState(false);

  // SpaceMono is now loaded natively via expo-font config plugin
  // Only need to load FontAwesome icons async
  const [loaded, error] = useFonts({
    ...FontAwesome.font,
  });

  // Initialize SDK
  useEffect(() => {
    initSDK()
      .then(() => {
        setSdkReady(true);
        console.log('[App] SDK initialized');
      })
      .catch((err) => {
        console.error('[App] SDK init failed:', err);
        // Continue anyway - some features may still work
        setSdkReady(true);
      });
  }, []);

  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (loaded && sdkReady) {
      SplashScreen.hideAsync();
    }
  }, [loaded, sdkReady]);

  if (!loaded || !sdkReady) {
    return null;
  }

  return (
    <PhantomWalletProvider>
      <WalletProvider>
        <SDKProvider isSDKReady={sdkReady}>
          <PaymentRequestProvider>
            <RootLayoutNav />
          </PaymentRequestProvider>
        </SDKProvider>
      </WalletProvider>
    </PhantomWalletProvider>
  );
}
