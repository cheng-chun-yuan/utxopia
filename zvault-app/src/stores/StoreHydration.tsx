"use client";

import { useEffect, useRef, type JSX } from "react";
import { useBitcoinWalletStore } from "./bitcoin-wallet-store";
import { useZVaultStore } from "./zvault-store";

/**
 * Component to hydrate Zustand stores on mount.
 * Handles localStorage restoration and Poseidon initialization.
 * Also handles auto-refresh of inbox when keys become available (ONCE).
 */
export function StoreHydration(): JSX.Element {
  const hydrateBtcWallet = useBitcoinWalletStore((s) => s._hydrate);
  const initPoseidon = useZVaultStore((s) => s.initPoseidon);
  const keys = useZVaultStore((s) => s.keys);
  const inboxLoading = useZVaultStore((s) => s.inboxLoading);
  const inboxNotesLength = useZVaultStore((s) => s.inboxNotes.length);
  const refreshInbox = useZVaultStore((s) => s.refreshInbox);

  // Track if we've already triggered a refresh
  const hasRefreshedRef = useRef(false);

  useEffect(() => {
    // Hydrate Bitcoin wallet from localStorage
    hydrateBtcWallet();

    // Initialize Poseidon for cryptographic operations
    initPoseidon();
  }, [hydrateBtcWallet, initPoseidon]);

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
