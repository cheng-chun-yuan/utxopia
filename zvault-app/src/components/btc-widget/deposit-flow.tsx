"use client";

import { useState } from "react";
import { getConnectionAdapter } from "@/lib/adapters/connection-adapter";
import {
  Check, AlertCircle, Key, Wallet,
  RefreshCw, ExternalLink, Tag, Info,
  Zap, Loader2, CheckCircle2, ArrowRight,
  Hash, FileText, ArrowLeftRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { notifySuccess, notifyError } from "@/lib/notifications";
import {
  resolveSnsName,
  decodeStealthMetaAddress,
  bytesToHex,
  hexToBytes,
  createStealthDeposit,
  createNonInteractiveDeposit,
  buildDepositPsbt,
  selectUtxos,
  getConfig,
  type StealthMetaAddress,
  type BuildDepositPsbtResult,
} from "@zvault/sdk";
import { Tooltip } from "@/components/ui/tooltip";
import { useBitcoinWalletStore } from "@/stores/bitcoin-wallet-store";
import { getBtcSignerNetwork } from "@/lib/btc-network";

export function DepositFlow() {
  // Demo mode state (default ON for hackathon)
  const [demoMode, setDemoMode] = useState(true);
  const [demoAmount, setDemoAmount] = useState("10000");
  const [demoSubmitting, setDemoSubmitting] = useState(false);
  const [demoResult, setDemoResult] = useState<{
    signature: string;
    ephemeralPubKey?: string;
  } | null>(null);

  // Stealth mode state
  const [error, setError] = useState<string | null>(null);
  const [recipient, setRecipient] = useState("");
  const [recipientType, setRecipientType] = useState<"btcpro" | "address">("btcpro");
  const [resolvedMeta, setResolvedMeta] = useState<StealthMetaAddress | null>(null);
  const [resolvingRecipient, setResolvingRecipient] = useState(false);

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
  const btcWallet = useBitcoinWalletStore();

  const resetFlow = () => {
    // Stealth mode reset
    setError(null);
    setRecipient("");
    setResolvedMeta(null);
    // Demo mode reset
    setDemoAmount("10000");
    setDemoResult(null);
    // Wallet deposit reset
    setWalletDepositAmount("10000");
    setWalletDepositResult(null);
    setDepositPreview(null);
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
      // Create stealth deposit (single ephemeral key pattern)
      const stealthDepositData = await createStealthDeposit(resolvedMeta, amount);

      // Call API - relayer submits transaction (keeps user anonymous)
      const response = await fetch("/api/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "stealth",
          ephemeralPub: bytesToHex(stealthDepositData.ephemeralPub),
          commitment: bytesToHex(stealthDepositData.commitment),
          encryptedAmount: bytesToHex(stealthDepositData.encryptedAmount),
          amount: amount.toString(), // For merkle tree indexing
        }),
      });

      const result = await response.json();
      if (!result.success) {
        throw new Error(result.error || "Failed to submit demo stealth deposit");
      }

      setDemoResult({
        signature: result.signature,
        ephemeralPubKey: bytesToHex(stealthDepositData.ephemeralPub),
      });

      notifySuccess("Mock stealth deposit added on-chain!");
    } catch (err) {
      console.error("Demo deposit error:", err);
      setError(err instanceof Error ? err.message : "Failed to submit demo deposit");
    } finally {
      setDemoSubmitting(false);
    }
  };

  // Resolve recipient (.btcpro.sol name or stealth address - auto-detect)
  const resolveRecipient = async () => {
    if (!recipient.trim()) {
      setError("Please enter a recipient");
      return;
    }

    setResolvingRecipient(true);
    setError(null);
    setResolvedMeta(null);

    const trimmed = recipient.trim();

    try {
      // Auto-detect: if it looks like hex (long, only hex chars), try as address first
      // Otherwise try as .btcpro.sol name
      const isLikelyHex = /^[0-9a-fA-F]{100,}$/.test(trimmed);

      if (recipientType === "btcpro" || (!isLikelyHex && recipientType === "address")) {
        // Lookup via SNS subdomain (.btcpro.sol)
        const config = getConfig();
        const parentDomain = config.snsParentDomain || "btcpro";
        const name = trimmed
          .replace(new RegExp(`\\.${parentDomain}\\.sol$`, "i"), "")
          .replace(new RegExp(`\\.${parentDomain}$`, "i"), "")
          .toLowerCase();
        const connectionAdapter = getConnectionAdapter();
        const result = await resolveSnsName(connectionAdapter as any, name);
        if (!result) {
          // If in address mode, also try as hex
          if (recipientType === "address") {
            const meta = decodeStealthMetaAddress(trimmed);
            if (meta) {
              setResolvedMeta(meta);
              return;
            }
          }
          setError(`Name "${name}.${parentDomain}.sol" not found`);
          return;
        }
        // Convert SnsStealthAddress → StealthMetaAddress
        const meta: StealthMetaAddress = {
          spendingPubKey: result.spendingPubKey,
          viewingPubKey: result.viewingPubKey,
          mpk: new Uint8Array(32),
        };
        setResolvedMeta(meta);
      } else {
        // Parse raw stealth address (hex encoded)
        // Try to decode as hex stealth meta-address
        const meta = decodeStealthMetaAddress(trimmed);
        if (!meta) {
          setError("Invalid stealth address format. Expected 130 hex characters (65 bytes).");
          return;
        }
        setResolvedMeta(meta);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resolve recipient");
    } finally {
      setResolvingRecipient(false);
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

      setWalletDepositResult({
        txid,
        depositAddress: depositPreview.depositAddress,
        opReturnHex: depositPreview.opReturnHex,
      });
      setDepositPreview(null);
      notifySuccess(`Deposit broadcast! TxID: ${txid.slice(0, 12)}...`);
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
      {/* Demo Mode Toggle */}
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

      {/* ========== STEALTH MODE (Send by Stealth) ========== */}
      <>
          {/* Recipient Type Toggle */}
          <div className="flex gap-2 mb-3">
            <button
              onClick={() => { setRecipientType("btcpro"); setRecipient(""); setResolvedMeta(null); }}
              className={cn(
                "flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-[8px] text-caption transition-colors",
                recipientType === "btcpro"
                  ? "bg-sol/12 text-sol border border-sol/25"
                  : "bg-muted text-gray border border-gray/15 hover:text-gray-light"
              )}
            >
              <Tag className="w-3.5 h-3.5" />
              .btcpro.sol Name
              <Tooltip content="A human-readable name (like alice.btcpro.sol) that maps to a stealth address via Solana Name Service.">
                <Info className="w-3 h-3 opacity-60" />
              </Tooltip>
            </button>
            <button
              onClick={() => { setRecipientType("address"); setRecipient(""); setResolvedMeta(null); }}
              className={cn(
                "flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-[8px] text-caption transition-colors",
                recipientType === "address"
                  ? "bg-sol/12 text-sol border border-sol/25"
                  : "bg-muted text-gray border border-gray/15 hover:text-gray-light"
              )}
            >
              <Key className="w-3.5 h-3.5" />
              Stealth Address
            </button>
          </div>

          {/* Recipient Input */}
          <div className="mb-4">
            <label className="text-body2 text-gray-light pl-2 mb-2 block">
              {recipientType === "btcpro" ? "Recipient .btcpro.sol Name" : "Recipient Stealth Address"}
            </label>
            <div className="flex gap-2">
              <div className="flex-1 relative">
                <input
                  type="text"
                  value={recipient}
                  onChange={(e) => { setRecipient(e.target.value); setResolvedMeta(null); }}
                  placeholder={recipientType === "btcpro" ? "alice" : "alice.btcpro.sol or 130 hex chars"}
                  className={cn(
                    "w-full p-3 bg-muted border border-gray/15 rounded-[12px]",
                    "text-body2 font-mono text-foreground placeholder:text-gray",
                    "outline-none focus:border-sol/40 transition-colors",
                    recipientType === "btcpro" ? "pr-20" : ""
                  )}
                />
                {recipientType === "btcpro" && (
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-body2 text-gray">.btcpro.sol</span>
                )}
              </div>
              <button
                onClick={resolveRecipient}
                disabled={!recipient.trim() || resolvingRecipient}
                className={cn(
                  "px-4 py-2 rounded-[10px] text-body2 transition-colors",
                  "bg-sol hover:bg-sol-dark text-white",
                  "disabled:bg-gray/20 disabled:text-gray disabled:cursor-not-allowed"
                )}
              >
                {resolvingRecipient ? "..." : "Resolve"}
              </button>
            </div>
          </div>

          {/* Error alert */}
          {error && (
            <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-[12px]">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                <span className="text-body2 text-red-400">{error}</span>
              </div>
            </div>
          )}

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
                    href={`https://orbmarkets.io/tx/${demoResult.signature}?cluster=devnet`}
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
                        {btcWallet.balance !== null && ` · Balance: ${(btcWallet.balance / 100_000_000).toFixed(8)} BTC`}
                      </p>

                      <button
                        onClick={buildTxPreview}
                        disabled={buildingPreview || !walletDepositAmount || parseInt(walletDepositAmount) < 546}
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

                      <div className="flex justify-center">
                        <ArrowRight className="w-4 h-4 text-gray" />
                      </div>

                      {/* Output 1: P2TR Deposit */}
                      <div className="p-3 bg-btc/5 border border-btc/20 rounded-[12px]">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[10px] font-mono bg-btc/15 text-btc px-1.5 py-0.5 rounded">Output #1</span>
                          <span className="text-caption text-btc">P2TR Deposit</span>
                        </div>
                        <p className="text-body2 font-mono text-foreground mb-1">
                          {(depositPreview.depositAmountSats / 1e8).toFixed(8)} BTC
                          <span className="text-caption text-gray ml-1">({depositPreview.depositAmountSats.toLocaleString()} sats)</span>
                        </p>
                        <code className="block text-[10px] font-mono text-btc/70 break-all">
                          {depositPreview.depositAddress}
                        </code>
                      </div>

                      {/* Output 2: OP_RETURN */}
                      <div className="p-3 bg-sol/5 border border-sol/20 rounded-[12px]">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[10px] font-mono bg-sol/15 text-sol px-1.5 py-0.5 rounded">Output #2</span>
                          <span className="text-caption text-sol">OP_RETURN (64 bytes)</span>
                        </div>
                        <p className="text-body2 font-mono text-foreground mb-1">0.00000000 BTC</p>
                        <div className="space-y-1">
                          <div>
                            <p className="text-[10px] text-gray">ephemeralPub (32 bytes):</p>
                            <code className="block text-[10px] font-mono text-sol/70 break-all">
                              {depositPreview.opReturnHex.slice(0, 64)}
                            </code>
                          </div>
                          <div>
                            <p className="text-[10px] text-gray">npk (32 bytes):</p>
                            <code className="block text-[10px] font-mono text-sol/70 break-all">
                              {depositPreview.opReturnHex.slice(64)}
                            </code>
                          </div>
                        </div>
                      </div>

                      {/* Output 3: Change (if any) */}
                      {changeAmount > 0 && (
                        <div className="p-3 bg-muted border border-gray/20 rounded-[12px]">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-[10px] font-mono bg-gray/15 text-gray px-1.5 py-0.5 rounded">Output #3</span>
                            <span className="text-caption text-gray-light">Change</span>
                          </div>
                          <p className="text-body2 font-mono text-foreground mb-1">
                            {(changeAmount / 1e8).toFixed(8)} BTC
                            <span className="text-caption text-gray ml-1">({changeAmount.toLocaleString()} sats)</span>
                          </p>
                          <code className="block text-[10px] font-mono text-gray break-all">
                            {btcWallet.address}
                          </code>
                        </div>
                      )}

                      {/* Fee */}
                      <div className="flex items-center justify-between px-2 py-2 border-t border-gray/10">
                        <span className="text-caption text-gray">Estimated Fee</span>
                        <span className="text-caption font-mono text-foreground">
                          {estimatedFee.toLocaleString()} sats
                          <span className="text-gray ml-1">({(estimatedFee / 1e8).toFixed(8)} BTC)</span>
                        </span>
                      </div>

                      {/* Insufficient funds warning */}
                      {insufficientFunds && (
                        <div className="p-2 bg-red-500/10 border border-red-500/20 rounded-[8px]">
                          <div className="flex items-center gap-2">
                            <AlertCircle className="w-3.5 h-3.5 text-red-400" />
                            <span className="text-caption text-red-400">
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
                  <button
                    onClick={() => btcWallet.connect("sats-connect")}
                    disabled={btcWallet.connecting}
                    className={cn(
                      "w-full py-3 rounded-[12px] font-medium transition-colors flex items-center justify-center gap-2",
                      "bg-btc hover:bg-btc/90 text-background",
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
                      "bg-[#eb4b13] hover:bg-[#d44311] text-white",
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
                  <code className="block text-[10px] font-mono text-btc bg-muted p-2 rounded-[8px] break-all">
                    {walletDepositResult.txid}
                  </code>
                </div>

                <div className="mb-2">
                  <p className="text-caption text-gray mb-1">Deposit Address:</p>
                  <code className="block text-[10px] font-mono text-btc bg-muted p-2 rounded-[8px] break-all">
                    {walletDepositResult.depositAddress}
                  </code>
                </div>

                <div>
                  <p className="text-caption text-gray mb-1">OP_RETURN (ephemeralPub + npk):</p>
                  <code className="block text-[10px] font-mono text-sol bg-muted p-2 rounded-[8px] break-all">
                    {walletDepositResult.opReturnHex}
                  </code>
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
