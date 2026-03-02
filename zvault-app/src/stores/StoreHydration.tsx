"use client";

import { useEffect, useRef, type JSX } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useBitcoinWalletStore } from "./bitcoin-wallet-store";
import { useZVaultStore } from "./zvault-store";

/**
 * Component to hydrate Zustand stores on mount.
 * Handles localStorage restoration, Poseidon initialization,
 * and auto-hydration of zVault keys from localStorage on wallet connect.
 */
export function StoreHydration(): JSX.Element {
  const hydrateBtcWallet = useBitcoinWalletStore((s) => s._hydrate);
  const initPoseidon = useZVaultStore((s) => s.initPoseidon);
  const keys = useZVaultStore((s) => s.keys);
  const isPoseidonReady = useZVaultStore((s) => s.isPoseidonReady);
  const hydrateKeys = useZVaultStore((s) => s.hydrateKeys);
  const inboxLoading = useZVaultStore((s) => s.inboxLoading);
  const inboxNotesLength = useZVaultStore((s) => s.inboxNotes.length);
  const refreshInbox = useZVaultStore((s) => s.refreshInbox);

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

  // Auto-hydrate zVault keys from localStorage when wallet connects
  useEffect(() => {
    if (walletPubkey && isPoseidonReady && !keys && !hasHydratedRef.current) {
      hasHydratedRef.current = true;
      hydrateKeys(walletPubkey);
    }
  }, [walletPubkey, isPoseidonReady, keys, hydrateKeys]);

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

  return <></>;
}
