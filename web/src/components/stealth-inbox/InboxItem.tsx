"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, Copy, Check, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { InboxNote } from "@/hooks/use-privacy-coin";
import { SUPPORTED_TOKENS, getTokenBySymbol, type SupportedToken } from "@/lib/supported-tokens";
import { useTokenPrices } from "@/hooks/use-token-prices";

function getTokenForNote(note: InboxNote): SupportedToken {
  const sym = note.tokenSymbol;
  if (sym) {
    const found = getTokenBySymbol(sym);
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
        expanded && "border-privacy/25 bg-muted/80",
        !note.isSpent && "hover:border-privacy/30"
      )}
    >
      {/* Collapsed row */}
      <div className="flex items-center gap-2 px-3 py-2.5">
        {/* Dot indicator */}
        <div className={cn(
          "w-1.5 h-1.5 rounded-full shrink-0",
          note.isSpent ? "bg-gray/30" : "bg-privacy"
        )} />

        {/* Time */}
        <span className="text-xs text-gray/50 flex-1">
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
        <div className="px-3 pb-2.5">
          <div className="border-t border-gray/10 pt-2 flex items-center justify-between gap-3">
            {/* Left: metadata stack */}
            <div className="min-w-0 space-y-0.5">
              {usdValue > 0 && (
                <p className="text-xs text-gray/50 font-mono tabular-nums">
                  ${usdValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>
              )}
              <p className="text-[11px] text-gray/40">
                {formatFullDate(note.createdAt)}
              </p>
              <div className="flex items-center gap-1">
                <code className="text-[10px] font-mono text-gray/35 truncate">
                  {note.commitmentHex.slice(0, 10)}...{note.commitmentHex.slice(-6)}
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

            {/* Right: action */}
            {!note.isSpent && (
              <button
                onClick={(e) => { e.stopPropagation(); handleSend(); }}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-[8px] bg-privacy/10 text-privacy text-xs font-medium hover:bg-privacy/20 transition-colors shrink-0"
              >
                Send <ArrowRight className="w-3 h-3" />
              </button>
            )}
            {note.isSpent && (
              <span className="text-[10px] text-gray/35 px-2 py-1 rounded-full bg-gray/8 shrink-0">
                Spent
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
