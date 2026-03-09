"use client";

import { useState, useEffect } from "react";

/**
 * Returns true when the user is on a mobile browser without a BTC wallet provider injected.
 * This means they're in Safari/Chrome (not a wallet's in-app browser).
 */
export function useIsMobileWithoutWallet(): boolean {
  const [result, setResult] = useState(false);

  useEffect(() => {
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (!isMobile) {
      setResult(false);
      return;
    }

    const hasXverse = !!(window as any).XverseProviders?.BitcoinProvider;
    const hasUnisat = !!(window as any).unisat;
    const hasLeather = !!(window as any).LeatherProvider;

    setResult(!hasXverse && !hasUnisat && !hasLeather);
  }, []);

  return result;
}
