"use client";

/**
 * Withdrawals Tab — displays BTC redemption lifecycle.
 * Shows withdrawal status, amount conversion (zkBTC → BTC with fees),
 * and expandable detail rows with step-by-step progress
 * (request → processing → FROST sign → complete & burn).
 */

import { useState, useCallback, Fragment } from "react";
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
import { Th, Td, LoadingState, ErrorState, EmptyState, RefreshButton } from "./shared";

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

function WithdrawalStatusBadge({ status }: { status: string }) {
  const cfg = WITHDRAWAL_STATUS_CONFIG[status] ?? WITHDRAWAL_STATUS_CONFIG.Pending;
  const Icon = cfg.spinning ? Loader2 : (status === "Failed" ? XCircle : status === "Completed" ? CheckCircle2 : status === "Pending" ? Clock : CheckCircle2);
  const subtitle = status === "Failed" ? "Error" : status === "Completed" ? "Done" : status === "Pending" ? "Awaiting" : "In progress";

  return (
    <div className="flex items-center gap-1.5">
      <div className={cn("p-1 rounded-[6px] border", cfg.bg)}>
        <Icon className={cn("w-3 h-3", cfg.color, cfg.spinning && "animate-spin")} />
      </div>
      <div className="flex flex-col">
        <span className={cn("text-[12px] font-semibold leading-tight", cfg.color)}>{cfg.label}</span>
        <span className="text-[10px] text-gray leading-tight">{subtitle}</span>
      </div>
    </div>
  );
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
  // TODO(backward-compat): remove bps/base fallback once all redemptions have serviceFee populated
  const bps = redemption.serviceFeeBps ?? 0;
  const base = redemption.serviceFeeBase ?? 0;
  const serviceFee = redemption.serviceFee
    ? Number(redemption.serviceFee)
    : Math.floor(amount * bps / 10000) + base;
  const expectedSend = amount - serviceFee;
  const actualReceived = redemption.actualReceived ? Number(redemption.actualReceived) : null;
  const minerFee = actualReceived !== null ? expectedSend - actualReceived : null;
  const protocolRevenue = minerFee !== null ? serviceFee - minerFee : null;

  const btcLink = "text-[11px] text-btc/70 hover:text-btc flex items-center gap-1 transition-colors";
  const solLink = "text-[11px] text-purple-400/70 hover:text-purple-400 flex items-center gap-1 transition-colors";

  const steps = [
    {
      title: "Request Redemption",
      done: !isFailed && stepOrder >= 0,
      active: stepOrder === 0 && !isFailed,
      detail: (
        <div className="space-y-2 text-xs">
          {/* Tx link */}
          {redemption.requestTxSignature ? (
            <div className="flex items-center gap-1.5">
              <a href={`https://explorer.solana.com/tx/${redemption.requestTxSignature}?cluster=devnet`} target="_blank" rel="noopener noreferrer" className={solLink}>
                Request tx <ExternalLink className="w-2.5 h-2.5" />
              </a>
              <code className="font-mono text-[10px] text-gray/50">{truncate(redemption.requestTxSignature, 6, 4)}</code>
              <CopyButton text={redemption.requestTxSignature} label="Request TX" variant="default" iconSize="sm" />
            </div>
          ) : redemption.pubkey ? (
            <div className="flex items-center gap-1.5">
              <a href={`https://explorer.solana.com/address/${redemption.pubkey}?cluster=devnet`} target="_blank" rel="noopener noreferrer" className={solLink}>
                Request PDA <ExternalLink className="w-2.5 h-2.5" />
              </a>
              <code className="font-mono text-[10px] text-gray/50">{truncate(redemption.pubkey, 6, 4)}</code>
              <CopyButton text={redemption.pubkey} label="PDA" variant="default" iconSize="sm" />
            </div>
          ) : null}
          {/* Key-value rows */}
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[11px]">
            {btcAddr && <>
              <span className="text-gray/50">Destination</span>
              <div className="flex items-center gap-1.5">
                <code className="font-mono text-foreground/80">{truncate(btcAddr, 10, 6)}</code>
                <CopyButton text={btcAddr} label="BTC Address" variant="default" iconSize="sm" />
              </div>
            </>}
            <span className="text-gray/50">Amount</span>
            <span className="font-mono text-foreground/80">{amount.toLocaleString()} sats</span>
            <span className="text-gray/50">Service fee</span>
            <span className="font-mono text-gray">{serviceFee.toLocaleString()} sats</span>
            <span className="text-gray/50">Est. receive</span>
            <span className="font-mono text-foreground/80">{expectedSend.toLocaleString()} sats</span>
          </div>
        </div>
      ),
    },
    {
      title: "Mark Processing",
      done: !isFailed && stepOrder >= 1,
      active: stepOrder === 1 && !isFailed,
      detail: !isFailed && stepOrder >= 1 ? (
        <div className="space-y-2 text-xs">
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-gray/10 text-gray-light text-[10px]">
            <CheckCircle2 className="w-2.5 h-2.5" /> Backend picked up
          </span>
          {redemption.processingTxSignature && (
            <div className="flex items-center gap-1.5">
              <a href={`https://explorer.solana.com/tx/${redemption.processingTxSignature}?cluster=devnet`} target="_blank" rel="noopener noreferrer" className={solLink}>
                Processing tx <ExternalLink className="w-2.5 h-2.5" />
              </a>
              <code className="font-mono text-[10px] text-gray/50">{truncate(redemption.processingTxSignature, 6, 4)}</code>
              <CopyButton text={redemption.processingTxSignature} label="Processing TX" variant="default" iconSize="sm" />
            </div>
          )}
        </div>
      ) : null,
    },
    {
      title: "BTC Send (FROST Sign)",
      done: !isFailed && stepOrder >= 3,
      active: stepOrder === 2 && !isFailed,
      detail: redemption.btcTxid ? (
        <div className="space-y-2 text-xs">
          {/* Tx link */}
          {redemption.simulated ? (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-gray/10 text-gray-light text-[10px]">
              Simulated
            </span>
          ) : (
            <div className="flex items-center gap-1.5">
              <a href={`${getMempoolExplorerUrl()}/tx/${redemption.btcTxid}`} target="_blank" rel="noopener noreferrer" className={btcLink}>
                BTC tx <ExternalLink className="w-2.5 h-2.5" />
              </a>
              <code className="font-mono text-[10px] text-gray/50">{truncate(redemption.btcTxid, 6, 4)}</code>
              <CopyButton text={redemption.btcTxid} label="BTC TX" variant="default" iconSize="sm" />
            </div>
          )}
          {/* Destination */}
          {btcAddr && (
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="text-gray/50">→</span>
              <code className="font-mono text-foreground/80">{truncate(btcAddr, 10, 6)}</code>
              <CopyButton text={btcAddr} label="BTC Address" variant="default" iconSize="sm" />
            </div>
          )}
          {/* Fee breakdown */}
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[11px]">
            {actualReceived !== null ? (<>
              <span className="text-gray/50">Received</span>
              <span className="font-mono text-foreground/80">{actualReceived.toLocaleString()} sats</span>
              <span className="text-gray/50">Service fee</span>
              <span className="font-mono text-gray">{serviceFee.toLocaleString()} sats</span>
              {minerFee !== null && minerFee > 0 && <>
                <span className="text-gray/50">Miner fee</span>
                <span className="font-mono text-gray">{minerFee.toLocaleString()} sats</span>
              </>}
              {protocolRevenue !== null && protocolRevenue > 0 && <>
                <span className="text-gray/50">Protocol</span>
                <span className="font-mono text-gray">+{protocolRevenue.toLocaleString()} sats</span>
              </>}
            </>) : (
              <>
                <span className="text-gray/50">{redemption.btcTxid ? "Receive" : "Est. receive"}</span>
                <span className="font-mono text-foreground/80">{expectedSend.toLocaleString()} sats</span>
              </>
            )}
          </div>
        </div>
      ) : null,
    },
    {
      title: "Complete & Burn",
      done: !isFailed && stepOrder >= 4,
      active: false,
      detail: !isFailed && stepOrder >= 4 ? (
        <div className="space-y-2 text-xs">
          {/* Tx link */}
          {redemption.completeTxSignature && (
            <div className="flex items-center gap-1.5">
              <a href={`https://explorer.solana.com/tx/${redemption.completeTxSignature}?cluster=devnet`} target="_blank" rel="noopener noreferrer" className={solLink}>
                Complete tx <ExternalLink className="w-2.5 h-2.5" />
              </a>
              <code className="font-mono text-[10px] text-gray/50">{truncate(redemption.completeTxSignature, 6, 4)}</code>
              <CopyButton text={redemption.completeTxSignature} label="Complete TX" variant="default" iconSize="sm" />
            </div>
          )}
          {/* Summary — burn = amount - protocol_revenue (service fee stays in vault) */}
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[11px]">
            <span className="text-gray/50">Burned</span>
            <span className="font-mono text-foreground/80">
              {protocolRevenue !== null && protocolRevenue > 0
                ? (amount - protocolRevenue).toLocaleString()
                : amount.toLocaleString()
              } sats
            </span>
            {protocolRevenue !== null && protocolRevenue > 0 && <>
              <span className="text-gray/50">Fee retained</span>
              <span className="font-mono text-gray">+{protocolRevenue.toLocaleString()} sats</span>
            </>}
          </div>
        </div>
      ) : null,
    },
  ];

  return (
    <div className="mx-4 my-3 px-4 py-3 rounded-[10px] bg-linear-to-b from-gray/6 to-transparent border border-gray/10 space-y-1">
      {isFailed && (
        <div className="mb-2 px-3 py-1.5 rounded-[8px] bg-red-500/10 border border-red-500/20">
          <div className="flex items-center gap-1.5">
            <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
            <span className="text-[11px] text-red-400 font-medium">
              {redemption.trackerError ?? "Withdrawal failed"}
            </span>
          </div>
          {redemption.retryCount > 0 && (
            <span className="text-[10px] text-red-400/60 ml-5">Retry count: {redemption.retryCount}</span>
          )}
        </div>
      )}
      {steps.map((step, i) => (
        <div key={step.title} className="flex gap-2.5">
          <div className="flex flex-col items-center">
            <div className={cn(
              "w-5 h-5 rounded-full flex items-center justify-center shrink-0",
              step.done ? "bg-green-500/15" : step.active ? "bg-gray/15" : "bg-gray/8"
            )}>
              {step.done ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
              ) : step.active ? (
                <Loader2 className="w-3 h-3 text-gray-light animate-spin" />
              ) : (
                <Clock className="w-2.5 h-2.5 text-gray/30" />
              )}
            </div>
            {i < steps.length - 1 && (
              <div className={cn("w-px flex-1 min-h-[12px]", step.done ? "bg-green-500/20" : "bg-gray/8")} />
            )}
          </div>
          <div className={cn("pb-2 flex-1", i === steps.length - 1 && "pb-0")}>
            <p className={cn(
              "text-[11px] font-medium",
              step.done ? "text-foreground" : step.active ? "text-foreground" : "text-gray/40"
            )}>{step.title}</p>
            {step.detail && (step.done || step.active) && (
              <div className="mt-1">{step.detail}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// =============================================================================
// Withdrawals Tab
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
              <Th>Destination</Th>
              <Th>Amount</Th>
              <Th>Fee</Th>
              <Th>Time</Th>
              <Th className="w-[40px]" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray/10">
            {redemptions.map((r) => {
              const btcAddr = r.btcScript ? scriptToAddress(r.btcScript) : null;
              const isBtcWithdraw = !!r.btcScript;
              const rowKey = r.requestId || r.pubkey;
              const isOpen = expanded.has(rowKey);
              return (
                <Fragment key={rowKey}>
                  <tr
                    className="hover:bg-gray/5 transition-colors cursor-pointer"
                    onClick={() => toggle(rowKey)}
                  >
                    <Td>
                      <WithdrawalStatusBadge status={getEffectiveStatus(r)} />
                    </Td>
                    <Td>
                      <div className="flex items-center gap-1.5">
                        {btcAddr ? (
                          <>
                            <code className="text-caption font-mono text-foreground">{truncate(btcAddr, 8, 6)}</code>
                            <CopyButton text={btcAddr} label="BTC Address" variant="default" iconSize="sm" />
                          </>
                        ) : (
                          <span className="text-caption text-gray">—</span>
                        )}
                      </div>
                    </Td>
                    <Td>
                      <WithdrawalAmountCell r={r} />
                    </Td>
                    <Td>
                      <WithdrawalFeeCell r={r} />
                    </Td>
                    <Td>
                      <span className="text-caption text-gray">{timeAgo(r.createdAt)}</span>
                    </Td>
                    <Td>
                      <a
                        href={r.status === "Completed" && r.completeTxSignature
                          ? `https://explorer.solana.com/tx/${r.completeTxSignature}?cluster=devnet`
                          : `https://explorer.solana.com/address/${r.pubkey}?cluster=devnet`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sol hover:text-sol/80 transition-colors"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </Td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={7} className="p-0">
                        <WithdrawalDetails redemption={r} />
                      </td>
                    </tr>
                  )}
                </Fragment>
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
    ? Number(r.actualReceived).toLocaleString()
    : r.serviceFee
      ? (Number(r.amountSats) - Number(r.serviceFee)).toLocaleString()
      : "...";

  return (
    <div className="flex items-center gap-1.5 font-mono text-body2">
      <Image src="/zkbtc.png" alt="zkBTC" width={14} height={14} className="rounded-full shrink-0" />
      <span className="text-foreground">{Number(r.amountSats).toLocaleString()}</span>
      <span className="text-gray/40">→</span>
      <BitcoinIcon className="w-3.5 h-3.5 text-btc shrink-0" />
      <span className="text-foreground">{received}</span>
      <span className="text-[10px] text-gray">sats</span>
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
      {fee.toLocaleString()} sats
    </span>
  );
}
