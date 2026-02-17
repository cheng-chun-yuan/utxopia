"use client";

// Re-export from Zustand store for backwards compatibility
export { useBitcoinWallet } from "@/stores";

// Re-export types for backwards compatibility
export type { BitcoinWalletState as BitcoinWalletContextType } from "@/stores/bitcoin-wallet-store";

// Legacy provider - now a no-op, kept for backwards compatibility
export function BitcoinWalletProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
