"use client";

/**
 * Transfers Tab — displays shielded JoinSplit transactions.
 * Handles three transfer types: Private Send, Unshield (zkBTC → SPL),
 * and Redeem (zkBTC → BTC). Each has its own expandable detail view
 * showing nullifier inputs and commitment/BTC outputs.
 */

import { useState, useCallback, Fragment } from "react";
import Image from "next/image";
import {
  ExternalLink,
  Shield,
  Unlock,
  Wallet,
  CheckCircle2,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/ui/copy-button";
import { BitcoinIcon } from "@/components/bitcoin-wallet-selector";
import { useTransfers, useRedemptions, type RedemptionRecord } from "@/hooks/use-explorer";
import { getMempoolExplorerUrl } from "@/lib/btc-network";
import { getSolanaExplorerTxUrl, getSolanaExplorerAddressUrl } from "@/lib/solana-network";
import { truncate, timeAgo } from "./helpers";
import { Th, Td, SolanaLink, TypeBadge, StatusDot, FlowCell, LoadingState, ErrorState, EmptyState, RefreshButton } from "./shared";
import { SUPPORTED_TOKENS, formatTokenAmount, getTokenBySymbol, type SupportedToken } from "@/lib/supported-tokens";
import { resolveTokenSymbolSync } from "@/lib/token-map";

// =============================================================================
// Transfer Row — single unified table row + expandable detail
// =============================================================================

export type TransferTxPublic = TransferTx;

/** Determine the unified kind for a transfer row */
export function getTransferKind(tx: TransferTx): "transfer" | "unshield" | "withdraw" {
  if (tx.transferType === "redeem" || isRedeemType(tx)) return "withdraw";
  if (tx.transferType === "unshield" || isUnshieldType(tx)) return "unshield";
  return "transfer";
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
          <StatusDot
            variant={tx.status === "processing" ? "processing" : "confirmed"}
            label={tx.status === "processing" ? "Processing" : "Confirmed"}
          />
        </Td>
        <Td>
          <div className="flex items-center gap-1.5">
            <code className="text-caption font-mono text-foreground">{truncate(tx.txSignature, 6, 4)}</code>
            <CopyButton text={tx.txSignature} label="Tx" variant="default" iconSize="sm" />
          </div>
        </Td>
        <Td>
          <TypeBadge kind={kind} />
        </Td>
        <Td>
          {isUnshieldOrWithdraw ? (
            <FlowCell
              from={{ icon: "shield", label: token.shieldedSymbol }}
              to={{ icon: kind === "withdraw" ? "/tokens/btc.png" : (token.isBtcNative ? token.shieldedLogo : token.logo), label: kind === "withdraw" ? "BTC" : token.symbol }}
              meta={`${tx.inputCount} in, ${tx.outputs.length + 1} out`}
            />
          ) : (
            <FlowCell
              from={{ icon: "shield", label: "Shielded" }}
              to={{ icon: "shield", label: "Shielded" }}
              meta={`${tx.inputCount} in, ${tx.outputs.length} out`}
            />
          )}
        </Td>
        <Td>
          {isUnshieldOrWithdraw && tx.unshieldAmount ? (
            <span className="text-body2 text-foreground font-mono">
              {(() => {
                // For withdrawals, use actualReceived from redemption (net after service + miner fee)
                const amt = kind === "withdraw" && redemption?.actualReceived
                  ? Number(redemption.actualReceived)
                  : (tx.unshieldPayout ?? tx.unshieldAmount);
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
          <SolanaLink signature={tx.txSignature} />
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
// Transfers Tab (standalone, kept for backward compat)
// =============================================================================

export function TransfersTab() {
  const { transfers, isLoading, error, refresh } = useTransfers();
  const { redemptions } = useRedemptions();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Build lookup: requestTxSignature → RedemptionRecord (for withdraw detail enrichment)
  const redemptionByRequestTx = new Map<string, RedemptionRecord>();
  for (const r of redemptions) {
    if (r.requestTxSignature) redemptionByRequestTx.set(r.requestTxSignature, r);
  }

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
                redemption={redemptionByRequestTx.get(tx.txSignature)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// =============================================================================
// Sub-components
// =============================================================================

type TransferTx = ReturnType<typeof useTransfers>["transfers"][number];

/**
 * Determine transfer type from backend-computed `transferType` field.
 * Falls back to disc-based classification for old data without `transferType`.
 */
function isRedeemType(tx: TransferTx): boolean {
  if (tx.transferType) return tx.transferType === "redeem";
  // Fallback: disc-based classification for old indexed data
  if (tx.instructionDisc === 5 || tx.instructionDisc === 16) return true;
  if (tx.operationType === 0 && tx.instructionDisc !== 30 && tx.instructionDisc !== 15) return true;
  return false;
}

function isUnshieldType(tx: TransferTx): boolean {
  if (tx.transferType) return tx.transferType === "unshield";
  // Fallback: disc-based classification for old indexed data
  return tx.instructionDisc === 30 || tx.instructionDisc === 15;
}

function TransferTypeBadge({ tx }: { tx: TransferTx }) {
  if (isRedeemType(tx)) {
    return (
      <div className="flex items-center gap-1.5">
        <div className="p-1 rounded-[6px] bg-btc/10 border border-btc/20">
          <BitcoinIcon className="w-3 h-3 text-btc" />
        </div>
        <div className="flex flex-col">
          <span className="text-caption text-btc font-semibold leading-tight">Redeem</span>
          <span className="text-[10px] text-gray leading-tight">zkBTC → BTC</span>
        </div>
      </div>
    );
  }
  if (isUnshieldType(tx)) {
    return (
      <div className="flex items-center gap-1.5">
        <div className="p-1 rounded-[6px] bg-purple-500/10 border border-purple-500/20">
          <Unlock className="w-3 h-3 text-purple-400" />
        </div>
        <div className="flex flex-col">
          <span className="text-caption text-purple-400 font-semibold leading-tight">Unshield</span>
          <span className="text-[10px] text-gray leading-tight">zkBTC → SPL</span>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <div className="p-1 rounded-[6px] bg-privacy/10 border border-privacy/20">
        <Shield className="w-3 h-3 text-privacy" />
      </div>
      <div className="flex flex-col">
        <span className="text-caption text-privacy font-semibold leading-tight">Private Send</span>
        <span className="text-[10px] text-gray leading-tight">Shielded transfer</span>
      </div>
    </div>
  );
}

function TransferAssetBadge({ tx }: { tx: TransferTx }) {
  const tokenSym = tx.tokenSymbol ?? (tx.tokenId ? resolveTokenSymbolSync(tx.tokenId) : null);
  const token = tokenSym ? getTokenBySymbol(tokenSym) ?? SUPPORTED_TOKENS[0] : SUPPORTED_TOKENS[0];
  // Redeem = zkBTC → BTC, everything else = shielded token
  if (isRedeemType(tx)) {
    return (
      <span className="inline-flex items-center gap-1.5 text-caption text-btc/90 bg-btc/6 border border-btc/15 px-2 py-0.5 rounded-full font-medium">
        <img src={token.logo} alt={token.shieldedSymbol} className="w-3.5 h-3.5 rounded-full" />
        {token.shieldedSymbol}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-caption text-privacy/90 bg-privacy/6 border border-privacy/15 px-2 py-0.5 rounded-full font-medium">
      <img src={token.shieldedLogo} alt={token.shieldedSymbol} className="w-3.5 h-3.5 rounded-full" />
      {token.shieldedSymbol}
    </span>
  );
}

function TransferOutputCount({ tx }: { tx: TransferTx }) {
  if (isUnshieldType(tx) || isRedeemType(tx)) {
    return (
      <span className="inline-flex items-center gap-1 text-caption text-purple-400/70 bg-purple-500/6 border border-purple-500/12 px-2 py-0.5 rounded-full">
        <span className="font-mono">{1 + tx.outputs.length}</span>
        <span className="hidden sm:inline">output{tx.outputs.length > 0 ? "s" : ""}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-caption text-purple-400/70 bg-purple-500/6 border border-purple-500/12 px-2 py-0.5 rounded-full">
      <span className="font-mono">{tx.outputs.length}</span>
      <span className="hidden sm:inline">output{tx.outputs.length !== 1 ? "s" : ""}</span>
    </span>
  );
}

// --- Shared detail sub-components ---

function NullifierInputsList({ tx }: { tx: TransferTx }) {
  return (
    <div className="p-4 space-y-2.5">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
        <span className="text-caption text-green-400/90 font-semibold uppercase tracking-wider">Inputs</span>
        <span className="text-caption text-green-400/60 font-medium">{tx.inputCount}</span>
      </div>
      {tx.nullifierPdas.length > 0 ? tx.nullifierPdas.map((pda, i) => (
        <NullifierRow key={pda} pda={pda} index={i} />
      )) : (
        <div className="flex items-center justify-center gap-2 px-3 py-3 rounded-[8px] bg-gray/4 border border-gray/8">
          <Shield className="w-3.5 h-3.5 text-gray/30" />
          <span className="text-caption text-gray/40">No nullifiers (deposit claim)</span>
        </div>
      )}
    </div>
  );
}

function NullifierRow({ pda, index }: { pda: string; index: number }) {
  return (
    <div className="group flex items-center gap-2 px-3 py-2 rounded-[8px] bg-gray/4 border border-gray/8 hover:border-gray/15 transition-colors">
      <span className="text-[10px] text-gray/50 shrink-0">Nullifier</span>
      <code className="text-caption font-mono text-foreground/90 truncate">{truncate(pda, 8, 6)}</code>
      <div className="flex items-center gap-1 ml-auto shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
        <CopyButton text={pda} label="Nullifier" variant="default" iconSize="sm" />
        <a
          href={getSolanaExplorerAddressUrl(pda)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sol hover:text-sol/80 transition-colors p-0.5"
        >
          <ExternalLink className="w-3 h-3" />
        </a>
      </div>
    </div>
  );
}

function CommitmentRow({ commitment, leafIndex, txSignature, index }: { commitment: string; leafIndex: number; txSignature: string; index: number }) {
  return (
    <div className="group flex items-center gap-2 px-3 py-2 rounded-[8px] bg-gray/4 border border-gray/8 hover:border-gray/15 transition-colors">
      <span className="text-[10px] text-gray/50 shrink-0">Commitment</span>
      <code className="text-caption font-mono text-foreground/90 truncate">{truncate(commitment, 8, 6)}</code>
      <span className="text-[10px] text-gray/50 font-mono bg-gray/8 px-1.5 py-0.5 rounded shrink-0">#{leafIndex}</span>
      <div className="flex items-center gap-1 ml-auto shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
        <CopyButton text={commitment} label="Commitment" variant="default" iconSize="sm" />
        <a
          href={getSolanaExplorerTxUrl(txSignature)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sol hover:text-sol/80 transition-colors p-0.5"
          title="View transaction"
        >
          <ExternalLink className="w-3 h-3" />
        </a>
      </div>
    </div>
  );
}

// --- Transfer Details ---

function TransferDetails({ tx, redemption }: { tx: TransferTx; redemption?: RedemptionRecord }) {
  const kind = getTransferKind(tx);
  if (kind === "withdraw") return <RedeemDetails tx={tx} redemption={redemption} />;
  if (kind === "unshield") return <UnshieldDetails tx={tx} />;
  return <StandardTransferDetails tx={tx} />;
}

function RedeemDetails({ tx, redemption }: { tx: TransferTx; redemption?: RedemptionRecord }) {
  const tokenSym = tx.tokenSymbol ?? (tx.tokenId ? resolveTokenSymbolSync(tx.tokenId) : null);
  const token = tokenSym ? getTokenBySymbol(tokenSym) ?? SUPPORTED_TOKENS[0] : SUPPORTED_TOKENS[0];
  const r = redemption;
  const grossAmount = r ? Number(r.amountSats) : tx.unshieldAmount;
  const netReceived = r?.actualReceived ? Number(r.actualReceived) : tx.unshieldAmount;
  const serviceFee = r?.serviceFee ? Number(r.serviceFee) : 0;

  return (
    <div className="mx-4 my-3 rounded-[10px] bg-linear-to-b from-gray/6 to-transparent border border-gray/10 overflow-hidden">
      <div className="grid grid-cols-2 divide-x divide-gray/10">
        {/* INPUT — Shielded note burned */}
        <div className="p-4 space-y-2.5">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
            <span className="text-caption text-green-400/90 font-semibold uppercase tracking-wider">Input</span>
            <span className="text-caption text-green-400/60 font-medium">{tx.inputCount}</span>
          </div>
          <div className="px-3 py-2.5 rounded-[8px] bg-green-500/4 border border-green-500/10 space-y-1.5">
            <div className="flex items-center gap-2">
              <img src={token.shieldedLogo} alt={token.shieldedSymbol} className="w-3.5 h-3.5 rounded-full shrink-0" />
              <span className="text-body2 text-foreground font-mono font-semibold">
                {grossAmount ? formatTokenAmount(grossAmount, token) : "—"}
              </span>
            </div>
            <span className="text-[10px] text-gray/50">Shielded note (burned)</span>
          </div>
          {/* Nullifier */}
          {tx.nullifierPdas.length > 0 && tx.nullifierPdas.map((pda, i) => (
            <NullifierRow key={pda} pda={pda} index={i} />
          ))}
        </div>

        {/* OUTPUT — BTC sent */}
        <div className="p-4 space-y-2.5">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-1.5 h-1.5 rounded-full bg-btc" />
            <span className="text-caption text-btc/90 font-semibold uppercase tracking-wider">Output</span>
            <span className="text-caption text-btc/60 font-medium">1</span>
          </div>
          <div className="px-3 py-2.5 rounded-[8px] bg-btc/4 border border-btc/10 space-y-2">
            <div className="flex items-center gap-2">
              <BitcoinIcon className="w-3.5 h-3.5 text-btc shrink-0" />
              <span className="text-body2 text-foreground font-mono font-semibold">
                {netReceived ? formatTokenAmount(netReceived, token) : "—"}
              </span>
            </div>
            {tx.unshieldRecipient ? (
              <div className="group flex items-center gap-2">
                <span className="text-[10px] text-gray/50 shrink-0">&rarr;</span>
                <code className="text-caption font-mono text-foreground/80 truncate">{truncate(tx.unshieldRecipient, 10, 6)}</code>
                <div className="flex items-center gap-1 ml-auto shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                  <CopyButton text={tx.unshieldRecipient} label="BTC Address" variant="default" iconSize="sm" />
                  <a href={`${getMempoolExplorerUrl()}/address/${tx.unshieldRecipient}`} target="_blank" rel="noopener noreferrer" className="text-btc hover:text-btc/80 transition-colors p-0.5">
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <BitcoinIcon className="w-3.5 h-3.5 text-gray/30 shrink-0" />
                <span className="text-caption text-gray/40">Recipient pending</span>
              </div>
            )}
          </div>
          {/* Change outputs */}
          {tx.outputs.map((out, i) => (
            <CommitmentRow key={out.leafIndex} commitment={out.commitment} leafIndex={out.leafIndex} txSignature={tx.txSignature} index={i + 2} />
          ))}
        </div>
      </div>

      {/* Vertical timeline + service fee */}
      <div className="px-5 pb-4 pt-2 border-t border-gray/10 space-y-2">
        {serviceFee > 0 && (
          <span className="text-[10px] text-gray/60 font-mono">
            Service fee: {formatTokenAmount(serviceFee, token)}
          </span>
        )}
        <WithdrawTimeline tx={tx} redemption={r} />
      </div>
    </div>
  );
}

/** Vertical timeline showing withdrawal lifecycle */
function WithdrawTimeline({ tx, redemption: r }: { tx: TransferTx; redemption?: RedemptionRecord }) {
  const statusOrder: Record<string, number> = { Pending: 1, Processing: 2, "BTC Sent": 3, Completed: 4 };
  const current = statusOrder[r?.status ?? "Pending"] ?? 0;

  const steps = [
    {
      title: "Request Redemption",
      done: current >= 1,
      icon: "sol" as const,
      txId: tx.txSignature,
    },
    {
      title: "Mark Processing",
      done: current >= 2,
      icon: "sol" as const,
      txId: r?.processingTxSignature ?? null,
    },
    {
      title: "BTC Sent",
      done: current >= 3,
      icon: "btc" as const,
      txId: r?.btcTxid ?? null,
    },
    {
      title: "Complete Redemption",
      done: current >= 4,
      icon: "sol" as const,
      txId: r?.completeTxSignature ?? null,
    },
  ];

  return (
    <div className="space-y-0">
      {steps.map((step, i) => (
        <div key={step.title} className="flex gap-3">
          <div className="flex flex-col items-center w-5">
            <div className={cn(
              "w-5 h-5 rounded-full flex items-center justify-center shrink-0 border",
              step.done ? "bg-green-500/15 border-green-500/30" : "bg-gray/8 border-gray/15"
            )}>
              {step.done ? (
                <CheckCircle2 className="w-3 h-3 text-green-400" />
              ) : (
                <Loader2 className="w-3 h-3 text-gray/40 animate-spin" />
              )}
            </div>
            {i < steps.length - 1 && (
              <div className={cn("w-px flex-1 min-h-[20px]", step.done ? "bg-green-500/20" : "bg-gray/10")} />
            )}
          </div>
          <div className="flex-1 pb-3">
            <div className="flex items-center gap-2">
              {step.icon === "btc" ? (
                <BitcoinIcon className="w-3.5 h-3.5 text-btc/70" />
              ) : (
                <img src="/tokens/sol.png" alt="SOL" className="w-3.5 h-3.5 rounded-full opacity-70" />
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
          </div>
        </div>
      ))}
    </div>
  );
}

function UnshieldAmountDisplay({ grossAmount, netAmount, fee, token }: { grossAmount: number; netAmount: number; fee: number; token: SupportedToken }) {
  const fmt = (v: number) => token.showRawAmount
    ? v.toLocaleString()
    : (v / (10 ** token.decimals)).toLocaleString(undefined, { maximumFractionDigits: token.decimals });
  // Unshield output is the SPL token: zkBTC for BTC, USDC for USDC, etc.
  const outSymbol = token.isBtcNative ? token.shieldedSymbol : token.symbol;
  const outLogo = token.isBtcNative ? token.shieldedLogo : token.logo;
  return (
    <>
      <div className="flex items-center gap-2 flex-wrap">
        <img src={token.shieldedLogo} alt={token.shieldedSymbol} className="w-3.5 h-3.5 rounded-full shrink-0" />
        <span className="text-body2 text-foreground font-mono font-semibold">
          {fmt(grossAmount)} <span className="text-[10px] text-gray font-normal">{token.shieldedSymbol}</span>
        </span>
        <span className="text-[10px] text-gray/40">→</span>
        <img src={outLogo} alt={outSymbol} className="w-3.5 h-3.5 rounded-full shrink-0" />
        <span className="text-body2 text-foreground font-mono font-semibold">
          {fmt(netAmount)} <span className="text-[10px] text-gray font-normal">{outSymbol}</span>
        </span>
      </div>
      {fee > 0 && (
        <div className="text-[10px] text-gray/50 font-mono pt-1 border-t border-purple-500/8">
          Service fee {fmt(fee)} {token.unit}
        </div>
      )}
    </>
  );
}

function UnshieldDetails({ tx }: { tx: TransferTx }) {
  const tokenSym = tx.tokenSymbol ?? (tx.tokenId ? resolveTokenSymbolSync(tx.tokenId) : null);
  const token = tokenSym ? getTokenBySymbol(tokenSym) ?? SUPPORTED_TOKENS[0] : SUPPORTED_TOKENS[0];
  const grossAmount = tx.unshieldAmount;
  const fee = tx.unshieldFee ?? 0;
  const netAmount = tx.unshieldPayout ?? tx.unshieldAmount;
  return (
    <div className="mx-4 my-3 rounded-[10px] bg-linear-to-b from-gray/6 to-transparent border border-gray/10 overflow-hidden">
      <div className="grid grid-cols-2 divide-x divide-gray/10">
        {/* INPUT — nullifiers only */}
        <NullifierInputsList tx={tx} />

        {/* OUTPUT — zkToken → Token conversion */}
        <div className="p-4 space-y-2.5">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-1.5 h-1.5 rounded-full bg-purple-400" />
            <span className="text-caption text-purple-400/90 font-semibold uppercase tracking-wider">Output</span>
            <span className="text-caption text-purple-400/60 font-medium">{1 + tx.outputs.length}</span>
          </div>
          <div className="px-3 py-2.5 rounded-[8px] bg-purple-500/4 border border-purple-500/10 space-y-2">
            {/* zkToken → Token conversion */}
            {grossAmount ? (
              <UnshieldAmountDisplay grossAmount={grossAmount} netAmount={netAmount ?? grossAmount} fee={fee} token={token} />
            ) : (
              <span className="text-caption text-gray/40">Amount pending re-index</span>
            )}
            {tx.unshieldRecipient ? (
              <div className="group flex items-center gap-2">
                <Wallet className="w-3.5 h-3.5 text-sol/50 shrink-0" />
                <code className="text-caption font-mono text-foreground/80 truncate">{truncate(tx.unshieldRecipient, 8, 6)}</code>
                <div className="flex items-center gap-1 ml-auto shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                  <CopyButton text={tx.unshieldRecipient} label="Address" variant="default" iconSize="sm" />
                  <a
                    href={getSolanaExplorerAddressUrl(tx.unshieldRecipient)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sol hover:text-sol/80 transition-colors p-0.5"
                  >
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Wallet className="w-3.5 h-3.5 text-gray/30 shrink-0" />
                <span className="text-caption text-gray/40">Recipient pending re-index</span>
              </div>
            )}
          </div>
          {/* Change outputs */}
          {tx.outputs.map((out, i) => (
            <CommitmentRow key={out.leafIndex} commitment={out.commitment} leafIndex={out.leafIndex} txSignature={tx.txSignature} index={i + 2} />
          ))}
        </div>
      </div>
    </div>
  );
}

function StandardTransferDetails({ tx }: { tx: TransferTx }) {
  return (
    <div className="mx-4 my-3 rounded-[10px] bg-linear-to-b from-gray/6 to-transparent border border-gray/10 overflow-hidden">
      <div className="grid grid-cols-2 divide-x divide-gray/10">
        <NullifierInputsList tx={tx} />
        <div className="p-4 space-y-2.5">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-1.5 h-1.5 rounded-full bg-purple-400" />
            <span className="text-caption text-purple-400/90 font-semibold uppercase tracking-wider">Outputs</span>
            <span className="text-caption text-purple-400/60 font-medium">{tx.outputs.length}</span>
          </div>
          {tx.outputs.map((out, i) => (
            <CommitmentRow key={out.leafIndex} commitment={out.commitment} leafIndex={out.leafIndex} txSignature={tx.txSignature} index={i + 1} />
          ))}
        </div>
      </div>
    </div>
  );
}
