"use client";

import { useCallback, useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useConnection } from "@solana/wallet-adapter-react";
import { useZVaultStore, type InboxNote } from "@/stores";

// Re-export types
export type { InboxNote };

/**
 * Full zVault hook - wraps Zustand store with wallet integration.
 * Maintains backwards compatibility with the old context-based API.
 *
 * NOTE: Auto-refresh of inbox is handled in StoreHydration (renders once).
 * This hook just provides wallet-aware wrappers for store actions.
 */
export function useZVault() {
  const wallet = useWallet();
  const { connection } = useConnection();
  const store = useZVaultStore();

  // Wrap deriveKeys to automatically use wallet
  const deriveKeys = useCallback(async () => {
    if (!wallet.connected || !wallet.signMessage || !wallet.publicKey) {
      return;
    }
    await store.deriveKeys({
      publicKey: wallet.publicKey,
      signMessage: wallet.signMessage,
    });
  }, [wallet.connected, wallet.signMessage, wallet.publicKey, store.deriveKeys]);

  // Wrap refreshInbox to automatically use connection
  const refreshInbox = useCallback(async () => {
    await store.refreshInbox(connection);
  }, [connection, store.refreshInbox]);

  // Clear keys when wallet disconnects
  useEffect(() => {
    if (!wallet.connected) {
      store.clearKeys();
    }
  }, [wallet.connected, store.clearKeys]);

  return {
    // Poseidon
    isPoseidonReady: store.isPoseidonReady,

    // Keys
    keys: store.keys,
    stealthAddress: store.stealthAddress,
    stealthAddressEncoded: store.stealthAddressEncoded,
    isLoading: store.isLoading,
    error: store.error,
    deriveKeys,
    clearKeys: store.clearKeys,
    hasKeys: store.hasKeys,
    isWalletConnected: wallet.connected,

    // Inbox
    inboxNotes: store.inboxNotes,
    inboxTotalSats: store.inboxTotalSats,
    inboxDepositCount: store.inboxDepositCount,
    inboxLoading: store.inboxLoading,
    inboxError: store.inboxError,
    refreshInbox,
  };
}

/**
 * Just keys (backwards compatible)
 */
export function useZVaultKeys() {
  const ctx = useZVault();
  return {
    keys: ctx.keys,
    stealthAddress: ctx.stealthAddress,
    stealthAddressEncoded: ctx.stealthAddressEncoded,
    isLoading: ctx.isLoading,
    error: ctx.error,
    deriveKeys: ctx.deriveKeys,
    clearKeys: ctx.clearKeys,
    hasKeys: ctx.hasKeys,
    isWalletConnected: ctx.isWalletConnected,
  };
}

/**
 * Just inbox (backwards compatible)
 */
export function useStealthInbox() {
  const ctx = useZVault();
  return {
    notes: ctx.inboxNotes,
    totalAmountSats: ctx.inboxTotalSats,
    depositCount: ctx.inboxDepositCount,
    isLoading: ctx.inboxLoading,
    error: ctx.inboxError,
    refresh: ctx.refreshInbox,
    hasKeys: ctx.hasKeys,
  };
}

// Legacy provider - now a no-op, kept for backwards compatibility
export function ZVaultProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
