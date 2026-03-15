"use client";

/**
 * Shared UI components for the Explorer page.
 * Includes TabBar, table primitives (Th, Td), state indicators
 * (Loading, Error, Empty), SolanaLink, RefreshButton, and StatCard.
 */

import {
  ArrowDownToLine,
  ArrowUpDown,
  ArrowUpFromLine,
  ExternalLink,
  Loader2,
  Search,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";

// --- Types ---

export type TabType = "deposits" | "transfers" | "withdrawals";

export const tabs: { id: TabType; label: string; icon: React.ReactNode }[] = [
  { id: "deposits", label: "Deposits", icon: <ArrowDownToLine className="w-4 h-4" /> },
  { id: "transfers", label: "Transfers", icon: <ArrowUpDown className="w-4 h-4" /> },
  { id: "withdrawals", label: "Withdrawals", icon: <ArrowUpFromLine className="w-4 h-4" /> },
];

// --- Tab Bar ---

export function TabBar({ activeTab, onTabChange, counts }: {
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
            "flex-1 flex items-center justify-center gap-0 sm:gap-2 px-1 sm:px-3 py-2.5 rounded-[10px] text-xs sm:text-sm transition-colors",
            activeTab === tab.id
              ? colorMap[tab.id]
              : "text-gray hover:text-gray-light hover:bg-gray/10"
          )}
        >
          <span className="hidden sm:inline">{tab.icon}</span>
          {tab.label}
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

// --- Table Primitives ---

export function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th className={cn("px-4 py-3 text-left text-caption text-gray font-medium whitespace-nowrap", className)}>
      {children}
    </th>
  );
}

export function Td({ children, className, colSpan }: { children?: React.ReactNode; className?: string; colSpan?: number }) {
  return (
    <td className={cn("px-4 py-3.5 whitespace-nowrap", className)} colSpan={colSpan}>
      {children}
    </td>
  );
}

// --- Links ---

export function SolanaLink({ signature }: { signature: string }) {
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

// --- States ---

export function LoadingState() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="flex items-center gap-2 text-gray">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-body2">Loading on-chain data...</span>
      </div>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-[12px] space-y-2">
      <p className="text-body2 text-red-400">{message}</p>
      <button onClick={onRetry} className="text-caption text-red-400 hover:text-red-300 underline transition-colors">Retry</button>
    </div>
  );
}

export function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Search className="w-8 h-8 text-gray/50 mb-3" />
      <p className="text-body2 text-gray">No {label} found</p>
    </div>
  );
}

export function RefreshButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="text-caption text-gray hover:text-gray-light transition-colors cursor-pointer" aria-label="Refresh">
      <RefreshCw className="w-3.5 h-3.5" />
    </button>
  );
}

// --- Stat Card ---

export function StatCard({ label, value, icon, color }: { label: string; value: string | number; icon: React.ReactNode; color: string }) {
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
