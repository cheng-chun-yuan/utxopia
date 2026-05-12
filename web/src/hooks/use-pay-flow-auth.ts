"use client";

import { useState, useEffect, useRef } from "react";
import { usePasskey } from "@/hooks/use-passkey";
import { useUTXOpiaStore } from "@/stores/utxopia-store";

export function usePayFlowAuth(hasKeys: boolean) {
  const {
    isSupported: passkeySupported,
    hasCredential: hasPasskeyCredential,
    isLoading: passkeyLoading,
    error: passkeyError,
    register: registerPasskey,
    authenticate: authenticatePasskey,
  } = usePasskey();
  const deriveKeysFromPasskeySeed = useUTXOpiaStore((s) => s.deriveKeysFromPasskeySeed);
  const [authModalOpen, setAuthModalOpen] = useState(false);

  const handlePasskeyRegister = async () => {
    const seed = await registerPasskey();
    if (seed) {
      await deriveKeysFromPasskeySeed(seed);
      setAuthModalOpen(false);
    }
  };

  const handlePasskeyAuthenticate = async () => {
    const seed = await authenticatePasskey();
    if (seed) {
      await deriveKeysFromPasskeySeed(seed);
      setAuthModalOpen(false);
    }
  };

  // Auto-open auth modal when no keys
  const authAutoOpenedRef = useRef(false);
  useEffect(() => {
    if (!hasKeys && !authAutoOpenedRef.current) {
      authAutoOpenedRef.current = true;
      setAuthModalOpen(true);
    }
    if (hasKeys) authAutoOpenedRef.current = false;
  }, [hasKeys]);

  return {
    authModalOpen,
    setAuthModalOpen,
    passkeySupported,
    hasPasskeyCredential,
    passkeyLoading,
    passkeyError,
    handlePasskeyRegister,
    handlePasskeyAuthenticate,
  };
}
