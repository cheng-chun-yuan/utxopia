"use client";

import { useState } from "react";
import { getConnectionAdapter } from "@/lib/adapters/connection-adapter";
import {
  Copy, Check, AlertCircle, Key,
  RefreshCw, QrCode, ExternalLink, Send, Tag, Info,
  Zap, Loader2, CheckCircle2
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { cn } from "@/lib/utils";
import { notifyCopied, notifySuccess, notifyError } from "@/lib/notifications";
import {
  prepareStealthDeposit,
  lookupZkeyName,
  decodeStealthMetaAddress,
  bytesToHex,
  createStealthDeposit,
  type StealthMetaAddress,
  type PreparedStealthDeposit,
} from "@zvault/sdk";
import { Tooltip } from "@/components/ui/tooltip";

// Network: "testnet" for tb1p... addresses, "mainnet" for bc1p... addresses
const BITCOIN_NETWORK: "mainnet" | "testnet" = "testnet";

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
  const [showQR, setShowQR] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [addressCopied, setAddressCopied] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [recipientType, setRecipientType] = useState<"zkey" | "address">("zkey");
  const [resolvedMeta, setResolvedMeta] = useState<StealthMetaAddress | null>(null);
  const [stealthDeposit, setStealthDeposit] = useState<PreparedStealthDeposit | null>(null);
  const [resolvingRecipient, setResolvingRecipient] = useState(false);

  const resetFlow = () => {
    // Stealth mode reset
    setShowQR(false);
    setError(null);
    setLoading(false);
    setAddressCopied(false);
    setRecipient("");
    setResolvedMeta(null);
    setStealthDeposit(null);
    // Demo mode reset
    setDemoAmount("10000");
    setDemoResult(null);
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

  // Resolve recipient (zkey name or stealth address - auto-detect)
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
      // Otherwise try as zkey name
      const isLikelyHex = /^[0-9a-fA-F]{100,}$/.test(trimmed);

      if (recipientType === "zkey" || (!isLikelyHex && recipientType === "address")) {
        // Lookup .zkey.sol name on custom name registry
        // Remove .zkey.sol or .zkey suffix if user included it
        const name = trimmed.replace(/\.zkey\.sol$/i, "").replace(/\.zkey$/i, "");
        const connectionAdapter = getConnectionAdapter();
        const result = await lookupZkeyName(connectionAdapter as any, name);
        if (!result) {
          // If in address mode, also try as hex
          if (recipientType === "address") {
            const meta = decodeStealthMetaAddress(trimmed);
            if (meta) {
              setResolvedMeta(meta);
              return;
            }
          }
          setError(`Name "${name}.zkey.sol" not found`);
          return;
        }
        // Use resolved stealth address directly
        setResolvedMeta(result);
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

  // Generate stealth deposit (amount-independent - address works for any amount)
  const generateStealthDeposit = async () => {
    if (!resolvedMeta) {
      setError("Please resolve recipient first");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const prepared = await prepareStealthDeposit({
        recipientMeta: resolvedMeta,
        network: BITCOIN_NETWORK,
      });

      setStealthDeposit(prepared);
      console.log("[Stealth Deposit] Prepared:", {
        address: prepared.btcDepositAddress,
        opReturnSize: prepared.opReturnData.length,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to prepare stealth deposit");
    } finally {
      setLoading(false);
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
              onClick={() => { setRecipientType("zkey"); setRecipient(""); setResolvedMeta(null); }}
              className={cn(
                "flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-[8px] text-caption transition-colors",
                recipientType === "zkey"
                  ? "bg-sol/12 text-sol border border-sol/25"
                  : "bg-muted text-gray border border-gray/15 hover:text-gray-light"
              )}
            >
              <Tag className="w-3.5 h-3.5" />
              .zkey.sol Name
              <Tooltip content="A human-readable name (like alice.zkey.sol) that maps to a stealth address via Solana Name Service.">
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
              {recipientType === "zkey" ? "Recipient .zkey.sol Name" : "Recipient Stealth Address"}
            </label>
            <div className="flex gap-2">
              <div className="flex-1 relative">
                <input
                  type="text"
                  value={recipient}
                  onChange={(e) => { setRecipient(e.target.value); setResolvedMeta(null); setStealthDeposit(null); }}
                  placeholder={recipientType === "zkey" ? "alice" : "alice.zkey.sol or 130 hex chars"}
                  className={cn(
                    "w-full p-3 bg-muted border border-gray/15 rounded-[12px]",
                    "text-body2 font-mono text-foreground placeholder:text-gray",
                    "outline-none focus:border-sol/40 transition-colors",
                    recipientType === "zkey" ? "pr-20" : ""
                  )}
                />
                {recipientType === "zkey" && (
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-body2 text-gray">.zkey.sol</span>
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

          {/* Not found error */}
          {error && !resolvedMeta && (
            <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-[12px]">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-red-400" />
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

          {/* ========== NORMAL MODE: Generate Stealth Deposit ========== */}
          {/* Generate Stealth Deposit Button - amount is determined by actual BTC sent */}
          {!demoMode && resolvedMeta && !stealthDeposit && (
            <button
              onClick={generateStealthDeposit}
              disabled={loading}
              className={cn(
                "btn-primary w-full mb-4",
                "disabled:bg-gray/20 disabled:text-gray disabled:cursor-not-allowed"
              )}
            >
              {loading ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <Send className="w-4 h-4" />
                  Generate Deposit Address
                </>
              )}
            </button>
          )}

          {/* Stealth Deposit Result (Normal Mode) */}
          {!demoMode && stealthDeposit && (
            <>
              {/* Deposit Address */}
              <div className="gradient-bg-bitcoin p-4 rounded-[12px] mb-4">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-caption text-gray">Send BTC to this address</p>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setShowQR(!showQR)}
                      className={cn(
                        "p-1.5 rounded-[6px] transition-colors",
                        showQR ? "bg-btc/20 text-btc" : "bg-btc/10 text-btc hover:bg-btc/20"
                      )}
                    >
                      <QrCode className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => { navigator.clipboard.writeText(stealthDeposit.btcDepositAddress); setAddressCopied(true); notifyCopied("Deposit address"); setTimeout(() => setAddressCopied(false), 2000); }}
                      className="p-1.5 rounded-[6px] bg-btc/10 hover:bg-btc/20 transition-colors"
                    >
                      {addressCopied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4 text-btc" />}
                    </button>
                  </div>
                </div>
                <code className="text-body2 font-mono text-btc break-all block">
                  {stealthDeposit.btcDepositAddress}
                </code>
              </div>

              {/* QR Code */}
              {showQR && (
                <div
                  className="flex justify-center p-4 rounded-[12px] mb-4"
                  role="img"
                  aria-label={`QR code for stealth deposit address ${stealthDeposit.btcDepositAddress}`}
                >
                  <button
                    onClick={() => { navigator.clipboard.writeText(stealthDeposit.btcDepositAddress); setAddressCopied(true); notifyCopied("Deposit address"); setTimeout(() => setAddressCopied(false), 2000); }}
                    className="relative group cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-btc focus-visible:ring-offset-2 rounded-lg"
                    aria-label="Click to copy deposit address"
                  >
                    <QRCodeSVG
                      value={stealthDeposit.btcDepositAddress}
                      size={180}
                      level="M"
                      bgColor="transparent"
                      fgColor="#F7931A"
                    />
                    <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center rounded-lg">
                      <span className="text-white text-caption font-medium">
                        {addressCopied ? "Copied!" : "Tap to copy address"}
                      </span>
                    </div>
                  </button>
                </div>
              )}

              {/* Info */}
              <div className="gradient-bg-card p-4 rounded-[12px] mb-4 border border-sol/20">
                <p className="text-caption text-gray">
                  Send any amount of BTC to this address. Recipient will be able to scan and claim.
                </p>
              </div>

              {/* Important Note */}
              <div className="p-3 bg-btc/10 border border-btc/20 rounded-[12px] mb-4">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-btc shrink-0 mt-0.5" />
                  <div>
                    <p className="text-caption text-btc font-medium">Important</p>
                    <p className="text-caption text-gray">
                      The recipient must scan for this deposit using their stealth keys.
                      Only they can see and claim this deposit.
                    </p>
                  </div>
                </div>
              </div>

              {/* View on explorer */}
              <a
                href={`https://mempool.space/testnet/address/${stealthDeposit.btcDepositAddress}`}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-tertiary w-full mb-3 justify-center"
              >
                View on Mempool
                <ExternalLink className="w-4 h-4" />
              </a>

              {/* Reset button */}
              <button onClick={resetFlow} className="btn-secondary w-full">
                <RefreshCw className="w-4 h-4" />
                Start New Deposit
              </button>
            </>
          )}
        </>
    </div>
  );
}
