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
  const displayAmount = config.showRaw
    ? d.amountSats.toLocaleString()
    : (d.amountSats / (10 ** config.decimals)).toLocaleString(undefined, { maximumFractionDigits: config.decimals });

  return (
    <div className="mx-4 my-3 rounded-[10px] bg-linear-to-b from-gray/6 to-transparent border border-gray/10 overflow-hidden">
      <div className="grid grid-cols-2 divide-x divide-gray/10">
        {/* INPUT — BTC or SPL token deposited */}
        <div className="p-4 space-y-2.5">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-1.5 h-1.5 rounded-full bg-btc" />
            <span className="text-caption text-btc/90 font-semibold uppercase tracking-wider">Input</span>
            <span className="text-caption text-btc/60 font-medium">1</span>
          </div>
          <div className="px-3 py-2.5 rounded-[8px] bg-btc/4 border border-btc/10 space-y-2">
            <div className="flex items-center gap-2">
              <img src={config.from.logo} alt={config.from.label} className="w-3.5 h-3.5 rounded-full shrink-0" />
              <span className="text-body2 text-foreground font-mono font-semibold">
                {displayAmount} <span className="text-gray text-caption">{config.unit}</span>
              </span>
            </div>
            {d.taprootAddress && (
              <div className="group flex items-center gap-2">
                <span className="text-[10px] text-gray/50 shrink-0">&rarr;</span>
                <code className="text-caption font-mono text-foreground/80 truncate">{truncate(d.taprootAddress, 10, 6)}</code>
                <div className="flex items-center gap-1 ml-auto shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                  <CopyButton text={d.taprootAddress} label="Address" variant="default" iconSize="sm" />
                  <a href={`${getMempoolExplorerUrl()}/address/${d.taprootAddress}`} target="_blank" rel="noopener noreferrer" className="text-btc hover:text-btc/80 transition-colors p-0.5">
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              </div>
            )}
          </div>
          {/* BTC deposit tx */}
          {d.btcTxid && (
            <div className="group flex items-center gap-2 px-3 py-2 rounded-[8px] bg-gray/4 border border-gray/8 hover:border-btc/20 transition-colors">
              <BitcoinIcon className="w-3.5 h-3.5 text-btc/60 shrink-0" />
              <span className="text-[10px] text-gray/60 shrink-0">Deposit tx</span>
              <code className="text-caption font-mono text-foreground/80 truncate">{truncate(d.btcTxid, 8, 4)}</code>
              <div className="flex items-center gap-1 ml-auto shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                <CopyButton text={d.btcTxid} label="BTC Tx" variant="default" iconSize="sm" />
                <a href={`${getMempoolExplorerUrl()}/tx/${d.btcTxid}`} target="_blank" rel="noopener noreferrer" className="text-btc hover:text-btc/80 transition-colors p-0.5">
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </div>
          )}
          {/* Sweep tx */}
          {d.sweepTxid && (
            <div className="group flex items-center gap-2 px-3 py-2 rounded-[8px] bg-gray/4 border border-gray/8 hover:border-btc/20 transition-colors">
              <BitcoinIcon className="w-3.5 h-3.5 text-btc/40 shrink-0" />
              <span className="text-[10px] text-gray/60 shrink-0">Sweep tx</span>
              <code className="text-caption font-mono text-foreground/80 truncate">{truncate(d.sweepTxid, 8, 4)}</code>
              <div className="flex items-center gap-1 ml-auto shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                <CopyButton text={d.sweepTxid} label="Sweep Tx" variant="default" iconSize="sm" />
                <a href={`${getMempoolExplorerUrl()}/tx/${d.sweepTxid}`} target="_blank" rel="noopener noreferrer" className="text-btc hover:text-btc/80 transition-colors p-0.5">
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </div>
          )}
        </div>

        {/* OUTPUT — Shielded commitment */}
        <div className="p-4 space-y-2.5">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
            <span className="text-caption text-green-400/90 font-semibold uppercase tracking-wider">Output</span>
            <span className="text-caption text-green-400/60 font-medium">1</span>
          </div>
          <div className="px-3 py-2.5 rounded-[8px] bg-green-500/4 border border-green-500/10 space-y-2">
            <div className="flex items-center gap-2">
              <img src={config.to.logo} alt={config.to.label} className="w-3.5 h-3.5 rounded-full shrink-0" />
              <span className="text-body2 text-foreground font-mono font-semibold">
                {displayAmount} <span className="text-gray text-caption">{config.to.label}</span>
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-[10px] text-gray/60">
              <Shield className="w-3 h-3 text-privacy/50" />
              <span>Shielded note (commitment)</span>
            </div>
          </div>
          {/* Commitment */}
          {d.commitment && (
            <div className="group flex items-center gap-2 px-3 py-2 rounded-[8px] bg-purple-500/4 border border-purple-500/10 hover:border-purple-500/20 transition-colors">
              <span className="text-[10px] text-purple-400/60 font-mono font-semibold w-4 shrink-0">#{d.leafIndex}</span>
              <code className="text-caption font-mono text-foreground/90 truncate">{truncate(d.commitment, 8, 6)}</code>
              <div className="flex items-center gap-1 ml-auto shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                <CopyButton text={d.commitment} label="Commitment" variant="default" iconSize="sm" />
              </div>
            </div>
          )}
          {/* Solana verify tx */}
          {(d.solanaTx || d.txSignature) && (
            <div className="group flex items-center gap-2 px-3 py-2 rounded-[8px] bg-gray/4 border border-gray/8 hover:border-purple-500/20 transition-colors">
              <span className="text-[10px] text-gray/60 shrink-0">Solana tx</span>
              <code className="text-caption font-mono text-foreground/80 truncate">{truncate(d.solanaTx || d.txSignature, 8, 4)}</code>
              <div className="flex items-center gap-1 ml-auto shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                <CopyButton text={d.solanaTx || d.txSignature} label="Solana Tx" variant="default" iconSize="sm" />
                <a href={getSolanaExplorerTxUrl(d.solanaTx || d.txSignature)} target="_blank" rel="noopener noreferrer" className="text-sol hover:text-sol/80 transition-colors p-0.5">
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Status progress bar */}
      {isBtc && (
        <div className="px-4 pb-3 pt-1 border-t border-gray/10">
          <DepositProgressBar status={d.status} />
        </div>
      )}
    </div>
  );
}

/** Compact deposit progress indicator */
function DepositProgressBar({ status }: { status: string | null }) {
  const stepOrder = DEPOSIT_STATUS_ORDER[status ?? ""] ?? 0;
  const steps = ["Deposit", "Sweep", "SPV Verify", "Minted"];
  return (
    <div className="flex items-center gap-1.5 pt-2">
      {steps.map((label, i) => {
        const done = stepOrder >= (i === 0 ? 1 : i === 1 ? 3 : i === 2 ? 4 : 5);
        return (
          <Fragment key={label}>
            <div className="flex items-center gap-1">
              <CheckCircle2 className={cn("w-3 h-3", done ? "text-green-400" : "text-gray/30")} />
              <span className={cn("text-[10px]", done ? "text-green-400/80" : "text-gray/40")}>{label}</span>
            </div>
            {i < steps.length - 1 && (
              <div className={cn("w-4 h-px", done ? "bg-green-500/30" : "bg-gray/15")} />
            )}
          </Fragment>
        );
      })}
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
  // Only BTC SPV deposits (disc=1) are expandable
  const isBtcDeposit = shieldType === "btc";
  const canExpand = isBtcDeposit;

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
          ) : d.btcTxid ? (
            <div className="flex items-center gap-1.5">
              <code className="text-caption font-mono text-foreground">{truncate(d.btcTxid, 6, 4)}</code>
              <CopyButton text={d.btcTxid} label="BTC Tx" variant="default" iconSize="sm" />
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
          <div className="flex items-center gap-1.5">
            {d.txSignature && <SolanaLink signature={d.txSignature} />}
            {d.btcTxid && (
              <a href={`${getMempoolExplorerUrl()}/tx/${d.btcTxid}`} target="_blank" rel="noopener noreferrer" className="text-btc/60 hover:text-btc transition-colors p-0.5" title="View BTC tx">
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
        </Td>
      </tr>
      {expanded && isBtcDeposit && (
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
              const depositKey = `${d.btcTxid || d.txSignature || d.taprootAddress || d.commitment}-${i}`;
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
