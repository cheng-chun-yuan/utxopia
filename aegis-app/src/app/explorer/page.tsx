"use client";

import { useState, Suspense } from "react";
import {
  ArrowDownToLine,
  ArrowUpDown,
  ArrowUpFromLine,
  Shield,
} from "lucide-react";
import { BitcoinIcon } from "@/components/bitcoin-wallet-selector";
import { useDeposits, useTransfers, useRedemptions } from "@/hooks/use-explorer";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";

import { TabBar, LoadingState, StatCard } from "./components/shared";
import type { TabType } from "./components/shared";
import { DepositsTab } from "./components/deposits-tab";
import { TransfersTab } from "./components/transfers-tab";
import { WithdrawalsTab } from "./components/withdrawals-tab";

// =============================================================================
// Explorer Content
// =============================================================================

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

// =============================================================================
// Main Page
// =============================================================================

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
