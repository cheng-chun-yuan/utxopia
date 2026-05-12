"use client";

import { useState } from "react";
import { BTC_DUST_LIMIT } from "@/lib/btc-constants";
import {
  bytesToHex,
  buildDepositPsbt,
  UTXOpiaClient,
  type StealthMetaAddress,
} from "@utxopia/sdk";
import { useBitcoinWalletStore } from "@/stores/bitcoin-wallet-store";
import type { WalletUtxo } from "@/stores/bitcoin-wallet-store";
import { useNotesStore } from "@/stores/notes-store";
import { registerDeposit } from "@/lib/api/deposits";
import { getBtcSignerNetwork } from "@/lib/btc-network";
import { notifyError } from "@/lib/notifications";

export interface DepositPreview {
  depositAddress: string;
  depositAmountSats: number;
  opReturnHex: string;
  opReturnPayload: Uint8Array;
  cachedUtxos: WalletUtxo[];
}

export interface DepositResult {
  txid: string;
  depositAddress: string;
  opReturnHex: string;
}

export function useDepositFlow() {
  const btcWallet = useBitcoinWalletStore();

  // Recipient
  const [resolvedMeta, setResolvedMeta] = useState<StealthMetaAddress | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Amount
  const [walletDepositAmount, setWalletDepositAmount] = useState("10000");

  // Preview (after buildTxPreview, before signing)
  const [depositPreview, setDepositPreview] = useState<DepositPreview | null>(null);
  const [buildingPreview, setBuildingPreview] = useState(false);

  // Coin control
  const [selectedUtxoKeys, setSelectedUtxoKeys] = useState<Set<string>>(new Set());

  // Signing
  const [walletDepositing, setWalletDepositing] = useState(false);

  // Result
  const [walletDepositResult, setWalletDepositResult] = useState<DepositResult | null>(null);

  const resetFlow = () => {
    setError(null);
    setResolvedMeta(null);
    setWalletDepositAmount("10000");
    setWalletDepositResult(null);
    setDepositPreview(null);
  };

  /** Step 1: Generate deposit info + fetch UTXOs in parallel */
  const buildTxPreview = async () => {
    if (!resolvedMeta || !btcWallet.connected) return;

    const amountSats = parseInt(walletDepositAmount);
    if (!amountSats || amountSats < BTC_DUST_LIMIT) {
      notifyError(`Amount must be at least ${BTC_DUST_LIMIT} sats`);
      return;
    }

    setBuildingPreview(true);
    setError(null);
    setDepositPreview(null);

    try {
      const client = UTXOpiaClient.instance();
      const [deposit, utxos] = await Promise.all([
        client.prepareDeposit({ recipient: resolvedMeta }),
        btcWallet.getPaymentUtxos(),
      ]);

      if (utxos.length === 0) {
        throw new Error("No confirmed UTXOs available in wallet");
      }

      const autoSelected = client.selectUtxos(
        utxos.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, scriptPubkeyHex: u.scriptPubkeyHex })),
        amountSats,
        2,
      );
      setSelectedUtxoKeys(new Set(autoSelected.map((u) => `${u.txid}:${u.vout}`)));

      setDepositPreview({
        depositAddress: deposit.btcAddress,
        depositAmountSats: amountSats,
        opReturnHex: bytesToHex(deposit.opReturnPayload),
        opReturnPayload: deposit.opReturnPayload,
        cachedUtxos: utxos,
      });
    } catch (err) {
      console.error("Preview build error:", err);
      setError(err instanceof Error ? err.message : "Failed to generate deposit");
    } finally {
      setBuildingPreview(false);
    }
  };

  /** Step 2: Build PSBT from cached UTXOs, sign, and broadcast */
  const confirmAndSign = async () => {
    if (!depositPreview) return;

    setWalletDepositing(true);
    setError(null);

    try {
      const selected = depositPreview.cachedUtxos
        .filter((u) => selectedUtxoKeys.has(`${u.txid}:${u.vout}`))
        .map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, scriptPubkeyHex: u.scriptPubkeyHex }));

      if (selected.length === 0) {
        throw new Error("No UTXOs selected");
      }

      const totalSelected = selected.reduce((sum, u) => sum + u.value, 0);
      if (totalSelected < depositPreview.depositAmountSats) {
        throw new Error(`Selected UTXOs (${totalSelected} sats) insufficient for deposit (${depositPreview.depositAmountSats} sats)`);
      }

      const psbtResult = buildDepositPsbt({
        senderUtxos: selected,
        depositAddress: depositPreview.depositAddress,
        depositAmountSats: depositPreview.depositAmountSats,
        opReturnPayload: depositPreview.opReturnPayload,
        changeAddress: btcWallet.address!,
        feeRate: 2,
        network: getBtcSignerNetwork(),
      });

      const { txid } = await btcWallet.signAndBroadcastPsbt(psbtResult.psbtBase64);

      // Save to local notes store
      const opReturnHex = depositPreview.opReturnHex;
      useNotesStore.getState().saveNote({
        commitment: opReturnHex,
        noteExport: txid,
        amountSats: depositPreview.depositAmountSats,
        taprootAddress: depositPreview.depositAddress,
        expiresAt: Math.floor(Date.now() / 1000) + 86400 * 30,
      });

      // Register with backend tracker (retry up to 3 times)
      const ephemeralPubHex = opReturnHex.slice(0, 64);
      const npkHex = opReturnHex.slice(64);
      (async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const res = await registerDeposit(
              depositPreview.depositAddress,
              npkHex,
              depositPreview.depositAmountSats,
              ephemeralPubHex,
            );
            if (res.deposit_id) {
              useNotesStore.getState().updateNote(opReturnHex, { depositId: res.deposit_id });
            }
            return;
          } catch (err) {
            if (attempt < 2) {
              await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
            } else {
              console.error("Failed to register deposit after 3 attempts:", err);
              notifyError("Failed to register deposit with backend. Your deposit may not be tracked automatically.");
            }
          }
        }
      })();

      setWalletDepositResult({
        txid,
        depositAddress: depositPreview.depositAddress,
        opReturnHex: depositPreview.opReturnHex,
      });
      setDepositPreview(null);
      btcWallet.refreshBalance();
    } catch (err) {
      console.error("Wallet deposit error:", err);
      setError(err instanceof Error ? err.message : "Wallet deposit failed");
    } finally {
      setWalletDepositing(false);
    }
  };

  return {
    // State
    error,
    setError,
    resolvedMeta,
    setResolvedMeta,
    walletDepositAmount,
    setWalletDepositAmount,
    depositPreview,
    setDepositPreview,
    buildingPreview,
    selectedUtxoKeys,
    setSelectedUtxoKeys,
    walletDepositing,
    walletDepositResult,

    // Actions
    resetFlow,
    buildTxPreview,
    confirmAndSign,
  };
}
