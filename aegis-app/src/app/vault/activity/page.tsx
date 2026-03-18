"use client";

import { useSearchParams } from "next/navigation";
import { useState, useMemo, useEffect, useRef, Suspense } from "react";
import Link from "next/link";
import Image from "next/image";
import {
  Wallet,
  ArrowDownToLine,
  Shield,
  Inbox,
  Link2,
  ChevronDown,
  RefreshCw,
  Eye,
  EyeOff,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatBtc } from "@/lib/utils/formatting";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { ErrorBoundary } from "@/components/error-boundary";
import { BalanceView, useMyDepositCount } from "@/components/btc-widget/balance-view";
import { useAegisKeys, useStealthInbox } from "@/hooks/use-aegis";
import { usePasskey } from "@/hooks/use-passkey";
import { useAegisStore } from "@/stores/aegis-store";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { AuthModal } from "@/components/auth-modal";
import { InboxItem, EmptyInbox } from "@/components/stealth-inbox";

type TabType = "deposits" | "notes";

const tabs: { id: TabType; label: string; icon: React.ReactNode }[] = [
  { id: "deposits", label: "Deposits", icon: <ArrowDownToLine className="w-4 h-4" /> },
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

const WALLET_TOKENS = [
  { symbol: "zkBTC", name: "Shielded Bitcoin", logo: "/zkbtc.png", enabled: true },
  { symbol: "SOL", name: "Solana", logo: "/tokens/sol.png", enabled: true },
  { symbol: "USDC", name: "USD Coin", logo: "/tokens/usdc.png", enabled: true },
  { symbol: "USDT", name: "Tether USD", logo: "/tokens/usdt.png", enabled: true },
];

function TokenList() {
  const { hasKeys } = useAegisKeys();
  const { notes, totalAmountSats, isLoading, error, refresh } = useStealthInbox();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showSpent, setShowSpent] = useState(false);

  const spendableNotes = useMemo(() => notes.filter((n) => !n.isSpent), [notes]);
  const spentNotes = useMemo(() => notes.filter((n) => n.isSpent), [notes]);
  const displayedNotes = showSpent ? notes : spendableNotes;

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
        {WALLET_TOKENS.map((token, i) => {
          const isZkBtc = token.symbol === "zkBTC";
          const isExpanded = expanded === token.symbol;
          const noteCount = isZkBtc ? spendableNotes.length : 0;
          const balance = isZkBtc ? formatBtc(Number(totalAmountSats)) : null;

          return (
            <div key={token.symbol}>
              {/* Token row */}
              <button
                onClick={() => {
                  if (!token.enabled) return;
                  setExpanded(isExpanded ? null : token.symbol);
                }}
                disabled={!token.enabled}
                className={cn(
                  "w-full flex items-center gap-3 px-4 py-3.5 transition-colors",
                  token.enabled
                    ? "hover:bg-muted/50 cursor-pointer"
                    : "opacity-40 cursor-default",
                  i > 0 && "border-t border-gray/10"
                )}
              >
                <Image
                  src={token.logo}
                  alt={token.symbol}
                  width={32}
                  height={32}
                  className="rounded-full"
                />
                <div className="flex-1 min-w-0 text-left">
                  <p className="text-body2-semibold text-foreground">{token.symbol}</p>
                  <p className="text-caption text-gray">{token.name}</p>
                </div>
                {token.enabled ? (
                  <>
                    <div className="text-right mr-2">
                      <p className="text-body2-semibold text-foreground">{balance}</p>
                      {noteCount > 0 && (
                        <p className="text-caption text-gray">
                          {noteCount} note{noteCount !== 1 ? "s" : ""}
                        </p>
                      )}
                    </div>
                    <ChevronDown
                      className={cn(
                        "w-4 h-4 text-gray transition-transform",
                        isExpanded && "rotate-180"
                      )}
                    />
                  </>
                ) : (
                  <span className="text-caption text-gray/60 px-2 py-0.5 rounded-full bg-gray/10">
                    Soon
                  </span>
                )}
              </button>

              {/* Expanded notes section */}
              {isZkBtc && isExpanded && (
                <div className="border-t border-gray/10 bg-muted/30 px-4 py-3">
                  {/* Loading */}
                  {isLoading && (
                    <div className="flex items-center justify-center py-6">
                      <div className="flex items-center gap-2 text-gray">
                        <div className="w-5 h-5 border-2 border-privacy border-t-transparent rounded-full animate-spin" />
                        <span className="text-body2">Scanning...</span>
                      </div>
                    </div>
                  )}

                  {/* Empty */}
                  {!isLoading && notes.length === 0 && (
                    <EmptyInbox hasKeys={true} onRefresh={refresh} />
                  )}

                  {/* Notes */}
                  {!isLoading && notes.length > 0 && (
                    <div className="space-y-3">
                      {/* Show/hide spent toggle */}
                      {spentNotes.length > 0 && (
                        <div className="flex items-center justify-end">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setShowSpent(!showSpent);
                            }}
                            className={cn(
                              "flex items-center gap-1 px-2 py-1 rounded-[6px] text-caption transition-colors",
                              showSpent
                                ? "text-gray-light bg-gray/10"
                                : "text-gray hover:text-gray-light hover:bg-gray/10"
                            )}
                          >
                            {showSpent ? (
                              <EyeOff className="w-3.5 h-3.5" />
                            ) : (
                              <Eye className="w-3.5 h-3.5" />
                            )}
                            {spentNotes.length} Spent
                          </button>
                        </div>
                      )}

                      {displayedNotes.map((note) => (
                        <InboxItem key={note.id} note={note} onClaimed={refresh} />
                      ))}

                      {spendableNotes.length === 0 && !showSpent && spentNotes.length > 0 && (
                        <div className="text-center py-4">
                          <p className="text-body2 text-gray mb-2">No spendable notes</p>
                          <button
                            onClick={() => setShowSpent(true)}
                            className="text-caption text-purple hover:text-purple/80 transition-colors"
                          >
                            Show {spentNotes.length} spent {spentNotes.length === 1 ? "note" : "notes"}
                          </button>
                        </div>
                      )}
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
  const [activeTab, setActiveTab] = useState<TabType>(tabParam || "notes");
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

  // Badge shows spendable notes only (exclude spent)
  const notesCount = notes.filter((n) => !n.isSpent).length;
  const depositCount = useMyDepositCount();

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
          counts={{ deposits: depositCount, notes: notesCount }}
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
          {activeTab === "deposits" && <BalanceView />}
          {activeTab === "notes" && <TokenList />}
        </ErrorBoundary>
      )}
    </>
  );
}

export default function ActivityPage() {
  return (
    <main className="min-h-screen bg-background hacker-bg noise-overlay flex flex-col">
      <SiteHeader />

      {/* Content — centered, grows to push footer down */}
      <div className="flex-1 flex flex-col items-center pt-24 pb-8 px-4">
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
          <div className="min-h-[40vh]">
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

        </div>
      </div>
      <SiteFooter />
    </main>
  );
}
