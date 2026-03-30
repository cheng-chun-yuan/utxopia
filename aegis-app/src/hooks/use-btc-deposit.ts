"use client";

import { useState, useCallback, useRef } from "react";
import {
  bytesToHex,
  buildDepositPsbt,
  AegisClient,
} from "@aegis/sdk";
import type { StealthMetaAddress } from "@aegis/sdk";
import { useBitcoinWalletStore, type WalletUtxo } from "@/stores/bitcoin-wallet-store";
import { useNotesStore } from "@/stores/notes-store";
import { registerDeposit } from "@/lib/api/deposits";
import { getBtcSignerNetwork } from "@/lib/btc-network";
import { notifyError } from "@/lib/notifications";
import { BTC_DUST_LIMIT } from "@/lib/btc-constants";

export interface DepositPreview {
  depositAddress: string;
  depositAmountSats: number;
  opReturnHex: string;
  opReturnPayload: Uint8Array;
  cachedUtxos: WalletUtxo[];
}

export interface WalletDepositResult {
  txid: string;
  depositAddress: string;
  opReturnHex: string;
}

interface UseBtcDepositParams {
  stealthAddress: StealthMetaAddress | null | undefined;
  resolvedMeta: StealthMetaAddress | null;
  onStatusChange: (status: "done" | "error") => void;
  onError: (msg: string) => void;
}

export function useBtcDeposit({
  stealthAddress,
  resolvedMeta,
  onStatusChange,
  onError,
}: UseBtcDepositParams) {
  const btcWallet = useBitcoinWalletStore();

  const [btcAmount, setBtcAmount] = useState("");
  const [walletDepositing, setWalletDepositing] = useState(false);
  const [walletDepositResult, setWalletDepositResult] = useState<WalletDepositResult | null>(null);
  const [depositPreview, setDepositPreview] = useState<DepositPreview | null>(null);
  const [buildingPreview, setBuildingPreview] = useState(false);
  const [selectedUtxoKeys, setSelectedUtxoKeys] = useState<Set<string>>(new Set());
  const [showUtxoList, setShowUtxoList] = useState(false);
  const [editingUtxos, setEditingUtxos] = useState(false);
  const [showOpReturn, setShowOpReturn] = useState(false);
  const [copiedBtcAddr, setCopiedBtcAddr] = useState(false);
  const [showWalletPicker, setShowWalletPicker] = useState(false);
  const walletPickerRef = useRef<HTMLDivElement>(null);

  // ── BTC: Reset flow ──
  const resetBtcFlow = useCallback(() => {
    onError("");
    setBtcAmount("");
    setWalletDepositResult(null);
    setDepositPreview(null);
  }, [onError]);

  // ── BTC: Build PSBT preview ──
  const buildTxPreview = useCallback(async () => {
    if (!resolvedMeta || !btcWallet.connected) return;
    const amountSats = Math.floor(parseFloat(btcAmount || "0") * 1e8);
    if (!amountSats || amountSats < BTC_DUST_LIMIT) {
      notifyError(`Amount must be at least ${BTC_DUST_LIMIT} sats`);
      return;
    }

    setBuildingPreview(true);
    onError("");
    setDepositPreview(null);

    try {
      const client = AegisClient.instance();
      const [deposit, utxos] = await Promise.all([
        client.prepareDeposit({ recipient: resolvedMeta }),
        btcWallet.getPaymentUtxos(),
      ]);

      if (utxos.length === 0) throw new Error("No confirmed UTXOs available in wallet");

      const autoSelected = client.selectUtxos(
        utxos.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, scriptPubkeyHex: u.scriptPubkeyHex })),
        amountSats,
        2,
      );
      setSelectedUtxoKeys(new Set(autoSelected.map((u) => `${u.txid}:${u.vout}`)));
      setShowUtxoList(false);
      setEditingUtxos(false);

      setDepositPreview({
        depositAddress: deposit.btcAddress,
        depositAmountSats: amountSats,
        opReturnHex: bytesToHex(deposit.opReturnPayload),
        opReturnPayload: deposit.opReturnPayload,
        cachedUtxos: utxos,
      });
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to generate deposit");
    } finally {
      setBuildingPreview(false);
    }
  }, [resolvedMeta, btcAmount, btcWallet, onError]);

  // ── BTC: Confirm & sign PSBT ──
  const confirmAndSign = useCallback(async () => {
    if (!depositPreview) return;
    setWalletDepositing(true);
    onError("");

    try {
      const selected = depositPreview.cachedUtxos
        .filter((u) => selectedUtxoKeys.has(`${u.txid}:${u.vout}`))
        .map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, scriptPubkeyHex: u.scriptPubkeyHex }));
      if (selected.length === 0) throw new Error("No UTXOs selected");

      const totalSelected = selected.reduce((sum, u) => sum + u.value, 0);
      if (totalSelected < depositPreview.depositAmountSats)
        throw new Error(`Selected UTXOs (${totalSelected} sats) insufficient for deposit (${depositPreview.depositAmountSats} sats)`);

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

      const opReturnHex = depositPreview.opReturnHex;
      useNotesStore.getState().saveNote({
        commitment: opReturnHex,
        noteExport: txid,
        amountSats: depositPreview.depositAmountSats,
        taprootAddress: depositPreview.depositAddress,
        expiresAt: Math.floor(Date.now() / 1000) + 86400 * 30,
      });

      // Register with backend (fire-and-forget with retry)
      const ephemeralPubHex = opReturnHex.slice(0, 64);
      const npkHex = opReturnHex.slice(64);
      (async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const res = await registerDeposit(depositPreview.depositAddress, npkHex, depositPreview.depositAmountSats, ephemeralPubHex);
            if (res.deposit_id) useNotesStore.getState().updateNote(opReturnHex, { depositId: res.deposit_id });
            return;
          } catch (err) {
            if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
            else notifyError("Failed to register deposit with backend. Your deposit may not be tracked automatically.");
          }
        }
      })();

      setWalletDepositResult({ txid, depositAddress: depositPreview.depositAddress, opReturnHex });
      setDepositPreview(null);
      btcWallet.refreshBalance();
      onStatusChange("done");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Wallet deposit failed");
      onStatusChange("error");
    } finally {
      setWalletDepositing(false);
    }
  }, [depositPreview, selectedUtxoKeys, btcWallet, onStatusChange, onError]);

  return {
    btcWallet,
    btcAmount,
    setBtcAmount,
    walletDepositing,
    walletDepositResult,
    setWalletDepositResult,
    depositPreview,
    setDepositPreview,
    buildingPreview,
    selectedUtxoKeys,
    setSelectedUtxoKeys,
    showUtxoList,
    setShowUtxoList,
    editingUtxos,
    setEditingUtxos,
    showOpReturn,
    setShowOpReturn,
    copiedBtcAddr,
    setCopiedBtcAddr,
    showWalletPicker,
    setShowWalletPicker,
    walletPickerRef,
    resetBtcFlow,
    buildTxPreview,
    confirmAndSign,
  };
}
