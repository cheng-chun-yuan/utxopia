"use client";

import { useSearchParams } from "next/navigation";
import { useState, useEffect, useRef, Suspense } from "react";
import Link from "next/link";
import {
  Wallet,
  ArrowDownToLine,
  Shield,
  Inbox,
  Link2,
  EyeOff,
} from "lucide-react";
import { cn } from "@/lib/utils";
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
import { InboxList, EmptyInbox } from "@/components/stealth-inbox";

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

function BalanceBar() {
  const { totalAmountSats, depositCount } = useStealthInbox();
  const { keys } = useAegisKeys();

  if (!keys) return null;

  const privateBtc = (Number(totalAmountSats) / 1e8).toFixed(8);

  return (
    <div className="flex items-center gap-3 p-3 rounded-[12px] bg-privacy/8 border border-privacy/15">
      <div className="p-2 rounded-[8px] bg-privacy/15">
        <EyeOff className="w-4 h-4 text-privacy" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[10px] text-gray uppercase tracking-wider">Private zkBTC</p>
        <p className="text-[20px] font-bold text-privacy tracking-tight">{privateBtc}</p>
      </div>
      {depositCount > 0 && (
        <span className="text-caption text-gray/60">
          {depositCount} note{depositCount !== 1 ? "s" : ""}
        </span>
      )}
    </div>
  );
}

function NotesTab() {
  const { hasKeys } = useAegisKeys();
  const { notes, isLoading, error, refresh } = useStealthInbox();

  return (
    <div className="space-y-4">
      {/* Balance bar */}
      <BalanceBar />

      {/* Claim with Link button — only show when logged in */}
      {hasKeys && (
        <Link
          href="/claim"
          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-[12px] bg-sol/10 border border-sol/20 text-sol hover:bg-sol/20 transition-colors"
        >
          <Link2 className="w-4 h-4" />
          Claim with Link
        </Link>
      )}

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
            <span className="text-body2">Checking for incoming deposits...</span>
          </div>
        </div>
      )}

      {/* Empty or no keys — handled by parent ActivityContent */}
      {!isLoading && hasKeys && notes.length === 0 && (
        <EmptyInbox hasKeys={true} onRefresh={refresh} />
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
          {activeTab === "notes" && <NotesTab />}
        </ErrorBoundary>
      )}
    </>
  );
}

export default function ActivityPage() {
  return (
    <main className="min-h-screen bg-background hacker-bg noise-overlay flex flex-col items-center pt-24 pb-8 px-4">
      <SiteHeader />

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
              View and spend your private zkBTC notes
            </p>
          </div>
        </div>

        {/* Content with Suspense for searchParams — min height keeps footer at bottom */}
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
      <SiteFooter />
    </main>
  );
}
