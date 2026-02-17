"use client";

import { useSearchParams } from "next/navigation";
import { useState, useEffect, Suspense } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Wallet,
  ArrowDownToLine,
  Shield,
  Inbox,
  Link2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ErrorBoundary } from "@/components/error-boundary";
import { BalanceView } from "@/components/btc-widget/balance-view";
import { useZVaultKeys, useStealthInbox } from "@/hooks/use-zvault";
import { InboxList, EmptyInbox } from "@/components/stealth-inbox";

type TabType = "deposits" | "notes";

const tabs: { id: TabType; label: string; icon: React.ReactNode }[] = [
  { id: "deposits", label: "Deposits", icon: <ArrowDownToLine className="w-4 h-4" /> },
  { id: "notes", label: "Notes", icon: <Inbox className="w-4 h-4" /> },
];

function TabBar({
  activeTab,
  onTabChange,
  claimableCount,
}: {
  activeTab: TabType;
  onTabChange: (tab: TabType) => void;
  claimableCount: number;
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
          {tab.id === "notes" && claimableCount > 0 && (
            <span className="min-w-[22px] h-[22px] px-2 flex items-center justify-center text-sm rounded-full bg-privacy text-background font-bold">
              {claimableCount}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function NotesTab() {
  const { hasKeys, deriveKeys, isLoading: keysLoading } = useZVaultKeys();
  const { notes, isLoading, error, refresh } = useStealthInbox();

  return (
    <div className="space-y-4">
      {/* Claim with Link button */}
      <Link
        href="/claim"
        className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-[12px] bg-sol/10 border border-sol/20 text-sol hover:bg-sol/20 transition-colors"
      >
        <Link2 className="w-4 h-4" />
        Claim with Link
      </Link>

      {/* Error state */}
      {error && (
        <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Loading state */}
      {isLoading && hasKeys && (
        <div className="flex items-center justify-center py-8">
          <div className="flex items-center gap-2 text-gray">
            <div className="w-5 h-5 border-2 border-privacy border-t-transparent rounded-full animate-spin" />
            <span className="text-body2">Scanning announcements...</span>
          </div>
        </div>
      )}

      {/* Empty or no keys */}
      {!isLoading && (notes.length === 0 || !hasKeys) && (
        <EmptyInbox hasKeys={hasKeys} onDeriveKeys={deriveKeys} onRefresh={refresh} isLoading={keysLoading} />
      )}

      {/* Inbox list - show ALL notes (spent and spendable) */}
      {!isLoading && hasKeys && notes.length > 0 && (
        <InboxList notes={notes} isLoading={isLoading} onRefresh={refresh} />
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

  // Badge shows total notes count
  const notesCount = notes.length;

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
          claimableCount={notesCount}
        />
      </div>

      {/* Tab Content */}
      <ErrorBoundary>
        {activeTab === "deposits" && <BalanceView />}
        {activeTab === "notes" && <NotesTab />}
      </ErrorBoundary>
    </>
  );
}

export default function ActivityPage() {
  return (
    <main className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
      {/* Header */}
      <div className="w-full max-w-[480px] mb-4 flex items-center justify-between">
        <Link
          href="/bridge"
          className="inline-flex items-center gap-2 text-body2 text-gray hover:text-gray-light transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </Link>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-privacy/10 border border-privacy/20">
            <Wallet className="w-3 h-3 text-privacy" />
            <span className="text-caption text-privacy">Notes</span>
          </div>
        </div>
      </div>

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
              View and spend your private zBTC notes
            </p>
          </div>
        </div>

        {/* Content with Suspense for searchParams */}
        <Suspense
          fallback={
            <div className="flex items-center justify-center py-8">
              <div className="w-8 h-8 border-2 border-privacy border-t-transparent rounded-full animate-spin" />
            </div>
          }
        >
          <ActivityContent />
        </Suspense>

        {/* Footer */}
        <div className="flex flex-row justify-between items-center gap-2 mt-4 text-gray px-2 pt-4 border-t border-gray/15">
          <div className="flex flex-row items-center gap-4">
            <a
              href="https://zVault.xyz"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-gray-light transition-colors text-caption"
            >
              zVault
            </a>
            <a
              href="https://github.com/cheng-chun-yuan/zVault"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-gray-light transition-colors text-caption"
            >
              GitHub
            </a>
          </div>
          <p className="text-caption">Powered by zVault</p>
        </div>
      </div>
    </main>
  );
}
