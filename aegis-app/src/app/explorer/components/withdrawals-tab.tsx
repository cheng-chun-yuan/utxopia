"use client";

/**
 * Withdrawals Tab — displays BTC redemption lifecycle.
 * Shows withdrawal status, amount conversion (zkBTC → BTC with fees),
 * and expandable detail rows with step-by-step progress
 * (request → processing → FROST sign → complete & burn).
 */

import { useState, useCallback, useEffect, Fragment } from "react";
import {
  CheckCircle2,
  Clock,
  ExternalLink,
  Loader2,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/ui/copy-button";
import Image from "next/image";
import { BitcoinIcon } from "@/components/bitcoin-wallet-selector";
import { useRedemptions } from "@/hooks/use-explorer";
import type { RedemptionRecord } from "@/hooks/use-explorer";
import { getMempoolExplorerUrl } from "@/lib/btc-network";
import { truncate, timeAgo, scriptToAddress } from "./helpers";
import { getEsploraApiUrl } from "@/lib/btc-network";
import { getSolanaExplorerTxUrl, getSolanaExplorerAddressUrl } from "@/lib/solana-network";
import { Th, Td, TypeBadge, StatusDot, FlowCell, SolanaLink, LoadingState, ErrorState, EmptyState, RefreshButton } from "./shared";
import type { StatusDotVariant } from "./shared";

/** Format raw sats as BTC string, trimming trailing zeros (keep at least 1 decimal) */
const fmtBtc = (sats: number) => {
  const full = (sats / 1e8).toFixed(8);
  // Trim trailing zeros but keep at least "0.0"
  const trimmed = full.replace(/\.?0+$/, "");
  return trimmed.includes(".") ? trimmed : trimmed + ".0";
};

// =============================================================================
// BTC Confirmation Status — fetches live confirmation count from mempool.space
// =============================================================================

const REQUIRED_CONFIRMATIONS = 6;

function BtcConfirmationStatus({ txid }: { txid: string }) {
  const [confirmations, setConfirmations] = useState<number | null>(null);
  const [blockHeight, setBlockHeight] = useState<number | null>(null);
  const [relayedHeight, setRelayedHeight] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchStatus() {
      try {
        // Fetch BTC tx status + on-chain relayed header height in parallel
        const [statusResp, tipResp, relayResp] = await Promise.all([
          fetch(`${getEsploraApiUrl()}/tx/${txid}/status`),
          fetch(`${getEsploraApiUrl()}/blocks/tip/height`),
          fetch("/api/relayer/meta").catch(() => null),
        ]);
        if (cancelled) return;

        const status = await statusResp.json();
        const tip = await tipResp.json();

        if (relayResp?.ok) {
          try {
            const relay = await relayResp.json();
            if (relay.tip_height) setRelayedHeight(relay.tip_height);
          } catch { /* ignore */ }
        }

        if (status.confirmed && status.block_height) {
          setConfirmations(tip - status.block_height + 1);
          setBlockHeight(status.block_height);
        } else {
          setConfirmations(0);
        }
      } catch { /* ignore */ }
    }
    fetchStatus();
    const interval = setInterval(fetchStatus, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [txid]);

  if (confirmations === null) return null;

  const done = confirmations >= REQUIRED_CONFIRMATIONS;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-[11px]">
        {done ? (
          <CheckCircle2 className="w-3 h-3 text-green-400 shrink-0" />
        ) : confirmations === 0 ? (
          <Clock className="w-3 h-3 text-gray/50 shrink-0" />
        ) : (
          <Loader2 className="w-3 h-3 text-gray-light animate-spin shrink-0" />
        )}
        <span className={done ? "text-green-400" : "text-gray-light"}>
          {confirmations === 0
            ? "Unconfirmed — waiting for block..."
            : done
              ? `Confirmed · ${confirmations} blocks`
              : `Waiting for confirmations · ${confirmations}/${REQUIRED_CONFIRMATIONS}`
          }
        </span>
      </div>
      {blockHeight && (
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-[10px] font-mono text-gray/40 pl-5">
          <span>Confirmed at</span>
          <span>block #{blockHeight.toLocaleString()}</span>
          {relayedHeight && (
            <>
              <span>Relayed to</span>
              <span>block #{relayedHeight.toLocaleString()}{relayedHeight >= blockHeight ? " ✓" : ""}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Withdrawal Status
// =============================================================================

const WITHDRAWAL_STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; spinning?: boolean }> = {
  Pending: { label: "Pending", color: "text-orange-400", bg: "bg-orange-500/10 border-orange-500/20" },
  Detected: { label: "Detected", color: "text-blue-400", bg: "bg-blue-500/10 border-blue-500/20", spinning: true },
  Processing: { label: "Processing", color: "text-blue-400", bg: "bg-blue-500/10 border-blue-500/20", spinning: true },
  Signing: { label: "Signing", color: "text-purple-400", bg: "bg-purple-500/10 border-purple-500/20", spinning: true },
  AwaitingConfirmation: { label: "Confirming", color: "text-yellow-400", bg: "bg-yellow-500/10 border-yellow-500/20", spinning: true },
  SpvVerified: { label: "Verified", color: "text-cyan-400", bg: "bg-cyan-500/10 border-cyan-500/20", spinning: true },
  Completed: { label: "Completed", color: "text-green-400", bg: "bg-green-500/10 border-green-500/20" },
  Cancelled: { label: "Cancelled", color: "text-gray", bg: "bg-gray/10 border-gray/20" },
  Failed: { label: "Failed", color: "text-red-400", bg: "bg-red-500/10 border-red-500/20" },
};

function getWithdrawalStatusDot(status: string): { variant: StatusDotVariant; label: string } {
  if (status === "Completed") return { variant: "confirmed", label: "Confirmed" };
  if (status === "Failed" || status === "Cancelled") return { variant: "failed", label: status };
  if (status === "Pending") return { variant: "pending", label: "Pending" };
  return { variant: "processing", label: WITHDRAWAL_STATUS_CONFIG[status]?.label ?? "Processing" };
}

// =============================================================================
// Status helpers
// =============================================================================

const WITHDRAWAL_STATUS_ORDER: Record<string, number> = {
  Pending: 0, pending: 0,
  Detected: 1, processing: 1, Processing: 1,
  Signing: 2, sending: 2,
  AwaitingConfirmation: 3, sent: 3, confirming: 3, SpvVerified: 3,
  completed: 4, Completed: 4,
  Cancelled: -1, Failed: -1, failed: -1,
};

/**
 * Derive effective status: prefer localStatus, but if backend says Completed
 * without on-chain completion tx, fall back to on-chain status.
 *
 * TODO(backward-compat): remove fallback chain once backend always populates
 * localStatus correctly and completeTxSignature is guaranteed on completion.
 */
function getEffectiveStatus(r: RedemptionRecord): string {
  const local = r.localStatus;
  if (local === "Completed" && !r.completeTxSignature) {
    return r.status ?? "Processing";
  }
  return local ?? r.status ?? "Pending";
}

// =============================================================================
// Withdrawal Details (expandable row)
// =============================================================================

function WithdrawalDetails({ redemption }: { redemption: RedemptionRecord }) {
  const status = getEffectiveStatus(redemption);
  const stepOrder = WITHDRAWAL_STATUS_ORDER[status] ?? 0;
  const isFailed = stepOrder === -1;
  const btcAddr = redemption.btcScript ? scriptToAddress(redemption.btcScript) : null;

  const amount = Number(redemption.amountSats);
  const bps = redemption.serviceFeeBps ?? 0;
  const base = redemption.serviceFeeBase ?? 0;
  const serviceFee = redemption.serviceFee
    ? Number(redemption.serviceFee)
    : Math.floor(amount * bps / 10000) + base;
  const expectedSend = amount - serviceFee;
  const actualReceived = redemption.actualReceived ? Number(redemption.actualReceived) : null;
  const minerFee = actualReceived !== null ? expectedSend - actualReceived : null;

  return (
    <div className="mx-4 my-3 rounded-[10px] bg-gradient-to-b from-gray/6 to-transparent border border-gray/10 overflow-hidden">
      {/* Error banner */}
      {isFailed && (
        <div className="mx-4 mt-3 px-3 py-2 rounded-[8px] bg-red-500/10 border border-red-500/20">
          <div className="flex items-center gap-1.5">
            <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
            <span className="text-[11px] text-red-400 font-medium">
              {redemption.trackerError ?? "Withdrawal failed"}
            </span>
          </div>
        </div>
      )}

      {/* ── Input / Output 2-column (matches transfer detail layout) ── */}
      <div className="grid grid-cols-2 divide-x divide-gray/10">
        {/* INPUT side */}
        <div className="p-4 space-y-2.5">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
            <span className="text-caption text-green-400/90 font-semibold uppercase tracking-wider">Input</span>
            <span className="text-caption text-green-400/60 font-medium">1</span>
          </div>
          <div className="group flex items-center gap-2 px-3 py-2.5 rounded-[8px] bg-green-500/4 border border-green-500/10">
            <Image src="/zkbtc.png" alt="zkBTC" width={16} height={16} className="rounded-full shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-body2 text-foreground font-mono font-semibold">{fmtBtc(amount)} <span className="text-[10px] text-gray font-normal">zkBTC</span></div>
              <div className="text-[10px] text-gray/50">Shielded note (burned)</div>
            </div>
          </div>
          {/* Nullifier */}
          {redemption.requestTxSignature && (
            <div className="group flex items-center gap-2 px-3 py-2 rounded-[8px] bg-gray/4 border border-gray/8">
              <span className="text-[10px] text-gray/40 shrink-0">Nullifier</span>
              <code className="text-caption font-mono text-foreground/70 truncate">{truncate(redemption.requestTxSignature, 6, 4)}</code>
              <div className="flex items-center gap-1 ml-auto shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                <CopyButton text={redemption.requestTxSignature} label="Tx" variant="default" iconSize="sm" />
                <a href={getSolanaExplorerTxUrl(redemption.requestTxSignature)} target="_blank" rel="noopener noreferrer" className="text-sol hover:text-sol/80 transition-colors p-0.5">
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </div>
          )}
        </div>

        {/* OUTPUT side */}
        <div className="p-4 space-y-2.5">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-1.5 h-1.5 rounded-full bg-btc" />
            <span className="text-caption text-btc/90 font-semibold uppercase tracking-wider">Output</span>
            <span className="text-caption text-btc/60 font-medium">1</span>
          </div>
          <div className="px-3 py-2.5 rounded-[8px] bg-btc/4 border border-btc/10 space-y-2">
            <div className="flex items-center gap-2">
              <BitcoinIcon className="w-4 h-4 text-btc shrink-0" />
              <span className="text-body2 text-foreground font-mono font-semibold">
                {fmtBtc(actualReceived ?? expectedSend)} <span className="text-[10px] text-gray font-normal">BTC</span>
              </span>
            </div>
            {btcAddr && (
              <div className="group flex items-center gap-2">
                <span className="text-[10px] text-gray/40">→</span>
                <code className="text-caption font-mono text-foreground/80 truncate">{truncate(btcAddr, 10, 6)}</code>
                <div className="flex items-center gap-1 ml-auto shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                  <CopyButton text={btcAddr} label="BTC Address" variant="default" iconSize="sm" />
                  <a href={`${getMempoolExplorerUrl()}/address/${btcAddr}`} target="_blank" rel="noopener noreferrer" className="text-btc hover:text-btc/80 transition-colors p-0.5">
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              </div>
            )}
          </div>
          {/* BTC tx link */}
          {redemption.btcTxid && !redemption.simulated && (
            <div className="group flex items-center gap-2 px-3 py-2 rounded-[8px] bg-gray/4 border border-gray/8">
              <span className="text-[10px] text-gray/40 shrink-0">BTC tx</span>
              <code className="text-caption font-mono text-foreground/70 truncate">{truncate(redemption.btcTxid, 6, 4)}</code>
              <div className="flex items-center gap-1 ml-auto shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                <CopyButton text={redemption.btcTxid} label="BTC TX" variant="default" iconSize="sm" />
                <a href={`${getMempoolExplorerUrl()}/tx/${redemption.btcTxid}`} target="_blank" rel="noopener noreferrer" className="text-btc hover:text-btc/80 transition-colors p-0.5">
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Fee Breakdown + Progress ── */}
      <div className="border-t border-gray/10 px-4 py-3 space-y-3">
        {/* Fees */}
        <div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-[11px]">
          {serviceFee > 0 && <>
            <span className="text-gray/50">Service fee</span>
            <span className="font-mono text-gray">{fmtBtc(serviceFee)} BTC</span>
          </>}
          {minerFee !== null && minerFee > 0 && <>
            <span className="text-gray/50">Miner fee</span>
            <span className="font-mono text-gray">{fmtBtc(minerFee)} BTC</span>
          </>}
        </div>

        {/* Progress steps (horizontal) */}
        <div className="flex items-center gap-2 text-[10px]">
          {[
            { label: "Request", done: !isFailed && stepOrder >= 0, sig: redemption.requestTxSignature },
            { label: "Processing", done: !isFailed && stepOrder >= 1, sig: redemption.processingTxSignature },
            { label: "BTC Sent", done: !isFailed && stepOrder >= 3, sig: redemption.btcTxid },
            { label: "Complete", done: !isFailed && stepOrder >= 4, sig: redemption.completeTxSignature },
          ].map((step, i, arr) => (
            <Fragment key={step.label}>
              <div className="flex items-center gap-1">
                {step.done ? (
                  <CheckCircle2 className="w-3 h-3 text-green-400 shrink-0" />
                ) : i === arr.findIndex(s => !s.done) && !isFailed ? (
                  <Loader2 className="w-3 h-3 text-gray-light animate-spin shrink-0" />
                ) : (
                  <Clock className="w-3 h-3 text-gray/20 shrink-0" />
                )}
                <span className={step.done ? "text-foreground/70" : "text-gray/30"}>{step.label}</span>
              </div>
              {i < arr.length - 1 && (
                <div className={cn("h-px w-3", step.done ? "bg-green-500/30" : "bg-gray/10")} />
              )}
            </Fragment>
          ))}
        </div>

        {/* BTC confirmation status */}
        {!redemption.simulated && redemption.btcTxid && stepOrder < 4 && (
          <BtcConfirmationStatus txid={redemption.btcTxid} />
        )}
      </div>
    </div>
  );
}

// =============================================================================
// Withdrawal Row — single unified table row + expandable detail
// =============================================================================

export function WithdrawalRow({
  redemption,
  expanded,
  onToggle,
}: {
  redemption: RedemptionRecord;
  expanded: boolean;
  onToggle: () => void;
}) {
  const r = redemption;
  const btcAddr = r.btcScript ? scriptToAddress(r.btcScript) : null;

  return (
    <Fragment>
      <tr
        className="hover:bg-gray/5 transition-colors cursor-pointer"
        onClick={onToggle}
      >
        <Td>
          <StatusDot {...getWithdrawalStatusDot(getEffectiveStatus(r))} />
        </Td>
        <Td>
          {(() => {
            const status = getEffectiveStatus(r);
            const order = WITHDRAWAL_STATUS_ORDER[status] ?? 0;
            const sig = order >= 4 && r.completeTxSignature
              ? r.completeTxSignature
              : order >= 1 && r.processingTxSignature
                ? r.processingTxSignature
                : r.requestTxSignature ?? null;
            return sig ? (
              <div className="flex items-center gap-1.5">
                <code className="text-caption font-mono text-foreground">{truncate(sig, 6, 4)}</code>
                <CopyButton text={sig} label="Tx" variant="default" iconSize="sm" />
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <code className="text-caption font-mono text-foreground">{truncate(r.pubkey, 6, 4)}</code>
                <CopyButton text={r.pubkey} label="PDA" variant="default" iconSize="sm" />
              </div>
            );
          })()}
        </Td>
        <Td>
          <TypeBadge kind="withdraw" />
        </Td>
        <Td>
          <FlowCell
            from={{ icon: "shield", label: "Shielded" }}
            to={{ icon: "/tokens/btc.png", label: "BTC" }}
            meta={`${r.inputCount} in, ${r.outputCount} out`}
          />
        </Td>
        <Td>
          <span className="text-body2 text-foreground font-mono">
            {fmtBtc(Number(r.amountSats))} <span className="text-gray text-caption">BTC</span>
          </span>
        </Td>
        <Td>
          <span className="text-caption text-gray">{timeAgo(r.createdAt)}</span>
        </Td>
        <Td>
          <a
            href={(() => {
              const s = getEffectiveStatus(r);
              const o = WITHDRAWAL_STATUS_ORDER[s] ?? 0;
              const sig = o >= 4 && r.completeTxSignature ? r.completeTxSignature
                : o >= 1 && r.processingTxSignature ? r.processingTxSignature
                : r.requestTxSignature;
              return sig
                ? getSolanaExplorerTxUrl(sig)
                : getSolanaExplorerAddressUrl(r.pubkey);
            })()}
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray hover:text-gray-light transition-colors"
            onClick={(e) => e.stopPropagation()}
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </Td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={8} className="p-0">
            <WithdrawalDetails redemption={r} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

// =============================================================================
// Withdrawals Tab (standalone, kept for backward compat)
// =============================================================================

export function WithdrawalsTab() {
  const { redemptions, isLoading, error, refresh } = useRedemptions();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  if (error) return <ErrorState message={error} onRetry={refresh} />;
  if (isLoading) return <LoadingState />;
  if (redemptions.length === 0) return <EmptyState label="withdrawals" />;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <span className="text-caption text-gray">{redemptions.length} withdrawal(s)</span>
        <RefreshButton onClick={refresh} />
      </div>
      <div className="overflow-x-auto rounded-[12px] border border-gray/15 backdrop-blur-sm bg-muted/30">
        <table className="w-full min-w-[600px]">
          <thead>
            <tr className="border-b border-gray/15 bg-muted/50">
              <Th>Status</Th>
              <Th>Tx ID</Th>
              <Th>Type</Th>
              <Th>Flow</Th>
              <Th>Amount</Th>
              <Th>Time</Th>
              <Th className="w-[40px]" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray/10">
            {redemptions.map((r) => {
              const rowKey = r.requestId || r.pubkey;
              return (
                <WithdrawalRow
                  key={rowKey}
                  redemption={r}
                  expanded={expanded.has(rowKey)}
                  onToggle={() => toggle(rowKey)}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --- Amount Cell ---

function WithdrawalAmountCell({ r }: { r: RedemptionRecord }) {
  const received = r.actualReceived && r.status === "Completed"
    ? fmtBtc(Number(r.actualReceived))
    : r.serviceFee
      ? fmtBtc(Number(r.amountSats) - Number(r.serviceFee))
      : "...";

  return (
    <div className="flex items-center gap-1.5 font-mono text-body2">
      <Image src="/zkbtc.png" alt="zkBTC" width={14} height={14} className="rounded-full shrink-0" />
      <span className="text-foreground">{fmtBtc(Number(r.amountSats))}</span>
      <span className="text-gray/40">→</span>
      <BitcoinIcon className="w-3.5 h-3.5 text-btc shrink-0" />
      <span className="text-foreground">{received}</span>
      <span className="text-[10px] text-gray">BTC</span>
    </div>
  );
}

function WithdrawalFeeCell({ r }: { r: RedemptionRecord }) {
  const fee = r.serviceFee
    ? Number(r.serviceFee)
    : r.actualReceived && Number(r.actualReceived) !== Number(r.amountSats)
      ? Number(r.amountSats) - Number(r.actualReceived)
      : 0;

  if (fee === 0) return <span className="text-caption text-gray/40">—</span>;

  return (
    <span className="text-caption font-mono text-gray">
      {fmtBtc(fee)} BTC
    </span>
  );
}
