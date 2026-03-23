"use client";

/**
 * BalanceView — displays user's shielded BTC deposits and their lifecycle status.
 *
 * Shows two deposit categories:
 * - Ongoing: deposits in progress (detecting → confirming → sweeping → verifying)
 * - Minted: successfully verified and minted as zkBTC commitments
 *
 * Also includes an address lookup tool to check deposit status by Taproot address.
 *
 * Sub-components (all defined inline as memoized):
 * - StatusBadge: color-coded deposit status pill
 * - ProgressBar: visual progress indicator
 * - OpReturnData: collapsible OP_RETURN data display
 * - TimelineStep: expandable timeline step with icon + content
 * - TxLink: transaction link with copy button
 * - DepositCard: full deposit card with expandable timeline
 * - RetryButton: retry failed deposits
 *
 * TODO(backward-compat): Method 2 fallback (explorer + inbox notes join by commitment)
 * can be removed once all deposits flow through the backend tracker with npk matching.
 */

import React, { useState, useEffect, useCallback, useMemo, memo } from "react";
import Image from "next/image";
import {
  AlertCircle, Clock, CheckCircle2, XCircle, RotateCcw,
  ExternalLink, Copy, Check, ArrowDownToLine, Loader2, Search, ChevronDown, ArrowRight
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getDepositByAddress,
  getDepositProgress,
  getStatusMessage,
  retryDeposit,
  type DepositStatus,
  type DepositStatusResponse as TrackerDepositStatus,
} from "@/lib/api/deposits";
import { formatBtc, formatSats, truncateMiddle } from "@/lib/utils/formatting";
import { BitcoinIcon } from "@/components/bitcoin-wallet-selector";
import { SUPPORTED_TOKENS, type SupportedToken } from "@/lib/supported-tokens";

/** Resolve token config from deposit data */
function getDepositToken(deposit: { token_symbol?: string; instruction_disc?: number }): SupportedToken {
  const sym = deposit.token_symbol;
  if (sym) {
    const found = SUPPORTED_TOKENS.find((t) => t.symbol === sym || t.shieldedSymbol === sym);
    if (found) return found;
  }
  return SUPPORTED_TOKENS[0]; // default: BTC
}

/** Format amount using token decimals, trim trailing zeros */
function formatTokenAmt(rawAmount: number, token: SupportedToken): string {
  const num = rawAmount / 10 ** token.decimals;
  if (num < 0.01 && num > 0) return num.toFixed(token.decimals).replace(/(\.\d{2,}?)0+$/, "$1");
  const s = num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: token.decimals > 2 ? token.decimals : 2 });
  return s.replace(/(\.\d{2,}?)0+$/, "$1");
}
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { getMempoolExplorerUrl } from "@/lib/btc-network";
import { getSolanaExplorerTxUrl } from "@/lib/solana-network";
import { useBackendDeposits } from "@/hooks/use-backend-deposits";
import { useDeposits } from "@/hooks/use-explorer";
import { useAegisStore, type InboxNote } from "@/stores";
import { isDepositForViewer, hexToBytes, bytesToBigint } from "@aegis/sdk";

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
  ready: { label: "Minted", color: "text-success", bg: "bg-success/10" },
  claimed: { label: "Minted", color: "text-success", bg: "bg-success/10" },
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

// OP_RETURN data display (collapsible)
const OpReturnData = memo(({ ephemeralPub, npk }: { ephemeralPub?: string; npk?: string }) => {
  const [open, setOpen] = useState(false);
  if (!ephemeralPub && !npk) return null;
  return (
    <div className="pt-2 border-t border-gray/15">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-xs text-gray hover:text-gray-light cursor-pointer transition-colors w-full"
      >
        <ChevronDown className={cn("w-3 h-3 transition-transform", open && "rotate-180")} />
        OP_RETURN (64 bytes)
      </button>
      {open && (
        <div className="bg-background rounded-lg p-2 mt-1.5 space-y-1.5">
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
      )}
    </div>
  );
});
OpReturnData.displayName = "OpReturnData";

const STATUS_ORDER: Record<string, number> = {
  pending: 0, detected: 1, confirming: 1, confirmed: 2,
  sweeping: 3, sweep_confirming: 3, verifying: 4, ready: 5, claimed: 5,
};

// =============================================================================
// Unified deposit card (DepositCard style)
// =============================================================================

// Timeline step component
const TimelineStep = memo(({
  done,
  active,
  title,
  children,
  isLast,
}: {
  done: boolean;
  active: boolean;
  title: string;
  children?: React.ReactNode;
  isLast?: boolean;
}) => {
  const [expanded, setExpanded] = useState(false);
  const hasChildren = !!children;

  return (
    <div className="flex gap-3">
      {/* Timeline line + circle */}
      <div className="flex flex-col items-center">
        <div className={cn(
          "w-6 h-6 rounded-full flex items-center justify-center shrink-0",
          done ? "bg-success/20" : active ? "bg-btc/20 border border-btc/50" : "bg-gray/10"
        )}>
          {done ? (
            <CheckCircle2 className="w-4 h-4 text-success" />
          ) : active ? (
            <Loader2 className="w-3.5 h-3.5 text-btc animate-spin" />
          ) : (
            <Clock className="w-3 h-3 text-gray/40" />
          )}
        </div>
        {!isLast && (
          <div className={cn("w-px flex-1 min-h-[16px]", done ? "bg-success/30" : "bg-gray/10")} />
        )}
      </div>

      {/* Content */}
      <div className={cn("pb-4 flex-1", isLast && "pb-0")}>
        <p className={cn(
          "text-sm font-medium",
          done ? "text-white" : active ? "text-white" : "text-gray/40"
        )}>{title}</p>
        {hasChildren && (done || active) && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 text-[11px] text-gray hover:text-gray-light mt-1.5 cursor-pointer transition-colors"
          >
            <ChevronDown className={cn("w-3 h-3 transition-transform", expanded && "rotate-180")} />
            Details
          </button>
        )}
        {expanded && children && (
          <div className="mt-2 space-y-1.5 pl-1">
            {children}
          </div>
        )}
      </div>
    </div>
  );
});
TimelineStep.displayName = "TimelineStep";

// Tx link helper
const TxLink = memo(({ href, label, color = "text-btc/70 hover:text-btc" }: { href: string; label: string; color?: string }) => {
  const { copied, copy } = useCopyToClipboard();
  const id = href.split("/").pop() || "";
  return (
    <div className="flex items-center gap-1.5">
      <a href={href} target="_blank" rel="noopener noreferrer"
        className={cn("flex items-center gap-1 text-[11px] cursor-pointer transition-colors", color)}>
        {label} <ExternalLink className="w-2.5 h-2.5" />
      </a>
      <code className="text-[10px] font-mono text-gray">{truncateMiddle(id, 6)}</code>
      <button onClick={() => copy(id)} className="cursor-pointer p-0.5">
        {copied ? <Check className="w-2.5 h-2.5 text-success" /> : <Copy className="w-2.5 h-2.5 text-gray/40 hover:text-gray" />}
      </button>
    </div>
  );
});
TxLink.displayName = "TxLink";

const DepositCard = memo(({ deposit }: { deposit: TrackerDepositStatus & { token_symbol?: string; instruction_disc?: number } }) => {
  const { copied, copy } = useCopyToClipboard();
  const status = deposit.status;
  const stepOrder = STATUS_ORDER[status] ?? 0;
  const [expanded, setExpanded] = useState(false);
  const token = getDepositToken(deposit);
  const isBtcNative = token.isBtcNative;

  return (
    <div className="space-y-4">
      {/* Amount header card — click to expand timeline */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full p-4 rounded-xl bg-linear-to-br from-muted to-muted/50 border border-gray/15 cursor-pointer hover:border-gray/25 transition-colors text-left"
      >
        <div className="flex items-center justify-between mb-3">
          <StatusBadge status={status} />
          <ChevronDown className={cn("w-3.5 h-3.5 text-gray transition-transform", expanded && "rotate-180")} />
        </div>
        <div className="space-y-2">
          {isBtcNative ? (
            <>
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray">Deposit</span>
                <span className="flex items-center gap-1.5">
                  <BitcoinIcon className="w-4 h-4" />
                  <span className="text-base font-semibold text-white">{formatBtc(deposit.btc_deposit_amount_sats ?? deposit.amount_sats)}</span>
                  <span className="text-xs text-btc">BTC</span>
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray">Receive</span>
                <span className="flex items-center gap-1.5">
                  <Image src="/zkbtc.png" alt="zkBTC" width={16} height={16} className="rounded-full" />
                  {deposit.minted_sats != null ? (
                    <span className="text-base font-semibold text-white">{formatBtc(deposit.minted_sats)}</span>
                  ) : (
                    <span className="text-base font-semibold text-gray">~</span>
                  )}
                  <span className="text-xs text-purple">zkBTC</span>
                </span>
              </div>
              {(deposit.btc_deposit_amount_sats || deposit.sweep_fee_sats != null) && (
                <div className="flex items-center justify-between pt-1 border-t border-gray/10">
                  <span className="text-[10px] text-gray">Network Fee</span>
                  <span className="text-[10px] text-gray">
                    -{formatSats(deposit.sweep_fee_sats ?? ((deposit.btc_deposit_amount_sats ?? deposit.amount_sats) - (deposit.minted_sats ?? deposit.amount_sats)))} sats
                  </span>
                </div>
              )}
            </>
          ) : (
            <div className="flex items-center gap-3">
              <img src={token.shieldedLogo} alt={token.shieldedSymbol} className="w-6 h-6 rounded-full shrink-0" />
              <div className="flex-1 min-w-0">
                <span className="text-xs text-gray">{token.symbol} shielded</span>
              </div>
              <span className="flex items-center gap-1.5">
                <span className="text-base font-semibold text-white font-mono">{formatTokenAmt(deposit.amount_sats, token)}</span>
                <span className="text-xs text-purple">{token.shieldedSymbol}</span>
              </span>
            </div>
          )}
        </div>
      </button>

      {/* Timeline — expanded on click */}
      {expanded && (<>
      <div className="px-1">
        {/* Step 1: Deposit Detected */}
        <TimelineStep
          done={stepOrder >= 1}
          active={stepOrder === 1}
          title="Deposit BTC to Reserve"
          isLast={false}
        >
          {deposit.btc_txid && (
            <TxLink
              href={`${getMempoolExplorerUrl()}/tx/${deposit.btc_txid}`}
              label="Deposit tx"
            />
          )}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-gray">Address</span>
            <code className="text-[10px] font-mono text-btc/70 truncate max-w-[180px]">{deposit.taproot_address}</code>
            <button onClick={() => copy(deposit.taproot_address)} className="cursor-pointer p-0.5">
              {copied ? <Check className="w-2.5 h-2.5 text-success" /> : <Copy className="w-2.5 h-2.5 text-gray/40 hover:text-gray" />}
            </button>
          </div>
          {deposit.confirmations > 0 && (
            <span className="text-[10px] text-gray">{deposit.confirmations} confirmation{deposit.confirmations !== 1 ? "s" : ""}</span>
          )}
        </TimelineStep>

        {/* Step 2: Sweep to Pool */}
        <TimelineStep
          done={stepOrder >= 3}
          active={stepOrder === 3}
          title="Sweep to Pool"
          isLast={false}
        >
          {deposit.sweep_txid && (
            <TxLink
              href={`${getMempoolExplorerUrl()}/tx/${deposit.sweep_txid}`}
              label="Sweep tx"
            />
          )}
          {deposit.sweep_confirmations > 0 && (
            <span className="text-[10px] text-gray">{deposit.sweep_confirmations} confirmation{deposit.sweep_confirmations !== 1 ? "s" : ""}</span>
          )}
        </TimelineStep>

        {/* Step 3: SPV Verification */}
        <TimelineStep
          done={stepOrder >= 4}
          active={stepOrder === 4}
          title="SPV Verification"
          isLast={false}
        >
          {deposit.solana_tx && (
            <>
              <span className={cn(
                "inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full",
                "bg-success/10 text-success"
              )}>
                <CheckCircle2 className="w-2.5 h-2.5" /> SPV Confirmed
              </span>
              <TxLink
                href={getSolanaExplorerTxUrl(deposit.solana_tx)}
                label="Solana tx"
                color="text-sol/70 hover:text-sol"
              />
            </>
          )}
        </TimelineStep>

        {/* Step 4: Mint zkBTC */}
        <TimelineStep
          done={stepOrder >= 5}
          active={false}
          title="Mint zkBTC"
          isLast
        />
      </div>

      {/* Error */}
      {deposit.error && (
        <div className="flex items-center gap-2 p-2 bg-error/10 border border-error/30 rounded-lg text-xs text-error">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          {deposit.error}
        </div>
      )}

      {/* OP_RETURN — collapsible */}
      <OpReturnData ephemeralPub={deposit.ephemeral_pub} npk={deposit.npk} />
      </> )}
    </div>
  );
});
DepositCard.displayName = "DepositCard";

// =============================================================================
// Retry button (shared between DepositCard and address lookup)
// =============================================================================

const RetryButton = memo(({ depositId, onRetried }: { depositId: string; onRetried: () => void }) => {
  const [retrying, setRetrying] = useState(false);
  return (
    <button
      onClick={async () => {
        setRetrying(true);
        try {
          await retryDeposit(depositId);
          onRetried();
        } catch (err) {
          console.error("Retry failed:", err);
        } finally {
          setRetrying(false);
        }
      }}
      disabled={retrying}
      className="w-full p-2 rounded-lg text-xs font-medium bg-btc/10 border border-btc/30 text-btc hover:bg-btc/20 disabled:opacity-50 flex items-center justify-center gap-2"
    >
      {retrying ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Retrying...</> : <><RotateCcw className="w-3.5 h-3.5" /> Retry Deposit</>}
    </button>
  );
});
RetryButton.displayName = "RetryButton";

// =============================================================================
// Main BalanceView
// =============================================================================

export function BalanceView() {
  const { deposits: backendDeposits, isLoading: backendLoading } = useBackendDeposits();
  const { deposits: explorerDeposits, isLoading: explorerLoading } = useDeposits();
  const keys = useAegisStore((s) => s.keys);
  const inboxNotes = useAegisStore((s) => s.inboxNotes);

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

  // Filter deposits belonging to current user:
  // 1. Try tracker deposits (original method, uses npk matching)
  // 2. Fallback: join explorer deposits with inbox notes by commitment
  //    (inbox scanning already identified the user's notes via viewing key)
  const myDeposits = useMemo(() => {
    if (!keys) return [];

    // Method 1: tracker deposits with npk matching
    const fromTracker = backendDeposits.filter((d) => {
      if (!d.ephemeral_pub || !d.npk) return false;
      try {
        const ephPub = hexToBytes(d.ephemeral_pub);
        const npk = bytesToBigint(hexToBytes(d.npk));
        return isDepositForViewer(
          keys.viewingPrivKey, keys.spendingPubKey, keys.nullifyingKey, ephPub, npk,
        );
      } catch { return false; }
    });

    if (fromTracker.length > 0) return fromTracker;

    // Method 2: join explorer deposits with inbox notes by commitment
    // The inbox notes are already filtered to the user's keys (via scanUnifiedNotes)
    const myCommitments = new Set(inboxNotes.map((n) => n.commitmentHex));
    const fromExplorer: TrackerDepositStatus[] = explorerDeposits
      .filter((d) => myCommitments.has(d.commitment))
      .map((d) => ({
        id: d.commitment,
        status: (d.status ?? "claimed") as DepositStatus,
        taproot_address: d.btcMeta?.taprootAddress ?? "",
        amount_sats: d.amountSats,
        confirmations: d.btcMeta?.confirmations ?? 0,
        can_claim: false,
        btc_txid: d.btcMeta?.depositTxid ?? undefined,
        sweep_txid: d.btcMeta?.sweepTxid ?? undefined,
        sweep_confirmations: d.btcMeta?.sweepConfirmations ?? 0,
        solana_tx: d.txSignature ?? undefined,
        leaf_index: d.leafIndex,
        ephemeral_pub: d.ephemeralPub,
        sweep_fee_sats: d.btcMeta?.sweepFeeSats ?? undefined,
        minted_sats: d.btcMeta?.mintedSats ?? undefined,
        error: d.btcMeta?.trackerError ?? undefined,
        created_at: d.timestamp,
        updated_at: d.timestamp,
        btc_deposit_amount_sats: d.btcMeta?.depositAmountSats ?? undefined,
        token_symbol: d.tokenSymbol ?? undefined,
        instruction_disc: d.instructionDisc ?? undefined,
      }));

    return fromExplorer;
  }, [backendDeposits, explorerDeposits, inboxNotes, keys]);

  // Split into ongoing vs minted
  const { ongoing, minted } = useMemo(() => {
    const sorted = [...myDeposits].sort((a, b) => b.updated_at - a.updated_at);
    const ongoing: TrackerDepositStatus[] = [];
    const minted: TrackerDepositStatus[] = [];
    for (const d of sorted) {
      const ext = d as TrackerDepositStatus & { instruction_disc?: number };
      const isShield = ext.instruction_disc === 29;
      if (isShield) {
        // SPL shield — show in minted section
        minted.push(d);
      } else if (d.status === "ready" || d.status === "claimed") {
        minted.push(d);
      } else {
        ongoing.push(d);
      }
    }
    return { ongoing, minted };
  }, [myDeposits]);

  const isLoading = backendLoading || explorerLoading;
  const hasAnyDeposits = myDeposits.length > 0;

  if (!mounted) {
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
          <p className="text-lg font-semibold text-white">Shielded Deposits</p>
        </div>
      </div>

      {/* No keys — prompt to unlock */}
      {!keys && (
        <div className="text-center py-8">
          <p className="text-sm text-gray">Unlock your vault to see your deposits</p>
        </div>
      )}

      {/* Ongoing deposits */}
      {ongoing.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 text-btc animate-spin" />
            <span className="text-xs font-medium text-btc">Ongoing ({ongoing.length})</span>
          </div>
          {ongoing.map((dep) => (
            <DepositCard key={dep.id} deposit={dep} />
          ))}
        </div>
      )}

      {/* Minted deposits */}
      {minted.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-3.5 h-3.5 text-success" />
            <span className="text-xs font-medium text-success">Completed ({minted.length})</span>
          </div>
          {minted.map((dep) => (
            <DepositCard key={dep.id} deposit={dep} />
          ))}
        </div>
      )}

      {/* Loading state for backend */}
      {!hasAnyDeposits && isLoading && (
        <div className="flex flex-col items-center py-8">
          <Loader2 className="w-6 h-6 text-btc animate-spin mb-2" />
          <p className="text-sm text-gray">Checking for deposits...</p>
        </div>
      )}

      {/* Empty state */}
      {keys && !hasAnyDeposits && !isLoading && (
        <div className="text-center py-8">
          <div className="rounded-full bg-btc/10 p-4 w-fit mx-auto mb-4">
            <ArrowDownToLine className="h-8 w-8 text-btc" />
          </div>
          <p className="text-sm text-gray">No deposits found for your keys</p>
          <p className="text-xs text-gray/40 mt-1">Deposits addressed to you will appear here automatically</p>
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
                    <span className="text-xs flex items-center gap-1">
                      <span className="text-btc">{formatBtc(lookupResult.amount_sats)} BTC</span>
                      <ArrowRight className="w-2.5 h-2.5 text-gray" />
                      <span className="text-purple">{formatBtc(lookupResult.minted_sats ?? (lookupResult.sweep_fee_sats != null ? lookupResult.amount_sats - lookupResult.sweep_fee_sats : lookupResult.amount_sats))} zkBTC</span>
                    </span>
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
                {lookupResult.status === "failed" && lookupResult.id && (
                  <RetryButton
                    depositId={lookupResult.id}
                    onRetried={async () => {
                      const updated = await getDepositByAddress(lookupAddress.trim());
                      setLookupResult(updated);
                    }}
                  />
                )}
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

// =============================================================================
// Hook for deposit count (used by activity page tab bar)
// =============================================================================

export function useMyDepositCount(): number {
  const { deposits: backendDeposits } = useBackendDeposits();
  const { deposits: explorerDeposits } = useDeposits();
  const keys = useAegisStore((s) => s.keys);
  const inboxNotes = useAegisStore((s) => s.inboxNotes);

  return useMemo(() => {
    if (!keys) return 0;

    // Method 1: tracker deposits
    const fromTracker = backendDeposits.filter((d) => {
      if (!d.ephemeral_pub || !d.npk) return false;
      try {
        const ephPub = hexToBytes(d.ephemeral_pub);
        const npk = bytesToBigint(hexToBytes(d.npk));
        return isDepositForViewer(keys.viewingPrivKey, keys.spendingPubKey, keys.nullifyingKey, ephPub, npk);
      } catch { return false; }
    });
    if (fromTracker.length > 0) return fromTracker.length;

    // Method 2: explorer + inbox notes
    const myCommitments = new Set(inboxNotes.map((n) => n.commitmentHex));
    return explorerDeposits.filter((d) => myCommitments.has(d.commitment)).length;
  }, [backendDeposits, explorerDeposits, inboxNotes, keys]);
}
