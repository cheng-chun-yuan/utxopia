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
import type { RedemptionRecord } from "@/hooks/use-explorer";
import { formatAmount } from "@/lib/utils/formatting";
import useSWR from "swr";
import { getMempoolExplorerUrl } from "@/lib/btc-network";
import { truncate, timeAgo, scriptToAddress } from "./helpers";
import { getEsploraApiUrl } from "@/lib/btc-network";
import { getSolanaExplorerTxUrl, getSolanaExplorerAddressUrl } from "@/lib/solana-network";
import { Th, Td, TypeBadge, StatusDot, FlowCell, SolanaLink, LoadingState, ErrorState, EmptyState, RefreshButton } from "./shared";
import type { StatusDotVariant } from "./shared";

/** Format raw sats as trimmed BTC string */
const fmtBtc = (sats: number) => formatAmount(sats, 8);

// =============================================================================
// BTC Confirmation Status — fetches live confirmation count from mempool.space
// =============================================================================

const REQUIRED_CONFIRMATIONS = 6;

function BtcConfirmationStatus({ txid, onMinerFee }: { txid: string; onMinerFee?: (fee: number) => void }) {
  const [confirmations, setConfirmations] = useState<number | null>(null);
  const [blockHeight, setBlockHeight] = useState<number | null>(null);
  const [relayedHeight, setRelayedHeight] = useState<number | null>(null);
  const [minerFee, setMinerFee] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchStatus() {
      try {
        // Fetch BTC tx details + tip + on-chain relayed header height in parallel
        const [txResp, tipResp, relayResp] = await Promise.all([
          fetch(`${getEsploraApiUrl()}/tx/${txid}`),
          fetch(`${getEsploraApiUrl()}/blocks/tip/height`),
          fetch("/api/relayer/meta").catch((err) => { console.error("[BtcConfirmationStatus] relayer meta fetch error:", err); return null; }),
        ]);
        if (cancelled) return;

        const txData = await txResp.json();
        const tip = await tipResp.json();

        if (relayResp?.ok) {
          try {
            const relay = await relayResp.json();
            if (relay.tip_height) setRelayedHeight(relay.tip_height);
          } catch (err) { console.error("[BtcConfirmationStatus] relay meta parse error:", err); }
        }

        // Compute miner fee from tx data
        if (txData.fee != null) {
          setMinerFee(txData.fee);
          onMinerFee?.(txData.fee);
        }

        if (txData.status?.confirmed && txData.status?.block_height) {
          setConfirmations(tip - txData.status.block_height + 1);
          setBlockHeight(txData.status.block_height);
        } else {
          setConfirmations(0);
        }
      } catch (err) { console.error("[BtcConfirmationStatus] fetch error:", err); }
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
      {(blockHeight || minerFee !== null) && (
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-[10px] font-mono text-gray/40 pl-5">
          {blockHeight && (
            <>
              <span>Confirmed at</span>
              <span>block #{blockHeight.toLocaleString()}</span>
            </>
          )}
          {relayedHeight && (
            <>
              <span>Relayed to</span>
              <span>block #{relayedHeight.toLocaleString()}{blockHeight && relayedHeight >= blockHeight ? " ✓" : ""}</span>
            </>
          )}
          {minerFee !== null && (
            <>
              <span>Miner fee</span>
              <span>{fmtBtc(minerFee)} BTC</span>
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

import { WITHDRAWAL_STATUS_CONFIG, WITHDRAWAL_STATUS_ORDER } from "@/lib/deposit-status";

function getWithdrawalStatusDot(status: string): { variant: StatusDotVariant; label: string } {
  if (status === "Completed") return { variant: "confirmed", label: "Confirmed" };
  if (status === "Failed" || status === "Cancelled") return { variant: "failed", label: status };
  if (status === "Pending") return { variant: "pending", label: "Pending" };
  return { variant: "processing", label: WITHDRAWAL_STATUS_CONFIG[status]?.label ?? "Processing" };
}

// =============================================================================
// Status helpers
// =============================================================================


/**
 * Derive effective status: prefer localStatus, but if backend says Completed
 * without on-chain completion tx, fall back to on-chain status.
 *
 * Falls back to on-chain status when localStatus is inconsistent.
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
  const [btcMinerFee, setBtcMinerFee] = useState<number | null>(null);
  const poolRevenue = btcMinerFee !== null && serviceFee > 0 ? serviceFee - btcMinerFee : null;

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

      {/* ── Input / Output 2-column ── */}
      <div className="grid grid-cols-2 divide-x divide-gray/10">
        {/* INPUT side — nullifier only */}
        <div className="p-4 space-y-2.5">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
            <span className="text-caption text-green-400/90 font-semibold uppercase tracking-wider">Input</span>
            <span className="text-caption text-green-400/60 font-medium">1</span>
          </div>
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

        {/* OUTPUT side — zkBTC → BTC conversion */}
        <div className="p-4 space-y-2.5">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-1.5 h-1.5 rounded-full bg-btc" />
            <span className="text-caption text-btc/90 font-semibold uppercase tracking-wider">Output</span>
            <span className="text-caption text-btc/60 font-medium">1</span>
          </div>
          <div className="px-3 py-2.5 rounded-[8px] bg-btc/4 border border-btc/10 space-y-2">
            {/* zkBTC → BTC conversion */}
            <div className="flex items-center gap-2 flex-wrap">
              <Image src="/tokens/zkbtc.png" alt="zkBTC" width={14} height={14} className="rounded-full shrink-0" />
              <span className="text-body2 text-foreground font-mono font-semibold">
                {fmtBtc(amount)} <span className="text-[10px] text-gray font-normal">zkBTC</span>
              </span>
              <span className="text-[10px] text-gray/40">→</span>
              <Image src="/tokens/btc.png" alt="BTC" width={14} height={14} className="rounded-full shrink-0" />
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
            {/* Fee line */}
            {serviceFee > 0 && (
              <div className="flex items-center gap-2 pt-1 border-t border-btc/8">
                <span className="text-[10px] text-gray/40">Service Fee</span>
                <span className="text-[10px] font-mono text-gray/60">{fmtBtc(serviceFee)} BTC</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Progress Timeline ── */}
      <div className="border-t border-gray/10 px-4 py-3 space-y-3">
        {/* Vertical timeline */}
        <div className="space-y-0">
          {[
            { key: "request", title: "Request Redemption", done: !isFailed && stepOrder >= 0, icon: "sol" as const, txId: redemption.requestTxSignature },
            { key: "processing", title: "Mark Processing", done: !isFailed && stepOrder >= 1, icon: "sol" as const, txId: redemption.processingTxSignature },
            { key: "btc_sent", title: "BTC Sent", done: !isFailed && stepOrder >= 3, icon: "btc" as const, txId: redemption.btcTxid },
            { key: "complete", title: "Complete Redemption", done: !isFailed && stepOrder >= 4, icon: "sol" as const, txId: redemption.completeTxSignature },
          ].map((step, i, arr) => (
            <div key={step.key} className="flex gap-3">
              <div className="flex flex-col items-center w-5">
                <div className={cn(
                  "w-5 h-5 rounded-full flex items-center justify-center shrink-0 border",
                  step.done ? "bg-green-500/15 border-green-500/30"
                    : i === arr.findIndex(s => !s.done) && !isFailed ? "bg-gray/8 border-gray/15"
                    : "bg-gray/5 border-gray/10"
                )}>
                  {step.done ? (
                    <CheckCircle2 className="w-3 h-3 text-green-400" />
                  ) : i === arr.findIndex(s => !s.done) && !isFailed ? (
                    <Loader2 className="w-3 h-3 text-gray/40 animate-spin" />
                  ) : (
                    <Clock className="w-2.5 h-2.5 text-gray/20" />
                  )}
                </div>
                {i < arr.length - 1 && (
                  <div className={cn("w-px flex-1 min-h-[20px]", step.done ? "bg-green-500/20" : "bg-gray/10")} />
                )}
              </div>
              <div className="flex-1 pb-3">
                <div className="flex items-center gap-2">
                  {step.icon === "btc" ? (
                    <BitcoinIcon className="w-3.5 h-3.5 text-btc/70" />
                  ) : (
                    <Image src="/tokens/sol.png" alt="SOL" width={14} height={14} className="rounded-full opacity-70" />
                  )}
                  <span className={cn("text-[12px] font-medium", step.done ? "text-foreground" : "text-gray/50")}>
                    {step.title}
                  </span>
                </div>
                {step.txId && step.done && (
                  <div className="group flex items-center gap-1.5 mt-1">
                    <span className="text-[10px] text-gray/40">{step.icon === "btc" ? "Transaction ID" : "Signature"}</span>
                    <code className="text-[10px] font-mono text-gray/60 truncate max-w-[280px]">{step.txId}</code>
                    <CopyButton text={step.txId} label={step.title} variant="default" iconSize="sm" />
                    <a
                      href={step.icon === "btc" ? `${getMempoolExplorerUrl()}/tx/${step.txId}` : getSolanaExplorerTxUrl(step.txId)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={cn("transition-colors p-0.5", step.icon === "btc" ? "text-btc/40 hover:text-btc" : "text-purple-400/40 hover:text-purple-400")}
                    >
                      <ExternalLink className="w-2.5 h-2.5" />
                    </a>
                  </div>
                )}
                {/* BTC Sent — block height, confirmations, miner fee */}
                {step.key === "btc_sent" && step.done && !redemption.simulated && redemption.btcTxid && (
                  <div className="mt-1.5">
                    <BtcConfirmationStatus txid={redemption.btcTxid} onMinerFee={setBtcMinerFee} />
                  </div>
                )}
                {/* Complete Redemption — burn amount + pool fee */}
                {step.key === "complete" && step.done && (
                  <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 mt-1.5 text-[10px] font-mono text-gray/50 pl-5">
                    {redemption.burnAmount && (
                      <>
                        <span className="text-gray/40 font-sans">Burned</span>
                        <span>{fmtBtc(Number(redemption.burnAmount))} zkBTC</span>
                      </>
                    )}
                    {redemption.burnAmount && amount > Number(redemption.burnAmount) && (
                      <>
                        <span className="text-gray/40 font-sans">Pool fee</span>
                        <span>{fmtBtc(amount - Number(redemption.burnAmount))} zkBTC</span>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
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
            {fmtBtc(Number(r.actualReceived ?? r.amountSats))} <span className="text-gray text-caption">BTC</span>
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
// Withdrawals Tab (standalone)
// =============================================================================

export function WithdrawalsTab() {
  const { data, error: swrError, isLoading, mutate } = useSWR<RedemptionRecord[]>(
    "explorer-redemptions",
    async () => {
      const resp = await fetch("/api/explorer/redemptions");
      if (!resp.ok) return [];
      const json = await resp.json();
      return json.redemptions ?? [];
    },
    { refreshInterval: 30_000, dedupingInterval: 5_000, revalidateOnFocus: false, errorRetryCount: 3 },
  );
  const redemptions = data ?? [];
  const error = swrError ? (swrError instanceof Error ? swrError.message : "Failed to fetch redemptions") : null;
  const refresh = () => mutate();
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
      <Image src="/tokens/zkbtc.png" alt="zkBTC" width={14} height={14} className="rounded-full shrink-0" />
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
