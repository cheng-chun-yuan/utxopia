"use client";

/**
 * Deposits Tab — displays BTC deposit lifecycle.
 * Shows deposit status badge, expandable detail rows with step-by-step
 * progress (BTC deposit → sweep → SPV verify → mint zkBTC).
 */

import { useState, useCallback, Fragment } from "react";
import {
  CheckCircle2,
  Clock,
  ExternalLink,
  Loader2,
  Shield,
  XCircle,
} from "lucide-react";
import { BitcoinIcon } from "@/components/bitcoin-wallet-selector";
import { getSolanaExplorerAddressUrl } from "@/lib/solana-network";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/ui/copy-button";
import { useDeposits } from "@/hooks/use-explorer";
import type { DepositRecord } from "@/hooks/use-explorer";
import { getMempoolExplorerUrl } from "@/lib/btc-network";
import { getSolanaExplorerTxUrl } from "@/lib/solana-network";
import Image from "next/image";
import { truncate, timeAgo } from "./helpers";
import { Th, Td, SolanaLink, TypeBadge, StatusDot, FlowCell, LoadingState, ErrorState, EmptyState, RefreshButton } from "./shared";
import type { StatusDotVariant } from "./shared";
import { SUPPORTED_TOKENS, formatTokenAmount, type SupportedToken } from "@/lib/supported-tokens";
import { getTokenBySymbol } from "@/lib/supported-tokens";

// =============================================================================
// Deposit Status
// =============================================================================

const DEPOSIT_STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; spinning?: boolean }> = {
  pending: { label: "Awaiting BTC", color: "text-yellow-400", bg: "bg-yellow-500/10 border-yellow-500/20" },
  detected: { label: "Detected", color: "text-purple-400", bg: "bg-purple-500/10 border-purple-500/20", spinning: true },
  confirming: { label: "Confirming", color: "text-purple-400", bg: "bg-purple-500/10 border-purple-500/20", spinning: true },
  confirmed: { label: "Confirmed", color: "text-blue-400", bg: "bg-blue-500/10 border-blue-500/20" },
  sweeping: { label: "Sweeping", color: "text-blue-400", bg: "bg-blue-500/10 border-blue-500/20", spinning: true },
  sweep_confirming: { label: "Sweep Confirming", color: "text-blue-400", bg: "bg-blue-500/10 border-blue-500/20", spinning: true },
  verifying: { label: "Verifying", color: "text-sol", bg: "bg-sol/10 border-sol/20", spinning: true },
  ready: { label: "Minted", color: "text-green-400", bg: "bg-green-500/10 border-green-500/20" },
  claimed: { label: "Minted", color: "text-green-400", bg: "bg-green-500/10 border-green-500/20" },
  failed: { label: "Failed", color: "text-red-400", bg: "bg-red-500/10 border-red-500/20" },
};

function getDepositStatusDot(status: string | null): { variant: StatusDotVariant; label: string } {
  const resolved = status ?? "claimed";
  if (resolved === "ready" || resolved === "claimed") return { variant: "confirmed", label: "Confirmed" };
  if (resolved === "failed") return { variant: "failed", label: "Failed" };
  if (resolved === "pending") return { variant: "pending", label: "Pending" };
  return { variant: "processing", label: DEPOSIT_STATUS_CONFIG[resolved]?.label ?? "Processing" };
}

// =============================================================================
// Deposit Details (expandable row)
// =============================================================================

const DEPOSIT_STATUS_ORDER: Record<string, number> = {
  pending: 0, detected: 1, confirming: 1, confirmed: 2,
  sweeping: 3, sweep_confirming: 3, verifying: 4, ready: 5, claimed: 5,
};

function DepositDetails({ deposit }: { deposit: DepositRecord }) {
  const d = deposit;
  const resolvedToken = d.tokenSymbol ? getTokenBySymbol(d.tokenSymbol) : null;
  const shieldType = resolvedToken
    ? (resolvedToken.explorerFilter as "btc" | "sol" | "usdc" | "usdt")
    : getShieldType(d);
  const config = resolvedToken
    ? buildShieldConfig(resolvedToken)
    : SHIELD_TYPE_CONFIG[shieldType];
  const isBtc = shieldType === "btc";
  // For BTC deposits:
  //   depositAmountSats = original deposit to taproot (25000, from DepositVerified event)
  //   grossAmount = sweep output arriving at pool (24000, from ShieldMeta)
  //   fee = protocol fee (2048, from ShieldMeta)
  //   amountSats = shielded amount (21952)
  //   minerFee = depositAmountSats - grossAmount (1000, computed)
  const originalDeposit = isBtc ? (d.btcMeta?.depositAmountSats ?? null) : null;
  const grossAmount = d.grossAmount ?? d.amountSats;
  const shieldedAmount = d.amountSats;
  const serviceFee = d.fee ?? (grossAmount - shieldedAmount);
  // Miner fee: difference between original deposit and what arrived at pool
  const minerFee = originalDeposit && originalDeposit > grossAmount ? originalDeposit - grossAmount : (d.btcMeta?.sweepFeeSats ?? 0);
  // Display gross = original deposit if known, otherwise sweep amount
  const displayGross = originalDeposit ?? grossAmount;
  const fmtAmount = (sats: number) => config.showRaw
    ? sats.toLocaleString()
    : (sats / (10 ** config.decimals)).toLocaleString(undefined, { maximumFractionDigits: config.decimals });

  return (
    <div className="mx-4 my-3 rounded-[10px] bg-linear-to-b from-gray/6 to-transparent border border-gray/10 overflow-hidden">
      <div className="grid grid-cols-2 divide-x divide-gray/10">
        {/* INPUT — token → shielded conversion */}
        <div className="p-4 space-y-2.5">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
            <span className="text-caption text-green-400/90 font-semibold uppercase tracking-wider">Input</span>
            <span className="text-caption text-green-400/60 font-medium">1</span>
          </div>
          <div className={cn("px-3 py-2.5 rounded-[8px] space-y-2", isBtc ? "bg-btc/4 border border-btc/10" : "bg-green-500/4 border border-green-500/10")}>
            {/* Token → Shielded conversion */}
            <div className="flex items-center gap-2 flex-wrap">
              <img src={config.from.logo} alt={config.from.label} className="w-3.5 h-3.5 rounded-full shrink-0" />
              <span className="text-body2 text-foreground font-mono font-semibold">
                {fmtAmount(displayGross)} <span className="text-[10px] text-gray font-normal">{config.unit}</span>
              </span>
              <span className="text-[10px] text-gray/40">→</span>
              <img src={config.to.logo} alt={config.to.label} className="w-3.5 h-3.5 rounded-full shrink-0" />
              <span className="text-body2 text-foreground font-mono font-semibold">
                {fmtAmount(shieldedAmount)} <span className="text-[10px] text-gray font-normal">{config.to.label}</span>
              </span>
            </div>
            {d.btcMeta?.taprootAddress && (
              <div className="group flex items-center gap-2">
                <span className="text-[10px] text-gray/50 shrink-0">→</span>
                <code className="text-caption font-mono text-foreground/80 truncate">{truncate(d.btcMeta?.taprootAddress, 10, 6)}</code>
                <div className="flex items-center gap-1 ml-auto shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                  <CopyButton text={d.btcMeta?.taprootAddress} label="Address" variant="default" iconSize="sm" />
                  <a href={`${getMempoolExplorerUrl()}/address/${d.btcMeta?.taprootAddress}`} target="_blank" rel="noopener noreferrer" className="text-btc hover:text-btc/80 transition-colors p-0.5">
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              </div>
            )}
            {/* Fee breakdown */}
            {(serviceFee > 0 || minerFee > 0) && (
              <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[10px] text-gray/50 font-mono pt-1 border-t border-green-500/8">
                {serviceFee > 0 && (
                  <>
                    <span>Service fee</span>
                    <span>{fmtAmount(serviceFee)} {config.unit}</span>
                  </>
                )}
                {minerFee > 0 && (
                  <>
                    <span>Miner fee</span>
                    <span>{fmtAmount(minerFee)} {config.unit}</span>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* OUTPUT — commitment only */}
        <div className="p-4 space-y-2.5">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-1.5 h-1.5 rounded-full bg-purple-400" />
            <span className="text-caption text-purple-400/90 font-semibold uppercase tracking-wider">Output</span>
            <span className="text-caption text-purple-400/60 font-medium">1</span>
          </div>
          {d.commitment && (
            <div className="group rounded-[8px] bg-gray/4 border border-gray/8 hover:border-gray/15 transition-colors overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2">
                <span className="text-[10px] text-gray/50 shrink-0">Commitment</span>
                <code className="text-caption font-mono text-foreground/90 truncate">{truncate(d.commitment, 8, 6)}</code>
                <span className="text-[10px] text-gray/50 font-mono bg-gray/8 px-1.5 py-0.5 rounded shrink-0">#{d.leafIndex}</span>
                <div className="flex items-center gap-1 ml-auto shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                  <CopyButton text={d.commitment} label="Commitment" variant="default" iconSize="sm" />
                  {d.txSignature && (
                    <a href={getSolanaExplorerTxUrl(d.txSignature)} target="_blank" rel="noopener noreferrer" className="text-sol hover:text-sol/80 transition-colors p-0.5" title="View transaction">
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Fee + timeline */}
      {isBtc && (
        <div className="px-5 pb-4 pt-2 border-t border-gray/10">
          <DepositTimeline deposit={d} />
        </div>
      )}
    </div>
  );
}

/** Vertical timeline showing deposit lifecycle transactions */
function DepositTimeline({ deposit: d }: { deposit: DepositRecord }) {
  const stepOrder = DEPOSIT_STATUS_ORDER[d.status ?? ""] ?? 0;

  const steps = [
    {
      title: "Deposit BTC",
      done: stepOrder >= 1,
      icon: "btc" as const,
      txId: d.btcMeta?.depositTxid,
      txType: "btc" as const,
      badge: null,
    },
    {
      title: "Sweep to Pool",
      done: stepOrder >= 3,
      icon: "btc" as const,
      txId: d.btcMeta?.sweepTxid,
      txType: "btc" as const,
      badge: null,
    },
    {
      title: "SPV Verify",
      done: stepOrder >= 4,
      icon: "sol" as const,
      txId: d.txSignature || d.txSignature,
      txType: "sol" as const,
      badge: null,
    },
    {
      title: "Mint zkBTC",
      done: stepOrder >= 5,
      icon: "sol" as const,
      txId: d.txSignature,
      txType: "sol" as const,
      badge: d.btcMeta?.mintedSats ? `${d.btcMeta?.mintedSats.toLocaleString()} sats` : null,
    },
  ];

  return (
    <div className="space-y-0">
      {steps.map((step, i) => (
        <div key={step.title} className="flex gap-3">
          {/* Vertical line + dot */}
          <div className="flex flex-col items-center w-5">
            <div className={cn(
              "w-5 h-5 rounded-full flex items-center justify-center shrink-0 border",
              step.done
                ? "bg-green-500/15 border-green-500/30"
                : "bg-gray/8 border-gray/15"
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
          {/* Content */}
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
              {step.badge && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-green-500/10 border border-green-500/20 text-[9px] text-green-400 font-medium">
                  <CheckCircle2 className="w-2.5 h-2.5" /> {step.badge}
                </span>
              )}
            </div>
            {step.txId && step.done && (
              <div className="group flex items-center gap-1.5 mt-1">
                <span className="text-[10px] text-gray/40">{step.txType === "btc" ? "Transaction ID" : "Signature"}</span>
                <code className="text-[10px] font-mono text-gray/60 truncate max-w-[280px]">{step.txId}</code>
                <CopyButton text={step.txId} label={step.title} variant="default" iconSize="sm" />
                <a
                  href={step.txType === "btc" ? `${getMempoolExplorerUrl()}/tx/${step.txId}` : getSolanaExplorerTxUrl(step.txId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn("transition-colors p-0.5", step.txType === "btc" ? "text-btc/40 hover:text-btc" : "text-purple-400/40 hover:text-purple-400")}
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

// =============================================================================
// Deposit Row — single unified table row + expandable detail
// =============================================================================

/**
 * Determine shield type from instruction discriminator.
 * TODO: Once on-chain events include tokenMint (Issue 1B), replace heuristic with mint lookup.
 */
export function getShieldType(d: DepositRecord): "btc" | "sol" | "usdc" | "usdt" | "spl" {
  if (d.instructionDisc === 1) return "btc"; // verify_stealth_deposit
  if (d.instructionDisc === 29) {
    // SPL shield — detect token by amount heuristic (workaround until Issue 1B lands)
    // SOL: 9 decimals (amounts like 100_000_000 = 0.1 SOL)
    // USDC/USDT: 6 decimals (amounts like 1_000_000 = 1 USDC)
    if (d.amountSats >= 1_000_000 && d.amountSats < 1_000_000_000) return "sol";
    if (d.amountSats >= 1_000_000_000) return "usdc"; // could be USDC or USDT — ambiguous until Issue 1B
    return "spl";
  }
  return "btc"; // fallback
}

// Build shield type config from consolidated SUPPORTED_TOKENS
type ShieldTypeConfig = {
  from: { label: string; logo: string; color: string };
  to: { label: string; logo: string; color: string };
  decimals: number; unit: string; showRaw: boolean;
};

function buildShieldConfig(token: SupportedToken): ShieldTypeConfig {
  return {
    from: { label: token.symbol, logo: token.logo, color: token.explorerColors.from },
    to: { label: token.shieldedSymbol, logo: token.shieldedLogo, color: token.explorerColors.to },
    decimals: token.decimals, unit: token.unit, showRaw: token.showRawAmount,
  };
}

const btcToken = SUPPORTED_TOKENS.find(t => t.symbol === "BTC")!;
const solToken = SUPPORTED_TOKENS.find(t => t.symbol === "SOL")!;
const usdcToken = SUPPORTED_TOKENS.find(t => t.symbol === "USDC")!;
const usdtToken = SUPPORTED_TOKENS.find(t => t.symbol === "USDT")!;

const SHIELD_TYPE_CONFIG: Record<string, ShieldTypeConfig> = {
  btc: buildShieldConfig(btcToken),
  sol: buildShieldConfig(solToken),
  usdc: buildShieldConfig(usdcToken),
  usdt: buildShieldConfig(usdtToken),
  spl: {
    from: { label: "SPL", logo: "/tokens/sol.png", color: "text-gray/70 bg-gray/6 border-gray/10" },
    to: { label: "Shielded", logo: "/tokens/sol.png", color: "text-privacy/80 bg-privacy/6 border-privacy/10" },
    decimals: 0, unit: "", showRaw: true,
  },
};

const SHIELDED = { icon: "shield", label: "Shielded" };
const FLOW_ICONS: Record<string, { from: { icon: string; label: string }; to: { icon: string; label: string } }> = {
  btc: { from: { icon: "/tokens/btc.png", label: "BTC" }, to: SHIELDED },
  sol: { from: { icon: "/tokens/sol.png", label: "SOL" }, to: SHIELDED },
  usdc: { from: { icon: "/tokens/usdc.png", label: "USDC" }, to: SHIELDED },
  usdt: { from: { icon: "/tokens/usdt.png", label: "USDT" }, to: SHIELDED },
  spl: { from: { icon: "/tokens/sol.png", label: "SPL" }, to: SHIELDED },
};

export function DepositRow({
  deposit,
  index,
  expanded,
  onToggle,
}: {
  deposit: DepositRecord;
  index: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const d = deposit;
  // Use tokenSymbol from backend if available, fall back to heuristic
  const resolvedToken = d.tokenSymbol ? getTokenBySymbol(d.tokenSymbol) : null;
  const shieldType = resolvedToken
    ? (resolvedToken.explorerFilter as "btc" | "sol" | "usdc" | "usdt")
    : getShieldType(d);
  const config = resolvedToken
    ? buildShieldConfig(resolvedToken)
    : SHIELD_TYPE_CONFIG[shieldType];
  const isBtcDeposit = shieldType === "btc";
  const canExpand = true;

  return (
    <Fragment>
      <tr
        className={cn("hover:bg-gray/5 transition-colors", canExpand && "cursor-pointer")}
        onClick={() => canExpand && onToggle()}
      >
        <Td>
          <div className="flex items-center gap-1.5">
            <StatusDot {...getDepositStatusDot(d.status)} />
          </div>
        </Td>
        <Td>
          {d.txSignature ? (
            <div className="flex items-center gap-1.5">
              <code className="text-caption font-mono text-foreground">{truncate(d.txSignature, 6, 4)}</code>
              <CopyButton text={d.txSignature} label="Tx" variant="default" iconSize="sm" />
            </div>
          ) : d.btcMeta?.depositTxid ? (
            <div className="flex items-center gap-1.5">
              <code className="text-caption font-mono text-foreground">{truncate(d.btcMeta?.depositTxid, 6, 4)}</code>
              <CopyButton text={d.btcMeta?.depositTxid} label="BTC Tx" variant="default" iconSize="sm" />
            </div>
          ) : (
            <span className="text-caption text-gray">Pending...</span>
          )}
        </Td>
        <Td>
          <TypeBadge kind="shield" />
        </Td>
        <Td>
          <FlowCell {...(FLOW_ICONS[shieldType] ?? FLOW_ICONS.btc)} />
        </Td>
        <Td>
          <span className="text-body2 text-foreground font-mono">
            {config.showRaw
              ? d.amountSats.toLocaleString()
              : (d.amountSats / (10 ** config.decimals)).toLocaleString(undefined, { maximumFractionDigits: config.decimals })
            } <span className="text-gray text-caption">{config.unit}</span>
          </span>
        </Td>
        <Td>
          <span className="text-caption text-gray">{timeAgo(d.timestamp)}</span>
        </Td>
        <Td>
          {d.txSignature ? (
            <SolanaLink signature={d.txSignature} />
          ) : d.btcMeta?.depositTxid ? (
            <a href={`${getMempoolExplorerUrl()}/tx/${d.btcMeta?.depositTxid}`} target="_blank" rel="noopener noreferrer" className="text-btc/60 hover:text-btc transition-colors p-0.5" title="View BTC tx">
              <ExternalLink className="w-3 h-3" />
            </a>
          ) : null}
        </Td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={8} className="p-0">
            <DepositDetails deposit={d} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

// =============================================================================
// Deposits Tab (standalone, kept for backward compat)
// =============================================================================

export function DepositsTab() {
  const { deposits, isLoading, error, refresh } = useDeposits();
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
  if (deposits.length === 0) return <EmptyState label="deposits" />;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <span className="text-caption text-gray">{deposits.length} deposit(s)</span>
        <RefreshButton onClick={refresh} />
      </div>
      <div className="overflow-x-auto rounded-[12px] border border-gray/15 backdrop-blur-sm bg-muted/30">
        <table className="w-full min-w-[700px]">
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
            {deposits.map((d, i) => {
              const depositKey = `${d.btcMeta?.depositTxid || d.txSignature || d.btcMeta?.taprootAddress || d.commitment}-${i}`;
              return (
                <DepositRow
                  key={depositKey}
                  deposit={d}
                  index={i}
                  expanded={expanded.has(depositKey)}
                  onToggle={() => toggle(depositKey)}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
