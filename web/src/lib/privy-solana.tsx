"use client";

import React, { createContext, useCallback, useContext, useMemo } from "react";
import { PrivyProvider, useLogin, usePrivy } from "@privy-io/react-auth";
import {
  toSolanaWalletConnectors,
  useCreateWallet,
  useSignTransaction,
  useWallets,
  type ConnectedStandardSolanaWallet,
} from "@privy-io/react-auth/solana";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";
import { PublicKey, Transaction } from "@solana/web3.js";
import { getSolanaRpcUrl } from "@/lib/api/constants";

type PrivySolanaAuthority = {
  enabled: boolean;
  ready: boolean;
  authenticated: boolean;
  publicKey: PublicKey | null;
  login: () => Promise<void>;
  ensureWallet: () => Promise<PublicKey | null>;
  signTransaction: (transaction: Transaction) => Promise<Transaction>;
};

type PrivySolanaChain = "solana:mainnet" | "solana:devnet" | "solana:testnet";

const noopAuthority: PrivySolanaAuthority = {
  enabled: false,
  ready: true,
  authenticated: false,
  publicKey: null,
  login: async () => {},
  ensureWallet: async () => null,
  signTransaction: async (transaction) => transaction,
};

const PrivySolanaContext = createContext<PrivySolanaAuthority>(noopAuthority);

function rpcWebsocketUrl(rpcUrl: string): string {
  if (rpcUrl.startsWith("https://")) return rpcUrl.replace("https://", "wss://");
  if (rpcUrl.startsWith("http://")) return rpcUrl.replace("http://", "ws://");
  return rpcUrl;
}

function inferSolanaChain(rpcUrl: string): PrivySolanaChain {
  if (rpcUrl.includes("mainnet")) return "solana:mainnet";
  if (rpcUrl.includes("testnet")) return "solana:testnet";
  return "solana:devnet";
}

function findEmbeddedWallet(wallets: ConnectedStandardSolanaWallet[]) {
  return wallets.find((wallet) => wallet.standardWallet.name === "Privy") ?? wallets[0] ?? null;
}

function PrivySolanaBridge({ children }: { children: React.ReactNode }) {
  const { ready: privyReady, authenticated } = usePrivy();
  const { login } = useLogin();
  const { ready: walletsReady, wallets } = useWallets();
  const { createWallet } = useCreateWallet();
  const { signTransaction } = useSignTransaction();
  const solanaChain = inferSolanaChain(getSolanaRpcUrl());

  const wallet = useMemo(() => findEmbeddedWallet(wallets), [wallets]);
  const publicKey = useMemo(
    () => (wallet?.address ? new PublicKey(wallet.address) : null),
    [wallet],
  );
  const openLogin = useCallback(async () => {
    login();
  }, [login]);

  const ensureWallet = useCallback(async () => {
    if (!authenticated) {
      login();
      return null;
    }

    const currentWallet = findEmbeddedWallet(wallets);
    if (currentWallet?.address) {
      return new PublicKey(currentWallet.address);
    }

    const created = await createWallet({ createAdditional: false });
    const address = created.wallet.address;
    return address ? new PublicKey(address) : null;
  }, [authenticated, createWallet, login, wallets]);

  const signPrivyTransaction = useCallback(
    async (transaction: Transaction) => {
      const signingWallet = findEmbeddedWallet(wallets);
      if (!signingWallet) {
        throw new Error("Privy Solana wallet is not ready");
      }

      const { signedTransaction } = await signTransaction({
        transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }),
        wallet: signingWallet,
        chain: solanaChain,
      });
      return Transaction.from(signedTransaction);
    },
    [signTransaction, solanaChain, wallets],
  );

  const value = useMemo<PrivySolanaAuthority>(
    () => ({
      enabled: true,
      ready: privyReady && walletsReady,
      authenticated,
      publicKey,
      login: openLogin,
      ensureWallet,
      signTransaction: signPrivyTransaction,
    }),
    [authenticated, ensureWallet, openLogin, privyReady, publicKey, signPrivyTransaction, walletsReady],
  );

  return (
    <PrivySolanaContext.Provider value={value}>
      {children}
    </PrivySolanaContext.Provider>
  );
}

export function UtxopiaPrivyProvider({ children }: { children: React.ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const clientId = process.env.NEXT_PUBLIC_PRIVY_CLIENT_ID;

  if (!appId) {
    return (
      <PrivySolanaContext.Provider value={noopAuthority}>
        {children}
      </PrivySolanaContext.Provider>
    );
  }

  const rpcUrl = getSolanaRpcUrl();
  const wsUrl = rpcWebsocketUrl(rpcUrl);
  const solanaChain = inferSolanaChain(rpcUrl);

  return (
    <PrivyProvider
      appId={appId}
      clientId={clientId}
      config={{
        loginMethods: ["passkey", "email", "wallet"],
        appearance: {
          theme: "dark",
          accentColor: "#14F195",
        },
        embeddedWallets: {
          solana: { createOnLogin: "users-without-wallets" },
          showWalletUIs: true,
        },
        externalWallets: {
          solana: { connectors: toSolanaWalletConnectors() },
        },
        solana: {
          rpcs: {
            [solanaChain]: {
              rpc: createSolanaRpc(rpcUrl),
              rpcSubscriptions: createSolanaRpcSubscriptions(wsUrl),
              blockExplorerUrl: "https://explorer.solana.com",
            },
          },
        },
      }}
    >
      <PrivySolanaBridge>{children}</PrivySolanaBridge>
    </PrivyProvider>
  );
}

export function usePrivySolanaAuthority() {
  return useContext(PrivySolanaContext);
}
