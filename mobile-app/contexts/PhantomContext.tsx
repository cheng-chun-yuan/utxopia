/**
 * Phantom Wallet Context
 *
 * Provides Phantom wallet connection and signing functionality
 * throughout the app using the Phantom React Native SDK.
 */

import React, { createContext, useContext, useMemo, ReactNode } from 'react';
import * as Linking from 'expo-linking';
import { PhantomProvider, usePhantom } from '@phantom/react-native-wallet-sdk';

// Re-export the usePhantom hook for convenience
export { usePhantom };

// Config type based on PhantomProvider props
interface PhantomConfig {
  redirectURI: string;
  sdkKey: string;
  autoShowLoginIfNeeded?: boolean;
}

interface PhantomContextValue {
  config: PhantomConfig;
}

const PhantomContext = createContext<PhantomContextValue | null>(null);

interface PhantomWalletProviderProps {
  children: ReactNode;
  sdkKey?: string;
}

export function PhantomWalletProvider({ children, sdkKey = 'zvault-mobile' }: PhantomWalletProviderProps) {
  const config = useMemo<PhantomConfig>(
    () => ({
      redirectURI: Linking.createURL(''),
      sdkKey,
      autoShowLoginIfNeeded: false,
    }),
    [sdkKey]
  );

  return (
    <PhantomContext.Provider value={{ config }}>
      <PhantomProvider config={config}>{children}</PhantomProvider>
    </PhantomContext.Provider>
  );
}

export function usePhantomConfig() {
  const context = useContext(PhantomContext);
  if (!context) {
    throw new Error('usePhantomConfig must be used within a PhantomWalletProvider');
  }
  return context;
}
