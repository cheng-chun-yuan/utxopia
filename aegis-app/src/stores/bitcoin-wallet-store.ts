"use client";

import { create } from "zustand";
import {
  getAddress,
  sendBtcTransaction,
  signTransaction,
  type GetAddressResponse,
  AddressPurpose,
} from "sats-connect";
import {
  getSatsConnectNetwork,
  getUnisatChain,
  getUnisatFallbackNetwork,
  getEsploraApiUrl,
} from "@/lib/btc-network";

export type BtcWalletType = "sats-connect" | "unisat";

declare global {
  interface Window {
    unisat?: {
      requestAccounts(): Promise<string[]>;
      getAccounts(): Promise<string[]>;
      getPublicKey(): Promise<string>;
      switchNetwork(network: string): Promise<void>;
      switchChain(chain: string): Promise<void>;
      signPsbt(psbtHex: string, options?: any): Promise<string>;
      getNetwork(): Promise<string>;
      getChain(): Promise<{ enum: string; name: string; network: string }>;
    };
  }
}

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
  walletType: BtcWalletType | null;

  // Actions
  connect: (type: BtcWalletType) => Promise<void>;
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
      `${getEsploraApiUrl()}/address/${addr}`
    );
    if (response.ok) {
      const data = await response.json();
      const confirmed =
        (data.chain_stats?.funded_txo_sum || 0) -
        (data.chain_stats?.spent_txo_sum || 0);
      return confirmed;
    }
  } catch {
    // Network errors are expected when mempool API is unreachable
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
  walletType: null,

  _hydrate: () => {
    if (typeof window === "undefined") return;
    const savedAddress = localStorage.getItem("btc_wallet_address");
    const savedPubKey = localStorage.getItem("btc_wallet_pubkey");
    const savedType = localStorage.getItem("btc_wallet_type") as BtcWalletType | null;
    if (savedAddress && savedPubKey) {
      set({
        address: savedAddress,
        publicKey: savedPubKey,
        walletType: savedType,
        connected: true,
      });
      fetchBalance(savedAddress).then((balance) => {
        if (balance !== null) set({ balance });
      });
    }
  },

  connect: async (type: BtcWalletType) => {
    set({ connecting: true, error: null });

    try {
      if (type === "unisat") {
        if (!window.unisat) {
          throw new Error("UniSat wallet not installed");
        }

        // Use switchChain for testnet4 support (switchNetwork only supports testnet3)
        if (window.unisat.switchChain) {
          await window.unisat.switchChain(getUnisatChain());
        } else {
          await window.unisat.switchNetwork(getUnisatFallbackNetwork());
        }
        const accounts = await window.unisat.requestAccounts();
        const address = accounts[0];
        if (!address) throw new Error("No accounts returned from UniSat");

        const publicKey = await window.unisat.getPublicKey();
        const balance = await fetchBalance(address);

        localStorage.setItem("btc_wallet_address", address);
        localStorage.setItem("btc_wallet_pubkey", publicKey);
        localStorage.setItem("btc_wallet_type", "unisat");

        set({
          address,
          publicKey,
          connected: true,
          connecting: false,
          walletType: "unisat",
          balance,
        });
      } else {
        // sats-connect (Xverse / Leather)
        await getAddress({
          payload: {
            purposes: [AddressPurpose.Payment, AddressPurpose.Ordinals],
            message: "Connect to Privacy Coin for BTC deposits",
            network: { type: getSatsConnectNetwork() },
          },
          onFinish: async (response: GetAddressResponse) => {
            const paymentAddr = response.addresses.find(
              (a) => a.purpose === AddressPurpose.Payment
            );

            if (paymentAddr) {
              localStorage.setItem("btc_wallet_address", paymentAddr.address);
              localStorage.setItem("btc_wallet_pubkey", paymentAddr.publicKey);
              localStorage.setItem("btc_wallet_type", "sats-connect");

              const balance = await fetchBalance(paymentAddr.address);

              set({
                address: paymentAddr.address,
                publicKey: paymentAddr.publicKey,
                connected: true,
                connecting: false,
                walletType: "sats-connect",
                balance,
              });
            }
          },
          onCancel: () => {
            set({ error: "Connection cancelled by user", connecting: false });
          },
        });
      }
    } catch (err) {
      let message: string;
      if (err instanceof Error) {
        message = err.message;
      } else if (typeof err === "string") {
        message = err;
      } else if (typeof err === "object" && err !== null) {
        const obj = err as Record<string, unknown>;
        if (Object.keys(obj).length === 0) {
          // sats-connect throws empty {} when no wallet provider is found
          message = type === "sats-connect"
            ? "No compatible Bitcoin wallet found. Install Xverse or Leather extension."
            : "No compatible Bitcoin wallet found. Install UniSat extension.";
        } else {
          // Some wallets throw { message: "..." } or { error: "..." } objects
          message = (typeof obj.message === "string" && obj.message)
            || (typeof obj.error === "string" && obj.error)
            || JSON.stringify(err);
        }
      } else {
        message = "Failed to connect wallet";
      }
      set({ error: message, connecting: false });
      console.error("Bitcoin wallet connection error:", message);
    }
  },

  disconnect: () => {
    localStorage.removeItem("btc_wallet_address");
    localStorage.removeItem("btc_wallet_pubkey");
    localStorage.removeItem("btc_wallet_type");
    set({
      connected: false,
      address: null,
      publicKey: null,
      balance: null,
      walletType: null,
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
          network: { type: getSatsConnectNetwork() },
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
      `${getEsploraApiUrl()}/address/${address}/utxo`
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
          `${getEsploraApiUrl()}/tx/${txid}`
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
    const { connected, address, walletType } = get();
    if (!connected || !address) throw new Error("Wallet not connected");

    // Parse PSBT to count inputs for signing all of them
    const { Transaction } = await import("@scure/btc-signer");
    const parsedPsbtBytes = Uint8Array.from(atob(psbtBase64), (c) => c.charCodeAt(0));
    const parsedTx = Transaction.fromPSBT(parsedPsbtBytes, { allowUnknownOutputs: true });
    const inputCount = parsedTx.inputsLength;
    const signingIndexes = Array.from({ length: inputCount }, (_, i) => i);

    if (walletType === "unisat") {
      if (!window.unisat) throw new Error("UniSat wallet not available");

      // Convert base64 PSBT to hex for UniSat
      const psbtHex = Array.from(parsedPsbtBytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      // Sign via UniSat with autoFinalized — wallet handles finalization
      const signedPsbtHex = await window.unisat.signPsbt(psbtHex, {
        autoFinalized: true,
      });

      // Extract raw tx from finalized PSBT (no need to call finalize())
      const signedBytes = new Uint8Array(
        signedPsbtHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16))
      );
      const tx = Transaction.fromPSBT(signedBytes, { allowUnknownOutputs: true, allowUnknownInputs: true });
      const rawTxHex = Array.from(tx.extract())
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      // Broadcast via mempool.space
      const broadcastRes = await fetch(`${getEsploraApiUrl()}/tx`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: rawTxHex,
      });

      if (!broadcastRes.ok) {
        const errText = await broadcastRes.text();
        throw new Error(`Broadcast failed: ${errText}`);
      }

      const txid = await broadcastRes.text();
      return { txid: txid.trim() };
    } else {
      // sats-connect (Xverse / Leather): let wallet broadcast directly
      const txid = await new Promise<string>((resolve, reject) => {
        signTransaction({
          payload: {
            network: { type: getSatsConnectNetwork() },
            psbtBase64,
            message: "Sign Privacy Coin deposit transaction",
            broadcast: true,
            inputsToSign: [
              {
                address,
                signingIndexes,
              },
            ],
          },
          onFinish: (response: any) => {
            // With broadcast: true, response contains txid
            resolve(typeof response === "string" ? response : response.txid || response);
          },
          onCancel: () => reject(new Error("PSBT signing cancelled by user")),
        });
      });

      return { txid: txid.trim() };
    }
  },

  clearError: () => set({ error: null }),
}));

// Hook for backwards compatibility
export function useBitcoinWallet() {
  return useBitcoinWalletStore();
}
