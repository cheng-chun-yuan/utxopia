"use client";

import { create } from "zustand";
import {
  getAddress,
  sendBtcTransaction,
  type GetAddressResponse,
  BitcoinNetworkType,
  AddressPurpose,
} from "sats-connect";

const NETWORK = BitcoinNetworkType.Testnet;

export interface BitcoinWalletState {
  // Connection state
  connected: boolean;
  connecting: boolean;
  address: string | null;
  publicKey: string | null;
  balance: number | null;
  error: string | null;

  // Actions
  connect: () => Promise<void>;
  disconnect: () => void;
  sendBtc: (toAddress: string, amountSats: number) => Promise<string>;
  refreshBalance: () => Promise<void>;
  clearError: () => void;
  _hydrate: () => void;
}

async function fetchBalance(addr: string): Promise<number | null> {
  try {
    const response = await fetch(
      `https://mempool.space/testnet/api/address/${addr}`
    );
    if (response.ok) {
      const data = await response.json();
      const confirmed =
        (data.chain_stats?.funded_txo_sum || 0) -
        (data.chain_stats?.spent_txo_sum || 0);
      const unconfirmed =
        (data.mempool_stats?.funded_txo_sum || 0) -
        (data.mempool_stats?.spent_txo_sum || 0);
      return confirmed + unconfirmed;
    }
  } catch (err) {
    console.error("Failed to fetch balance:", err);
  }
  return null;
}

export const useBitcoinWalletStore = create<BitcoinWalletState>((set, get) => ({
  connected: false,
  connecting: false,
  address: null,
  publicKey: null,
  balance: null,
  error: null,

  _hydrate: () => {
    if (typeof window === "undefined") return;
    const savedAddress = localStorage.getItem("btc_wallet_address");
    const savedPubKey = localStorage.getItem("btc_wallet_pubkey");
    if (savedAddress && savedPubKey) {
      set({
        address: savedAddress,
        publicKey: savedPubKey,
        connected: true,
      });
      fetchBalance(savedAddress).then((balance) => {
        if (balance !== null) set({ balance });
      });
    }
  },

  connect: async () => {
    set({ connecting: true, error: null });

    try {
      await getAddress({
        payload: {
          purposes: [AddressPurpose.Payment, AddressPurpose.Ordinals],
          message: "Connect to zVault for BTC deposits",
          network: { type: NETWORK },
        },
        onFinish: async (response: GetAddressResponse) => {
          const paymentAddr = response.addresses.find(
            (a) => a.purpose === AddressPurpose.Payment
          );

          if (paymentAddr) {
            localStorage.setItem("btc_wallet_address", paymentAddr.address);
            localStorage.setItem("btc_wallet_pubkey", paymentAddr.publicKey);

            const balance = await fetchBalance(paymentAddr.address);

            set({
              address: paymentAddr.address,
              publicKey: paymentAddr.publicKey,
              connected: true,
              connecting: false,
              balance,
            });
          }
        },
        onCancel: () => {
          set({ error: "Connection cancelled by user", connecting: false });
        },
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to connect wallet";
      set({ error: message, connecting: false });
      console.error("Bitcoin wallet connection error:", err);
    }
  },

  disconnect: () => {
    localStorage.removeItem("btc_wallet_address");
    localStorage.removeItem("btc_wallet_pubkey");
    set({
      connected: false,
      address: null,
      publicKey: null,
      balance: null,
    });
  },

  refreshBalance: async () => {
    const { address } = get();
    if (address) {
      const balance = await fetchBalance(address);
      if (balance !== null) set({ balance });
    }
  },

  sendBtc: async (toAddress: string, amountSats: number): Promise<string> => {
    const { connected, address } = get();
    if (!connected || !address) {
      throw new Error("Wallet not connected");
    }

    return new Promise((resolve, reject) => {
      sendBtcTransaction({
        payload: {
          network: { type: NETWORK },
          recipients: [{ address: toAddress, amountSats: BigInt(amountSats) }],
          senderAddress: address,
        },
        onFinish: (txid) => resolve(txid),
        onCancel: () => reject(new Error("Transaction cancelled by user")),
      });
    });
  },

  clearError: () => set({ error: null }),
}));

// Hook for backwards compatibility
export function useBitcoinWallet() {
  return useBitcoinWalletStore();
}
