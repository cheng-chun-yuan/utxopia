"use client";

import { useEffect, useRef, useCallback, type JSX } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useBitcoinWalletStore } from "./bitcoin-wallet-store";
import { useAegisStore } from "./aegis-store";

/**
 * Component to hydrate Zustand stores on mount.
 * Handles localStorage restoration, Poseidon initialization,
 * and auto-hydration of Aegis keys from localStorage on wallet connect.
 */
export function StoreHydration(): JSX.Element {
  const hydrateBtcWallet = useBitcoinWalletStore((s) => s._hydrate);
  const initPoseidon = useAegisStore((s) => s.initPoseidon);
  const keys = useAegisStore((s) => s.keys);
  const isPoseidonReady = useAegisStore((s) => s.isPoseidonReady);
  const hydrateKeys = useAegisStore((s) => s.hydrateKeys);
  const hydratePasskeyKeys = useAegisStore((s) => s.hydratePasskeyKeys);
  const inboxLoading = useAegisStore((s) => s.inboxLoading);
  const inboxNotesLength = useAegisStore((s) => s.inboxNotes.length);
  const refreshInbox = useAegisStore((s) => s.refreshInbox);

  const refreshPublicBalance = useAegisStore((s) => s.refreshPublicBalance);
  const { publicKey: walletPubkey } = useWallet();

  // Track if we've already triggered a refresh
  const hasRefreshedRef = useRef(false);
  const hasHydratedRef = useRef(false);

  useEffect(() => {
    // Hydrate Bitcoin wallet from localStorage
    hydrateBtcWallet();

    // Initialize Poseidon for cryptographic operations
    initPoseidon();
  }, [hydrateBtcWallet, initPoseidon]);

  // Auto-hydrate Aegis keys from localStorage when wallet connects
  useEffect(() => {
    if (walletPubkey && isPoseidonReady && !keys && !hasHydratedRef.current) {
      hasHydratedRef.current = true;
      hydrateKeys(walletPubkey);
    }
  }, [walletPubkey, isPoseidonReady, keys, hydrateKeys]);

  // Auto-hydrate passkey keys (no wallet needed)
  useEffect(() => {
    if (isPoseidonReady && !keys && !walletPubkey && !hasHydratedRef.current) {
      hasHydratedRef.current = true;
      hydratePasskeyKeys();
    }
  }, [isPoseidonReady, keys, walletPubkey, hydratePasskeyKeys]);

  // Reset hydration flag when wallet disconnects
  useEffect(() => {
    if (!walletPubkey) {
      hasHydratedRef.current = false;
    }
  }, [walletPubkey]);

  // Auto-refresh inbox when keys become available (ONCE per session)
  useEffect(() => {
    if (keys && !inboxLoading && inboxNotesLength === 0 && !hasRefreshedRef.current) {
      hasRefreshedRef.current = true;
      refreshInbox();
    }
  }, [keys, inboxLoading, inboxNotesLength, refreshInbox]);

  // Reset refresh flag when keys are cleared (user disconnects)
  useEffect(() => {
    if (!keys) {
      hasRefreshedRef.current = false;
    }
  }, [keys]);

  // Auto-refresh balances every 30s when keys are available and page is visible
  const refreshAll = useCallback(() => {
    if (!keys) return;
    refreshInbox();
    if (walletPubkey) refreshPublicBalance(walletPubkey);
  }, [keys, refreshInbox, walletPubkey, refreshPublicBalance]);

  useEffect(() => {
    if (!keys) return;

    const interval = setInterval(() => {
      if (!document.hidden) refreshAll();
    }, 60_000);

    // Also refresh when tab becomes visible after being hidden
    const onVisibility = () => {
      if (!document.hidden) refreshAll();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [keys, refreshAll]);

  return <></>;
}
