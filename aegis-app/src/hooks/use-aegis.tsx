"use client";

import { useCallback, useEffect, useMemo } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useConnection } from "@solana/wallet-adapter-react";
import { useAegisStore, type InboxNote } from "@/stores";

// Re-export types
export type { InboxNote };

/**
 * Full Aegis hook - wraps Zustand store with wallet integration.
 *
 * NOTE: Auto-refresh of inbox is handled in StoreHydration (renders once).
 * This hook just provides wallet-aware wrappers for store actions.
 */
export function useAegis() {
  const wallet = useWallet();
  const { connection } = useConnection();
  const store = useAegisStore();

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

  // Refresh public zkBTC balance when wallet is connected
  useEffect(() => {
    if (wallet.publicKey) {
      store.refreshPublicBalance(wallet.publicKey);
    }
  }, [wallet.publicKey, store.refreshPublicBalance]);

  // Clear keys when wallet disconnects — but only if using wallet auth (not passkey)
  // Passkey-derived keys have solanaPublicKey set to all zeros
  useEffect(() => {
    if (!wallet.connected && store.keys?.solanaPublicKey.some(b => b !== 0)) {
      store.clearKeys(wallet.publicKey?.toBase58());
    }
  }, [wallet.connected, wallet.publicKey, store.clearKeys, store.keys]);

  return {
    // Poseidon
    isPoseidonReady: store.isPoseidonReady,

    // Keys
    keys: store.keys,
    isViewOnly: store.isViewOnly,
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

    // Public zkBTC balance
    publicZkbtcBalance: store.publicZkbtcBalance,
    refreshPublicBalance: store.refreshPublicBalance,
  };
}

/**
 * Just keys (backwards compatible)
 */
export function useAegisKeys() {
  const ctx = useAegis();
  return {
    keys: ctx.keys,
    isViewOnly: ctx.isViewOnly,
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
  const ctx = useAegis();
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
