"use client";

import React, { useState, useEffect, useCallback, useMemo, memo } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  AlertCircle, RefreshCw, Clock, CheckCircle2, XCircle,
  ExternalLink, Key, Copy, Check, ArrowDownToLine, Loader2, Search, ChevronDown
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getDepositByAddress,
  getDepositStatus,
  getDepositProgress,
  getStatusMessage,
  isDepositTerminal,
  type DepositStatus,
  type DepositStatusResponse as TrackerDepositStatus,
} from "@/lib/api/deposits";
import { useDepositStatus } from "@/hooks/use-deposit-status";
import { formatBtc, truncateMiddle } from "@/lib/utils/formatting";
import { BitcoinIcon } from "@/components/bitcoin-wallet-selector";
import { useNoteStorage, type StoredNote } from "@/stores";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { getMempoolExplorerUrl } from "@/lib/btc-network";

// =============================================================================
// Status badge — maps backend DepositStatus to UI
// =============================================================================

const STATUS_CONFIG: Record<DepositStatus | "unknown", { label: string; color: string; bg: string; spinning?: boolean }> = {
  pending: { label: "Awaiting BTC", color: "text-warning", bg: "bg-warning/10" },
  detected: { label: "Detected", color: "text-purple", bg: "bg-purple/10", spinning: true },
  confirming: { label: "Confirming", color: "text-purple", bg: "bg-purple/10", spinning: true },
  confirmed: { label: "Confirmed", color: "text-blue-400", bg: "bg-blue-400/10" },
  sweeping: { label: "Sweeping", color: "text-blue-400", bg: "bg-blue-400/10", spinning: true },
  sweep_confirming: { label: "Sweep Confirming", color: "text-blue-400", bg: "bg-blue-400/10", spinning: true },
  verifying: { label: "Verifying on Solana", color: "text-sol", bg: "bg-sol/10", spinning: true },
  ready: { label: "Ready to Claim", color: "text-success", bg: "bg-success/10" },
  claimed: { label: "Claimed", color: "text-success", bg: "bg-success/10" },
  failed: { label: "Failed", color: "text-error", bg: "bg-error/10" },
  unknown: { label: "Unknown", color: "text-gray", bg: "bg-gray/10" },
};

const StatusBadge = memo(({ status }: { status: DepositStatus | "unknown" }) => {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.unknown;
  const Icon = cfg.spinning ? Loader2 : (status === "failed" ? XCircle : status === "claimed" || status === "ready" ? CheckCircle2 : Clock);
  return (
    <span className={cn("flex items-center gap-1 text-xs px-2 py-1 rounded-full", cfg.color, cfg.bg)}>
      <Icon className={cn("h-3 w-3", cfg.spinning && "animate-spin")} />
      {cfg.label}
    </span>
  );
});
StatusBadge.displayName = "StatusBadge";

// Progress bar
const ProgressBar = memo(({ progress }: { progress: number }) => (
  <div className="w-full bg-background rounded-full h-2">
    <div
      className="bg-gradient-to-r from-btc to-btc-light h-2 rounded-full transition-all shadow-[0_0_10px_rgba(247,147,26,0.5)]"
      style={{ width: `${Math.min(progress, 100)}%` }}
    />
  </div>
));
ProgressBar.displayName = "ProgressBar";

// OP_RETURN data display (ephemeralPub + npk)
const OpReturnData = memo(({ ephemeralPub, npk }: { ephemeralPub?: string; npk?: string }) => {
  if (!ephemeralPub && !npk) return null;
  return (
    <div className="space-y-1.5 pt-2 border-t border-gray/15">
      <span className="text-xs text-gray">OP_RETURN (64 bytes)</span>
      <div className="bg-background rounded-lg p-2 space-y-1.5">
        {ephemeralPub && (
          <div>
            <p className="text-[10px] text-gray">ephemeralPub (32 bytes):</p>
            <code className="block text-[10px] font-mono text-purple-400 break-all">{ephemeralPub}</code>
          </div>
        )}
        {npk && (
          <div>
            <p className="text-[10px] text-gray">npk (32 bytes):</p>
            <code className="block text-[10px] font-mono text-purple-400 break-all">{npk}</code>
          </div>
        )}
      </div>
    </div>
  );
});
OpReturnData.displayName = "OpReturnData";

// =============================================================================
// Deposit lifecycle stepper
// =============================================================================

const LIFECYCLE_STEPS = [
  { key: "detected", label: "Detected" },
  { key: "confirmed", label: "Confirmed" },
  { key: "sweeping", label: "Swept" },
  { key: "verifying", label: "Verified" },
  { key: "ready", label: "Ready" },
] as const;

const STATUS_ORDER: Record<string, number> = {
  pending: 0, detected: 1, confirming: 1, confirmed: 2,
  sweeping: 3, sweep_confirming: 3, verifying: 4, ready: 5, claimed: 5,
};

const LifecycleStepper = memo(({ status }: { status: DepositStatus }) => {
  const currentStep = STATUS_ORDER[status] ?? 0;
  return (
    <div className="flex items-center gap-1 w-full">
      {LIFECYCLE_STEPS.map((step, i) => {
        const stepIdx = i + 1; // steps start at 1 (detected)
        const done = currentStep >= stepIdx;
        const active = currentStep === stepIdx;
        return (
          <React.Fragment key={step.key}>
            <div className="flex flex-col items-center flex-1">
              <div className={cn(
                "w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold transition-colors",
                done ? "bg-btc text-white" : active ? "bg-btc/30 text-btc border border-btc" : "bg-gray/15 text-gray"
              )}>
                {done ? <Check className="w-3 h-3" /> : i + 1}
              </div>
              <span className={cn("text-[9px] mt-0.5", done || active ? "text-btc" : "text-gray")}>{step.label}</span>
            </div>
            {i < LIFECYCLE_STEPS.length - 1 && (
              <div className={cn("h-0.5 flex-1 rounded-full -mt-3", currentStep > stepIdx ? "bg-btc" : "bg-gray/15")} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
});
LifecycleStepper.displayName = "LifecycleStepper";

// =============================================================================
// Deposit card — uses useDepositStatus hook for live updates
// =============================================================================

const DepositCard = memo(({ note }: { note: StoredNote }) => {
  const { copied, copy } = useCopyToClipboard();
  const depositId = note.depositId || null;

  const {
    status,
    confirmations,
    sweepConfirmations,
    canClaim,
    btcTxid,
    sweepTxid,
    solanaTx,
    error,
    isLoading,
    deposit,
    refresh,
  } = useDepositStatus(depositId, { pollInterval: 15000 });

  // Fall back to address-based lookup if no depositId
  const [addrStatus, setAddrStatus] = useState<TrackerDepositStatus | null>(null);
  const [addrLoading, setAddrLoading] = useState(false);

  const fetchByAddress = useCallback(async () => {
    if (depositId) return; // using hook instead
    setAddrLoading(true);
    try {
      const data = await getDepositByAddress(note.taprootAddress);
      setAddrStatus(data);
      // Save depositId for future use
      if (data.id) {
        useNoteStorage().updateNote(note.commitment, { depositId: data.id });
      }
    } catch {
      // No deposit found in tracker — that's okay
    } finally {
      setAddrLoading(false);
    }
  }, [depositId, note.taprootAddress, note.commitment]);

  useEffect(() => {
    if (!depositId) fetchByAddress();
  }, [depositId, fetchByAddress]);

  // Resolve effective status
  const effectiveStatus: DepositStatus = status || addrStatus?.status || "pending";
  const effectiveConfirmations = confirmations || addrStatus?.confirmations || 0;
  const effectiveSweepConfirmations = sweepConfirmations || addrStatus?.sweep_confirmations || 0;
  const effectiveTxid = btcTxid || addrStatus?.btc_txid;
  const effectiveSweepTxid = sweepTxid || addrStatus?.sweep_txid;
  const effectiveSolanaTx = solanaTx || addrStatus?.solana_tx;
  const effectiveError = error || addrStatus?.error;
  const effectiveNpk = deposit?.npk || addrStatus?.npk;
  const effectiveEphemeralPub = deposit?.ephemeral_pub || addrStatus?.ephemeral_pub;

  const progress = getDepositProgress(effectiveStatus, effectiveConfirmations, effectiveSweepConfirmations);
  const loading = isLoading || addrLoading;

  return (
    <div className="p-4 bg-muted border border-gray/15 rounded-xl space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-sm text-white flex items-center gap-2">
          <BitcoinIcon className="w-4 h-4" />
          {formatBtc(note.amountSats)} BTC
        </span>
        <div className="flex items-center gap-2">
          <button onClick={depositId ? refresh : fetchByAddress} disabled={loading} className="p-1.5 rounded bg-gray/10 hover:bg-gray/20">
            <RefreshCw className={cn("w-3 h-3 text-gray", loading && "animate-spin")} />
          </button>
          <StatusBadge status={effectiveStatus} />
        </div>
      </div>

      {/* Lifecycle Stepper */}
      {effectiveStatus !== "pending" && effectiveStatus !== "failed" && (
        <LifecycleStepper status={effectiveStatus} />
      )}

      {/* Progress bar */}
      {effectiveStatus !== "pending" && effectiveStatus !== "failed" && (
        <div className="space-y-1">
          <div className="flex justify-between text-[10px] text-gray">
            <span>{getStatusMessage(effectiveStatus)}</span>
            <span>{progress}%</span>
          </div>
          <ProgressBar progress={progress} />
        </div>
      )}

      {/* Address */}
      <div className="space-y-1">
        <span className="text-xs text-gray">Deposit Address</span>
        <div className="flex items-center gap-2">
          <code className="flex-1 text-xs font-mono text-btc break-all">{note.taprootAddress}</code>
          <button onClick={() => copy(note.taprootAddress)} className="p-1.5 rounded bg-btc/10 hover:bg-btc/20">
            {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3 text-btc" />}
          </button>
        </div>
      </div>

      {/* Secret indicator */}
      {note.secretNote && (
        <div className="flex items-center gap-2 text-xs">
          <Key className="w-3 h-3 text-privacy" />
          <span className="text-gray">Secret saved locally</span>
        </div>
      )}

      {/* Confirmations */}
      {effectiveTxid && (
        <div className="space-y-2 pt-2 border-t border-gray/15">
          <div className="flex justify-between text-xs">
            <span className="text-gray">BTC Confirmations</span>
            <span className="text-gray-light">{effectiveConfirmations}</span>
          </div>
          <a
            href={`${getMempoolExplorerUrl()}/tx/${effectiveTxid}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs text-btc hover:text-btc-light"
          >
            View deposit tx <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      )}

      {/* Sweep tx */}
      {effectiveSweepTxid && (
        <div className="space-y-1 pt-1">
          <div className="flex justify-between text-xs">
            <span className="text-gray">Sweep Confirmations</span>
            <span className="text-gray-light">{effectiveSweepConfirmations}</span>
          </div>
          <a
            href={`${getMempoolExplorerUrl()}/tx/${effectiveSweepTxid}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300"
          >
            View sweep tx <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      )}

      {/* Solana verification */}
      {effectiveSolanaTx && (
        <div className="pt-1">
          <a
            href={`https://explorer.solana.com/tx/${effectiveSolanaTx}?cluster=devnet`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs text-sol hover:text-sol/80"
          >
            View Solana verification <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      )}

      {/* Error */}
      {effectiveError && (
        <div className="flex items-center gap-2 p-2 bg-error/10 border border-error/30 rounded-lg text-xs text-error">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          {effectiveError}
        </div>
      )}

      {/* OP_RETURN data */}
      <OpReturnData ephemeralPub={effectiveEphemeralPub} npk={effectiveNpk} />

      {/* Mempool link */}
      <a
        href={`${getMempoolExplorerUrl()}/address/${note.taprootAddress}`}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center justify-center gap-2 text-xs text-gray hover:text-gray-light pt-2"
      >
        View on Mempool <ExternalLink className="w-3 h-3" />
      </a>
    </div>
  );
});
DepositCard.displayName = "DepositCard";

// =============================================================================
// Main BalanceView
// =============================================================================

export function BalanceView() {
  const { publicKey, connected } = useWallet();
  const { notes, isLoaded } = useNoteStorage();

  const [mounted, setMounted] = useState(false);

  // Address lookup (collapsed by default)
  const [showLookup, setShowLookup] = useState(false);
  const [lookupAddress, setLookupAddress] = useState("");
  const [lookupResult, setLookupResult] = useState<TrackerDepositStatus | null>(null);
  const [isLooking, setIsLooking] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  useEffect(() => { setMounted(true); }, []);

  const handleLookup = useCallback(async () => {
    if (!lookupAddress.trim() || (!lookupAddress.startsWith("tb1p") && !lookupAddress.startsWith("bc1p"))) {
      setLookupError("Enter a valid taproot address (tb1p... or bc1p...)");
      return;
    }
    setLookupError(null);
    setIsLooking(true);
    try {
      const status = await getDepositByAddress(lookupAddress.trim());
      setLookupResult(status);
    } catch (err) {
      setLookupError(err instanceof Error ? err.message : "No deposit found for this address");
    } finally {
      setIsLooking(false);
    }
  }, [lookupAddress]);

  const sortedNotes = useMemo(() => [...notes].sort((a, b) => b.createdAt - a.createdAt), [notes]);

  if (!mounted || !isLoaded) {
    return (
      <div className="flex flex-col items-center py-12">
        <div className="w-12 h-12 mb-4 border-4 border-gray/15 border-t-pink-400 rounded-full animate-spin" />
        <p className="text-sm text-gray">Loading...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ArrowDownToLine className="w-5 h-5 text-btc" />
          <p className="text-lg font-semibold text-white">Bitcoin Deposits</p>
        </div>
      </div>

      {/* Wallet connection */}
      {connected && publicKey && (
        <div className="flex items-center gap-2 p-2 bg-privacy/10 border border-privacy/30 rounded-lg">
          <div className="w-2 h-2 rounded-full bg-privacy" />
          <span className="text-xs text-privacy">Solana: {truncateMiddle(publicKey.toBase58(), 6)}</span>
        </div>
      )}

      {/* Deposit cards */}
      {sortedNotes.length > 0 ? (
        <div className="space-y-3">
          {sortedNotes.map((note, index) => (
            <DepositCard
              key={`${note.commitment}-${index}`}
              note={note}
            />
          ))}
        </div>
      ) : (
        <div className="text-center py-8">
          <div className="rounded-full bg-btc/10 p-4 w-fit mx-auto mb-4">
            <BitcoinIcon className="h-8 w-8" />
          </div>
          <p className="text-sm text-gray">No deposits yet</p>
          <p className="text-xs text-gray/40 mt-1">Create a deposit to see your Bitcoin activity</p>
        </div>
      )}

      {/* Address lookup — uses backend tracker */}
      <div className="border-t border-gray/15 pt-4">
        <button onClick={() => setShowLookup(!showLookup)} className="flex items-center justify-between w-full">
          <div className="flex items-center gap-2">
            <Search className="w-4 h-4 text-btc" />
            <span className="text-sm text-gray-light">Check Address Status</span>
          </div>
          <ChevronDown className={cn("w-4 h-4 text-gray transition-transform", showLookup && "rotate-180")} />
        </button>

        {showLookup && (
          <div className="mt-3 space-y-3">
            <input
              type="text"
              value={lookupAddress}
              onChange={(e) => setLookupAddress(e.target.value)}
              placeholder="tb1p... or bc1p..."
              className="w-full p-2.5 bg-muted border border-gray/15 rounded-lg text-xs font-mono text-white placeholder:text-gray/40 outline-none focus:border-orange-500/50"
            />
            {lookupError && (
              <div className="flex items-center gap-2 p-2 bg-red-500/10 border border-red-500/30 rounded-lg text-red-500 text-xs">
                <AlertCircle className="w-3.5 h-3.5" /> {lookupError}
              </div>
            )}
            <button
              onClick={handleLookup}
              disabled={isLooking || !lookupAddress.trim()}
              className="w-full p-2.5 rounded-lg text-xs font-medium bg-btc/10 border border-btc/30 text-btc hover:bg-btc/20 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {isLooking ? <><Loader2 className="w-4 h-4 animate-spin" /> Checking...</> : <><Search className="w-4 h-4" /> Check Status</>}
            </button>

            {lookupResult && (
              <div className="p-3 bg-muted border border-gray/15 rounded-lg space-y-2">
                <div className="flex justify-between">
                  <span className="text-xs text-gray">Status</span>
                  <StatusBadge status={lookupResult.status} />
                </div>
                {lookupResult.amount_sats > 0 && (
                  <div className="flex justify-between">
                    <span className="text-xs text-gray">Amount</span>
                    <span className="text-xs text-btc">{formatBtc(lookupResult.amount_sats)} BTC</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-xs text-gray">Progress</span>
                  <span className="text-xs text-gray-light">{getStatusMessage(lookupResult.status)}</span>
                </div>
                <ProgressBar progress={getDepositProgress(lookupResult.status, lookupResult.confirmations, lookupResult.sweep_confirmations)} />
                {lookupResult.btc_txid && (
                  <a
                    href={`${getMempoolExplorerUrl()}/tx/${lookupResult.btc_txid}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-xs text-btc"
                  >
                    View tx <ExternalLink className="w-3 h-3" />
                  </a>
                )}
                <OpReturnData ephemeralPub={lookupResult.ephemeral_pub} npk={lookupResult.npk} />
                <button onClick={() => { setLookupResult(null); setLookupAddress(""); }} className="text-xs text-gray hover:text-gray-light">
                  Clear
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
