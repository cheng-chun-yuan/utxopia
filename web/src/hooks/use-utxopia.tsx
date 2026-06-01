"use client";

import { useCallback, useEffect, useMemo } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useConnection } from "@solana/wallet-adapter-react";
import { useUTXOpiaStore, type InboxNote } from "@/stores";

// Re-export types
export type { InboxNote };

/**
 * Full UTXOpia hook - wraps Zustand store with wallet integration.
 *
 * NOTE: Auto-refresh of inbox is handled in StoreHydration (renders once).
 * This hook just provides wallet-aware wrappers for store actions.
 */
export function useUTXOpia() {
  const wallet = useWallet();
  const { connection } = useConnection();
  const store = useUTXOpiaStore();

  // Wrap deriveKeys to automatically use wallet
  const deriveKeys = useCallback(async () => {
    if (!wallet.connected || !wallet.signMessage || !wallet.publicKey) {
      return;
    }
    await store.deriveKeys({
      publicKey: wallet.publicKey,
      signMessage: wallet.signMessage,
    });
  }, [wallet.connected, wallet.signMessage, wallet.publicKey, store]);

  // Wrap refreshInbox to automatically use connection
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const refreshInbox = useCallback(async (_conn?: unknown, force?: boolean) => {
    await store.refreshInbox(connection, force);
  }, [connection, store]);

  // Refresh public zkBTC balance when wallet is connected
  useEffect(() => {
    if (wallet.publicKey) {
      store.refreshPublicBalance(wallet.publicKey);
    }
  }, [wallet.publicKey, store]);

  // Clear keys when wallet disconnects — but only if using wallet auth (not passkey)
  // Passkey-derived keys have solanaPublicKey set to all zeros
  useEffect(() => {
    if (!wallet.connected && store.keys?.solanaPublicKey.some(b => b !== 0)) {
      store.clearKeys(wallet.publicKey?.toBase58());
    }
  }, [wallet.connected, wallet.publicKey, store]);

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
    inboxBalancesByToken: store.inboxBalancesByToken,
    inboxDepositCount: store.inboxDepositCount,
    inboxLoading: store.inboxLoading,
    inboxError: store.inboxError,
    refreshInbox,

    // Public zkBTC balance
    publicZkbtcBalance: store.publicZkbtcBalance,
    refreshPublicBalance: store.refreshPublicBalance,
  };
}

/** Keys-only subset of useUTXOpia() */
export function useUTXOpiaKeys() {
  const ctx = useUTXOpia();
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

/** Inbox-only subset of useUTXOpia() */
export function useStealthInbox() {
  const ctx = useUTXOpia();
  return {
    notes: ctx.inboxNotes,
    totalAmountSats: ctx.inboxTotalSats,
    balancesByToken: ctx.inboxBalancesByToken,
    depositCount: ctx.inboxDepositCount,
    isLoading: ctx.inboxLoading,
    error: ctx.inboxError,
    refresh: ctx.refreshInbox,
    hasKeys: ctx.hasKeys,
  };
}

/**
 * Get available (unspent, non-zero) notes filtered by token symbol.
 * Reusable across pay-flow, vault activity, and any component that needs
 * token-specific note balances.
 *
 * @param tokenSymbol - The shielded token symbol (e.g. "zkBTC", "zkSOL", "zkUSDC")
 */
export function useTokenNotes(tokenSymbol: string) {
  const { inboxNotes, inboxLoading } = useUTXOpia();

  const availableNotes = useMemo(() => {
    return inboxNotes.filter(
      (n) => n.amount > 0n && !n.isSpent && n.tokenSymbol === tokenSymbol
    );
  }, [inboxNotes, tokenSymbol]);

  const totalBalance = useMemo(() => {
    return availableNotes.reduce((sum, n) => sum + Number(n.amount), 0);
  }, [availableNotes]);

  return { availableNotes, totalBalance, isLoading: inboxLoading };
}
