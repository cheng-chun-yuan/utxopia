"use client";

import { useState, Suspense, useCallback, Fragment } from "react";
import Image from "next/image";
import {
  ArrowDownToLine,
  ArrowUpDown,
  ArrowUpFromLine,
  CheckCircle2,
  Clock,
  ExternalLink,
  Loader2,
  Search,
  Shield,
  RefreshCw,
  Unlock,
  Wallet,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatBtc } from "@/lib/utils/formatting";
import { CopyButton } from "@/components/ui/copy-button";
import { BitcoinIcon } from "@/components/bitcoin-wallet-selector";
import {
  useDeposits,
  useTransfers,
  useRedemptions,
} from "@/hooks/use-explorer";
import { getMempoolExplorerUrl } from "@/lib/btc-network";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";

// =============================================================================
// Helpers
// =============================================================================

function truncate(str: string, start = 6, end = 4): string {
  if (str.length <= start + end + 3) return str;
  return `${str.slice(0, start)}...${str.slice(-end)}`;
}

function timeAgo(timestamp: number): string {
  if (timestamp === 0) return "—";
  const now = Date.now() / 1000;
  const diff = now - timestamp;
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(timestamp * 1000).toLocaleDateString();
}

/** Decode a hex scriptPubKey to a testnet bech32m address */
function scriptToAddress(hexScript: string): string | null {
  try {
    const bytes = new Uint8Array(hexScript.match(/.{2}/g)!.map(b => parseInt(b, 16)));
    if (bytes.length < 4) return null;
    const version = bytes[0] === 0x00 ? 0 : bytes[0] - 0x50;
    if (version < 0 || version > 16) return null;
    const progLen = bytes[1];
    if (bytes.length < 2 + progLen) return null;
    const program = bytes.slice(2, 2 + progLen);
    const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    const data5: number[] = [version];
    let acc = 0, bits = 0;
    for (const b of program) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; data5.push((acc >> bits) & 31); } }
    if (bits > 0) data5.push((acc << (5 - bits)) & 31);
    const hrp = "tb";
    const useBech32m = version > 0;
    function polymod(values: number[]): number {
      const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
      let chk = 1;
      for (const v of values) { const b = chk >> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i]; }
      return chk;
    }
    function hrpExpand(h: string): number[] {
      const r: number[] = [];
      for (const c of h) r.push(c.charCodeAt(0) >> 5);
      r.push(0);
      for (const c of h) r.push(c.charCodeAt(0) & 31);
      return r;
    }
    const checkConst = useBech32m ? 0x2bc830a3 : 1;
    const values = [...hrpExpand(hrp), ...data5, 0, 0, 0, 0, 0, 0];
    const pm = polymod(values) ^ checkConst;
    const checksum: number[] = [];
    for (let i = 0; i < 6; i++) checksum.push((pm >> (5 * (5 - i))) & 31);
    return hrp + "1" + [...data5, ...checksum].map(v => CHARSET[v]).join("");
  } catch {
    return null;
  }
}

// =============================================================================
// Shared Components
// =============================================================================

type TabType = "deposits" | "transfers" | "withdrawals";

const tabs: { id: TabType; label: string; icon: React.ReactNode }[] = [
  { id: "deposits", label: "Deposits", icon: <ArrowDownToLine className="w-4 h-4" /> },
  { id: "transfers", label: "Transfers", icon: <ArrowUpDown className="w-4 h-4" /> },
  { id: "withdrawals", label: "Withdrawals", icon: <ArrowUpFromLine className="w-4 h-4" /> },
];

function TabBar({ activeTab, onTabChange, counts }: {
  activeTab: TabType;
  onTabChange: (tab: TabType) => void;
  counts: Record<TabType, number>;
}) {
  const colorMap: Record<TabType, string> = {
    deposits: "bg-green-500/10 text-green-400 border-green-500/20",
    transfers: "bg-purple-500/10 text-purple-400 border-purple-500/20",
    withdrawals: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  };

  return (
    <div className="flex gap-1 p-1 bg-muted border border-gray/15 rounded-[12px]">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className={cn(
            "flex-1 flex items-center justify-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-2.5 rounded-[10px] text-xs sm:text-sm transition-colors",
            activeTab === tab.id
              ? colorMap[tab.id]
              : "text-gray hover:text-gray-light hover:bg-gray/10"
          )}
        >
          {tab.icon}
          <span className="hidden sm:inline">{tab.label}</span>
          <span className="sm:hidden">{tab.label.slice(0, 3)}</span>
          {counts[tab.id] > 0 && (
            <span className="min-w-[22px] h-[22px] px-1.5 flex items-center justify-center text-xs rounded-full bg-gray/20 text-gray-light font-medium">
              {counts[tab.id]}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th className={cn("px-4 py-3 text-left text-caption text-gray font-medium whitespace-nowrap", className)}>
      {children}
    </th>
  );
}

function Td({ children, className, colSpan }: { children?: React.ReactNode; className?: string; colSpan?: number }) {
  return (
    <td className={cn("px-4 py-3.5 whitespace-nowrap", className)} colSpan={colSpan}>
      {children}
    </td>
  );
}

function SolanaLink({ signature }: { signature: string }) {
  return (
    <a
      href={`https://explorer.solana.com/tx/${signature}?cluster=devnet`}
      target="_blank"
      rel="noopener noreferrer"
      className="text-sol hover:text-sol/80 transition-colors"
      aria-label="View transaction"
    >
      <ExternalLink className="w-3.5 h-3.5" />
    </a>
  );
}

function LoadingState() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="flex items-center gap-2 text-gray">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-body2">Loading on-chain data...</span>
      </div>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-[12px] space-y-2">
      <p className="text-body2 text-red-400">{message}</p>
      <button onClick={onRetry} className="text-caption text-red-400 hover:text-red-300 underline transition-colors">Retry</button>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Search className="w-8 h-8 text-gray/50 mb-3" />
      <p className="text-body2 text-gray">No {label} found</p>
    </div>
  );
}

function RefreshButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="text-caption text-gray hover:text-gray-light transition-colors cursor-pointer" aria-label="Refresh">
      <RefreshCw className="w-3.5 h-3.5" />
    </button>
  );
}

// =============================================================================
// Deposit Status Badge (reused from balance-view pattern)
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

function DepositStatusBadge({ status }: { status: string | null }) {
  const resolvedStatus = status ?? "claimed";
  const cfg = DEPOSIT_STATUS_CONFIG[resolvedStatus] ?? DEPOSIT_STATUS_CONFIG.pending;
  const Icon = cfg.spinning ? Loader2 : (resolvedStatus === "failed" ? XCircle : resolvedStatus === "claimed" || resolvedStatus === "ready" ? CheckCircle2 : Clock);

  const subtitle = resolvedStatus === "claimed" || resolvedStatus === "ready"
    ? "Complete"
    : resolvedStatus === "failed"
    ? "Error"
    : "In progress";

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
// Deposit Details (expandable row for real deposits)
// =============================================================================

import type { DepositRecord } from "@/hooks/use-explorer";

const DEPOSIT_STATUS_ORDER: Record<string, number> = {
  pending: 0, detected: 1, confirming: 1, confirmed: 2,
  sweeping: 3, sweep_confirming: 3, verifying: 4, ready: 5, claimed: 5,
};

function DepositDetails({ deposit }: { deposit: DepositRecord }) {
  const stepOrder = DEPOSIT_STATUS_ORDER[deposit.status ?? ""] ?? 0;

  const steps = [
    {
      title: "Deposit BTC to Reserve",
      done: stepOrder >= 1,
      active: stepOrder === 1,
      detail: (deposit.btcTxid || deposit.taprootAddress) ? (
        <div className="space-y-1">
          {deposit.btcTxid && (
            <div className="flex items-center gap-1.5">
              <a
                href={`${getMempoolExplorerUrl()}/tx/${deposit.btcTxid}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-btc/70 hover:text-btc flex items-center gap-1 transition-colors"
              >
                Deposit tx <ExternalLink className="w-2.5 h-2.5" />
              </a>
              <code className="text-[10px] font-mono text-gray">{truncate(deposit.btcTxid, 6, 4)}</code>
              <CopyButton text={deposit.btcTxid} label="TX" variant="default" iconSize="sm" />
            </div>
          )}
          {deposit.taprootAddress && (
            <div className="flex items-center gap-1.5">
              <a
                href={`${getMempoolExplorerUrl()}/address/${deposit.taprootAddress}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-btc/70 hover:text-btc flex items-center gap-1 transition-colors"
              >
                Address <ExternalLink className="w-2.5 h-2.5" />
              </a>
              <code className="text-[10px] font-mono text-gray">{truncate(deposit.taprootAddress, 8, 6)}</code>
              <CopyButton text={deposit.taprootAddress} label="Address" variant="default" iconSize="sm" />
            </div>
          )}
        </div>
      ) : null,
    },
    {
      title: "Sweep to Pool",
      done: stepOrder >= 3,
      active: stepOrder === 3,
      detail: deposit.sweepTxid ? (
        <div className="flex items-center gap-1.5">
          <a
            href={`${getMempoolExplorerUrl()}/tx/${deposit.sweepTxid}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-btc/70 hover:text-btc flex items-center gap-1 transition-colors"
          >
            Sweep tx <ExternalLink className="w-2.5 h-2.5" />
          </a>
          <code className="text-[10px] font-mono text-gray">{truncate(deposit.sweepTxid, 6, 4)}</code>
          <CopyButton text={deposit.sweepTxid} label="TX" variant="default" iconSize="sm" />
        </div>
      ) : null,
    },
    {
      title: "SPV Verification",
      done: stepOrder >= 4,
      active: stepOrder === 4,
      detail: deposit.solanaTx ? (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5">
            <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-400">
              <CheckCircle2 className="w-2.5 h-2.5" /> SPV Confirmed
            </span>
            <a
              href={`https://explorer.solana.com/tx/${deposit.solanaTx}?cluster=devnet`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-sol/70 hover:text-sol flex items-center gap-1 transition-colors"
            >
              Solana tx <ExternalLink className="w-2.5 h-2.5" />
            </a>
          </div>
          {deposit.commitment && (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-gray">Commitment</span>
              <code className="text-[10px] font-mono text-purple-400/70">{truncate(deposit.commitment, 8, 6)}</code>
              <CopyButton text={deposit.commitment} label="Commitment" variant="default" iconSize="sm" />
            </div>
          )}
        </div>
      ) : null,
    },
    {
      title: "Mint zkBTC",
      done: stepOrder >= 5,
      active: false,
      detail: deposit.mintedSats ? (
        <span className="text-[10px] text-green-400 font-mono">{deposit.mintedSats.toLocaleString()} sats minted</span>
      ) : null,
    },
  ];

  return (
    <div className="mx-4 my-3 px-4 py-3 rounded-[10px] bg-linear-to-b from-gray/6 to-transparent border border-gray/10 space-y-1">
      {steps.map((step, i) => (
        <div key={step.title} className="flex gap-2.5">
          <div className="flex flex-col items-center">
            <div className={cn(
              "w-5 h-5 rounded-full flex items-center justify-center shrink-0",
              step.done ? "bg-green-500/20" : step.active ? "bg-btc/20" : "bg-gray/10"
            )}>
              {step.done ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
              ) : step.active ? (
                <Loader2 className="w-3 h-3 text-btc animate-spin" />
              ) : (
                <Clock className="w-2.5 h-2.5 text-gray/40" />
              )}
            </div>
            {i < steps.length - 1 && (
              <div className={cn("w-px flex-1 min-h-[12px]", step.done ? "bg-green-500/30" : "bg-gray/10")} />
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
// Deposits Tab
// =============================================================================

function DepositsTab() {
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
              <Th>Source</Th>
              <Th>Destination</Th>
              <Th>Amount</Th>
              <Th>Time</Th>
              <Th className="w-[40px]" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray/10">
            {deposits.map((d, i) => {
              const depositKey = d.btcTxid || d.txSignature || d.taprootAddress || `${d.commitment}-${d.leafIndex ?? i}`;
              const isOpen = expanded.has(depositKey);
              const canExpand = !d.isDemo;

              return (
                <Fragment key={depositKey}>
                  <tr
                    className={cn("hover:bg-gray/5 transition-colors", canExpand && "cursor-pointer")}
                    onClick={() => canExpand && toggle(depositKey)}
                  >
                    <Td>
                      <div className="flex items-center gap-1.5">
                        <DepositStatusBadge status={d.status} />
                        {d.isDemo && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-500/10 text-yellow-500 border border-yellow-500/20 font-medium">
                            Demo
                          </span>
                        )}
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
                          <BitcoinIcon className="w-3 h-3 text-btc/60" />
                          <code className="text-caption font-mono text-foreground">{truncate(d.btcTxid, 6, 4)}</code>
                          <CopyButton text={d.btcTxid} label="BTC Tx" variant="default" iconSize="sm" />
                        </div>
                      ) : (
                        <span className="text-caption text-gray">Pending...</span>
                      )}
                    </Td>
                    <Td>
                      <span className="inline-flex items-center gap-1.5 text-caption text-btc/90 bg-btc/6 border border-btc/15 px-2 py-0.5 rounded-full font-medium">
                        <BitcoinIcon className="w-3.5 h-3.5" />
                        BTC
                      </span>
                    </Td>
                    <Td>
                      <span className="inline-flex items-center gap-1.5 text-caption text-purple-400/90 bg-purple-500/6 border border-purple-500/15 px-2 py-0.5 rounded-full font-medium">
                        <Image src="/zkbtc.png" alt="zkBTC" width={14} height={14} className="rounded-full" />
                        zkBTC
                      </span>
                    </Td>
                    <Td>
                      <span className="text-body2 text-foreground font-mono">{d.amountSats.toLocaleString()} <span className="text-gray text-caption">sats</span></span>
                    </Td>
                    <Td>
                      <span className="text-caption text-gray">{timeAgo(d.timestamp)}</span>
                    </Td>
                    <Td>
                      <div className="flex items-center gap-1.5">
                        {d.txSignature && <SolanaLink signature={d.txSignature} />}
                      </div>
                    </Td>
                  </tr>
                  {isOpen && !d.isDemo && (
                    <tr>
                      <td colSpan={8} className="p-0">
                        <DepositDetails deposit={d} />
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

// =============================================================================
// Transfers Tab — grouped by transaction
// =============================================================================

function TransfersTab() {
  const { transfers, isLoading, error, refresh } = useTransfers();
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
              <Th>Type</Th>
              <Th>Tx ID</Th>
              <Th>Inputs</Th>
              <Th>Outputs</Th>
              <Th>Time</Th>
              <Th className="w-[40px]" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray/10">
            {transfers.map((tx) => {
              const isOpen = expanded.has(tx.txSignature);
              return (
                <Fragment key={tx.txSignature}>
                  <tr
                    className="hover:bg-gray/5 transition-colors cursor-pointer"
                    onClick={() => toggle(tx.txSignature)}
                  >
                    <Td>
                      {tx.instructionDisc === 16 || tx.instructionDisc === 5 || (tx.operationType === 0 && tx.instructionDisc !== 15) ? (
                        <div className="flex items-center gap-1.5">
                          <div className="p-1 rounded-[6px] bg-btc/10 border border-btc/20">
                            <BitcoinIcon className="w-3 h-3 text-btc" />
                          </div>
                          <div className="flex flex-col">
                            <span className="text-caption text-btc font-semibold leading-tight">Redeem</span>
                            <span className="text-[10px] text-gray leading-tight">zkBTC → BTC</span>
                          </div>
                        </div>
                      ) : tx.instructionDisc === 15 ? (
                        <div className="flex items-center gap-1.5">
                          <div className="p-1 rounded-[6px] bg-purple-500/10 border border-purple-500/20">
                            <Unlock className="w-3 h-3 text-purple-400" />
                          </div>
                          <div className="flex flex-col">
                            <span className="text-caption text-purple-400 font-semibold leading-tight">Unshield</span>
                            <span className="text-[10px] text-gray leading-tight">zkBTC → SPL</span>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1.5">
                          <div className="p-1 rounded-[6px] bg-privacy/10 border border-privacy/20">
                            <Shield className="w-3 h-3 text-privacy" />
                          </div>
                          <div className="flex flex-col">
                            <span className="text-caption text-privacy font-semibold leading-tight">Private Send</span>
                            <span className="text-[10px] text-gray leading-tight">Shielded transfer</span>
                          </div>
                        </div>
                      )}
                    </Td>
                    <Td>
                      <div className="flex items-center gap-1.5">
                        <code className="text-caption font-mono text-foreground">{truncate(tx.txSignature, 6, 4)}</code>
                        <CopyButton text={tx.txSignature} label="Tx" variant="default" iconSize="sm" />
                      </div>
                    </Td>
                    <Td>
                      <span className="inline-flex items-center gap-1 text-caption text-green-400/70 bg-green-500/6 border border-green-500/12 px-2 py-0.5 rounded-full">
                        <span className="font-mono">{tx.inputCount}</span>
                        <span className="hidden sm:inline">input{tx.inputCount !== 1 ? "s" : ""}</span>
                      </span>
                    </Td>
                    <Td>
                      {tx.instructionDisc === 15 || tx.instructionDisc === 16 || tx.instructionDisc === 5 || (tx.operationType === 0 && tx.instructionDisc !== 15) ? (
                        <span className="inline-flex items-center gap-1 text-caption text-purple-400/70 bg-purple-500/6 border border-purple-500/12 px-2 py-0.5 rounded-full">
                          <span className="font-mono">{1 + tx.outputs.length}</span>
                          <span className="hidden sm:inline">output{tx.outputs.length > 0 ? "s" : ""}</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-caption text-purple-400/70 bg-purple-500/6 border border-purple-500/12 px-2 py-0.5 rounded-full">
                          <span className="font-mono">{tx.outputs.length}</span>
                          <span className="hidden sm:inline">output{tx.outputs.length !== 1 ? "s" : ""}</span>
                        </span>
                      )}
                    </Td>
                    <Td>
                      {tx.status === "processing" ? (
                        <span className="inline-flex items-center gap-1 text-caption text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 px-2 py-0.5 rounded-full animate-pulse">
                          Processing
                        </span>
                      ) : (
                        <span className="text-caption text-gray">{timeAgo(tx.timestamp)}</span>
                      )}
                    </Td>
                    <Td>
                      <SolanaLink signature={tx.txSignature} />
                    </Td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={6} className="p-0">
                        <div className="mx-4 my-3 rounded-[10px] bg-linear-to-b from-gray/6 to-transparent border border-gray/10 overflow-hidden">
                          {tx.instructionDisc === 16 || tx.instructionDisc === 5 || (tx.operationType === 0 && tx.instructionDisc !== 15) ? (
                            /* Redeem: Inputs on left, Output (BTC amount + BTC address) on right */
                            <div className="grid grid-cols-2 divide-x divide-gray/10">
                              {/* Inputs (Nullifiers) */}
                              <div className="p-4 space-y-2.5">
                                <div className="flex items-center gap-2 mb-3">
                                  <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
                                  <span className="text-caption text-green-400/90 font-semibold uppercase tracking-wider">
                                    Inputs
                                  </span>
                                  <span className="text-caption text-green-400/60 font-medium">{tx.inputCount}</span>
                                </div>
                                {tx.nullifierPdas.map((pda, i) => (
                                  <div key={pda} className="group flex items-center gap-2 px-3 py-2 rounded-[8px] bg-green-500/4 border border-green-500/10 hover:border-green-500/20 transition-colors">
                                    <span className="text-[10px] text-green-400/60 font-mono font-semibold w-4 shrink-0">{i + 1}</span>
                                    <code className="text-caption font-mono text-foreground/90 truncate">{truncate(pda, 8, 6)}</code>
                                    <div className="flex items-center gap-1 ml-auto shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                                      <CopyButton text={pda} label="Nullifier" variant="default" iconSize="sm" />
                                      <a
                                        href={`https://explorer.solana.com/address/${pda}?cluster=devnet`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-sol hover:text-sol/80 transition-colors p-0.5"
                                      >
                                        <ExternalLink className="w-3 h-3" />
                                      </a>
                                    </div>
                                  </div>
                                ))}
                              </div>
                              {/* Outputs — BTC redemption */}
                              <div className="p-4 space-y-2.5">
                                <div className="flex items-center gap-2 mb-3">
                                  <div className="w-1.5 h-1.5 rounded-full bg-btc" />
                                  <span className="text-caption text-btc/90 font-semibold uppercase tracking-wider">
                                    Outputs
                                  </span>
                                  <span className="text-caption text-btc/60 font-medium">{1 + tx.outputs.length}</span>
                                </div>
                                <div className="px-3 py-2.5 rounded-[8px] bg-btc/4 border border-btc/10 space-y-2">
                                  {/* Amount */}
                                  <div className="flex items-center gap-2">
                                    <BitcoinIcon className="w-3.5 h-3.5 text-btc shrink-0" />
                                    {tx.unshieldAmount ? (
                                      <span className="text-body2 text-foreground font-mono font-semibold">
                                        {tx.unshieldAmount.toLocaleString()} <span className="text-gray text-caption">sats</span>
                                        <span className="text-[10px] text-gray/60 ml-1.5">({(tx.unshieldAmount / 1e8).toFixed(8)} BTC)</span>
                                      </span>
                                    ) : (
                                      <span className="text-caption text-gray/40">Amount pending re-index</span>
                                    )}
                                  </div>
                                  {/* BTC Destination */}
                                  {tx.unshieldRecipient ? (
                                    <div className="group flex items-center gap-2">
                                      <BitcoinIcon className="w-3.5 h-3.5 text-btc/50 shrink-0" />
                                      <code className="text-caption font-mono text-foreground/80 truncate">{truncate(tx.unshieldRecipient, 10, 6)}</code>
                                      <div className="flex items-center gap-1 ml-auto shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                                        <CopyButton text={tx.unshieldRecipient} label="BTC Address" variant="default" iconSize="sm" />
                                        <a
                                          href={`${getMempoolExplorerUrl()}/address/${tx.unshieldRecipient}`}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="text-btc hover:text-btc/80 transition-colors p-0.5"
                                        >
                                          <ExternalLink className="w-3 h-3" />
                                        </a>
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="flex items-center gap-2">
                                      <BitcoinIcon className="w-3.5 h-3.5 text-gray/30 shrink-0" />
                                      <span className="text-caption text-gray/40">BTC address pending re-index</span>
                                    </div>
                                  )}
                                </div>
                                {/* Shielded outputs (change) */}
                                {tx.outputs.map((out, i) => (
                                  <div key={out.leafIndex} className="group flex items-center gap-2 px-3 py-2 rounded-[8px] bg-purple-500/4 border border-purple-500/10 hover:border-purple-500/20 transition-colors">
                                    <span className="text-[10px] text-purple-400/60 font-mono font-semibold w-4 shrink-0">{i + 2}</span>
                                    <code className="text-caption font-mono text-foreground/90 truncate">{truncate(out.commitment, 8, 6)}</code>
                                    <span className="text-[10px] text-gray/50 font-mono bg-gray/8 px-1.5 py-0.5 rounded shrink-0">#{out.leafIndex}</span>
                                    <div className="flex items-center gap-1 ml-auto shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                                      <CopyButton text={out.commitment} label="Commitment" variant="default" iconSize="sm" />
                                      <a
                                        href={`https://explorer.solana.com/tx/${tx.txSignature}?cluster=devnet`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-sol hover:text-sol/80 transition-colors p-0.5"
                                        title="View transaction"
                                      >
                                        <ExternalLink className="w-3 h-3" />
                                      </a>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : tx.instructionDisc === 15 ? (
                            /* Unshield: Inputs on left, Output (amount + recipient) on right */
                            <div className="grid grid-cols-2 divide-x divide-gray/10">
                              {/* Inputs (Nullifiers) */}
                              <div className="p-4 space-y-2.5">
                                <div className="flex items-center gap-2 mb-3">
                                  <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
                                  <span className="text-caption text-green-400/90 font-semibold uppercase tracking-wider">
                                    Inputs
                                  </span>
                                  <span className="text-caption text-green-400/60 font-medium">{tx.inputCount}</span>
                                </div>
                                {tx.nullifierPdas.map((pda, i) => (
                                  <div key={pda} className="group flex items-center gap-2 px-3 py-2 rounded-[8px] bg-green-500/4 border border-green-500/10 hover:border-green-500/20 transition-colors">
                                    <span className="text-[10px] text-green-400/60 font-mono font-semibold w-4 shrink-0">{i + 1}</span>
                                    <code className="text-caption font-mono text-foreground/90 truncate">{truncate(pda, 8, 6)}</code>
                                    <div className="flex items-center gap-1 ml-auto shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                                      <CopyButton text={pda} label="Nullifier" variant="default" iconSize="sm" />
                                      <a
                                        href={`https://explorer.solana.com/address/${pda}?cluster=devnet`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-sol hover:text-sol/80 transition-colors p-0.5"
                                      >
                                        <ExternalLink className="w-3 h-3" />
                                      </a>
                                    </div>
                                  </div>
                                ))}
                              </div>
                              {/* Outputs — single output showing amount + recipient */}
                              <div className="p-4 space-y-2.5">
                                <div className="flex items-center gap-2 mb-3">
                                  <div className="w-1.5 h-1.5 rounded-full bg-purple-400" />
                                  <span className="text-caption text-purple-400/90 font-semibold uppercase tracking-wider">
                                    Outputs
                                  </span>
                                  <span className="text-caption text-purple-400/60 font-medium">{1 + tx.outputs.length}</span>
                                </div>
                                <div className="px-3 py-2.5 rounded-[8px] bg-purple-500/4 border border-purple-500/10 space-y-2">
                                  {/* Amount */}
                                  <div className="flex items-center gap-2">
                                    <Image src="/zkbtc.png" alt="zkBTC" width={14} height={14} className="rounded-full shrink-0" />
                                    {tx.unshieldAmount ? (
                                      <span className="text-body2 text-foreground font-mono font-semibold">
                                        {tx.unshieldAmount.toLocaleString()} <span className="text-gray text-caption">sats</span>
                                        <span className="text-[10px] text-gray/60 ml-1.5">({(tx.unshieldAmount / 1e8).toFixed(8)} BTC)</span>
                                      </span>
                                    ) : (
                                      <span className="text-caption text-gray/40">Amount pending re-index</span>
                                    )}
                                  </div>
                                  {/* Recipient */}
                                  {tx.unshieldRecipient ? (
                                    <div className="group flex items-center gap-2">
                                      <Wallet className="w-3.5 h-3.5 text-sol/50 shrink-0" />
                                      <code className="text-caption font-mono text-foreground/80 truncate">{truncate(tx.unshieldRecipient, 8, 6)}</code>
                                      <div className="flex items-center gap-1 ml-auto shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                                        <CopyButton text={tx.unshieldRecipient} label="Address" variant="default" iconSize="sm" />
                                        <a
                                          href={`https://explorer.solana.com/address/${tx.unshieldRecipient}?cluster=devnet`}
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
                                {/* Shielded outputs */}
                                {tx.outputs.map((out, i) => (
                                  <div key={out.leafIndex} className="group flex items-center gap-2 px-3 py-2 rounded-[8px] bg-purple-500/4 border border-purple-500/10 hover:border-purple-500/20 transition-colors">
                                    <span className="text-[10px] text-purple-400/60 font-mono font-semibold w-4 shrink-0">{i + 2}</span>
                                    <code className="text-caption font-mono text-foreground/90 truncate">{truncate(out.commitment, 8, 6)}</code>
                                    <span className="text-[10px] text-gray/50 font-mono bg-gray/8 px-1.5 py-0.5 rounded shrink-0">#{out.leafIndex}</span>
                                    <div className="flex items-center gap-1 ml-auto shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                                      <CopyButton text={out.commitment} label="Commitment" variant="default" iconSize="sm" />
                                      <a
                                        href={`https://explorer.solana.com/tx/${tx.txSignature}?cluster=devnet`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-sol hover:text-sol/80 transition-colors p-0.5"
                                        title="View transaction"
                                      >
                                        <ExternalLink className="w-3 h-3" />
                                      </a>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : (
                            /* Standard transfer: inputs/outputs */
                            <div className="grid grid-cols-2 divide-x divide-gray/10">
                              {/* Inputs (Nullifiers) */}
                              <div className="p-4 space-y-2.5">
                                <div className="flex items-center gap-2 mb-3">
                                  <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
                                  <span className="text-caption text-green-400/90 font-semibold uppercase tracking-wider">
                                    Inputs
                                  </span>
                                  <span className="text-caption text-green-400/60 font-medium">{tx.inputCount}</span>
                                </div>
                                {tx.nullifierPdas.length > 0 ? tx.nullifierPdas.map((pda, i) => (
                                  <div key={pda} className="group flex items-center gap-2 px-3 py-2 rounded-[8px] bg-green-500/4 border border-green-500/10 hover:border-green-500/20 transition-colors">
                                    <span className="text-[10px] text-green-400/60 font-mono font-semibold w-4 shrink-0">{i + 1}</span>
                                    <code className="text-caption font-mono text-foreground/90 truncate">{truncate(pda, 8, 6)}</code>
                                    <div className="flex items-center gap-1 ml-auto shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                                      <CopyButton text={pda} label="Nullifier" variant="default" iconSize="sm" />
                                      <a
                                        href={`https://explorer.solana.com/address/${pda}?cluster=devnet`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-sol hover:text-sol/80 transition-colors p-0.5"
                                      >
                                        <ExternalLink className="w-3 h-3" />
                                      </a>
                                    </div>
                                  </div>
                                )) : (
                                  <div className="flex items-center justify-center gap-2 px-3 py-3 rounded-[8px] bg-gray/4 border border-gray/8">
                                    <Shield className="w-3.5 h-3.5 text-gray/30" />
                                    <span className="text-caption text-gray/40">No nullifiers (deposit claim)</span>
                                  </div>
                                )}
                              </div>
                              {/* Outputs (Commitments) */}
                              <div className="p-4 space-y-2.5">
                                <div className="flex items-center gap-2 mb-3">
                                  <div className="w-1.5 h-1.5 rounded-full bg-purple-400" />
                                  <span className="text-caption text-purple-400/90 font-semibold uppercase tracking-wider">
                                    Outputs
                                  </span>
                                  <span className="text-caption text-purple-400/60 font-medium">{tx.outputs.length}</span>
                                </div>
                                {tx.outputs.map((out, i) => (
                                  <div key={out.leafIndex} className="group flex items-center gap-2 px-3 py-2 rounded-[8px] bg-purple-500/4 border border-purple-500/10 hover:border-purple-500/20 transition-colors">
                                    <span className="text-[10px] text-purple-400/60 font-mono font-semibold w-4 shrink-0">{i + 1}</span>
                                    <code className="text-caption font-mono text-foreground/90 truncate">{truncate(out.commitment, 8, 6)}</code>
                                    <span className="text-[10px] text-gray/50 font-mono bg-gray/8 px-1.5 py-0.5 rounded shrink-0">
                                      #{out.leafIndex}
                                    </span>
                                    <div className="flex items-center gap-1 ml-auto shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                                      <CopyButton text={out.commitment} label="Commitment" variant="default" iconSize="sm" />
                                      <a
                                        href={`https://explorer.solana.com/tx/${tx.txSignature}?cluster=devnet`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-sol hover:text-sol/80 transition-colors p-0.5"
                                        title="View transaction"
                                      >
                                        <ExternalLink className="w-3 h-3" />
                                      </a>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
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

// =============================================================================
// Withdrawals Tab
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

// Withdrawal lifecycle step order based on localStatus/status
const WITHDRAWAL_STATUS_ORDER: Record<string, number> = {
  Pending: 0,
  pending: 0,
  Detected: 1,
  processing: 1,
  Processing: 1,
  Signing: 2,
  sending: 2,
  AwaitingConfirmation: 3,
  sent: 3,
  confirming: 3,
  SpvVerified: 3,
  completed: 4,
  Completed: 4,
  Cancelled: -1,
  Failed: -1,
  failed: -1,
};

import type { RedemptionRecord } from "@/hooks/use-explorer";

/** Derive effective status: if backend says Completed but no on-chain completion tx, use on-chain status */
function getEffectiveStatus(r: RedemptionRecord): string {
  const local = r.localStatus;
  // Backend marked Completed but complete_redemption was never called (simulated or stale)
  if (local === "Completed" && !r.completeTxSignature) {
    return r.status ?? "Processing";
  }
  return local ?? r.status ?? "Pending";
}

function WithdrawalDetails({ redemption }: { redemption: RedemptionRecord }) {
  const status = getEffectiveStatus(redemption);
  const stepOrder = WITHDRAWAL_STATUS_ORDER[status] ?? 0;
  const isFailed = stepOrder === -1;
  const btcAddr = redemption.btcScript ? scriptToAddress(redemption.btcScript) : null;

  // Fee calculations — prefer on-chain locked fee, fallback to pool config estimate
  const amount = Number(redemption.amountSats);
  const bps = redemption.serviceFeeBps ?? 0;
  const base = redemption.serviceFeeBase ?? 0;
  const serviceFee = redemption.serviceFee
    ? Number(redemption.serviceFee)
    : Math.floor(amount * bps / 10000) + base;
  const expectedSend = amount - serviceFee;
  const actualReceived = redemption.actualReceived ? Number(redemption.actualReceived) : null;
  const minerFee = actualReceived !== null ? expectedSend - actualReceived : null;
  const protocolRevenue = minerFee !== null ? serviceFee - minerFee : null;

  const steps = [
    {
      title: "Request Redemption",
      done: !isFailed && stepOrder >= 0,
      active: stepOrder === 0 && !isFailed,
      detail: (
        <div className="space-y-1">
          {redemption.requestTxSignature ? (
            <div className="flex items-center gap-1.5">
              <a
                href={`https://explorer.solana.com/tx/${redemption.requestTxSignature}?cluster=devnet`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-sol/70 hover:text-sol flex items-center gap-1 transition-colors"
              >
                Request tx <ExternalLink className="w-2.5 h-2.5" />
              </a>
              <code className="text-[10px] font-mono text-gray">{truncate(redemption.requestTxSignature, 6, 4)}</code>
              <CopyButton text={redemption.requestTxSignature} label="Request TX" variant="default" iconSize="sm" />
            </div>
          ) : redemption.pubkey ? (
            <div className="flex items-center gap-1.5">
              <a
                href={`https://explorer.solana.com/address/${redemption.pubkey}?cluster=devnet`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-sol/70 hover:text-sol flex items-center gap-1 transition-colors"
              >
                Request PDA <ExternalLink className="w-2.5 h-2.5" />
              </a>
              <code className="text-[10px] font-mono text-gray">{truncate(redemption.pubkey, 6, 4)}</code>
              <CopyButton text={redemption.pubkey} label="PDA" variant="default" iconSize="sm" />
            </div>
          ) : null}
          {btcAddr && (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-gray">Destination</span>
              <code className="text-[10px] font-mono text-btc/70">{truncate(btcAddr, 8, 6)}</code>
              <CopyButton text={btcAddr} label="BTC Address" variant="default" iconSize="sm" />
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-gray">Amount</span>
            <span className="text-[10px] font-mono text-foreground">{amount.toLocaleString()} sats</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] font-mono text-gray/70">
            <span>Service fee: <span className="text-foreground/60">{serviceFee.toLocaleString()} sats</span>{!redemption.serviceFee && <span className="text-gray/50"> ({(bps / 100).toFixed(2)}% + {base.toLocaleString()} base)</span>}</span>
            <span>Est. receive: <span className="text-green-400/70">{expectedSend.toLocaleString()} sats</span></span>
          </div>
        </div>
      ),
    },
    {
      title: "Mark Processing",
      done: !isFailed && stepOrder >= 1,
      active: stepOrder === 1 && !isFailed,
      detail: !isFailed && stepOrder >= 1 ? (
        <div className="space-y-1">
          <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-400">
            <CheckCircle2 className="w-2.5 h-2.5" /> Backend picked up
          </span>
          {redemption.processingTxSignature ? (
            <div className="flex items-center gap-1.5">
              <a
                href={`https://explorer.solana.com/tx/${redemption.processingTxSignature}?cluster=devnet`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-sol/70 hover:text-sol flex items-center gap-1 transition-colors"
              >
                Processing tx <ExternalLink className="w-2.5 h-2.5" />
              </a>
              <code className="text-[10px] font-mono text-gray">{truncate(redemption.processingTxSignature, 6, 4)}</code>
              <CopyButton text={redemption.processingTxSignature} label="Processing TX" variant="default" iconSize="sm" />
            </div>
          ) : null}
        </div>
      ) : null,
    },
    {
      title: "BTC Send (FROST Sign)",
      done: !isFailed && stepOrder >= 3,
      active: stepOrder === 2 && !isFailed,
      detail: redemption.btcTxid ? (
        <div className="space-y-1">
          {redemption.simulated ? (
            <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">
              Simulated
            </span>
          ) : (
            <div className="flex items-center gap-1.5">
              <a
                href={`${getMempoolExplorerUrl()}/tx/${redemption.btcTxid}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-btc/70 hover:text-btc flex items-center gap-1 transition-colors"
              >
                BTC tx <ExternalLink className="w-2.5 h-2.5" />
              </a>
              <code className="text-[10px] font-mono text-gray">{truncate(redemption.btcTxid, 6, 4)}</code>
              <CopyButton text={redemption.btcTxid} label="BTC TX" variant="default" iconSize="sm" />
            </div>
          )}
          {btcAddr && (
            <div className="flex items-center gap-1.5">
              <BitcoinIcon className="w-3 h-3 text-btc/50" />
              <span className="text-[10px] text-gray">→</span>
              <code className="text-[10px] font-mono text-btc/70">{truncate(btcAddr, 8, 6)}</code>
              <CopyButton text={btcAddr} label="BTC Address" variant="default" iconSize="sm" />
            </div>
          )}
          {actualReceived !== null ? (
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] font-mono text-gray/70">
              <span>Received: <span className="text-green-400/80">{actualReceived.toLocaleString()} sats</span></span>
              <span>Service fee: <span className="text-foreground/60">{serviceFee.toLocaleString()} sats</span></span>
              {minerFee !== null && <span>Miner fee: <span className="text-btc/70">{minerFee.toLocaleString()} sats</span></span>}
              {protocolRevenue !== null && protocolRevenue > 0 && <span>Protocol: <span className="text-sol/70">+{protocolRevenue.toLocaleString()} sats</span></span>}
            </div>
          ) : (
            <div className="mt-1.5 text-[10px] font-mono text-gray/70">
              <span>{redemption.btcTxid ? "Receive" : "Est. receive"}: <span className="text-green-400/70">{expectedSend.toLocaleString()} sats</span></span>
            </div>
          )}
        </div>
      ) : null,
    },
    {
      title: "Complete & Burn",
      done: !isFailed && stepOrder >= 4,
      active: false,
      detail: !isFailed && stepOrder >= 4 ? (
        <div className="space-y-1">
          <span className="text-[10px] text-green-400 font-mono">Redemption completed on-chain</span>
          {redemption.completeTxSignature && (
            <div className="flex items-center gap-1.5">
              <a
                href={`https://explorer.solana.com/tx/${redemption.completeTxSignature}?cluster=devnet`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-sol/70 hover:text-sol flex items-center gap-1 transition-colors"
              >
                Complete tx <ExternalLink className="w-2.5 h-2.5" />
              </a>
              <code className="text-[10px] font-mono text-gray">{truncate(redemption.completeTxSignature, 6, 4)}</code>
              <CopyButton text={redemption.completeTxSignature} label="Complete TX" variant="default" iconSize="sm" />
            </div>
          )}
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] font-mono text-gray/70">
            <span>Burned: <span className="text-red-400/70">{amount.toLocaleString()} sats</span> from pool vault</span>
            {protocolRevenue !== null && protocolRevenue > 0 && <span>Fee pool: <span className="text-sol/70">+{protocolRevenue.toLocaleString()} sats</span></span>}
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
              step.done ? "bg-green-500/20" : step.active ? "bg-btc/20" : "bg-gray/10"
            )}>
              {step.done ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
              ) : step.active ? (
                <Loader2 className="w-3 h-3 text-btc animate-spin" />
              ) : (
                <Clock className="w-2.5 h-2.5 text-gray/40" />
              )}
            </div>
            {i < steps.length - 1 && (
              <div className={cn("w-px flex-1 min-h-[12px]", step.done ? "bg-green-500/30" : "bg-gray/10")} />
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

function WithdrawalsTab() {
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
              <Th>Requester</Th>
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
                        {isBtcWithdraw ? (
                          <BitcoinIcon className="w-4 h-4 text-btc" />
                        ) : (
                          <Shield className="w-4 h-4 text-sol" />
                        )}
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
                      <div className="flex flex-col gap-0.5">
                        <div className="flex items-center gap-1.5">
                          <BitcoinIcon className="w-3.5 h-3.5 text-btc" />
                          <span className="text-body2 text-foreground font-mono">
                            {Number(r.amountSats).toLocaleString()} <span className="text-[10px] text-gray">sats</span>
                          </span>
                        </div>
                        <span className="text-[10px] text-gray/60 font-mono pl-5">
                          {formatBtc(Number(r.amountSats))}
                        </span>
                        {r.actualReceived && r.status === "Completed" && Number(r.actualReceived) !== Number(r.amountSats) && (
                          <span className="text-[10px] text-green-400/70 font-mono pl-5">
                            received: {Number(r.actualReceived).toLocaleString()} sats
                          </span>
                        )}
                      </div>
                    </Td>
                    <Td>
                      <div className="flex items-center gap-1.5">
                        <code className="text-caption font-mono text-foreground">{truncate(r.requester, 6, 4)}</code>
                        <CopyButton text={r.requester} label="Requester" variant="default" iconSize="sm" />
                      </div>
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
                      <td colSpan={6} className="p-0">
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

// =============================================================================
// Main Page
// =============================================================================

function StatCard({ label, value, icon, color }: { label: string; value: string | number; icon: React.ReactNode; color: string }) {
  return (
    <div className={cn("flex items-center gap-3 px-4 py-3 rounded-[12px] border backdrop-blur-sm", color)}>
      <div className="shrink-0">{icon}</div>
      <div>
        <p className="text-heading6 text-foreground font-mono">{value}</p>
        <p className="text-caption text-gray">{label}</p>
      </div>
    </div>
  );
}

function ExplorerContent() {
  const [activeTab, setActiveTab] = useState<TabType>("deposits");
  const { deposits } = useDeposits();
  const { transfers } = useTransfers();
  const { redemptions } = useRedemptions();

  const counts: Record<TabType, number> = {
    deposits: deposits.length,
    transfers: transfers.length,
    withdrawals: redemptions.length,
  };

  const totalShielded = deposits.reduce((sum, d) => sum + (d.amountSats || 0), 0);

  return (
    <>
      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatCard
          label="Deposits"
          value={counts.deposits}
          icon={<ArrowDownToLine className="w-4 h-4 text-green-400" />}
          color="bg-green-500/5 border-green-500/15"
        />
        <StatCard
          label="Transfers"
          value={counts.transfers}
          icon={<ArrowUpDown className="w-4 h-4 text-purple-400" />}
          color="bg-purple-500/5 border-purple-500/15"
        />
        <StatCard
          label="Withdrawals"
          value={counts.withdrawals}
          icon={<ArrowUpFromLine className="w-4 h-4 text-orange-400" />}
          color="bg-orange-500/5 border-orange-500/15"
        />
        <StatCard
          label="Total Shielded"
          value={`${(totalShielded / 1e8).toFixed(4)}`}
          icon={<BitcoinIcon className="w-4 h-4 text-btc" />}
          color="bg-btc/5 border-btc/15"
        />
      </div>

      <div className="mb-4">
        <TabBar activeTab={activeTab} onTabChange={setActiveTab} counts={counts} />
      </div>
      <div className="min-h-[40vh]">
        {activeTab === "deposits" && <DepositsTab />}
        {activeTab === "transfers" && <TransfersTab />}
        {activeTab === "withdrawals" && <WithdrawalsTab />}
      </div>
    </>
  );
}

export default function ExplorerPage() {
  return (
    <main className="min-h-screen bg-background hacker-bg noise-overlay overflow-x-hidden">
      <SiteHeader />
      <div className="container mx-auto px-4 pt-24 pb-8 relative z-10 max-w-7xl">
        {/* Title */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-3">
            <div className="h-px w-8 bg-gradient-to-r from-privacy/50 to-transparent" />
            <span className="text-[11px] font-mono uppercase tracking-[0.2em] text-privacy/60">On-Chain Data</span>
          </div>
          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
            <div>
              <h1 className="text-3xl md:text-4xl font-semibold tracking-tight text-foreground mb-1.5">Explorer</h1>
              <p className="text-sm text-gray font-light">Browse all shielded pool activity — deposits, transfers &amp; withdrawals</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-privacy/5 border border-privacy/15">
                <Shield className="w-3 h-3 text-privacy" />
                <span className="text-[10px] font-mono text-privacy/70">Shielded Pool</span>
              </div>
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-muted/30 border border-gray/10">
                <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
                <span className="text-[10px] font-mono text-gray/50">Devnet</span>
              </div>
            </div>
          </div>
        </div>

        <Suspense fallback={<LoadingState />}>
          <ExplorerContent />
        </Suspense>

        {/* Privacy Note */}
        <div className="mt-6 p-3 glass-card border-privacy/15 rounded-[16px]">
          <div className="flex items-center gap-2 mb-1">
            <Shield className="w-4 h-4 text-privacy" />
            <span className="text-caption text-privacy">Privacy Preserved</span>
          </div>
          <p className="text-caption text-gray">
            Transfer amounts are encrypted with zero-knowledge proofs. Only commitments and
            nullifiers are visible on-chain — no amounts or sender/recipient information is exposed.
          </p>
        </div>

      </div>
      <SiteFooter />
    </main>
  );
}
