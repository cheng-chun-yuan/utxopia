"use client";

import { useState, Suspense } from "react";
import Link from "next/link";
import {
  ArrowDownToLine,
  ArrowUpDown,
  ArrowUpFromLine,
  ExternalLink,
  Loader2,
  Search,
  Shield,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/ui/copy-button";
import { BitcoinIcon } from "@/components/bitcoin-wallet-selector";
import {
  useDeposits,
  useTransfers,
  useRedemptions,
  type DepositRecord,
  type TransferEvent,
  type RedemptionRecord,
} from "@/hooks/use-explorer";

// =============================================================================
// Constants
// =============================================================================

const EXPLORER_BASE = "https://orbmarkets.io/address";

function solanaExplorerUrl(pubkey: string): string {
  return `${EXPLORER_BASE}/${pubkey}/history?cluster=devnet`;
}

function truncate(str: string, start = 6, end = 4): string {
  if (str.length <= start + end + 3) return str;
  return `${str.slice(0, start)}...${str.slice(-end)}`;
}

function formatBtc(sats: bigint): string {
  return (Number(sats) / 100_000_000).toFixed(8);
}

function timeAgo(timestamp: number): string {
  if (timestamp === 0) return "Unknown";
  const now = Date.now() / 1000;
  const diff = now - timestamp;
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// =============================================================================
// Tab Types
// =============================================================================

type TabType = "deposits" | "transfers" | "withdrawals";

const tabs: { id: TabType; label: string; icon: React.ReactNode }[] = [
  { id: "deposits", label: "Deposits", icon: <ArrowDownToLine className="w-4 h-4" /> },
  { id: "transfers", label: "Transfers", icon: <ArrowUpDown className="w-4 h-4" /> },
  { id: "withdrawals", label: "Withdrawals", icon: <ArrowUpFromLine className="w-4 h-4" /> },
];

// =============================================================================
// Tab Bar
// =============================================================================

function TabBar({
  activeTab,
  onTabChange,
  counts,
}: {
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
            "flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-[10px] text-sm transition-colors",
            activeTab === tab.id
              ? colorMap[tab.id]
              : "text-gray hover:text-gray-light hover:bg-gray/10"
          )}
        >
          {tab.icon}
          <span>{tab.label}</span>
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

// =============================================================================
// Deposits Tab
// =============================================================================

function DepositRow({ deposit }: { deposit: DepositRecord }) {
  return (
    <div className="p-4 gradient-bg-card rounded-[12px] space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-[8px] bg-green-500/10">
            <ArrowDownToLine className="w-3.5 h-3.5 text-green-400" />
          </div>
          <span className="text-body2-semibold text-foreground">
            {formatBtc(deposit.amountSats)} BTC
          </span>
        </div>
        {deposit.createdAt ? (
          <span className="text-caption text-gray">{timeAgo(deposit.createdAt)}</span>
        ) : null}
      </div>

      <div className="space-y-2">
        {deposit.commitment && (
          <div className="flex items-center justify-between">
            <span className="text-caption text-gray">Commitment</span>
            <div className="flex items-center gap-1.5">
              <code className="text-caption font-mono text-green-400">
                {truncate(deposit.commitment, 8, 6)}
              </code>
              <CopyButton text={deposit.commitment} label="Commitment" variant="default" iconSize="sm" />
            </div>
          </div>
        )}
        <div className="flex items-center justify-between">
          <span className="text-caption text-gray">Leaf Index</span>
          <span className="text-caption text-foreground font-mono">
            {deposit.leafIndex.toString()}
          </span>
        </div>
      </div>

      <a
        href={solanaExplorerUrl(deposit.pubkey)}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1.5 text-caption text-sol hover:text-sol/80 transition-colors"
      >
        <ExternalLink className="w-3 h-3" />
        View on OrbMarkets
      </a>
    </div>
  );
}

function DepositsTab() {
  const { deposits, isLoading, error, refresh } = useDeposits();

  if (error) return <ErrorState message={error} onRetry={refresh} />;
  if (isLoading) return <LoadingState />;
  if (deposits.length === 0) return <EmptyState label="deposits" />;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <span className="text-caption text-gray">{deposits.length} deposit(s)</span>
        <button onClick={refresh} className="text-caption text-gray hover:text-gray-light transition-colors cursor-pointer" aria-label="Refresh deposits">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {deposits.map((d) => (
          <DepositRow key={d.pubkey} deposit={d} />
        ))}
      </div>
    </div>
  );
}

// =============================================================================
// Transfers Tab
// =============================================================================

function TransferEventRow({ event }: { event: TransferEvent }) {
  const isCommitment = event.type === "commitment";

  return (
    <div className="p-4 gradient-bg-card rounded-[12px] space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className={cn(
              "p-1.5 rounded-[8px]",
              isCommitment ? "bg-purple-500/10" : "bg-red-500/10"
            )}
          >
            {isCommitment ? (
              <ArrowDownToLine className="w-3.5 h-3.5 text-purple-400" />
            ) : (
              <ArrowUpFromLine className="w-3.5 h-3.5 text-red-400" />
            )}
          </div>
          <span
            className={cn(
              "text-body2-semibold",
              isCommitment ? "text-purple-400" : "text-red-400"
            )}
          >
            {isCommitment ? "Commitment Added" : "Nullifier Spent"}
          </span>
        </div>
        <span className="text-caption text-gray">{timeAgo(event.timestamp)}</span>
      </div>

      <div className="space-y-2">
        {isCommitment && event.commitment && (
          <>
            <div className="flex items-center justify-between">
              <span className="text-caption text-gray">Commitment</span>
              <div className="flex items-center gap-1.5">
                <code className="text-caption font-mono text-purple-400">
                  {truncate(event.commitment, 8, 6)}
                </code>
                <CopyButton text={event.commitment} label="Commitment" variant="default" iconSize="sm" />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-caption text-gray">Leaf Index</span>
              <span className="text-caption text-foreground font-mono">
                {event.leafIndex?.toString()}
              </span>
            </div>
          </>
        )}
      </div>

      <a
        href={solanaExplorerUrl(event.pubkey)}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1.5 text-caption text-sol hover:text-sol/80 transition-colors"
      >
        <ExternalLink className="w-3 h-3" />
        View on OrbMarkets
      </a>
    </div>
  );
}

function TransfersTab() {
  const { events, isLoading, error, refresh } = useTransfers();

  if (error) return <ErrorState message={error} onRetry={refresh} />;
  if (isLoading) return <LoadingState />;
  if (events.length === 0) return <EmptyState label="transfers" />;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <span className="text-caption text-gray">{events.length} event(s)</span>
        <button onClick={refresh} className="text-caption text-gray hover:text-gray-light transition-colors cursor-pointer" aria-label="Refresh transfers">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {events.map((e, i) => (
          <TransferEventRow key={`${e.pubkey}-${i}`} event={e} />
        ))}
      </div>
    </div>
  );
}

// =============================================================================
// Withdrawals Tab
// =============================================================================

const STATUS_STYLES: Record<RedemptionRecord["status"], { bg: string; text: string }> = {
  Pending: { bg: "bg-orange-500/10 border-orange-500/20", text: "text-orange-400" },
  Processing: { bg: "bg-blue-500/10 border-blue-500/20", text: "text-blue-400" },
  Failed: { bg: "bg-red-500/10 border-red-500/20", text: "text-red-400" },
};

function RedemptionRow({ redemption }: { redemption: RedemptionRecord }) {
  const statusStyle = STATUS_STYLES[redemption.status];

  return (
    <div className="p-4 gradient-bg-card rounded-[12px] space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-[8px] bg-orange-500/10">
            <ArrowUpFromLine className="w-3.5 h-3.5 text-orange-400" />
          </div>
          <span className="text-body2-semibold text-foreground">
            {formatBtc(redemption.amountSats)} BTC
          </span>
        </div>
        <span
          className={cn(
            "px-2 py-0.5 rounded-full text-caption border",
            statusStyle.bg,
            statusStyle.text
          )}
        >
          {redemption.status}
        </span>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-caption text-gray">Request ID</span>
          <span className="text-caption text-foreground font-mono">
            #{redemption.requestId.toString()}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-caption text-gray">Requester</span>
          <div className="flex items-center gap-1.5">
            <code className="text-caption font-mono text-foreground">
              {truncate(redemption.requester, 6, 4)}
            </code>
            <CopyButton text={redemption.requester} label="Requester" variant="default" iconSize="sm" />
          </div>
        </div>
        {redemption.btcScript && (
          <div className="flex items-center justify-between">
            <span className="text-caption text-gray">BTC Script</span>
            <div className="flex items-center gap-1.5">
              <code className="text-caption font-mono text-btc">
                {truncate(redemption.btcScript, 8, 6)}
              </code>
              <CopyButton text={redemption.btcScript} label="BTC Script" variant="default" iconSize="sm" />
            </div>
          </div>
        )}
      </div>

      <a
        href={solanaExplorerUrl(redemption.pubkey)}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1.5 text-caption text-sol hover:text-sol/80 transition-colors"
      >
        <ExternalLink className="w-3 h-3" />
        View on OrbMarkets
      </a>
    </div>
  );
}

function WithdrawalsTab() {
  const { redemptions, isLoading, error, refresh } = useRedemptions();

  if (error) return <ErrorState message={error} onRetry={refresh} />;
  if (isLoading) return <LoadingState />;
  if (redemptions.length === 0) return <EmptyState label="withdrawals" />;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <span className="text-caption text-gray">{redemptions.length} withdrawal(s)</span>
        <button onClick={refresh} className="text-caption text-gray hover:text-gray-light transition-colors cursor-pointer" aria-label="Refresh withdrawals">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {redemptions.map((r) => (
          <RedemptionRow key={r.pubkey} redemption={r} />
        ))}
      </div>
    </div>
  );
}

// =============================================================================
// Shared States
// =============================================================================

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
      <button
        onClick={onRetry}
        className="text-caption text-red-400 hover:text-red-300 underline transition-colors"
      >
        Retry
      </button>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Search className="w-8 h-8 text-gray/50 mb-3" />
      <p className="text-body2 text-gray">No {label} found on devnet</p>
      <p className="text-caption text-gray/60 mt-1">
        Activity will appear here as it happens on-chain
      </p>
    </div>
  );
}

// =============================================================================
// Main Page
// =============================================================================

function ExplorerContent() {
  const [activeTab, setActiveTab] = useState<TabType>("deposits");
  const { deposits } = useDeposits();
  const { events } = useTransfers();
  const { redemptions } = useRedemptions();

  const counts: Record<TabType, number> = {
    deposits: deposits.length,
    transfers: events.length,
    withdrawals: redemptions.length,
  };

  return (
    <>
      <div className="mb-4">
        <TabBar activeTab={activeTab} onTabChange={setActiveTab} counts={counts} />
      </div>

      {activeTab === "deposits" && <DepositsTab />}
      {activeTab === "transfers" && <TransfersTab />}
      {activeTab === "withdrawals" && <WithdrawalsTab />}
    </>
  );
}

export default function ExplorerPage() {
  return (
    <main className="min-h-screen bg-background hacker-bg noise-overlay">
      <div className="container mx-auto px-4 py-8 relative z-10 max-w-5xl">
        {/* Header */}
        <header className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <Link href="/" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
              <div className="p-2 rounded-[12px] bg-gradient-to-br from-btc/20 to-privacy/20 border border-btc/20">
                <div className="relative">
                  <BitcoinIcon className="h-6 w-6 btc-glow" />
                  <Shield className="h-3 w-3 text-privacy absolute -bottom-1 -right-1" />
                </div>
              </div>
              <span className="text-heading6 text-foreground">Aegis</span>
            </Link>
          </div>
          <div className="flex items-center gap-4">
            <Link
              href="/vault"
              className="text-body2 text-gray hover:text-gray-light transition-colors"
            >
              Vault
            </Link>
            <Link
              href="/docs"
              className="text-body2 text-gray hover:text-gray-light transition-colors"
            >
              Docs
            </Link>
            <a
              href="https://github.com/cheng-chun-yuan/Aegis"
              target="_blank"
              rel="noopener noreferrer"
              className="text-body2 text-gray hover:text-gray-light transition-colors flex items-center gap-1"
            >
              GitHub
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </header>

        {/* Title */}
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-[10px] bg-privacy/10 border border-privacy/20">
              <Search className="w-5 h-5 text-privacy" />
            </div>
            <div>
              <h1 className="text-heading5 text-foreground">Explorer</h1>
              <p className="text-caption text-gray">
                Browse all on-chain Aegis activity on Solana devnet
              </p>
            </div>
          </div>
        </div>

        {/* Content */}
        <Suspense fallback={<LoadingState />}>
          <ExplorerContent />
        </Suspense>

        {/* Privacy Note */}
        <div className="mt-6 p-3 bg-privacy/5 border border-privacy/15 rounded-[12px]">
          <div className="flex items-center gap-2 mb-1">
            <Shield className="w-4 h-4 text-privacy" />
            <span className="text-caption text-privacy">Privacy Preserved</span>
          </div>
          <p className="text-caption text-gray">
            Transfer amounts are encrypted with zero-knowledge proofs. Only commitments and
            nullifiers are visible on-chain — no amounts or sender/recipient information is exposed.
          </p>
        </div>

        {/* Footer */}
        <footer className="mt-8 pt-6 border-t border-gray/15">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-4">
              <Link
                href="/"
                className="text-caption text-gray hover:text-gray-light transition-colors"
              >
                Aegis
              </Link>
              <a
                href="https://github.com/cheng-chun-yuan/Aegis"
                target="_blank"
                rel="noopener noreferrer"
                className="text-caption text-gray hover:text-gray-light transition-colors"
              >
                GitHub
              </a>
            </div>
            <a href="https://zeusnetwork.xyz/" target="_blank" rel="noopener noreferrer" className="text-caption text-gray hover:text-gray-light transition-colors flex items-center gap-1.5">Powered by <img src="/zeus_network.svg" alt="Zeus Network" className="w-4 h-4" />Zeus Network</a>
          </div>
        </footer>
      </div>
    </main>
  );
}
