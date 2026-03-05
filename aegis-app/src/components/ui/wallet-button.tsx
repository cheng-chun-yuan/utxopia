"use client";

import { useState, useEffect } from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

interface WalletButtonProps {
  className?: string;
}

/**
 * Client-side only wallet button wrapper
 * Fixes hydration mismatch by only rendering after mount
 */
export function WalletButton({ className = "" }: WalletButtonProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <button className={className} disabled>
        Select Wallet
      </button>
    );
  }

  return <WalletMultiButton className={className} />;
}
