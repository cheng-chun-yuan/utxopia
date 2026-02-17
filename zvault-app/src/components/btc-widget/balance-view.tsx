"use client";

import React, { useState, useEffect, useCallback, useMemo, memo } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  AlertCircle, RefreshCw, Clock, CheckCircle2, XCircle,
  ExternalLink, Key, Copy, Check, ArrowDownToLine, Loader2, Search, ChevronDown
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getDepositStatusFromMempool } from "@/lib/api/client";
import { formatBtc, truncateMiddle } from "@/lib/utils/formatting";
import { BitcoinIcon } from "@/components/bitcoin-wallet-selector";
import { useNoteStorage, type StoredNote } from "@/hooks/use-note-storage";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import type { DepositStatusResponse, EscrowStatus } from "@/lib/api/types";

// Status badge config
const STATUS_CONFIG: Record<EscrowStatus | "unknown", { label: string; color: string; bg: string; spinning?: boolean }> = {
  waiting_payment: { label: "Awaiting BTC", color: "text-yellow-500", bg: "bg-yellow-500/10" },
  confirming: { label: "Confirming", color: "text-pink-400", bg: "bg-pink-400/10", spinning: true },
  screening: { label: "Screening", color: "text-emerald-400", bg: "bg-emerald-400/10", spinning: true },
  passed: { label: "Ready to Mint", color: "text-green-400", bg: "bg-green-400/10" },
  blocked: { label: "Blocked", color: "text-red-500", bg: "bg-red-500/10" },
  in_custody: { label: "Ready to Mint", color: "text-green-400", bg: "bg-green-400/10" },
  minted: { label: "Minted", color: "text-green-400", bg: "bg-green-400/10" },
  refunded: { label: "Refunded", color: "text-gray-400", bg: "bg-gray-400/10" },
  expired: { label: "Expired", color: "text-gray-400", bg: "bg-gray-400/10" },
  unknown: { label: "Unknown", color: "text-gray-400", bg: "bg-gray-400/10" },
};

const StatusBadge = memo(({ status }: { status: EscrowStatus | "unknown" }) => {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.unknown;
  const Icon = cfg.spinning ? Loader2 : (status === "blocked" || status === "expired" ? XCircle : CheckCircle2);
  return (
    <span className={cn("flex items-center gap-1 text-xs px-2 py-1 rounded-full", cfg.color, cfg.bg)}>
      <Icon className={cn("h-3 w-3", cfg.spinning && "animate-spin")} />
      {cfg.label}
    </span>
  );
});
StatusBadge.displayName = "StatusBadge";

// Progress bar
const ProgressBar = memo(({ current, total }: { current: number; total: number }) => (
  <div className="w-full bg-background rounded-full h-2">
    <div
      className="bg-gradient-to-r from-btc to-btc-light h-2 rounded-full transition-all shadow-[0_0_10px_rgba(247,147,26,0.5)]"
      style={{ width: `${Math.min((current / total) * 100, 100)}%` }}
    />
  </div>
));
ProgressBar.displayName = "ProgressBar";

// Deposit card
const DepositCard = memo(({ note, status, onRefresh, isRefreshing }: {
  note: StoredNote;
  status: DepositStatusResponse | null;
  onRefresh: () => void;
  isRefreshing: boolean;
}) => {
  const { copied, copy } = useCopyToClipboard();
  const escrowStatus = (status?.escrow_status as EscrowStatus) || "waiting_payment";

  return (
    <div className="p-4 bg-muted border border-gray/15 rounded-xl space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-sm text-white flex items-center gap-2">
          <BitcoinIcon className="w-4 h-4" />
          {formatBtc(note.amountSats)} BTC
        </span>
        <div className="flex items-center gap-2">
          <button onClick={onRefresh} disabled={isRefreshing} className="p-1.5 rounded bg-gray/10 hover:bg-gray/20">
            <RefreshCw className={cn("w-3 h-3 text-gray", isRefreshing && "animate-spin")} />
          </button>
          <StatusBadge status={escrowStatus} />
        </div>
      </div>

      {/* Address */}
      <div className="space-y-1">
        <span className="text-xs text-gray">Deposit Address</span>
        <div className="flex items-center gap-2">
          <code className="flex-1 text-xs font-mono text-orange-500 break-all">{note.taprootAddress}</code>
          <button onClick={() => copy(note.taprootAddress)} className="p-1.5 rounded bg-orange-500/10 hover:bg-orange-500/20">
            {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 text-orange-500" />}
          </button>
        </div>
      </div>

      {/* Secret indicator */}
      {note.secretNote && (
        <div className="flex items-center gap-2 text-xs">
          <Key className="w-3 h-3 text-emerald-400" />
          <span className="text-gray">Secret saved locally</span>
        </div>
      )}

      {/* Confirmations */}
      {status?.btc_txid && (
        <div className="space-y-2 pt-2 border-t border-gray/15">
          <div className="flex justify-between text-xs">
            <span className="text-gray">Confirmations</span>
            <span className="text-gray-light">{status.confirmations} / {status.required_confirmations}</span>
          </div>
          <ProgressBar current={status.confirmations} total={status.required_confirmations} />
          <a
            href={`https://mempool.space/testnet/tx/${status.btc_txid}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs text-orange-500 hover:text-orange-400"
          >
            View transaction <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      )}

      {/* Mempool link */}
      <a
        href={`https://mempool.space/testnet/address/${note.taprootAddress}`}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center justify-center gap-2 text-xs text-gray hover:text-gray-light pt-2"
      >
        View on Mempool <ExternalLink className="w-3 h-3" />
      </a>
    </div>
  );
});
DepositCard.displayName = "DepositCard";

export function BalanceView() {
  const { publicKey, connected } = useWallet();
  const { notes, isLoaded } = useNoteStorage();

  const [mounted, setMounted] = useState(false);
  const [depositStatuses, setDepositStatuses] = useState<Record<string, DepositStatusResponse>>({});
  const [refreshing, setRefreshing] = useState<Set<string>>(new Set());

  // Address lookup (collapsed by default)
  const [showLookup, setShowLookup] = useState(false);
  const [lookupAddress, setLookupAddress] = useState("");
  const [lookupResult, setLookupResult] = useState<DepositStatusResponse | null>(null);
  const [isLooking, setIsLooking] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  useEffect(() => { setMounted(true); }, []);

  const fetchStatus = useCallback(async (commitment: string, address: string) => {
    setRefreshing(prev => new Set(prev).add(commitment));
    try {
      const status = await getDepositStatusFromMempool(address);
      setDepositStatuses(prev => ({ ...prev, [commitment]: status }));
    } catch (err) {
      console.error(`Failed to fetch status:`, err);
    } finally {
      setRefreshing(prev => { const next = new Set(prev); next.delete(commitment); return next; });
    }
  }, []);

  const fetchAll = useCallback(async () => {
    for (const note of notes) await fetchStatus(note.commitment, note.taprootAddress);
  }, [notes, fetchStatus]);

  useEffect(() => {
    if (isLoaded && notes.length > 0) fetchAll();
  }, [isLoaded, notes.length, fetchAll]);

  const handleLookup = useCallback(async () => {
    if (!lookupAddress.trim() || (!lookupAddress.startsWith("tb1p") && !lookupAddress.startsWith("bc1p"))) {
      setLookupError("Enter a valid taproot address (tb1p... or bc1p...)");
      return;
    }
    setLookupError(null);
    setIsLooking(true);
    try {
      const status = await getDepositStatusFromMempool(lookupAddress.trim());
      setLookupResult(status);
    } catch (err) {
      setLookupError(err instanceof Error ? err.message : "Lookup failed");
    } finally {
      setIsLooking(false);
    }
  }, [lookupAddress]);

  const sortedNotes = useMemo(() => [...notes].sort((a, b) => b.createdAt - a.createdAt), [notes]);

  if (!mounted || !isLoaded) {
    return (
      <div className="flex flex-col items-center py-12">
        <div className="w-12 h-12 mb-4 border-4 border-gray/15 border-t-pink-400 rounded-full animate-spin" />
        <p className="text-sm text-gray">Loading...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ArrowDownToLine className="w-5 h-5 text-orange-500" />
          <p className="text-lg font-semibold text-white">Bitcoin Deposits</p>
        </div>
        {notes.length > 0 && (
          <button onClick={fetchAll} disabled={refreshing.size > 0} className="p-2 rounded-lg bg-muted border border-gray/15 hover:bg-card">
            <RefreshCw className={cn("h-4 w-4 text-gray", refreshing.size > 0 && "animate-spin")} />
          </button>
        )}
      </div>

      {/* Wallet connection */}
      {connected && publicKey && (
        <div className="flex items-center gap-2 p-2 bg-emerald-500/10 border border-emerald-500/30 rounded-lg">
          <div className="w-2 h-2 rounded-full bg-emerald-400" />
          <span className="text-xs text-emerald-400">Solana: {truncateMiddle(publicKey.toBase58(), 6)}</span>
        </div>
      )}

      {/* Deposit cards */}
      {sortedNotes.length > 0 ? (
        <div className="space-y-3">
          {sortedNotes.map((note, index) => (
            <DepositCard
              key={`${note.commitment}-${index}`}
              note={note}
              status={depositStatuses[note.commitment] || null}
              onRefresh={() => fetchStatus(note.commitment, note.taprootAddress)}
              isRefreshing={refreshing.has(note.commitment)}
            />
          ))}
        </div>
      ) : (
        <div className="text-center py-8">
          <div className="rounded-full bg-orange-500/10 p-4 w-fit mx-auto mb-4">
            <BitcoinIcon className="h-8 w-8" />
          </div>
          <p className="text-sm text-gray">No deposits yet</p>
          <p className="text-xs text-gray/40 mt-1">Create a deposit to see your Bitcoin activity</p>
        </div>
      )}

      {/* Simple address lookup */}
      <div className="border-t border-gray/15 pt-4">
        <button onClick={() => setShowLookup(!showLookup)} className="flex items-center justify-between w-full">
          <div className="flex items-center gap-2">
            <Search className="w-4 h-4 text-orange-500" />
            <span className="text-sm text-gray-light">Check Address Status</span>
          </div>
          <ChevronDown className={cn("w-4 h-4 text-gray transition-transform", showLookup && "rotate-180")} />
        </button>

        {showLookup && (
          <div className="mt-3 space-y-3">
            <input
              type="text"
              value={lookupAddress}
              onChange={(e) => setLookupAddress(e.target.value)}
              placeholder="tb1p... or bc1p..."
              className="w-full p-2.5 bg-muted border border-gray/15 rounded-lg text-xs font-mono text-white placeholder:text-gray/40 outline-none focus:border-orange-500/50"
            />
            {lookupError && (
              <div className="flex items-center gap-2 p-2 bg-red-500/10 border border-red-500/30 rounded-lg text-red-500 text-xs">
                <AlertCircle className="w-3.5 h-3.5" /> {lookupError}
              </div>
            )}
            <button
              onClick={handleLookup}
              disabled={isLooking || !lookupAddress.trim()}
              className="w-full p-2.5 rounded-lg text-xs font-medium bg-orange-500/10 border border-orange-500/30 text-orange-500 hover:bg-orange-500/20 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {isLooking ? <><Loader2 className="w-4 h-4 animate-spin" /> Checking...</> : <><Search className="w-4 h-4" /> Check Status</>}
            </button>

            {lookupResult && (
              <div className="p-3 bg-muted border border-gray/15 rounded-lg space-y-2">
                <div className="flex justify-between">
                  <span className="text-xs text-gray">Status</span>
                  <StatusBadge status={lookupResult.escrow_status || "unknown"} />
                </div>
                {lookupResult.found && lookupResult.amount_sats && (
                  <div className="flex justify-between">
                    <span className="text-xs text-gray">Amount</span>
                    <span className="text-xs text-orange-500">{formatBtc(lookupResult.amount_sats)} BTC</span>
                  </div>
                )}
                {lookupResult.btc_txid && (
                  <a
                    href={`https://mempool.space/testnet/tx/${lookupResult.btc_txid}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-xs text-orange-500"
                  >
                    View tx <ExternalLink className="w-3 h-3" />
                  </a>
                )}
                <button onClick={() => { setLookupResult(null); setLookupAddress(""); }} className="text-xs text-gray hover:text-gray-light">
                  Clear
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
