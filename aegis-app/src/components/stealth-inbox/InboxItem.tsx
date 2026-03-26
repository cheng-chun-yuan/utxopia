"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, Copy, Check, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { InboxNote } from "@/hooks/use-aegis";
import { SUPPORTED_TOKENS, type SupportedToken } from "@/lib/supported-tokens";
import { useTokenPrices } from "@/hooks/use-btc-price";

function getTokenForNote(note: InboxNote): SupportedToken {
  const sym = note.tokenSymbol;
  if (sym) {
    const found = SUPPORTED_TOKENS.find(
      (t) => t.shieldedSymbol === sym || t.symbol === sym
    );
    if (found) return found;
  }
  return SUPPORTED_TOKENS[0]; // default: BTC
}

function formatNoteAmount(amount: bigint | number, token: SupportedToken): string {
  const num = Number(amount) / 10 ** token.decimals;
  const maxDecimals = token.decimals > 2 ? token.decimals : 2;
  const formatted = num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: maxDecimals });
  return formatted.replace(/(\.\d{2,}?)0+$/, "$1");
}

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

function formatFullDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  }) + " \u00B7 " + new Date(timestamp).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export function InboxItem({ note }: InboxItemProps) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const token = getTokenForNote(note);
  const tokenPrices = useTokenPrices();
  const price = tokenPrices[token.priceKey];
  const usdValue = price ? (Number(note.amount) / 10 ** token.decimals) * price : 0;

  const handleSend = () => {
    const params = new URLSearchParams({
      commitment: note.commitmentHex,
      leafIndex: note.leafIndex.toString(),
      amount: note.amount.toString(),
    });
    router.push(`/vault/pay?${params.toString()}`);
  };

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(note.commitmentHex);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      onClick={() => setExpanded(!expanded)}
      className={cn(
        "rounded-[10px] border border-gray/15 bg-muted transition-colors cursor-pointer",
        expanded && "border-gray/25",
        !note.isSpent && "hover:border-privacy/30"
      )}
    >
      {/* Collapsed row */}
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        {/* Arrow indicator */}
        <div className={cn(
          "w-5 h-5 rounded-full flex items-center justify-center shrink-0",
          note.isSpent ? "bg-gray/10" : "bg-privacy/10"
        )}>
          <ArrowDown className={cn(
            "w-3 h-3",
            note.isSpent ? "text-gray" : "text-privacy"
          )} />
        </div>

        {/* Time */}
        <span className="text-xs text-gray/60 flex-1">
          {formatRelativeTime(note.createdAt)}
        </span>

        {/* Amount */}
        <p className={cn(
          "text-sm font-semibold font-mono tabular-nums shrink-0",
          note.isSpent ? "text-gray" : "text-privacy"
        )}>
          {formatNoteAmount(note.amount, token)}
        </p>
      </div>

      {/* Expanded detail panel */}
      {expanded && (
        <div className="px-3 pb-3 pt-0">
          <div className="border-t border-gray/10 pt-2.5 space-y-1.5">
            {/* USD value */}
            {usdValue > 0 && (
              <p className="text-xs text-gray/60 font-mono tabular-nums">
                ${usdValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
            )}

            {/* Timestamp */}
            <p className="text-xs text-gray/50">
              {formatFullDate(note.createdAt)}
            </p>

            {/* Commitment + Copy + Send */}
            <div className="flex items-center gap-2">
              <code className="text-[10px] font-mono text-gray/50 truncate flex-1">
                {note.commitmentHex.slice(0, 12)}...{note.commitmentHex.slice(-8)}
              </code>
              <button
                onClick={handleCopy}
                className="p-1 rounded hover:bg-gray/10 transition-colors shrink-0"
              >
                {copied
                  ? <Check className="w-3 h-3 text-privacy" />
                  : <Copy className="w-3 h-3 text-gray/50" />
                }
              </button>
              {!note.isSpent && (
                <button
                  onClick={(e) => { e.stopPropagation(); handleSend(); }}
                  className="flex items-center gap-1 px-2 py-1 rounded-[6px] bg-privacy/10 text-privacy text-xs font-medium hover:bg-privacy/20 transition-colors shrink-0"
                >
                  Send <ArrowRight className="w-3 h-3" />
                </button>
              )}
              {note.isSpent && (
                <span className="text-[10px] text-gray/40 px-1.5 py-0.5 rounded-full bg-gray/8">
                  Spent
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
