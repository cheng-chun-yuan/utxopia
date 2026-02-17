"use client";

import { useRouter } from "next/navigation";
import { Clock, Shield, Send, Wallet } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatBtc } from "@/lib/utils/formatting";
import type { InboxNote } from "@/hooks/use-zvault";

interface InboxItemProps {
  note: InboxNote;
  onClaimed?: () => void;
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  const minutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;

  return new Date(timestamp).toLocaleDateString();
}

export function InboxItem({ note }: InboxItemProps) {
  const router = useRouter();

  // Navigate to pay page with note data
  const handleSendPublic = () => {
    const params = new URLSearchParams({
      commitment: note.commitmentHex,
      leafIndex: note.leafIndex.toString(),
      amount: note.amount.toString(),
      mode: "public",
    });
    router.push(`/bridge/pay?${params.toString()}`);
  };

  const handleSendPrivate = () => {
    const params = new URLSearchParams({
      commitment: note.commitmentHex,
      leafIndex: note.leafIndex.toString(),
      amount: note.amount.toString(),
      mode: "stealth",
    });
    router.push(`/bridge/pay?${params.toString()}`);
  };

  return (
    <div
      className={cn(
        "p-4 rounded-[12px] border border-gray/15 bg-muted",
        "hover:border-privacy/40 transition-colors"
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-[6px] bg-privacy/10">
            <Shield className="w-4 h-4 text-privacy" />
          </div>
          <span className="text-body2-semibold text-foreground">
            Stealth Deposit
          </span>
        </div>
        <div className="flex items-center gap-1 text-caption text-gray">
          <Clock className="w-3 h-3" />
          <span>{formatRelativeTime(note.createdAt)}</span>
        </div>
      </div>

      {/* Amount */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className={cn(
            "text-heading5",
            note.isSpent ? "text-gray" : "text-privacy"
          )}>
            {formatBtc(Number(note.amount))} zBTC
          </p>
          <p className="text-caption text-gray">
            {Number(note.amount).toLocaleString()} sats
          </p>
        </div>
        {note.isSpent ? (
          <div className="px-2 py-1 rounded-full bg-gray/10 border border-gray/20">
            <span className="text-caption text-gray">Spent</span>
          </div>
        ) : (
          <div className="px-2 py-1 rounded-full bg-privacy/10 border border-privacy/20">
            <span className="text-caption text-privacy">Spendable</span>
          </div>
        )}
      </div>

      {/* Commitment (truncated) */}
      <div className="p-2 bg-background rounded-[8px] mb-4">
        <p className="text-caption text-gray mb-1">Commitment</p>
        <code className="text-caption font-mono text-gray-light truncate block">
          {note.commitmentHex.slice(0, 16)}...{note.commitmentHex.slice(-16)}
        </code>
      </div>

      {/* Action buttons */}
      {!note.isSpent && (
        <div className="flex gap-2">
          <button
            onClick={handleSendPublic}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-[10px] bg-privacy/10 hover:bg-privacy/20 text-privacy transition-colors"
          >
            <Wallet className="w-4 h-4" />
            To Wallet
          </button>
          <button
            onClick={handleSendPrivate}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-[10px] bg-purple/10 hover:bg-purple/20 text-purple transition-colors"
          >
            <Send className="w-4 h-4" />
            Send Private
          </button>
        </div>
      )}
    </div>
  );
}
