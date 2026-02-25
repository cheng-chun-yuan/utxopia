"use client";

import { create } from "zustand";
import {
  getAddress,
  sendBtcTransaction,
  signTransaction,
  type GetAddressResponse,
  BitcoinNetworkType,
  AddressPurpose,
} from "sats-connect";

const NETWORK = BitcoinNetworkType.Testnet;

/** UTXO descriptor for the connected wallet */
export interface WalletUtxo {
  txid: string;
  vout: number;
  value: number;
  scriptPubkeyHex: string;
}

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

  /** Fetch confirmed UTXOs for the connected payment address */
  getPaymentUtxos: () => Promise<WalletUtxo[]>;

  /** Sign a PSBT via the connected wallet, then broadcast via mempool.space */
  signAndBroadcastPsbt: (psbtBase64: string) => Promise<{ txid: string }>;
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

  getPaymentUtxos: async (): Promise<WalletUtxo[]> => {
    const { address } = get();
    if (!address) throw new Error("Wallet not connected");

    // Fetch UTXOs from mempool.space
    const res = await fetch(
      `https://mempool.space/testnet/api/address/${address}/utxo`
    );
    if (!res.ok) throw new Error(`Failed to fetch UTXOs: ${res.statusText}`);

    const utxos: Array<{
      txid: string;
      vout: number;
      value: number;
      status: { confirmed: boolean };
    }> = await res.json();

    // Filter to confirmed only, then fetch scriptPubkey for each tx
    const confirmed = utxos.filter((u) => u.status.confirmed);
    const txidSet = new Set(confirmed.map((u) => u.txid));
    const txCache = new Map<string, any>();

    await Promise.all(
      [...txidSet].map(async (txid) => {
        const txRes = await fetch(
          `https://mempool.space/testnet/api/tx/${txid}`
        );
        if (txRes.ok) txCache.set(txid, await txRes.json());
      })
    );

    return confirmed
      .map((u) => {
        const tx = txCache.get(u.txid);
        const output = tx?.vout?.[u.vout];
        return {
          txid: u.txid,
          vout: u.vout,
          value: u.value,
          scriptPubkeyHex: output?.scriptpubkey ?? "",
        };
      })
      .filter((u) => u.scriptPubkeyHex.length > 0);
  },

  signAndBroadcastPsbt: async (psbtBase64: string): Promise<{ txid: string }> => {
    const { connected, address } = get();
    if (!connected || !address) throw new Error("Wallet not connected");

    // Sign via sats-connect
    const signedPsbtBase64 = await new Promise<string>((resolve, reject) => {
      signTransaction({
        payload: {
          network: { type: NETWORK },
          psbtBase64,
          message: "Sign zVault deposit transaction",
          broadcast: false,
          inputsToSign: [
            {
              address,
              signingIndexes: [0], // Sign all inputs from this address
            },
          ],
        },
        onFinish: (response: any) => {
          resolve(response.psbtBase64);
        },
        onCancel: () => reject(new Error("PSBT signing cancelled by user")),
      });
    });

    // Decode the signed PSBT to get raw tx hex for broadcast
    // The wallet returns a signed PSBT; we need to finalize and extract
    const { Transaction } = await import("@scure/btc-signer");
    const psbtBytes = Uint8Array.from(atob(signedPsbtBase64), (c) =>
      c.charCodeAt(0)
    );
    const tx = Transaction.fromPSBT(psbtBytes);
    tx.finalize();
    const rawTxHex = Array.from(tx.extract())
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Broadcast via mempool.space
    const broadcastRes = await fetch(
      "https://mempool.space/testnet/api/tx",
      {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: rawTxHex,
      }
    );

    if (!broadcastRes.ok) {
      const errText = await broadcastRes.text();
      throw new Error(`Broadcast failed: ${errText}`);
    }

    const txid = await broadcastRes.text();
    return { txid: txid.trim() };
  },

  clearError: () => set({ error: null }),
}));

// Hook for backwards compatibility
export function useBitcoinWallet() {
  return useBitcoinWalletStore();
}
