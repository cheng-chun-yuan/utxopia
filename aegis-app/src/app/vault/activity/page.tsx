"use client";

import { useState, useMemo, useEffect, useRef, Suspense } from "react";
import Link from "next/link";
import {
  ArrowDownToLine,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  Shield,
  ExternalLink,
  Copy,
  Check,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ErrorBoundary } from "@/components/error-boundary";
import { useAegisKeys, useStealthInbox } from "@/hooks/use-aegis";
import { usePasskey } from "@/hooks/use-passkey";
import { useAegisStore } from "@/stores/aegis-store";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { AuthModal } from "@/components/auth-modal";
import { EmptyInbox } from "@/components/stealth-inbox";

import { SUPPORTED_TOKENS, type SupportedToken } from "@/lib/supported-tokens";
import { useTokenPrices } from "@/hooks/use-btc-price";
import type { InboxNote } from "@/stores/aegis-store";

function getToken(sym: string): SupportedToken {
  return SUPPORTED_TOKENS.find(t => t.shieldedSymbol === sym || t.symbol === sym) || SUPPORTED_TOKENS[0];
}

function formatAmt(amount: bigint | number, token: SupportedToken): string {
  const num = Number(amount) / 10 ** token.decimals;
  return num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDateKey(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function formatFullDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }) + " \u00B7 " + new Date(ts).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

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

function ActivityRow({ note }: { note: InboxNote }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const tokenPrices = useTokenPrices();
  const token = getToken(note.tokenSymbol);
  const price = tokenPrices[token.priceKey];
  const usdValue = price ? (Number(note.amount) / 10 ** token.decimals) * price : 0;
  const isReceived = !note.isSpent;

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(note.commitmentHex);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div>
      {/* Collapsed row */}
      <div
        onClick={() => setExpanded(!expanded)}
        className={cn(
          "flex items-center gap-2.5 px-4 py-3 transition-colors cursor-pointer",
          expanded ? "bg-muted/50" : "hover:bg-muted/40"
        )}
      >
        {/* Arrow indicator */}
        <div className={cn(
          "w-6 h-6 rounded-full flex items-center justify-center shrink-0",
          isReceived ? "bg-privacy/10" : "bg-gray/10"
        )}>
          {isReceived
            ? <ArrowDown className="w-3.5 h-3.5 text-privacy" />
            : <ArrowUp className="w-3.5 h-3.5 text-gray" />
          }
        </div>

        {/* Label + time */}
        <div className="flex-1 min-w-0">
          <span className="text-sm text-foreground font-medium">
            {isReceived ? "Received" : "Sent"}
          </span>
          <p className="text-[11px] text-gray/40">{timeAgo(note.createdAt)}</p>
        </div>

        {/* Amount + token */}
        <div className="text-right shrink-0">
          <p className={cn(
            "text-sm font-semibold font-mono tabular-nums",
            isReceived ? "text-privacy" : "text-gray"
          )}>
            {isReceived ? "+" : "-"}{formatAmt(note.amount, token)}{" "}
            <span className="text-xs font-medium">{token.shieldedSymbol}</span>
          </p>
          {usdValue > 0 && (
            <p className="text-[11px] text-gray/45 font-mono tabular-nums">
              ${usdValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          )}
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-4 pb-3 bg-muted/30">
          <div className="border-t border-gray/10 pt-2.5 space-y-2">
            {/* Detail rows */}
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
              <span className="text-gray/40">Type</span>
              <span className="text-foreground font-medium">
                {isReceived ? "Shielded Deposit" : "Private Transfer"}
              </span>

              <span className="text-gray/40">Token</span>
              <div className="flex items-center gap-1.5">
                <img src={token.shieldedLogo} alt={token.shieldedSymbol} className="w-4 h-4 rounded-full" />
                <span className="text-foreground">{token.shieldedSymbol}</span>
                <span className="text-gray/40">({token.name})</span>
              </div>

              <span className="text-gray/40">Amount</span>
              <span className={cn("font-mono tabular-nums", isReceived ? "text-privacy" : "text-gray")}>
                {formatAmt(note.amount, token)} {token.shieldedSymbol}
                {usdValue > 0 && <span className="text-gray/40 ml-1.5">(${usdValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })})</span>}
              </span>

              <span className="text-gray/40">Time</span>
              <span className="text-gray/60">{formatFullDate(note.createdAt)}</span>

              <span className="text-gray/40">Leaf</span>
              <span className="text-gray/60 font-mono">#{note.leafIndex}</span>

              <span className="text-gray/40">Commitment</span>
              <div className="flex items-center gap-1 min-w-0">
                <code className="text-[10px] font-mono text-gray/50 truncate">
                  {note.commitmentHex.slice(0, 12)}...{note.commitmentHex.slice(-8)}
                </code>
                <button
                  onClick={handleCopy}
                  className="p-0.5 rounded hover:bg-gray/10 transition-colors shrink-0"
                >
                  {copied
                    ? <Check className="w-2.5 h-2.5 text-privacy" />
                    : <Copy className="w-2.5 h-2.5 text-gray/40" />
                  }
                </button>
              </div>
            </div>

            {/* Explorer link */}
            <div className="pt-1">
              <Link
                href={`/explorer`}
                className="inline-flex items-center gap-1 text-[11px] text-privacy hover:text-privacy/80 transition-colors"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink className="w-3 h-3" />
                View in Explorer
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ActivityFeed() {
  const { notes, isLoading, refresh } = useStealthInbox();

  // Sort by createdAt descending, then group by date
  const grouped = useMemo(() => {
    const sorted = [...notes].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const groups: { date: string; notes: typeof sorted }[] = [];
    for (const note of sorted) {
      const dateKey = formatDateKey(note.createdAt);
      const last = groups[groups.length - 1];
      if (last && last.date === dateKey) {
        last.notes.push(note);
      } else {
        groups.push({ date: dateKey, notes: [note] });
      }
    }
    return groups;
  }, [notes]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <span className="text-caption text-gray/50">{notes.length} transaction{notes.length !== 1 ? "s" : ""}</span>
        <button
          onClick={refresh}
          disabled={isLoading}
          className="flex items-center gap-1 px-2 py-1 rounded-[6px] text-caption text-gray hover:text-gray-light hover:bg-gray/10 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={cn("w-3.5 h-3.5", isLoading && "animate-spin")} />
        </button>
      </div>

      {isLoading && notes.length === 0 && (
        <div className="flex items-center justify-center py-6">
          <div className="w-6 h-6 border-2 border-privacy border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {notes.length === 0 && !isLoading && (
        <div className="text-center py-6">
          <Shield className="w-8 h-8 text-gray/20 mx-auto mb-2" />
          <p className="text-sm text-gray/50">No activity yet</p>
          <p className="text-xs text-gray/30 mt-1">Deposits and transfers will appear here</p>
        </div>
      )}

      {grouped.map(({ date, notes: groupNotes }) => (
        <div key={date}>
          <p className="text-xs text-gray/50 font-medium px-1 mb-1.5">{date}</p>
          <div className="rounded-[12px] border border-gray/10 overflow-hidden divide-y divide-gray/8">
            {groupNotes.map((note) => (
              <ActivityRow key={note.id} note={note} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ActivityContent() {
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

  return (
    <>
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

      {/* Activity feed — only when keys available */}
      {hasKeys && (
        <ErrorBoundary>
          <ActivityFeed />
        </ErrorBoundary>
      )}
    </>
  );
}

export default function ActivityPage() {
  return (
    <main className="min-h-screen bg-background hacker-bg noise-overlay flex flex-col items-center py-8 px-4 sm:py-12">
      {/* Header — Back + Badges */}
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
              <ArrowDownToLine className="w-5 h-5 text-privacy" />
            </div>
            <div>
              <h1 className="text-heading6 text-foreground">Activity</h1>
              <p className="text-caption text-gray">
                Your shielded transaction history
              </p>
            </div>
          </div>

          {/* Content with Suspense */}
          <Suspense fallback={<div className="flex items-center justify-center py-8"><div className="w-6 h-6 border-2 border-privacy border-t-transparent rounded-full animate-spin" /></div>}>
            <ActivityContent />
          </Suspense>

          {/* Footer inside card */}
          <div className="flex flex-row justify-between items-center gap-2 mt-2 text-gray px-2 pt-2">
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
