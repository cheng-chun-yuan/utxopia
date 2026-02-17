"use client";

import React, { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { Toaster } from "sonner";
import { StoreHydration } from "@/stores";
import { HELIUS_RPC_DEVNET } from "@/lib/helius";

// Debug: Log RPC endpoint being used
if (typeof window !== "undefined") {
  console.log("[RPC] Endpoint:", HELIUS_RPC_DEVNET);
}

// Import wallet adapter CSS
import "@solana/wallet-adapter-react-ui/styles.css";

/**
 * Simplified providers - only Solana wallet adapter requires React Context.
 * All other state (Bitcoin wallet, zVault keys, notes) is managed by Zustand stores.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  // Helius primary (supports getProgramAccounts), fallback to configured RPC
  const endpoint = useMemo(
    () => HELIUS_RPC_DEVNET || process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com",
    []
  );

  // Configure supported wallets
  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter(),
      // Add more wallets as needed
      // new SolflareWalletAdapter(),
    ],
    []
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          {/* Hydrate Zustand stores (Bitcoin wallet, Poseidon) */}
          <StoreHydration />
          {children}
          <Toaster
            position="top-right"
            toastOptions={{
              style: {
                background: "var(--muted)",
                border: "1px solid rgba(139, 138, 158, 0.15)",
                color: "var(--color-gray-light)",
              },
              classNames: {
                success: "!border-privacy/30 !bg-privacy/10",
                error: "!border-error/30 !bg-error/10",
                warning: "!border-warning-alt/30 !bg-warning-alt/10",
              },
            }}
          />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
