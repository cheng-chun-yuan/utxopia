"use client";

/**
 * Shared UI components for the Explorer page.
 * Includes TypeFilterBar, TokenFilterDropdown, table primitives (Th, Td),
 * state indicators (Loading, Error, Empty), chain explorer links, RefreshButton, and StatCard.
 */

import { useState, useRef, useEffect } from "react";
import {
  ArrowDownToLine,
  ArrowUpDown,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  ExternalLink,
  Loader2,
  Search,
  Shield,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useChainEnvironment } from "@/lib/chain-environment";
import { getChainLinkClass, getChainTransactionUrl } from "@/lib/chain-links";
import { EXPLORER_FILTER_TOKENS, type TokenFilterId } from "@/lib/supported-tokens";

// --- Types ---

export type FilterType = "all" | "shield" | "transfer" | "unshield";

export type TokenFilter = TokenFilterId;

const TOKEN_LIST = EXPLORER_FILTER_TOKENS.map((t) => ({
  id: t.explorerFilter,
  label: t.explorerLabel,
  subtitle: t.explorerSubtitle,
  logo: t.logo,
  secondLogo: t.explorerSecondLogo,
  live: t.enabled,
}));

// --- Type Filter Bar ---

const FILTER_PILLS: { id: FilterType; label: string; icon: React.ReactNode; color: string; hasTokens: boolean }[] = [
  { id: "all", label: "All", icon: null, color: "bg-gray/15 text-foreground border-gray/20", hasTokens: false },
  { id: "shield", label: "Shield", icon: <ArrowDownToLine className="w-3.5 h-3.5" />, color: "bg-gray/15 text-foreground border-gray/20", hasTokens: true },
  { id: "transfer", label: "Transfer", icon: <ArrowUpDown className="w-3.5 h-3.5" />, color: "bg-gray/15 text-foreground border-gray/20", hasTokens: false },
  { id: "unshield", label: "Unshield", icon: <ArrowUpFromLine className="w-3.5 h-3.5" />, color: "bg-gray/15 text-foreground border-gray/20", hasTokens: true },
];

export function TypeFilterBar({
  activeFilter,
  onFilterChange,
  selectedTokens,
  onToggleToken,
  counts,
}: {
  activeFilter: FilterType;
  onFilterChange: (f: FilterType) => void;
  selectedTokens: Set<TokenFilter>;
  onToggleToken: (t: TokenFilter) => void;
  counts: Record<FilterType, number>;
}) {
  const [openDropdown, setOpenDropdown] = useState<FilterType | null>(null);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {FILTER_PILLS.map((pill) => {
        const isActive = activeFilter === pill.id;
        const isDropdownOpen = openDropdown === pill.id;

        return (
          <div key={pill.id} className="relative">
            <button
              onClick={() => {
                if (isActive) {
                  // Already active — close dropdown and reset to All
                  setOpenDropdown(null);
                  onFilterChange("all");
                } else {
                  onFilterChange(pill.id);
                  setOpenDropdown(pill.hasTokens ? pill.id : null);
                }
              }}
              className={cn(
                "flex items-center gap-1.5 px-3 py-2 rounded-[10px] text-xs font-medium transition-all border",
                isActive ? pill.color : "bg-muted/40 text-gray border-gray/10 hover:border-gray/25 hover:text-gray-light"
              )}
            >
              {pill.icon}
              {pill.label}
              {counts[pill.id] > 0 && (
                <span className="min-w-[20px] h-[20px] px-1 flex items-center justify-center text-[10px] rounded-full bg-black/20 font-mono">
                  {counts[pill.id]}
                </span>
              )}
              {pill.hasTokens && isActive && (
                <ChevronDown className={cn("w-3 h-3 opacity-60 transition-transform", isDropdownOpen && "rotate-180")} />
              )}
            </button>

            {/* Dropdown with checkboxes */}
            {isDropdownOpen && (
              <TokenCheckboxDropdown
                selectedTokens={selectedTokens}
                onToggle={onToggleToken}
                onClose={() => setOpenDropdown(null)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// --- Token Checkbox Dropdown ---

function TokenCheckboxDropdown({
  selectedTokens,
  onToggle,
  onClose,
}: {
  selectedTokens: Set<TokenFilter>;
  onToggle: (t: TokenFilter) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute top-full left-0 mt-1.5 py-1.5 rounded-[10px] bg-background border border-gray/15 shadow-xl min-w-[180px] z-50"
    >
      {TOKEN_LIST.map((token) => {
        const checked = selectedTokens.has(token.id);
        return (
          <button
            key={token.id}
            onClick={() => token.live && onToggle(token.id)}
            disabled={!token.live}
            className={cn(
              "w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors",
              !token.live
                ? "text-gray/30 cursor-default"
                : "text-gray-light hover:bg-gray/5"
            )}
          >
            {/* Checkbox */}
            <span
              className={cn(
                "w-4 h-4 rounded-[4px] border flex items-center justify-center shrink-0 transition-colors",
                !token.live
                  ? "border-gray/15 bg-transparent"
                  : checked
                    ? "bg-green-500 border-green-500"
                    : "border-gray/30 bg-transparent"
              )}
            >
              {checked && <Check className="w-3 h-3 text-background" strokeWidth={3} />}
            </span>
            {/* Logo(s) */}
            <span className="flex items-center -space-x-1 shrink-0">
              <img
                src={token.logo}
                alt={token.label}
                className={cn("w-5 h-5 rounded-full", !token.live && "opacity-30")}
              />
              {token.secondLogo && (
                <img
                  src={token.secondLogo}
                  alt=""
                  className="w-5 h-5 rounded-full ring-1 ring-background"
                />
              )}
            </span>
            {/* Label + subtitle */}
            <div className="flex flex-col min-w-0">
              <span className={cn("text-[12px] font-medium", !token.live && "text-gray/30")}>{token.label}</span>
              <span className={cn("text-[10px]", !token.live ? "text-gray/20" : "text-gray/50")}>{token.subtitle}</span>
            </div>
            {!token.live && <span className="text-[10px] text-gray/30 ml-auto shrink-0">Soon</span>}
          </button>
        );
      })}
    </div>
  );
}

// --- Type Badge (unified row first column) ---

export function TypeBadge({ kind }: { kind: "shield" | "transfer" | "unshield" | "withdraw" }) {
  const label = { shield: "Shield", transfer: "Transfer", unshield: "Unshield", withdraw: "Withdraw" }[kind];
  return <span className="text-[13px] text-gray-light font-medium">{label}</span>;
}

// --- Status Dot ---

export type StatusDotVariant = "confirmed" | "processing" | "pending" | "failed";

export function StatusDot({ variant, label }: { variant: StatusDotVariant; label?: string }) {
  const config = {
    confirmed: { dot: "bg-green-400", text: "text-green-400", defaultLabel: "Confirmed" },
    processing: { dot: "bg-gray/50 animate-pulse", text: "text-gray-light", defaultLabel: "Processing" },
    pending: { dot: "bg-gray/40", text: "text-gray", defaultLabel: "Pending" },
    failed: { dot: "bg-red-400", text: "text-red-400", defaultLabel: "Failed" },
  }[variant];

  return (
    <div className="flex items-center gap-1.5">
      <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", config.dot)} />
      <span className={cn("text-[13px] font-medium", config.text)}>{label ?? config.defaultLabel}</span>
    </div>
  );
}

// --- Flow Cell ---

function FlowIcon({ icon, label }: { icon: string | "shield"; label: string }) {
  if (icon === "shield") {
    return <Shield className="w-4 h-4 text-green-400/70" />;
  }
  return <img src={icon} alt={label} className="w-4 h-4 rounded-full" />;
}

export function FlowCell({
  from,
  to,
  meta,
}: {
  from: { icon: string; label: string };
  to: { icon: string; label: string };
  meta?: string;
}) {
  return (
    <div className="flex items-center gap-2 text-gray-light">
      <span className="inline-flex items-center gap-1.5 text-[13px] font-medium">
        <FlowIcon icon={from.icon} label={from.label} />
        {from.label}
      </span>
      <span className="text-gray/40 text-[12px]">&rarr;</span>
      <span className="inline-flex items-center gap-1.5 text-[13px] font-medium">
        <FlowIcon icon={to.icon} label={to.label} />
        {to.label}
      </span>
      {meta && <span className="text-[11px] text-gray/50 font-normal">({meta})</span>}
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

export function ChainTxLink({ signature }: { signature: string }) {
  const { config } = useChainEnvironment();
  const href = getChainTransactionUrl(config, signature);

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn("transition-colors", getChainLinkClass(config))}
      aria-label="View transaction"
    >
      <ExternalLink className="w-3.5 h-3.5" />
    </a>
  );
}

export const SolanaLink = ChainTxLink;

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
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="p-4 rounded-full bg-privacy/5 border border-privacy/10 mb-4">
        <Shield className="w-8 h-8 text-privacy/40" />
      </div>
      <p className="text-body2 text-gray-light mb-1">No {label} yet</p>
      <p className="text-caption text-gray/50 max-w-[280px]">
        The shielded pool is quiet. Shield some tokens to see activity here.
      </p>
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

export function StatCard({ label, value, icon, color }: { label: string; value: string | number; icon?: React.ReactNode; color: string }) {
  return (
    <div className={cn("flex items-center gap-3 px-4 py-3 rounded-[12px] border backdrop-blur-sm", color)}>
      {icon && <div className="shrink-0">{icon}</div>}
      <div>
        <p className="text-heading6 text-foreground font-mono">{value}</p>
        <p className="text-caption text-gray">{label}</p>
      </div>
    </div>
  );
}
