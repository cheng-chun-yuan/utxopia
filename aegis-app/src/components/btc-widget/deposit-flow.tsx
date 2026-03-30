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

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { BTC_DUST_LIMIT } from "@/lib/btc-constants";
import confetti from "canvas-confetti";
import {
  Check, AlertCircle, Wallet,
  RefreshCw, ExternalLink,
  Loader2, CheckCircle2, ArrowRight,
  FileText, ChevronDown, Shield,
  Copy,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { notifySuccess } from "@/lib/notifications";
import { useBitcoinWalletStore } from "@/stores/bitcoin-wallet-store";

import { MobileWalletGuidance } from "@/components/bitcoin-wallet-selector";
import { useIsMobileWithoutWallet } from "@/hooks/use-mobile-wallet-detect";
import { useAegis } from "@/hooks/use-aegis";
import { useDepositFlow } from "@/hooks/use-deposit-flow";
import { StealthRecipientInput } from "@/components/ui/stealth-recipient-input";
import { getMempoolExplorerUrl } from "@/lib/btc-network";

export function DepositFlow() {
  const { stealthAddress } = useAegis();
  const btcWallet = useBitcoinWalletStore();
  const isMobileNoWallet = useIsMobileWithoutWallet();

  const {
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
    resetFlow,
    buildTxPreview,
    confirmAndSign,
  } = useDepositFlow();

  // UI-only state
  const [showUtxoList, setShowUtxoList] = useState(false);
  const [editingUtxos, setEditingUtxos] = useState(false);
  const [showOpReturn, setShowOpReturn] = useState(false);

  return (
    <div className="flex flex-col">
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

          {/* ========== WALLET DEPOSIT ========== */}
          {resolvedMeta && !walletDepositResult && (
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
                        min={String(BTC_DUST_LIMIT)}
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
                        disabled={buildingPreview || !walletDepositAmount || parseInt(walletDepositAmount) < BTC_DUST_LIMIT || (btcWallet.balance !== null && parseInt(walletDepositAmount) > btcWallet.balance)}
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
          {walletDepositResult && (
            <DepositSuccess
              result={walletDepositResult}
              onReset={resetFlow}
            />
          )}

        </>
    </div>
  );
}

/** Deposit success with confetti celebration */
function DepositSuccess({
  result,
  onReset,
}: {
  result: { txid: string; depositAddress: string; opReturnHex: string };
  onReset: () => void;
}) {
  const [showOpReturn, setShowOpReturn] = useState(false);

  useEffect(() => {
    const fire = () => {
      confetti({
        particleCount: 60,
        spread: 70,
        origin: { y: 0.6 },
        colors: ["#f7931a", "#ffa940", "#14f195", "#9945ff"],
        disableForReducedMotion: true,
      });
    };
    fire();
    const t = setTimeout(fire, 200);
    return () => clearTimeout(t);
  }, []);

  return (
    <motion.div
      className="mb-4"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="p-4 bg-success/10 border border-success/30 rounded-[12px] mb-3">
        <div className="flex items-center gap-2 text-success mb-3">
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: [0, 1.3, 1] }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          >
            <CheckCircle2 className="w-5 h-5" />
          </motion.div>
          <span className="text-body2-semibold">Deposit Broadcast!</span>
        </div>
        <p className="text-caption text-gray mb-2">
          The backend will automatically detect, sweep, and verify it on Solana.
        </p>

        <div className="mb-2">
          <p className="text-caption text-gray mb-1">TxID:</p>
          <a
            href={`${getMempoolExplorerUrl()}/tx/${result.txid}`}
            target="_blank"
            rel="noopener noreferrer"
            className="block text-[10px] font-mono text-btc bg-muted p-2 rounded-[8px] break-all hover:underline"
          >
            {result.txid}
          </a>
        </div>

        <div className="mb-2">
          <p className="text-caption text-gray mb-1">Deposit Address:</p>
          <code className="block text-[10px] font-mono text-btc bg-muted p-2 rounded-[8px] break-all">
            {result.depositAddress}
          </code>
        </div>

        <button
          onClick={() => setShowOpReturn(!showOpReturn)}
          className="text-[10px] text-gray hover:text-gray-light transition-colors cursor-pointer"
        >
          {showOpReturn ? "Hide" : "Show"} OP_RETURN Data
        </button>
        {showOpReturn && (
          <div className="mt-2 bg-muted p-2 rounded-[8px] space-y-1.5">
            <div>
              <p className="text-[10px] text-gray">ephemeralPub (32 bytes):</p>
              <code className="block text-[10px] font-mono text-sol break-all">
                {result.opReturnHex.slice(0, 64)}
              </code>
            </div>
            <div>
              <p className="text-[10px] text-gray">npk (32 bytes):</p>
              <code className="block text-[10px] font-mono text-sol break-all">
                {result.opReturnHex.slice(64)}
              </code>
            </div>
          </div>
        )}
      </div>

      <button onClick={onReset} className="btn-secondary w-full">
        <RefreshCw className="w-4 h-4" />
        New Deposit
      </button>
    </motion.div>
  );
}
