"use client";

import { useState, useMemo, useCallback, Suspense, Fragment } from "react";
import {
  ArrowDownToLine,
  ArrowUpDown,
  ArrowUpFromLine,
  Shield,
} from "lucide-react";
import { useExplorer } from "@/hooks/use-explorer";
import type { ExplorerTransaction } from "@/hooks/use-explorer";
import { usePoolStats } from "@/hooks/use-pool-stats";
import { useTokenPrices, type TokenPrices } from "@/hooks/use-btc-price";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";

import { TypeFilterBar, LoadingState, StatCard, Th, RefreshButton, EmptyState } from "./components/shared";
import type { FilterType, TokenFilter } from "./components/shared";
import { TransferRow, getTransferKind } from "./components/transfers-tab";
import { getTokenByFilter, formatTokenAmount, type TokenFilterId } from "@/lib/supported-tokens";

// =============================================================================
// Filter type maps directly to ExplorerTransaction.type
// "all" shows everything, others filter by tx.type
// "unshield" filter also includes "withdraw" type

// =============================================================================
// Explorer Content
// =============================================================================

function ExplorerContent() {
  const [activeFilter, setActiveFilter] = useState<FilterType>("all");
  const [selectedTokens, setSelectedTokens] = useState<Set<TokenFilter>>(() => new Set(["btc", "sol", "usdc", "usdt"] as TokenFilter[]));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { transactions: allTransactions, refresh: refreshAll } = useExplorer();

  const toggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);


  // All transactions come from useExplorer() — already sorted by timestamp desc

  // Counts by type (withdraw counts as unshield)
  const counts = useMemo(() => {
    const c: Record<FilterType, number> = { all: 0, shield: 0, transfer: 0, unshield: 0 };
    for (const tx of allTransactions) {
      if (tx.type === "shield") c.shield++;
      else if (tx.type === "transfer") c.transfer++;
      else c.unshield++; // unshield + withdraw
    }
    c.all = allTransactions.length;
    return c;
  }, [allTransactions]);

  // Map token symbol to filter ID
  function getTokenFilter(tx: ExplorerTransaction): TokenFilterId {
    const sym = tx.tokenSymbol?.toUpperCase();
    if (sym === "SOL") return "sol";
    if (sym === "USDC") return "usdc";
    if (sym === "USDT") return "usdt";
    return "btc";
  }

  // Filter by type AND token
  const filtered = useMemo(() => {
    let items = allTransactions;

    // Type filter
    if (activeFilter !== "all") {
      if (activeFilter === "unshield") {
        items = items.filter((t) => t.type === "unshield" || t.type === "withdraw");
      } else {
        items = items.filter((t) => t.type === activeFilter);
      }
    }

    // Token filter (only applies to shield and unshield — transfers are token-agnostic)
    if (selectedTokens.size < 4) {
      items = items.filter((t) => {
        if (t.type === "transfer") return true;
        return selectedTokens.has(getTokenFilter(t));
      });
    }

    return items;
  }, [allTransactions, activeFilter, selectedTokens]);

  // TVL from on-chain pool state (same as main page)
  const { stats } = usePoolStats();
  const prices = useTokenPrices();

  const totalShieldedDisplay = useMemo(() => {
    if (!stats?.tokenTVL?.length) return "—";
    const priceMap: Record<string, number | null> = {
      BTC: prices.btc, zkBTC: prices.btc,
      SOL: prices.sol, zkSOL: prices.sol,
      USDC: prices.usdc, zkUSDC: prices.usdc,
      USDT: prices.usdt, zkUSDT: prices.usdt,
    };
    let total = 0;
    for (const t of stats.tokenTVL) {
      const price = priceMap[t.symbol] ?? priceMap[t.symbol.replace("zk", "")];
      if (price) {
        total += (Number(t.totalShielded) / (10 ** t.decimals)) * price;
      }
    }
    if (total === 0) return "—";
    return `$${total.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  }, [stats, prices]);

  return (
    <>
      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatCard label="Shield" value={counts.shield} color="bg-muted/30 border-gray/15" />
        <StatCard label="Transfer" value={counts.transfer} color="bg-muted/30 border-gray/15" />
        <StatCard label="Unshield" value={counts.unshield} color="bg-muted/30 border-gray/15" />
        <StatCard label="Total Shielded" value={totalShieldedDisplay} color="bg-muted/30 border-gray/15" />
      </div>

      {/* Filter Bar */}
      <div className="flex items-center justify-between mb-4">
        <TypeFilterBar
          activeFilter={activeFilter}
          onFilterChange={setActiveFilter}
          selectedTokens={selectedTokens}
          onToggleToken={(t) => {
            setSelectedTokens((prev) => {
              const next = new Set(prev);
              if (next.has(t)) {
                if (next.size > 1) next.delete(t);
              } else {
                next.add(t);
              }
              return next;
            });
          }}
          counts={counts}
        />
        <RefreshButton onClick={refreshAll} />
      </div>

      {/* Unified Table */}
      <div className="min-h-[40vh]">
        {filtered.length === 0 ? (
          <EmptyState label="transactions" />
        ) : (
          <div className="overflow-x-auto rounded-[12px] border border-gray/15 backdrop-blur-sm bg-muted/30">
            <table className="w-full min-w-[750px]">
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
                {filtered.map((tx) => {
                  const rowKey = tx.txSignature || tx.btcMeta?.depositTxid || `${tx.type}-${tx.timestamp}`;
                  return (
                    <TransferRow
                      key={`${tx.type}-${rowKey}`}
                      tx={tx}
                      expanded={expanded.has(rowKey)}
                      onToggle={() => toggle(rowKey)}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

// =============================================================================
// Main Page
// =============================================================================

export default function ExplorerPage() {
  return (
    <main className="min-h-screen bg-background hacker-bg noise-overlay overflow-x-hidden flex flex-col">
      <SiteHeader />
      <div className="container mx-auto px-4 pt-24 pb-8 relative z-10 max-w-7xl flex-1 flex flex-col">
        {/* Title */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-3">
            <div className="h-px w-8 bg-gradient-to-r from-privacy/50 to-transparent" />
            <span className="text-[11px] font-mono uppercase tracking-[0.2em] text-privacy/60">On-Chain Data</span>
          </div>
          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
            <div>
              <h1 className="text-3xl md:text-4xl font-semibold tracking-tight text-foreground mb-1.5">Explorer</h1>
              <p className="text-sm text-gray font-light">Browse all shielded pool activity</p>
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

        <div className="flex-1 flex flex-col">
          <Suspense fallback={<LoadingState />}>
            <ExplorerContent />
          </Suspense>
        </div>

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
