"use client";

/**
 * Transfers Tab — displays shielded JoinSplit transactions.
 * Handles three transfer types: Private Send, Unshield (zkBTC → SPL),
 * and Redeem (zkBTC → BTC). Each has its own expandable detail view
 * showing nullifier inputs and commitment/BTC outputs.
 */

import { useState, useCallback, Fragment } from "react";
import {
  ExternalLink,
} from "lucide-react";
import { CopyButton } from "@/components/ui/copy-button";
import { useExplorer, type ExplorerTransaction, type RedemptionRecord } from "@/hooks/use-explorer";
import { getMempoolExplorerUrl } from "@/lib/btc-network";
import { truncate, timeAgo } from "./helpers";
import { Th, Td, SolanaLink, TypeBadge, StatusDot, FlowCell, LoadingState, ErrorState, EmptyState, RefreshButton } from "./shared";
import type { StatusDotVariant } from "./shared";
import { SUPPORTED_TOKENS, formatTokenAmount, getTokenBySymbol } from "@/lib/supported-tokens";
import { resolveTokenSymbolSync } from "@/lib/token-map";
import { TransferDetails } from "./transfer-details";

// =============================================================================
// Transfer Row — single unified table row + expandable detail
// =============================================================================

export type TransferTxPublic = TransferTx;

/** Determine the unified kind for a transfer row */
export function getTransferKind(tx: TransferTx): "shield" | "transfer" | "unshield" | "withdraw" {
  if (tx.type === "shield") return "shield";
  if (tx.type === "withdraw") return "withdraw";
  if (tx.type === "unshield") return "unshield";
  return "transfer";
}

/** Map deposit tracker status to StatusDot variant + label */
function getShieldStatus(status: string): { variant: StatusDotVariant; label: string } {
  switch (status) {
    case "detected":
      return { variant: "processing", label: "Detected" };
    case "confirming":
      return { variant: "processing", label: "Confirming" };
    case "sweeping":
    case "sweep_confirming":
      return { variant: "processing", label: "Sweeping" };
    case "verifying":
    case "ready":
      return { variant: "processing", label: "Verifying" };
    case "claimed":
    case "verified":
    case "already_verified":
    case "confirmed":
      return { variant: "confirmed", label: "Confirmed" };
    case "failed":
      return { variant: "failed", label: "Failed" };
    default:
      return { variant: "pending", label: status || "Pending" };
  }
}

export function TransferRow({
  tx,
  expanded,
  onToggle,
  redemption,
}: {
  tx: TransferTx;
  expanded: boolean;
  onToggle: () => void;
  redemption?: RedemptionRecord;
}) {
  const kind = getTransferKind(tx);
  const isUnshieldOrWithdraw = kind === "unshield" || kind === "withdraw";
  const tokenSym = tx.tokenSymbol ?? (tx.tokenId ? resolveTokenSymbolSync(tx.tokenId) : null);
  const token = tokenSym ? getTokenBySymbol(tokenSym) ?? SUPPORTED_TOKENS[0] : SUPPORTED_TOKENS[0];

  return (
    <Fragment>
      <tr
        className="hover:bg-gray/5 transition-colors cursor-pointer"
        onClick={onToggle}
      >
        <Td>
          {tx.type === "shield" ? (() => {
            const s = getShieldStatus(tx.status);
            return <StatusDot variant={s.variant} label={s.label} />;
          })() : (
            <StatusDot
              variant={tx.status === "processing" ? "processing" : "confirmed"}
              label={tx.status === "processing" ? "Processing" : "Confirmed"}
            />
          )}
        </Td>
        <Td>
          {tx.txSignature ? (
            <div className="flex items-center gap-1.5">
              <code className="text-caption font-mono text-foreground">{truncate(tx.txSignature, 6, 4)}</code>
              <CopyButton text={tx.txSignature} label="Tx" variant="default" iconSize="sm" />
            </div>
          ) : tx.btcMeta?.depositTxid ? (
            <div className="flex items-center gap-1.5">
              <code className="text-caption font-mono text-gray">{truncate(tx.btcMeta.depositTxid, 6, 4)}</code>
              <CopyButton text={tx.btcMeta.depositTxid} label="BTC Tx" variant="default" iconSize="sm" />
            </div>
          ) : (
            <span className="text-caption text-gray/40">&mdash;</span>
          )}
        </Td>
        <Td>
          <TypeBadge kind={kind} />
        </Td>
        <Td>
          {kind === "shield" ? (
            <FlowCell
              from={{ icon: token.isBtcNative ? "/tokens/btc.png" : token.logo, label: token.symbol }}
              to={{ icon: "shield", label: "Shielded" }}
              meta={tx.btcMeta ? `${tx.btcMeta.confirmations ?? 0} conf` : undefined}
            />
          ) : isUnshieldOrWithdraw ? (
            <FlowCell
              from={{ icon: "shield", label: "Shielded" }}
              to={{ icon: kind === "withdraw" ? "/tokens/btc.png" : (token.isBtcNative ? token.shieldedLogo : token.logo), label: kind === "withdraw" ? "BTC" : token.symbol }}
              meta={`${getTxInputCount(tx)} in, ${tx.outputs.length} out`}
            />
          ) : (
            <FlowCell
              from={{ icon: "shield", label: "Shielded" }}
              to={{ icon: "shield", label: "Shielded" }}
              meta={`${getTxInputCount(tx)} in, ${tx.outputs.length} out`}
            />
          )}
        </Td>
        <Td>
          {kind === "shield" ? (() => {
            const gross = tx.inputs?.[0]?.grossAmount ?? tx.inputs?.[0]?.netAmount ?? tx.outputs?.[0]?.amount ?? 0;
            const net = tx.inputs?.[0]?.netAmount ?? tx.outputs?.[0]?.amount ?? gross;
            const fee = tx.inputs?.[0]?.fee ?? 0;
            if (!gross) return <span className="text-caption text-gray/40">&mdash;</span>;
            const fmt = (v: number) => token.showRawAmount
              ? v.toLocaleString()
              : (v / (10 ** token.decimals)).toLocaleString(undefined, { maximumFractionDigits: token.decimals });
            return fee > 0 && gross !== net ? (
              <div className="flex items-center gap-1.5 font-mono">
                <span className="text-body2 text-gray/50 line-through">{fmt(gross)}</span>
                <span className="text-[10px] text-gray/30">→</span>
                <span className="text-body2 text-foreground">{fmt(net)}</span>
                <span className="text-gray text-caption">{token.unit}</span>
              </div>
            ) : (
              <span className="text-body2 text-foreground font-mono">
                {fmt(gross)} <span className="text-gray text-caption">{token.unit}</span>
              </span>
            );
          })() : isUnshieldOrWithdraw && getTxUnshieldAmount(tx) ? (
            <span className="text-body2 text-foreground font-mono">
              {(() => {
                const amt = kind === "withdraw" && redemption?.actualReceived
                  ? Number(redemption.actualReceived)
                  : (getTxUnshieldPayout(tx) ?? getTxUnshieldAmount(tx) ?? 0);
                return token.showRawAmount
                  ? amt.toLocaleString()
                  : (amt / (10 ** token.decimals)).toLocaleString(undefined, { maximumFractionDigits: token.decimals });
              })()
              } <span className="text-gray text-caption">{token.unit}</span>
            </span>
          ) : isUnshieldOrWithdraw ? (
            <span className="text-caption text-gray/40">&mdash;</span>
          ) : (
            <span className="text-caption text-gray/40">&mdash; (private)</span>
          )}
        </Td>
        <Td>
          <span className="text-caption text-gray">{timeAgo(tx.timestamp)}</span>
        </Td>
        <Td>
          {tx.txSignature ? (
            <SolanaLink signature={tx.txSignature} />
          ) : tx.btcMeta?.depositTxid ? (
            <a
              href={`${getMempoolExplorerUrl()}/tx/${tx.btcMeta.depositTxid}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-caption text-gray hover:text-foreground transition-colors"
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          ) : null}
        </Td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={8} className="p-0">
            <TransferDetails tx={tx} redemption={redemption} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

// =============================================================================
// Transfers Tab (standalone)
// =============================================================================

export function TransfersTab() {
  const { transactions, isLoading, error, refresh } = useExplorer();
  const transfers = transactions.filter(t => t.type !== "shield");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = useCallback((sig: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(sig)) next.delete(sig);
      else next.add(sig);
      return next;
    });
  }, []);

  if (error) return <ErrorState message={error} onRetry={refresh} />;
  if (isLoading) return <LoadingState />;
  if (transfers.length === 0) return <EmptyState label="transfers" />;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <span className="text-caption text-gray">{transfers.length} transaction(s)</span>
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
            {transfers.map((tx) => (
              <TransferRow
                key={tx.txSignature}
                tx={tx}
                expanded={expanded.has(tx.txSignature)}
                onToggle={() => toggle(tx.txSignature)}
                redemption={undefined}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// =============================================================================
// Local helper accessors (used by TransferRow)
// =============================================================================

type TransferTx = ExplorerTransaction;

function getTxUnshieldOutputs(tx: TransferTx) {
  return tx.outputs.filter((o) => o.type === "unshield" || o.type === "withdraw");
}
function getTxUnshieldAmount(tx: TransferTx): number | undefined {
  const outs = getTxUnshieldOutputs(tx);
  if (outs.length === 0) return undefined;
  return outs.reduce((sum, o) => sum + (o.amount ?? 0), 0);
}
function getTxUnshieldPayout(tx: TransferTx): number | undefined {
  const outs = getTxUnshieldOutputs(tx);
  if (outs.length === 0) return undefined;
  return outs.reduce((sum, o) => sum + (o.payout ?? 0), 0);
}
function getTxInputCount(tx: TransferTx): number {
  return tx.inputs.length;
}
