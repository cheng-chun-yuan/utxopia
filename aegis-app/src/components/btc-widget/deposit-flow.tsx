"use client";

/**
 * DepositFlow — BTC deposit creation UI.
 *
 * Manages two deposit paths:
 * 1. Stealth deposit: generates ephemeral key + npk, creates Taproot address
 *    with OP_RETURN (64 bytes = ephemeralPub + npk)
 * 2. Backend-managed deposit: prepares address via API, tracks via WebSocket/polling
 *
 * Flow steps:
 * - Enter recipient (self or stealth address)
 * - Generate Taproot deposit address
 * - Display address for user to send BTC
 * - Track confirmation status
 *
 * Key functions:
 * - buildDepositPsbt(): Build PSBT for wallet signing
 * - buildDepositPsbt(): Build PSBT for wallet signing (sats-connect/Unisat)
 */

import { useState } from "react";
import {
  Check, AlertCircle, Wallet,
  RefreshCw, ExternalLink, Info,
  Zap, Loader2, CheckCircle2, ArrowRight,
  Hash, FileText, ArrowLeftRight, ChevronDown, Shield,
  Copy,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { notifySuccess, notifyError } from "@/lib/notifications";
import {
  bytesToHex,
  hexToBytes,
  createStealthDepositWithKeys,
  createNonInteractiveDeposit,
  bigintToBytes,
  buildDepositPsbt,
  selectUtxos,
  getConfig,
  type StealthMetaAddress,
  type BuildDepositPsbtResult,
} from "@aegis/sdk";
import { Tooltip } from "@/components/ui/tooltip";
import { useBitcoinWalletStore } from "@/stores/bitcoin-wallet-store";

import { useNotesStore } from "@/stores/notes-store";
import { registerDeposit } from "@/lib/api/deposits";
import { getBtcSignerNetwork, getMempoolExplorerUrl } from "@/lib/btc-network";
import { getSolanaExplorerTxUrl } from "@/lib/solana-network";

import { MobileWalletGuidance } from "@/components/bitcoin-wallet-selector";
import { useIsMobileWithoutWallet } from "@/hooks/use-mobile-wallet-detect";
import { useAegis } from "@/hooks/use-aegis";
import { StealthRecipientInput } from "@/components/ui/stealth-recipient-input";

export function DepositFlow() {
  const { stealthAddress } = useAegis();
  const isDevnet = getConfig().network === "devnet";
  // Demo mode state (only available on devnet)
  const [demoMode, setDemoMode] = useState(false);
  const [demoAmount, setDemoAmount] = useState("10000");
  const [demoSubmitting, setDemoSubmitting] = useState(false);
  const [demoResult, setDemoResult] = useState<{
    signature: string;
    ephemeralPubKey?: string;
  } | null>(null);

  // Stealth mode state
  const [error, setError] = useState<string | null>(null);
  const [resolvedMeta, setResolvedMeta] = useState<StealthMetaAddress | null>(null);

  // Wallet deposit state (PSBT flow)
  const [walletDepositAmount, setWalletDepositAmount] = useState("10000");
  const [walletDepositing, setWalletDepositing] = useState(false);
  const [walletDepositResult, setWalletDepositResult] = useState<{
    txid: string;
    depositAddress: string;
    opReturnHex: string;
  } | null>(null);
  // Preview: deposit outputs + pre-fetched UTXOs (both fetched in parallel)
  const [depositPreview, setDepositPreview] = useState<{
    depositAddress: string;
    depositAmountSats: number;
    opReturnHex: string;
    opReturnPayload: Uint8Array;
    cachedUtxos: import("@/stores/bitcoin-wallet-store").WalletUtxo[];
  } | null>(null);
  const [buildingPreview, setBuildingPreview] = useState(false);
  // Coin control: which UTXOs are selected (by "txid:vout" key)
  const [selectedUtxoKeys, setSelectedUtxoKeys] = useState<Set<string>>(new Set());
  const [showUtxoList, setShowUtxoList] = useState(false);
  const [editingUtxos, setEditingUtxos] = useState(false);
  const [showOpReturn, setShowOpReturn] = useState(false);
  const btcWallet = useBitcoinWalletStore();
  const isMobileNoWallet = useIsMobileWithoutWallet();

  const resetFlow = () => {
    setError(null);
    setResolvedMeta(null);
    setDemoAmount("10000");
    setDemoResult(null);
    setWalletDepositAmount("10000");
    setWalletDepositResult(null);
    setDepositPreview(null);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => notifySuccess("Copied!"));
  };

  // Demo mode: Submit mock stealth deposit via backend relayer (keeps user anonymous)
  const submitDemoDeposit = async () => {
    if (!resolvedMeta) {
      notifyError("Please resolve recipient first");
      return;
    }

    const amount = BigInt(demoAmount || "10000");
    if (amount <= 0n) {
      notifyError("Amount must be positive");
      return;
    }

    setDemoSubmitting(true);
    setDemoResult(null);
    setError(null);

    try {
      // Create stealth deposit with keys to get npk (note public key)
      const { getActiveTokenId } = await import("@/lib/token-context");
      const stealthData = await createStealthDepositWithKeys(resolvedMeta, amount, getActiveTokenId());

      // Convert npk (bigint) to 32-byte big-endian
      const npkBytes = bigintToBytes(stealthData.stealthPubKeyX);

      // Call API - relayer submits transaction (keeps user anonymous)
      // Send ephemeralPub + npk + amount (commitment computed on-chain)
      const response = await fetch("/api/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ephemeralPub: bytesToHex(stealthData.ephemeralPub),
          npk: bytesToHex(npkBytes),
          amount: amount.toString(),
        }),
      });

      const result = await response.json();
      if (!result.success) {
        throw new Error(result.error || "Failed to submit demo deposit");
      }

      setDemoResult({
        signature: result.signature,
        ephemeralPubKey: bytesToHex(stealthData.ephemeralPub),
      });
    } catch (err) {
      console.error("Demo deposit error:", err);
      setError(err instanceof Error ? err.message : "Failed to submit demo deposit");
    } finally {
      setDemoSubmitting(false);
    }
  };


  // Step 1: Generate deposit info + fetch UTXOs in parallel
  const buildTxPreview = async () => {
    if (!resolvedMeta || !btcWallet.connected) return;

    const amountSats = parseInt(walletDepositAmount);
    if (!amountSats || amountSats < 546) {
      notifyError("Amount must be at least 546 sats");
      return;
    }

    setBuildingPreview(true);
    setError(null);
    setDepositPreview(null);

    try {
      const config = getConfig();
      const groupPubKey = hexToBytes(config.groupPubKey);

      // Run crypto + UTXO fetch in parallel
      const [deposit, utxos] = await Promise.all([
        createNonInteractiveDeposit(resolvedMeta, groupPubKey, getBtcSignerNetwork()),
        btcWallet.getPaymentUtxos(),
      ]);

      if (utxos.length === 0) {
        throw new Error("No confirmed UTXOs available in wallet");
      }

      // Auto-select UTXOs
      const autoSelected = selectUtxos(
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
      console.error("Preview build error:", err);
      setError(err instanceof Error ? err.message : "Failed to generate deposit");
    } finally {
      setBuildingPreview(false);
    }
  };

  // Step 2: Build PSBT from cached UTXOs, sign, and broadcast
  const confirmAndSign = async () => {
    if (!depositPreview) return;

    setWalletDepositing(true);
    setError(null);

    try {
      // Use user-selected UTXOs (from coin control)
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

      // Save to local notes store so it appears in "Bitcoin Deposits" view
      const opReturnHex = depositPreview.opReturnHex; // ephemeralPub + npk
      useNotesStore.getState().saveNote({
        commitment: opReturnHex,
        noteExport: txid,
        amountSats: depositPreview.depositAmountSats,
        taprootAddress: depositPreview.depositAddress,
        expiresAt: Math.floor(Date.now() / 1000) + 86400 * 30, // 30 days
      });

      // Register with backend tracker and save depositId (retry up to 3 times)
      const ephemeralPubHex = opReturnHex.slice(0, 64); // first 32 bytes
      const npkHex = opReturnHex.slice(64); // second 32 bytes
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

  return (
    <div className="flex flex-col">
      {/* Demo Mode Toggle (devnet only) */}
      {isDevnet && (
        <div className="flex items-center justify-between mb-4 p-3 bg-warning/5 border border-warning/20 rounded-[12px]">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-warning" />
            <span className="text-body2 text-warning">Demo Mode</span>
            <Tooltip content="Skip BTC deposit - add mock commitment directly to Solana for testing">
              <Info className="w-3.5 h-3.5 text-warning/60" />
            </Tooltip>
          </div>
          <button
            onClick={() => { setDemoMode(!demoMode); setDemoResult(null); }}
            className={cn(
              "relative w-11 h-6 rounded-full transition-colors",
              demoMode ? "bg-warning" : "bg-gray/30"
            )}
            role="switch"
            aria-checked={demoMode}
          >
            <span
              className={cn(
                "absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform",
                demoMode && "translate-x-5"
              )}
            />
          </button>
        </div>
      )}

      {/* ========== STEALTH MODE (Send by Stealth) ========== */}
      <>
          {/* Recipient Input — shared component with auto-resolve on blur/Enter */}
          <StealthRecipientInput
            onResolved={(meta, name) => { setResolvedMeta(meta); }}
            resolvedMeta={resolvedMeta}
            resolvedName={null}
            error={error}
            onError={setError}
            selfMeta={stealthAddress ?? null}
            className="mb-4"
          />

          {/* Resolved recipient info */}
          {resolvedMeta && (
            <div className="mb-4 p-3 bg-sol/5 border border-sol/15 rounded-[12px]">
              <div className="flex items-center gap-2">
                <Check className="w-4 h-4 text-success" />
                <span className="text-body2-semibold text-success">Recipient Found</span>
              </div>
            </div>
          )}

          {/* ========== DEMO MODE: Stealth Deposit ========== */}
          {demoMode && resolvedMeta && (
            <>
              {/* Amount Input */}
              <div className="mb-4">
                <label className="text-body2 text-gray-light pl-2 mb-2 block">Amount (satoshis)</label>
                <input
                  type="number"
                  value={demoAmount}
                  onChange={(e) => setDemoAmount(e.target.value)}
                  placeholder="10000"
                  className={cn(
                    "w-full p-3 bg-muted border border-gray/15 rounded-[12px]",
                    "text-body2 font-mono text-foreground placeholder:text-gray",
                    "outline-none focus:border-warning/40 transition-colors"
                  )}
                />
                <p className="text-caption text-gray mt-1 pl-2">
                  {demoAmount ? `${(parseInt(demoAmount) / 100_000_000).toFixed(8)} BTC` : ""}
                </p>
              </div>

              {/* Demo Submit Button */}
              <button
                onClick={submitDemoDeposit}
                disabled={demoSubmitting}
                className={cn(
                  "w-full py-3 rounded-[12px] font-medium transition-colors flex items-center justify-center gap-2 mb-4",
                  "bg-warning hover:bg-warning/90 text-background",
                  "disabled:bg-gray/20 disabled:text-gray disabled:cursor-not-allowed"
                )}
              >
                {demoSubmitting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Publishing via relayer...
                  </>
                ) : (
                  <>
                    <Zap className="w-4 h-4" />
                    Add Mock Stealth Deposit
                  </>
                )}
              </button>

              {/* Demo Result */}
              {demoResult && (
                <div className="p-4 bg-success/10 border border-success/30 rounded-[12px] mb-4">
                  <div className="flex items-center gap-2 text-success mb-2">
                    <CheckCircle2 className="w-5 h-5" />
                    <span className="text-body2-semibold">Mock Stealth Deposit Published!</span>
                  </div>

                  {demoResult.ephemeralPubKey && (
                    <div className="mb-3">
                      <p className="text-caption text-gray mb-1">Ephemeral Public Key:</p>
                      <code className="block text-[10px] font-mono text-sol bg-muted p-2 rounded-[8px] break-all">
                        {demoResult.ephemeralPubKey}
                      </code>
                    </div>
                  )}

                  <a
                    href={getSolanaExplorerTxUrl(demoResult.signature)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-caption text-sol hover:text-sol-light transition-colors"
                  >
                    View transaction
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              )}

              {/* Info about stealth deposit */}
              <div className="p-3 bg-sol/10 border border-sol/20 rounded-[12px] mb-4">
                <div className="flex items-start gap-2">
                  <Info className="w-4 h-4 text-sol shrink-0 mt-0.5" />
                  <p className="text-caption text-gray">
                    The recipient can scan for this deposit using their stealth keys. Only they can see and claim it.
                  </p>
                </div>
              </div>

              {/* Reset button */}
              {demoResult && (
                <button onClick={resetFlow} className="btn-secondary w-full">
                  <RefreshCw className="w-4 h-4" />
                  Start New Deposit
                </button>
              )}
            </>
          )}

          {/* ========== NORMAL MODE: Wallet Deposit ========== */}
          {!demoMode && resolvedMeta && !walletDepositResult && (
            <>
              {/* ========== WALLET (PSBT) MODE ========== */}
              {btcWallet.connected ? (
                <div className="mb-4">
                  {/* Amount input (hidden once preview is built) */}
                  {!depositPreview && (
                    <>
                      <label className="text-body2 text-gray-light pl-2 mb-2 block">Amount (satoshis)</label>
                      <input
                        type="number"
                        value={walletDepositAmount}
                        onChange={(e) => setWalletDepositAmount(e.target.value)}
                        placeholder="10000"
                        min="546"
                        className={cn(
                          "w-full p-3 bg-muted border border-gray/15 rounded-[12px] mb-1",
                          "text-body2 font-mono text-foreground placeholder:text-gray",
                          "outline-none focus:border-btc/40 transition-colors"
                        )}
                      />
                      <p className="text-caption text-gray pl-2 mb-3">
                        {walletDepositAmount ? `${(parseInt(walletDepositAmount) / 100_000_000).toFixed(8)} BTC` : ""}
                        {btcWallet.connected && (btcWallet.balance !== null ? ` · Confirmed: ${(btcWallet.balance / 100_000_000).toFixed(8)} BTC` : " · Loading...")}
                      </p>

                      {btcWallet.balance !== null && walletDepositAmount && parseInt(walletDepositAmount) > btcWallet.balance && (
                        <div className="p-2.5 mb-3 bg-error/10 border border-error/20 rounded-[10px]">
                          <span className="text-caption text-error">
                            Insufficient confirmed funds: have {btcWallet.balance.toLocaleString()} sats, need {parseInt(walletDepositAmount).toLocaleString()}+ sats (excluding fees). Wait for pending transactions to confirm.
                          </span>
                        </div>
                      )}

                      <button
                        onClick={buildTxPreview}
                        disabled={buildingPreview || !walletDepositAmount || parseInt(walletDepositAmount) < 546 || (btcWallet.balance !== null && parseInt(walletDepositAmount) > btcWallet.balance)}
                        className={cn(
                          "w-full py-3 rounded-[12px] font-medium transition-colors flex items-center justify-center gap-2",
                          "bg-btc hover:bg-btc/90 text-background",
                          "disabled:bg-gray/20 disabled:text-gray disabled:cursor-not-allowed"
                        )}
                      >
                        {buildingPreview ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Generating...
                          </>
                        ) : (
                          <>
                            <FileText className="w-4 h-4" />
                            Preview Transaction
                          </>
                        )}
                      </button>
                    </>
                  )}

                  {/* Transaction Preview */}
                  {depositPreview && (() => {
                    const totalInput = depositPreview.cachedUtxos
                      .filter((u) => selectedUtxoKeys.has(`${u.txid}:${u.vout}`))
                      .reduce((sum, u) => sum + u.value, 0);
                    // Estimate: ~148 bytes per input + ~78 bytes overhead + outputs
                    const estimatedVsize = selectedUtxoKeys.size * 68 + 78 + 43 + 43 + 12;
                    const estimatedFee = estimatedVsize * 2; // 2 sat/vB
                    const changeAmount = totalInput - depositPreview.depositAmountSats - estimatedFee;
                    const insufficientFunds = totalInput < depositPreview.depositAmountSats + estimatedFee;

                    return (
                    <div className="flex flex-col gap-3">
                      {/* Inputs: UTXO list */}
                      <div className="p-3 bg-muted border border-gray/15 rounded-[12px]">
                        <div className="flex items-center justify-between">
                          <p className="text-caption text-gray">
                            Inputs ({selectedUtxoKeys.size} UTXO{selectedUtxoKeys.size !== 1 ? "s" : ""})
                            <span className="text-foreground ml-1">{(totalInput / 1e8).toFixed(8)} BTC</span>
                          </p>
                          <div className="flex items-center gap-2">
                            {showUtxoList && (
                              <button
                                onClick={() => setEditingUtxos(!editingUtxos)}
                                className={cn(
                                  "text-[10px] transition-colors",
                                  editingUtxos ? "text-warning hover:text-warning/80" : "text-sol hover:text-sol-light"
                                )}
                              >
                                {editingUtxos ? "Done" : "Edit"}
                              </button>
                            )}
                            <button
                              onClick={() => { setShowUtxoList(!showUtxoList); if (showUtxoList) setEditingUtxos(false); }}
                              className="text-[10px] text-gray hover:text-gray-light transition-colors"
                            >
                              {showUtxoList ? "Hide" : "Show UTXOs"}
                            </button>
                          </div>
                        </div>

                        {showUtxoList && (
                          <div className="space-y-1.5 max-h-36 overflow-y-auto mt-2">
                            {depositPreview.cachedUtxos.map((utxo) => {
                              const key = `${utxo.txid}:${utxo.vout}`;
                              const isSelected = selectedUtxoKeys.has(key);

                              if (!editingUtxos && !isSelected) return null;

                              return (
                                <div
                                  key={key}
                                  className={cn(
                                    "flex items-center gap-2 p-2 rounded-[8px] transition-colors",
                                    editingUtxos ? "cursor-pointer" : "",
                                    isSelected ? "bg-btc/10 border border-btc/20" : "bg-background border border-gray/10 hover:border-gray/25"
                                  )}
                                  onClick={editingUtxos ? () => {
                                    setSelectedUtxoKeys((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(key)) next.delete(key);
                                      else next.add(key);
                                      return next;
                                    });
                                  } : undefined}
                                >
                                  {editingUtxos && (
                                    <input
                                      type="checkbox"
                                      checked={isSelected}
                                      readOnly
                                      className="accent-btc w-3.5 h-3.5 pointer-events-none"
                                    />
                                  )}
                                  <div className="flex-1 min-w-0">
                                    <code className="text-[10px] font-mono text-gray-light block truncate">
                                      {utxo.txid.slice(0, 8)}...:{utxo.vout}
                                    </code>
                                  </div>
                                  <span className="text-[11px] font-mono text-btc whitespace-nowrap">
                                    {(utxo.value / 1e8).toFixed(8)}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      {/* ── Flow divider ── */}
                      <div className="flex items-center gap-2 px-1">
                        <div className="flex-1 h-px bg-gradient-to-r from-transparent via-gray/20 to-transparent" />
                        <span className="text-[10px] text-gray/50 uppercase tracking-widest">Outputs</span>
                        <div className="flex-1 h-px bg-gradient-to-r from-transparent via-gray/20 to-transparent" />
                      </div>

                      {/* Deposit output */}
                      <div className="p-3 bg-btc/5 border border-btc/20 rounded-[12px]">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <div className="w-6 h-6 rounded-full bg-btc/15 flex items-center justify-center">
                              <ArrowRight className="w-3 h-3 text-btc" />
                            </div>
                            <span className="text-caption font-semibold text-btc">Deposit</span>
                          </div>
                          <span className="text-[10px] font-mono bg-btc/10 text-btc/70 px-1.5 py-0.5 rounded">P2TR</span>
                        </div>
                        <p className="text-body2-semibold font-mono text-foreground">
                          {(depositPreview.depositAmountSats / 1e8).toFixed(8)} BTC
                        </p>
                        <p className="text-caption text-gray mb-1.5">{depositPreview.depositAmountSats.toLocaleString()} sats</p>
                        <div className="flex items-center gap-1.5 p-1.5 bg-background/50 rounded-[6px]">
                          <code className="text-[10px] font-mono text-btc/60 truncate">
                            {depositPreview.depositAddress.slice(0, 14)}...{depositPreview.depositAddress.slice(-14)}
                          </code>
                        </div>
                      </div>

                      {/* ZK Metadata (OP_RETURN) — compact by default */}
                      <div className="p-3 bg-privacy/5 border border-privacy/20 rounded-[12px]">
                        <button
                          onClick={() => setShowOpReturn(!showOpReturn)}
                          className="w-full flex items-center justify-between cursor-pointer"
                        >
                          <div className="flex items-center gap-2">
                            <div className="w-6 h-6 rounded-full bg-privacy/15 flex items-center justify-center">
                              <Shield className="w-3 h-3 text-privacy" />
                            </div>
                            <span className="text-caption font-semibold text-privacy">ZK Metadata</span>
                            <span className="text-[10px] text-privacy/50">64 bytes</span>
                          </div>
                          <ChevronDown className={cn(
                            "w-3.5 h-3.5 text-gray transition-transform duration-200",
                            showOpReturn && "rotate-180"
                          )} />
                        </button>
                        {showOpReturn && (
                          <div className="mt-2 pt-2 border-t border-privacy/10 space-y-1.5">
                            <div>
                              <p className="text-[10px] text-gray mb-0.5">Ephemeral Public Key</p>
                              <code className="block text-[9px] font-mono text-privacy/50 break-all leading-relaxed">
                                {depositPreview.opReturnHex.slice(0, 64)}
                              </code>
                            </div>
                            <div>
                              <p className="text-[10px] text-gray mb-0.5">Note Public Key</p>
                              <code className="block text-[9px] font-mono text-privacy/50 break-all leading-relaxed">
                                {depositPreview.opReturnHex.slice(64)}
                              </code>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Change output */}
                      {changeAmount > 0 && (
                        <div className="p-3 bg-muted border border-gray/15 rounded-[12px]">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <div className="w-6 h-6 rounded-full bg-gray/15 flex items-center justify-center">
                                <Wallet className="w-3 h-3 text-gray" />
                              </div>
                              <span className="text-caption font-semibold text-gray-light">Change</span>
                            </div>
                          </div>
                          <p className="text-body2-semibold font-mono text-foreground">
                            {(changeAmount / 1e8).toFixed(8)} BTC
                          </p>
                          <p className="text-caption text-gray mb-1.5">{changeAmount.toLocaleString()} sats</p>
                          <div className="flex items-center gap-1.5 p-1.5 bg-background/50 rounded-[6px]">
                            <code className="text-[10px] font-mono text-gray/60 truncate">
                              {btcWallet.address?.slice(0, 14)}...{btcWallet.address?.slice(-14)}
                            </code>
                          </div>
                        </div>
                      )}

                      {/* Summary */}
                      <div className="p-3 rounded-[12px] bg-muted border border-gray/15 space-y-1.5">
                        <div className="flex items-center justify-between text-caption">
                          <span className="text-gray">Deposit</span>
                          <span className="font-mono text-btc">{(depositPreview.depositAmountSats / 1e8).toFixed(8)} BTC</span>
                        </div>
                        {changeAmount > 0 && (
                          <div className="flex items-center justify-between text-caption">
                            <span className="text-gray">Change</span>
                            <span className="font-mono text-foreground">{(changeAmount / 1e8).toFixed(8)} BTC</span>
                          </div>
                        )}
                        <div className="flex items-center justify-between text-caption">
                          <span className="text-gray">Network Fee</span>
                          <span className="font-mono text-foreground">{estimatedFee.toLocaleString()} sats</span>
                        </div>
                        <div className="flex items-center justify-between text-caption pt-1.5 border-t border-gray/10">
                          <span className="text-gray-light font-medium">Total</span>
                          <span className="font-mono text-foreground font-semibold">
                            {((depositPreview.depositAmountSats + estimatedFee) / 1e8).toFixed(8)} BTC
                          </span>
                        </div>
                      </div>

                      {/* Insufficient funds warning */}
                      {insufficientFunds && (
                        <div className="p-2.5 bg-error/10 border border-error/20 rounded-[10px]">
                          <div className="flex items-center gap-2">
                            <AlertCircle className="w-3.5 h-3.5 text-error shrink-0" />
                            <span className="text-caption text-error">
                              Insufficient funds. Select more UTXOs or reduce amount.
                            </span>
                          </div>
                        </div>
                      )}

                      {/* Action buttons */}
                      <div className="flex gap-2">
                        <button
                          onClick={() => setDepositPreview(null)}
                          disabled={walletDepositing}
                          className={cn(
                            "flex-1 py-3 rounded-[12px] font-medium transition-colors flex items-center justify-center gap-2",
                            "bg-muted hover:bg-gray/20 text-foreground border border-gray/20",
                            "disabled:opacity-50 disabled:cursor-not-allowed"
                          )}
                        >
                          Back
                        </button>
                        <button
                          onClick={confirmAndSign}
                          disabled={walletDepositing || insufficientFunds || selectedUtxoKeys.size === 0}
                          className={cn(
                            "flex-[2] py-3 rounded-[12px] font-medium transition-colors flex items-center justify-center gap-2",
                            "bg-btc hover:bg-btc/90 text-background",
                            "disabled:bg-gray/20 disabled:text-gray disabled:cursor-not-allowed"
                          )}
                        >
                          {walletDepositing ? (
                            <>
                              <Loader2 className="w-4 h-4 animate-spin" />
                              Signing...
                            </>
                          ) : (
                            <>
                              <Wallet className="w-4 h-4" />
                              Confirm & Sign
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                    );
                  })()}
                </div>
              ) : (
                <div className="mb-4 flex flex-col gap-2">
                  <p className="text-body2 text-gray-light pl-2 mb-1">Connect Bitcoin Wallet</p>
                  {isMobileNoWallet ? (
                    <MobileWalletGuidance />
                  ) : (
                    <>
                      <button
                        onClick={() => btcWallet.connect("sats-connect")}
                        disabled={btcWallet.connecting}
                        className={cn(
                          "w-full py-3 rounded-[12px] font-medium transition-colors flex items-center justify-center gap-2",
                          "bg-gray/15 hover:bg-gray/25 text-foreground border border-gray/20",
                          "disabled:bg-gray/20 disabled:text-gray disabled:cursor-not-allowed"
                        )}
                      >
                        {btcWallet.connecting ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Wallet className="w-4 h-4" />
                        )}
                        Xverse / Leather
                      </button>
                      <button
                        onClick={() => btcWallet.connect("unisat")}
                        disabled={btcWallet.connecting}
                        className={cn(
                          "w-full py-3 rounded-[12px] font-medium transition-colors flex items-center justify-center gap-2",
                          "bg-gray/15 hover:bg-gray/25 text-foreground border border-gray/20",
                          "disabled:bg-gray/20 disabled:text-gray disabled:cursor-not-allowed"
                        )}
                      >
                        {btcWallet.connecting ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Wallet className="w-4 h-4" />
                        )}
                        UniSat
                      </button>
                    </>
                  )}
                </div>
              )}
            </>
          )}

          {/* Wallet Deposit Result */}
          {!demoMode && walletDepositResult && (
            <div className="mb-4">
              <div className="p-4 bg-success/10 border border-success/30 rounded-[12px] mb-3">
                <div className="flex items-center gap-2 text-success mb-3">
                  <CheckCircle2 className="w-5 h-5" />
                  <span className="text-body2-semibold">Deposit Broadcast!</span>
                </div>
                <p className="text-caption text-gray mb-2">
                  The backend will automatically detect, sweep, and verify it on Solana.
                </p>

                <div className="mb-2">
                  <p className="text-caption text-gray mb-1">TxID:</p>
                  <a
                    href={`${getMempoolExplorerUrl()}/tx/${walletDepositResult.txid}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-[10px] font-mono text-btc bg-muted p-2 rounded-[8px] break-all hover:underline"
                  >
                    {walletDepositResult.txid}
                  </a>
                </div>

                <div className="mb-2">
                  <p className="text-caption text-gray mb-1">Deposit Address:</p>
                  <code className="block text-[10px] font-mono text-btc bg-muted p-2 rounded-[8px] break-all">
                    {walletDepositResult.depositAddress}
                  </code>
                </div>

                <div className="space-y-2">
                  <p className="text-caption text-gray">OP_RETURN Data (64 bytes):</p>
                  <div className="bg-muted p-2 rounded-[8px] space-y-1.5">
                    <div>
                      <p className="text-[10px] text-gray">ephemeralPub (32 bytes):</p>
                      <code className="block text-[10px] font-mono text-sol break-all">
                        {walletDepositResult.opReturnHex.slice(0, 64)}
                      </code>
                    </div>
                    <div>
                      <p className="text-[10px] text-gray">npk (32 bytes):</p>
                      <code className="block text-[10px] font-mono text-sol break-all">
                        {walletDepositResult.opReturnHex.slice(64)}
                      </code>
                    </div>
                  </div>
                </div>
              </div>

              <button onClick={resetFlow} className="btn-secondary w-full">
                <RefreshCw className="w-4 h-4" />
                New Deposit
              </button>
            </div>
          )}

        </>
    </div>
  );
}
