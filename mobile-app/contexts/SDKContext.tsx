/**
 * SDK Context
 *
 * Centralized context for zVault SDK state including:
 * - ZVault keys (spending/viewing)
 * - Stealth meta-address
 * - Stealth inbox scanning
 * - Deposit watching
 */

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  ReactNode,
  useMemo,
} from 'react';
import { usePhantom } from '@phantom/react-native-wallet-sdk';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  // Key derivation
  deriveKeysFromSignature,
  createStealthMetaAddress,
  encodeStealthMetaAddress,
  decodeStealthMetaAddress,
  SPENDING_KEY_DERIVATION_MESSAGE,
  type ZVaultKeys,
  type StealthMetaAddress,
  // Stealth scanning
  scanAnnouncements,
  parseStealthAnnouncement,
  announcementToScanFormat,
  STEALTH_ANNOUNCEMENT_SIZE,
  type ScannedNote,
  // Deposit watching
  useDepositWatcher,
  type PendingDeposit,
  type DepositStatus,
  // Note types
  type Note,
  formatBtc,
} from '@zvault/sdk';

// ============================================================================
// Storage Keys
// ============================================================================

const STORAGE_KEYS = {
  KEYS_DERIVED: 'zvault_keys_derived',
  STEALTH_ADDRESS: 'zvault_stealth_address',
  INBOX_NOTES: 'zvault_inbox_notes',
} as const;

// ============================================================================
// Types
// ============================================================================

/** Inbox note from stealth scanning */
export interface InboxNote extends ScannedNote {
  id: string;
  createdAt: number;
  commitmentHex: string;
}

/** SDK Context state and actions */
interface SDKContextValue {
  // SDK Initialization
  isSDKReady: boolean;

  // Keys
  keys: ZVaultKeys | null;
  stealthMetaAddress: StealthMetaAddress | null;
  stealthAddressEncoded: string | null;
  keysDerived: boolean;
  isDerivingKeys: boolean;
  deriveKeys: () => Promise<void>;
  clearKeys: () => void;

  // Balance
  totalBalance: bigint;
  availableBalance: bigint;

  // Inbox (stealth notes)
  inboxNotes: InboxNote[];
  inboxLoading: boolean;
  inboxError: string | null;
  refreshInbox: () => Promise<void>;

  // Deposit watching
  deposits: PendingDeposit[];
  depositsReady: boolean;
  createDeposit: (amount: bigint) => Promise<PendingDeposit>;
  getDepositsByStatus: (status: DepositStatus) => PendingDeposit[];

  // Connection state
  isConnected: boolean;
  address: string | null;
}

const SDKContext = createContext<SDKContextValue | null>(null);

// ============================================================================
// Provider
// ============================================================================

interface SDKProviderProps {
  children: ReactNode;
  isSDKReady: boolean;
}

export function SDKProvider({ children, isSDKReady }: SDKProviderProps) {
  const { isLoggedIn, addresses, phantom } = usePhantom();

  // Keys state
  const [keys, setKeys] = useState<ZVaultKeys | null>(null);
  const [stealthMetaAddress, setStealthMetaAddress] = useState<StealthMetaAddress | null>(null);
  const [stealthAddressEncoded, setStealthAddressEncoded] = useState<string | null>(null);
  const [isDerivingKeys, setIsDerivingKeys] = useState(false);

  // Inbox state
  const [inboxNotes, setInboxNotes] = useState<InboxNote[]>([]);
  const [inboxLoading, setInboxLoading] = useState(false);
  const [inboxError, setInboxError] = useState<string | null>(null);

  // Deposit watcher hook
  const {
    deposits,
    isReady: depositsReady,
    createDeposit: watcherCreateDeposit,
    getDepositsByStatus,
  } = useDepositWatcher({
    requiredConfirmations: 2,
    callbacks: {
      onConfirmed: (deposit) => {
        console.log('[SDK] Deposit confirmed:', deposit.id);
      },
    },
  });

  // Get Solana address from Phantom
  const solanaAddress = useMemo(() => {
    if (!addresses) return null;
    const addrs = addresses as any;
    if (Array.isArray(addrs)) {
      const found = addrs.find((a: any) => a.chain === 'solana' || a.blockchain === 'solana');
      return found?.address ?? found?.publicKey ?? null;
    }
    return addrs.solana ?? null;
  }, [addresses]);

  // Calculate balances from inbox notes
  const totalBalance = useMemo(() => {
    return inboxNotes.reduce((sum, note) => sum + BigInt(note.amount || 0), 0n);
  }, [inboxNotes]);

  const availableBalance = totalBalance; // All inbox notes are available for now

  // Clear state when wallet disconnects
  useEffect(() => {
    if (!isLoggedIn) {
      setKeys(null);
      setStealthMetaAddress(null);
      setStealthAddressEncoded(null);
      setInboxNotes([]);
      setInboxError(null);
    }
  }, [isLoggedIn]);

  // Load saved keys on mount/address change
  useEffect(() => {
    if (!solanaAddress) return;

    const loadSavedKeys = async () => {
      try {
        const savedAddress = await AsyncStorage.getItem(
          `${STORAGE_KEYS.STEALTH_ADDRESS}_${solanaAddress}`
        );
        if (savedAddress) {
          const meta = decodeStealthMetaAddress(savedAddress);
          setStealthMetaAddress(meta);
          setStealthAddressEncoded(savedAddress);
          // Note: We don't store private keys, user must derive again to get full keys
        }
      } catch (err) {
        console.error('[SDK] Failed to load saved keys:', err);
      }
    };

    loadSavedKeys();
  }, [solanaAddress]);

  // Derive keys from wallet signature
  const deriveKeys = useCallback(async () => {
    if (!phantom || !solanaAddress) return;

    setIsDerivingKeys(true);
    try {
      // Sign the standard derivation message
      const message = new TextEncoder().encode(SPENDING_KEY_DERIVATION_MESSAGE);
      const result = await phantom.providers.solana.signMessage(message);
      const signature = result.signature;

      // Get Solana public key bytes
      const solanaPublicKeyBytes = new Uint8Array(
        Buffer.from(solanaAddress, 'base64').length === 32
          ? Buffer.from(solanaAddress, 'base64')
          : Buffer.from(solanaAddress)
      );

      // Derive keys using SDK
      const derivedKeys = deriveKeysFromSignature(signature, solanaPublicKeyBytes);

      // Create stealth meta-address
      const meta = createStealthMetaAddress(derivedKeys);
      const encoded = encodeStealthMetaAddress(meta);

      // Save to state
      setKeys(derivedKeys);
      setStealthMetaAddress(meta);
      setStealthAddressEncoded(encoded);

      // Persist stealth address (not private keys!)
      await AsyncStorage.setItem(
        `${STORAGE_KEYS.STEALTH_ADDRESS}_${solanaAddress}`,
        encoded
      );
      await AsyncStorage.setItem(
        `${STORAGE_KEYS.KEYS_DERIVED}_${solanaAddress}`,
        'true'
      );

      console.log('[SDK] Keys derived successfully');
    } catch (err) {
      console.error('[SDK] Failed to derive keys:', err);
      throw err;
    } finally {
      setIsDerivingKeys(false);
    }
  }, [phantom, solanaAddress]);

  // Clear keys
  const clearKeys = useCallback(() => {
    setKeys(null);
    setStealthMetaAddress(null);
    setStealthAddressEncoded(null);
    setInboxNotes([]);
    if (solanaAddress) {
      AsyncStorage.removeItem(`${STORAGE_KEYS.KEYS_DERIVED}_${solanaAddress}`);
      AsyncStorage.removeItem(`${STORAGE_KEYS.STEALTH_ADDRESS}_${solanaAddress}`);
    }
  }, [solanaAddress]);

  // Refresh inbox (scan stealth announcements)
  const refreshInbox = useCallback(async () => {
    if (!keys) {
      setInboxNotes([]);
      return;
    }

    setInboxLoading(true);
    setInboxError(null);

    try {
      // In a real app, we'd fetch announcements from Solana RPC
      // For now, load from local storage as a placeholder
      const savedNotes = await AsyncStorage.getItem(
        `${STORAGE_KEYS.INBOX_NOTES}_${solanaAddress}`
      );

      if (savedNotes) {
        const parsed = JSON.parse(savedNotes);
        setInboxNotes(parsed);
      }

      console.log('[SDK] Inbox refreshed');
    } catch (err) {
      console.error('[SDK] Failed to refresh inbox:', err);
      setInboxError(err instanceof Error ? err.message : 'Failed to refresh inbox');
    } finally {
      setInboxLoading(false);
    }
  }, [keys, solanaAddress]);

  // Auto-refresh inbox when keys become available
  useEffect(() => {
    if (keys && !inboxLoading) {
      refreshInbox();
    }
  }, [keys]);

  // Create deposit wrapper
  const createDeposit = useCallback(
    async (amount: bigint): Promise<PendingDeposit> => {
      if (!depositsReady) {
        throw new Error('Deposit watcher not ready');
      }
      return watcherCreateDeposit(amount);
    },
    [depositsReady, watcherCreateDeposit]
  );

  const value: SDKContextValue = {
    // SDK state
    isSDKReady,

    // Keys
    keys,
    stealthMetaAddress,
    stealthAddressEncoded,
    keysDerived: keys !== null || stealthAddressEncoded !== null,
    isDerivingKeys,
    deriveKeys,
    clearKeys,

    // Balance
    totalBalance,
    availableBalance,

    // Inbox
    inboxNotes,
    inboxLoading,
    inboxError,
    refreshInbox,

    // Deposits
    deposits,
    depositsReady,
    createDeposit,
    getDepositsByStatus,

    // Connection
    isConnected: isLoggedIn,
    address: solanaAddress,
  };

  return <SDKContext.Provider value={value}>{children}</SDKContext.Provider>;
}

// ============================================================================
// Hooks
// ============================================================================

/**
 * Main SDK hook - provides full context
 */
export function useSDK(): SDKContextValue {
  const context = useContext(SDKContext);
  if (!context) {
    throw new Error('useSDK must be used within SDKProvider');
  }
  return context;
}

/**
 * Key derivation hook - focused on keys and stealth address
 */
export function useSDKKeys() {
  const ctx = useSDK();
  return {
    keys: ctx.keys,
    stealthMetaAddress: ctx.stealthMetaAddress,
    stealthAddressEncoded: ctx.stealthAddressEncoded,
    keysDerived: ctx.keysDerived,
    isDerivingKeys: ctx.isDerivingKeys,
    deriveKeys: ctx.deriveKeys,
    clearKeys: ctx.clearKeys,
    isConnected: ctx.isConnected,
    address: ctx.address,
  };
}

/**
 * Stealth inbox hook - focused on received notes
 */
export function useStealthInbox() {
  const ctx = useSDK();
  return {
    notes: ctx.inboxNotes,
    totalAmountSats: ctx.totalBalance,
    depositCount: ctx.inboxNotes.length,
    isLoading: ctx.inboxLoading,
    error: ctx.inboxError,
    refresh: ctx.refreshInbox,
    hasKeys: ctx.keysDerived,
  };
}

/**
 * Native deposit hook - focused on BTC deposit watching
 */
export function useNativeDeposit() {
  const ctx = useSDK();
  return {
    deposits: ctx.deposits,
    isReady: ctx.depositsReady,
    createDeposit: ctx.createDeposit,
    getDepositsByStatus: ctx.getDepositsByStatus,
    pendingDeposits: ctx.getDepositsByStatus('waiting'),
    confirmingDeposits: ctx.getDepositsByStatus('confirming'),
    confirmedDeposits: ctx.getDepositsByStatus('confirmed'),
  };
}
