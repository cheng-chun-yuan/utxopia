"use client";

import { useSearchParams } from "next/navigation";
import { useState, useMemo, useEffect, useRef, Suspense } from "react";
import Link from "next/link";
import Image from "next/image";
import {
  Wallet,
  ArrowDownToLine,
  ArrowLeft,
  Shield,
  Inbox,
  Link2,
  ChevronDown,
  RefreshCw,
  Eye,
  EyeOff,
} from "lucide-react";
import { cn } from "@/lib/utils";
// formatBtc removed — per-token formatting used instead
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { ErrorBoundary } from "@/components/error-boundary";
import { useAegisKeys, useStealthInbox } from "@/hooks/use-aegis";
import { usePasskey } from "@/hooks/use-passkey";
import { useAegisStore } from "@/stores/aegis-store";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { AuthModal } from "@/components/auth-modal";
import { InboxItem, EmptyInbox } from "@/components/stealth-inbox";

type TabType = "activity" | "notes";

const tabs: { id: TabType; label: string; icon: React.ReactNode }[] = [
  { id: "activity", label: "Activity", icon: <ArrowDownToLine className="w-4 h-4" /> },
  { id: "notes", label: "My Funds", icon: <Inbox className="w-4 h-4" /> },
];

function TabBar({
  activeTab,
  onTabChange,
  counts,
}: {
  activeTab: TabType;
  onTabChange: (tab: TabType) => void;
  counts: Record<TabType, number>;
}) {
  return (
    <div className="flex gap-1 p-1 bg-muted border border-gray/15 rounded-[12px]">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className={cn(
            "flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-[10px] text-sm transition-colors",
            activeTab === tab.id
              ? "bg-privacy/10 text-privacy border border-privacy/20"
              : "text-gray hover:text-gray-light hover:bg-gray/10"
          )}
        >
          {tab.icon}
          <span>{tab.label}</span>
          {counts[tab.id] > 0 && (
            <span className={cn(
              "min-w-[18px] h-[18px] px-1.5 flex items-center justify-center text-[11px] rounded-full font-medium",
              activeTab === tab.id
                ? "bg-privacy/20 text-privacy"
                : "bg-gray/15 text-gray"
            )}>
              {counts[tab.id]}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

import { VAULT_TOKENS, SUPPORTED_TOKENS, type SupportedToken } from "@/lib/supported-tokens";
import { useTokenPrices } from "@/hooks/use-btc-price";
import type { InboxNote } from "@/stores/aegis-store";

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

function getToken(sym: string): SupportedToken {
  return SUPPORTED_TOKENS.find(t => t.shieldedSymbol === sym || t.symbol === sym) || SUPPORTED_TOKENS[0];
}

function formatAmt(amount: bigint | number, token: SupportedToken): string {
  const num = Number(amount) / 10 ** token.decimals;
  const s = num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: token.decimals > 2 ? token.decimals : 2 });
  return s.replace(/(\.\d{2,}?)0+$/, "$1");
}

function ActivityFeed() {
  const { notes, isLoading, refresh } = useStealthInbox();
  const tokenPrices = useTokenPrices();

  // Sort by createdAt descending (newest first)
  const sorted = useMemo(() =>
    [...notes].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    [notes]
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <span className="text-caption text-gray/50">{sorted.length} transaction{sorted.length !== 1 ? "s" : ""}</span>
        <button
          onClick={refresh}
          disabled={isLoading}
          className="flex items-center gap-1 px-2 py-1 rounded-[6px] text-caption text-gray hover:text-gray-light hover:bg-gray/10 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={cn("w-3.5 h-3.5", isLoading && "animate-spin")} />
        </button>
      </div>

      {sorted.length === 0 && !isLoading && (
        <div className="text-center py-8">
          <Shield className="w-8 h-8 text-gray/20 mx-auto mb-3" />
          <p className="text-sm text-gray/50">No activity yet</p>
          <p className="text-xs text-gray/30 mt-1">Deposits and transfers will appear here</p>
        </div>
      )}

      <div className="rounded-[12px] border border-gray/10 overflow-hidden divide-y divide-gray/8">
        {sorted.map((note) => {
          const token = getToken(note.tokenSymbol);
          const price = tokenPrices[token.priceKey];
          const usdValue = price ? (Number(note.amount) / 10 ** token.decimals) * price : 0;
          return (
            <div key={note.id} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors">
              {/* Token icon */}
              <img src={token.shieldedLogo} alt={token.shieldedSymbol} className="w-8 h-8 rounded-full shrink-0" />

              {/* Type + token name */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium text-foreground">
                    {note.isSpent ? "Sent" : "Received"}
                  </span>
                  <span className="text-xs text-gray/40">{token.shieldedSymbol}</span>
                </div>
                <p className="text-[11px] text-gray/40">{timeAgo(note.createdAt)}</p>
              </div>

              {/* Amount */}
              <div className="text-right">
                <p className={cn(
                  "text-sm font-semibold font-mono",
                  note.isSpent ? "text-gray" : "text-foreground"
                )}>
                  {note.isSpent ? "-" : "+"}{formatAmt(note.amount, token)}
                </p>
                {usdValue > 0 && (
                  <p className="text-[11px] text-gray/40 font-mono">
                    ${usdValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </p>
                )}
              </div>

              {/* Status dot */}
              <div className={cn(
                "w-2 h-2 rounded-full shrink-0",
                note.isSpent ? "bg-gray/30" : "bg-success"
              )} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TokenList() {
  const { hasKeys } = useAegisKeys();
  const { notes, balancesByToken, isLoading, error, refresh } = useStealthInbox();
  const tokenPrices = useTokenPrices();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showSpent, setShowSpent] = useState(false);

  // Group notes by tokenSymbol, sort tokens with balance first
  const notesByToken = useMemo(() => {
    const map = new Map<string, typeof notes>();
    for (const note of notes) {
      const sym = note.tokenSymbol || "zkBTC";
      if (!map.has(sym)) map.set(sym, []);
      map.get(sym)!.push(note);
    }
    return map;
  }, [notes]);

  // Build token rows: only tokens with balance
  const tokenRows = useMemo(() => {
    return VAULT_TOKENS.map((token) => {
      const tokenNotes = notesByToken.get(token.shieldedSymbol) || [];
      const spendable = tokenNotes.filter((n) => !n.isSpent);
      const spent = tokenNotes.filter((n) => n.isSpent);
      const rawBalance = Number(balancesByToken?.[token.shieldedSymbol] ?? 0n);
      const balanceNum = rawBalance / 10 ** token.decimals;
      const raw = balanceNum < 0.01 && balanceNum > 0
        ? balanceNum.toFixed(token.decimals)
        : balanceNum.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: token.decimals > 2 ? token.decimals : 2 });
      const balance = raw.replace(/(\.\d{2,}?)0+$/, "$1");
      const price = tokenPrices[token.priceKey];
      const usdValue = price ? (rawBalance / 10 ** token.decimals) * price : 0;
      return { token, tokenNotes, spendable, spent, rawBalance, balance, usdValue };
    }).filter((r) => r.rawBalance > 0)
      .sort((a, b) => b.usdValue - a.usdValue);
  }, [notesByToken, balancesByToken]);

  return (
    <div className="space-y-4">
      {/* Token list header */}
      <div className="flex items-center justify-between px-1">
        <p className="text-caption text-gray uppercase tracking-wider">Token</p>
        <div className="flex items-center gap-4">
          <p className="text-caption text-gray uppercase tracking-wider">Balance</p>
          <button
            onClick={refresh}
            disabled={isLoading}
            className="flex items-center gap-1 px-2 py-1 rounded-[6px] text-caption text-gray hover:text-gray-light hover:bg-gray/10 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", isLoading && "animate-spin")} />
          </button>
        </div>
      </div>

      {/* Token rows */}
      <div className="rounded-[12px] border border-gray/15 overflow-hidden">
        {tokenRows.length === 0 && !isLoading && (
          <div className="px-4 py-8 text-center text-caption text-gray/50">No tokens with balance</div>
        )}
        {tokenRows.map(({ token, spendable, spent, balance, usdValue }, i) => {
          const isExpanded = expanded === token.shieldedSymbol;
          const displayedNotes = showSpent ? [...spendable, ...spent] : spendable;

          return (
            <div key={token.shieldedSymbol}>
              <button
                onClick={() => setExpanded(isExpanded ? null : token.shieldedSymbol)}
                className={cn(
                  "w-full flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-muted/50 cursor-pointer",
                  i > 0 && "border-t border-gray/10"
                )}
              >
                <Image src={token.shieldedLogo} alt={token.shieldedSymbol} width={32} height={32} className="rounded-full" />
                <div className="flex-1 min-w-0 text-left">
                  <p className="text-body2-semibold text-foreground">{token.shieldedSymbol}</p>
                  <p className="text-caption text-gray">{token.name}</p>
                </div>
                <div className="text-right mr-2">
                  <p className="text-body2-semibold text-foreground font-mono">{balance}</p>
                  {usdValue > 0 ? (
                    <p className="text-caption text-gray font-mono">
                      ${usdValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </p>
                  ) : (
                    <p className="text-caption text-gray">
                      {spendable.length} note{spendable.length !== 1 ? "s" : ""}
                    </p>
                  )}
                </div>
                <ChevronDown className={cn("w-4 h-4 text-gray transition-transform", isExpanded && "rotate-180")} />
              </button>

              {isExpanded && (
                <div className="border-t border-gray/10 bg-muted/30 px-4 py-3 space-y-3">
                  {spent.length > 0 && (
                    <div className="flex items-center justify-end">
                      <button
                        onClick={(e) => { e.stopPropagation(); setShowSpent(!showSpent); }}
                        className={cn(
                          "flex items-center gap-1 px-2 py-1 rounded-[6px] text-caption transition-colors",
                          showSpent ? "text-gray-light bg-gray/10" : "text-gray hover:text-gray-light hover:bg-gray/10"
                        )}
                      >
                        {showSpent ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        {spent.length} Spent
                      </button>
                    </div>
                  )}
                  {displayedNotes.map((note) => (
                    <InboxItem key={note.id} note={note} onClaimed={refresh} />
                  ))}
                  {spendable.length === 0 && !showSpent && spent.length > 0 && (
                    <div className="text-center py-4">
                      <p className="text-body2 text-gray mb-2">No spendable notes</p>
                      <button onClick={() => setShowSpent(true)} className="text-caption text-purple hover:text-purple/80 transition-colors">
                        Show {spent.length} spent
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Error state */}
      {error && (
        <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Claim with Link button */}
      {hasKeys && (
        <Link
          href="/claim"
          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-[12px] bg-sol/10 border border-sol/20 text-sol hover:bg-sol/20 transition-colors"
        >
          <Link2 className="w-4 h-4" />
          Claim with Link
        </Link>
      )}

      {/* Privacy info */}
      <div className="p-3 bg-privacy/5 border border-privacy/15 rounded-[12px]">
        <div className="flex items-center gap-2 mb-1">
          <Shield className="w-4 h-4 text-privacy" />
          <span className="text-caption text-privacy">Privacy Protected</span>
        </div>
        <p className="text-caption text-gray">
          Only you can see deposits addressed to your stealth address. Scanning happens
          locally using your viewing key.
        </p>
      </div>
    </div>
  );
}

function ActivityContent() {
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab") as TabType | null;
  const initialTab: TabType = tabParam === "notes" ? "notes" : "activity";
  const [activeTab, setActiveTab] = useState<TabType>(initialTab);
  const { notes } = useStealthInbox();
  const { hasKeys, isLoading: keysLoading, deriveKeys } = useAegisKeys();

  // Auth modal state
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const { connected } = useWallet();
  const { setVisible: setWalletModalVisible } = useWalletModal();
  const {
    isSupported: passkeySupported,
    hasCredential: hasPasskeyCredential,
    isLoading: passkeyLoading,
    error: passkeyError,
    register: passkeyRegister,
    authenticate: passkeyAuthenticate,
  } = usePasskey();
  const deriveKeysFromPasskeySeed = useAegisStore((s) => s.deriveKeysFromPasskeySeed);

  const handlePasskeyRegister = async () => {
    const seed = await passkeyRegister();
    if (seed) {
      await deriveKeysFromPasskeySeed(seed);
      setAuthModalOpen(false);
    }
  };
  const handlePasskeyAuthenticate = async () => {
    const seed = await passkeyAuthenticate();
    if (seed) {
      await deriveKeysFromPasskeySeed(seed);
      setAuthModalOpen(false);
    }
  };

  // Auto-open auth modal on mount when not logged in
  const autoOpenRef = useRef(false);
  useEffect(() => {
    if (!hasKeys && !autoOpenRef.current) {
      autoOpenRef.current = true;
      setAuthModalOpen(true);
    }
  }, [hasKeys]);

  // Badge counts
  const notesCount = notes.filter((n) => !n.isSpent).length;
  const activityCount = notes.length;

  // Update URL when tab changes
  const handleTabChange = (tab: TabType) => {
    setActiveTab(tab);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState({}, "", url.toString());
  };

  // Sync with URL on mount
  useEffect(() => {
    if (tabParam && tabs.some((t) => t.id === tabParam)) {
      setActiveTab(tabParam);
    }
  }, [tabParam]);

  return (
    <>
      {/* Tab Bar */}
      <div className="mb-4">
        <TabBar
          activeTab={activeTab}
          onTabChange={handleTabChange}
          counts={{ activity: activityCount, notes: notesCount }}
        />
      </div>

      {/* Show unlock screen when no keys */}
      {!hasKeys && (
        <>
          <EmptyInbox hasKeys={false} onUnlock={() => setAuthModalOpen(true)} isLoading={keysLoading} />
          <AuthModal
            open={authModalOpen}
            onOpenChange={setAuthModalOpen}
            passkeySupported={passkeySupported}
            hasPasskeyCredential={hasPasskeyCredential}
            passkeyLoading={passkeyLoading}
            walletLoading={keysLoading}
            walletConnected={connected}
            error={passkeyError}
            onPasskeyRegister={handlePasskeyRegister}
            onPasskeyAuthenticate={handlePasskeyAuthenticate}
            onWalletConnect={() => { setAuthModalOpen(false); setWalletModalVisible(true); }}
            onWalletDeriveKeys={async () => { await deriveKeys(); setAuthModalOpen(false); }}
          />
        </>
      )}

      {/* Tab Content — only when keys available */}
      {hasKeys && (
        <ErrorBoundary>
          {activeTab === "activity" && <ActivityFeed />}
          {activeTab === "notes" && <TokenList />}
        </ErrorBoundary>
      )}
    </>
  );
}

export default function ActivityPage() {
  return (
    <main className="min-h-screen bg-background hacker-bg noise-overlay flex flex-col items-center py-8 px-4 sm:py-12">
      {/* Header — Back + Badges (matches /vault layout) */}
      <div className="w-full mb-4 flex items-center justify-between relative z-10" style={{ maxWidth: "480px" }}>
        <Link
          href="/vault"
          className="inline-flex items-center gap-2 text-body2 text-gray hover:text-gray-light transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </Link>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-full border bg-privacy/10 border-privacy/20">
            <Shield className="w-3 h-3 text-privacy" />
            <span className="text-caption text-privacy">Vault</span>
          </div>
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-full border bg-privacy/10 border-privacy/20">
            <Shield className="w-3 h-3 text-privacy" />
            <span className="text-caption text-privacy">ZK</span>
          </div>
        </div>
      </div>

      <div className="flex-1 flex flex-col items-center pb-8">
        {/* Widget */}
        <div
          className={cn(
            "bg-card border border-solid border-gray/30 p-4",
            "w-[480px] max-w-[calc(100vw-32px)] rounded-[16px]"
          )}
        >
          {/* Title */}
          <div className="flex items-center gap-3 mb-4 pb-4 border-b border-gray/15">
            <div className="p-2 rounded-[10px] bg-privacy/10 border border-privacy/20">
              <Wallet className="w-5 h-5 text-privacy" />
            </div>
            <div>
              <h1 className="text-heading6 text-foreground">Your Notes</h1>
              <p className="text-caption text-gray">
                View and spend your shielded tokens
              </p>
            </div>
          </div>

          {/* Content with Suspense for searchParams */}
          <div className="min-h-[200px]">
            <Suspense
              fallback={
                <div className="flex items-center justify-center py-8">
                  <div className="w-8 h-8 border-2 border-privacy border-t-transparent rounded-full animate-spin" />
                </div>
              }
            >
              <ActivityContent />
            </Suspense>
          </div>

          {/* Footer inside card */}
          <div className="flex flex-row justify-between items-center gap-2 mt-4 text-gray px-2 pt-4 border-t border-gray/15">
            <a href="/docs" className="hover:text-gray-light transition-colors text-caption">Privacy Coin</a>
            <a href="https://zeusnetwork.xyz/" target="_blank" rel="noopener noreferrer" className="text-caption hover:text-gray-light transition-colors flex items-center gap-1.5">
              Powered by <img src="/zeus_network.svg" alt="Zeus Network" className="w-4 h-4" />Zeus Network
            </a>
          </div>
        </div>
      </div>
    </main>
  );
}
