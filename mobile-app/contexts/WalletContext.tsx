/**
 * Wallet Context
 *
 * Manages wallet state including:
 * - ZVault keys (viewing/spending) via SDK
 * - zkBTC notes
 * - Stealth address
 *
 * This context wraps the SDK to provide a simpler API for the UI.
 */

import React, { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import { usePhantom } from '@phantom/react-native-wallet-sdk';
import AsyncStorage from '@react-native-async-storage/async-storage';
import bs58 from 'bs58';
import {
  deriveKeysFromSignature,
  createStealthMetaAddress,
  encodeStealthMetaAddress,
  SPENDING_KEY_DERIVATION_MESSAGE,
  formatBtc as sdkFormatBtc,
  type ZVaultKeys,
  type StealthMetaAddress,
  type Note,
} from '@zvault/sdk';

// Storage keys
const STORAGE_KEYS = {
  NOTES: 'zvault_notes',
  KEYS_DERIVED: 'zvault_keys_derived',
  STEALTH_ADDRESS: 'zvault_stealth_address',
};

// Note structure (compatible with SDK Note type)
export interface WalletNote {
  id: string;
  amount: bigint; // satoshis (changed from number to bigint)
  createdAt: number;
  status: 'available' | 'pending' | 'spent';
  // Optional SDK note fields
  nullifier?: bigint;
  secret?: bigint;
  commitment?: bigint;
}

interface WalletContextValue {
  // Connection
  isConnected: boolean;
  address: string | null;

  // Keys (SDK types)
  keys: ZVaultKeys | null;
  keysDerived: boolean;
  stealthAddress: string | null; // Encoded stealth meta-address
  stealthMetaAddress: StealthMetaAddress | null;
  deriveKeys: () => Promise<void>;
  isDerivingKeys: boolean;

  // Balance (bigint for precision)
  notes: WalletNote[];
  totalBalance: bigint;
  availableBalance: bigint;

  // Legacy number balance for backwards compatibility
  totalBalanceNumber: number;
  availableBalanceNumber: number;

  // Actions
  refreshNotes: () => Promise<void>;
  addDemoNote: (amount: number) => Promise<void>;
  isLoading: boolean;
}

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const { isLoggedIn, addresses, phantom } = usePhantom();

  // State
  const [keys, setKeys] = useState<ZVaultKeys | null>(null);
  const [keysDerived, setKeysDerived] = useState(false);
  const [stealthAddress, setStealthAddress] = useState<string | null>(null);
  const [stealthMetaAddress, setStealthMetaAddress] = useState<StealthMetaAddress | null>(null);
  const [notes, setNotes] = useState<WalletNote[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isDerivingKeys, setIsDerivingKeys] = useState(false);

  // Get Solana address from Phantom addresses
  const solanaAddress = (() => {
    if (!addresses) return null;
    const addrs = addresses as any;
    if (Array.isArray(addrs)) {
      const found = addrs.find((a: any) => a.chain === 'solana' || a.blockchain === 'solana');
      return found?.address ?? found?.publicKey ?? null;
    }
    return addrs.solana ?? null;
  })();

  // Calculate balances (bigint)
  const totalBalance = notes.reduce((sum, n) => sum + n.amount, 0n);
  const availableBalance = notes
    .filter((n) => n.status === 'available')
    .reduce((sum, n) => sum + n.amount, 0n);

  // Legacy number balances for backwards compatibility
  const totalBalanceNumber = Number(totalBalance);
  const availableBalanceNumber = Number(availableBalance);

  // Load saved data on mount
  useEffect(() => {
    loadSavedData();
  }, [solanaAddress]);

  const loadSavedData = async () => {
    if (!solanaAddress) {
      setKeysDerived(false);
      setStealthAddress(null);
      setStealthMetaAddress(null);
      setKeys(null);
      setNotes([]);
      return;
    }

    try {
      // Check if keys were derived for this address
      const keysData = await AsyncStorage.getItem(`${STORAGE_KEYS.KEYS_DERIVED}_${solanaAddress}`);
      const savedStealth = await AsyncStorage.getItem(`${STORAGE_KEYS.STEALTH_ADDRESS}_${solanaAddress}`);

      if (keysData && savedStealth) {
        setKeysDerived(true);
        setStealthAddress(savedStealth);
        // Note: We don't store private keys, they need to be re-derived for spending
      }

      // Load notes (convert legacy number amounts to bigint)
      const notesData = await AsyncStorage.getItem(`${STORAGE_KEYS.NOTES}_${solanaAddress}`);
      if (notesData) {
        const parsed = JSON.parse(notesData);
        const migratedNotes: WalletNote[] = parsed.map((n: any) => ({
          ...n,
          amount: BigInt(n.amount),
        }));
        setNotes(migratedNotes);
      }
    } catch (err) {
      console.error('Failed to load wallet data:', err);
    }
  };

  // Derive viewing/spending keys via SDK
  const deriveKeys = useCallback(async () => {
    if (!phantom || !solanaAddress) return;

    setIsDerivingKeys(true);
    try {
      // Sign the standard zVault derivation message
      const message = new TextEncoder().encode(SPENDING_KEY_DERIVATION_MESSAGE);
      const result = await phantom.providers.solana.signMessage(message);
      const signature = result.signature;

      // Get Solana public key as bytes (32 bytes)
      // For Phantom, the address is base58-encoded, we need raw bytes
      const solanaPublicKeyBytes = bs58.decode(solanaAddress);

      // Derive keys using SDK (Grumpkin curves for ZK compatibility)
      const derivedKeys = deriveKeysFromSignature(signature, solanaPublicKeyBytes);

      // Create stealth meta-address (66 bytes: spending pub + viewing pub)
      const meta = createStealthMetaAddress(derivedKeys);
      const encoded = encodeStealthMetaAddress(meta);

      // Save keys state
      await AsyncStorage.setItem(
        `${STORAGE_KEYS.KEYS_DERIVED}_${solanaAddress}`,
        'true'
      );
      await AsyncStorage.setItem(
        `${STORAGE_KEYS.STEALTH_ADDRESS}_${solanaAddress}`,
        encoded
      );

      setKeys(derivedKeys);
      setKeysDerived(true);
      setStealthAddress(encoded);
      setStealthMetaAddress(meta);

      console.log('[Wallet] Keys derived successfully via SDK');
    } catch (err) {
      console.error('Failed to derive keys:', err);
      throw err;
    } finally {
      setIsDerivingKeys(false);
    }
  }, [phantom, solanaAddress]);

  // Refresh notes (scan for new deposits)
  const refreshNotes = useCallback(async () => {
    if (!solanaAddress || !keysDerived) return;

    setIsLoading(true);
    try {
      // TODO: Implement real scanning via SDK using scanAnnouncements
      // For now, just reload from storage
      await loadSavedData();
    } catch (err) {
      console.error('Failed to refresh notes:', err);
    } finally {
      setIsLoading(false);
    }
  }, [solanaAddress, keysDerived]);

  // Add demo note (for testing) - stores as bigint
  const addDemoNote = useCallback(async (amount: number) => {
    if (!solanaAddress) return;

    const newNote: WalletNote = {
      id: `note_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      amount: BigInt(amount),
      createdAt: Date.now(),
      status: 'available',
    };

    const updatedNotes = [...notes, newNote];
    setNotes(updatedNotes);

    // Store with amounts as strings (JSON doesn't support bigint)
    const serialized = updatedNotes.map((n) => ({
      ...n,
      amount: n.amount.toString(),
    }));
    await AsyncStorage.setItem(
      `${STORAGE_KEYS.NOTES}_${solanaAddress}`,
      JSON.stringify(serialized)
    );
  }, [solanaAddress, notes]);

  const value: WalletContextValue = {
    isConnected: isLoggedIn,
    address: solanaAddress,
    keys,
    keysDerived,
    stealthAddress,
    stealthMetaAddress,
    deriveKeys,
    isDerivingKeys,
    notes,
    totalBalance,
    availableBalance,
    totalBalanceNumber,
    availableBalanceNumber,
    refreshNotes,
    addDemoNote,
    isLoading,
  };

  return (
    <WalletContext.Provider value={value}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  const context = useContext(WalletContext);
  if (!context) {
    throw new Error('useWallet must be used within a WalletProvider');
  }
  return context;
}
