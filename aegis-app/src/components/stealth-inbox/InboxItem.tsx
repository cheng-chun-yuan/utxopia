"use client";

import { useRouter } from "next/navigation";
import { Clock, Shield, Bitcoin } from "lucide-react";
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

export function InboxItem({ note }: InboxItemProps) {
  const router = useRouter();
  const token = getTokenForNote(note);
  const tokenPrices = useTokenPrices();
  const price = tokenPrices[token.priceKey];
  const usdValue = price ? (Number(note.amount) / 10 ** token.decimals) * price : 0;

  // Click entire card to navigate to pay page
  const handleClick = () => {
    if (note.isSpent) return;
    const params = new URLSearchParams({
      commitment: note.commitmentHex,
      leafIndex: note.leafIndex.toString(),
      amount: note.amount.toString(),
    });
    router.push(`/vault/pay?${params.toString()}`);
  };

  return (
    <div
      onClick={handleClick}
      className={cn(
        "px-3 py-2.5 rounded-[10px] border border-gray/15 bg-muted transition-colors",
        !note.isSpent && "hover:border-privacy/40 cursor-pointer"
      )}
    >
      {/* Single-row: icon + time | amount */}
      <div className="flex items-center gap-2">
        {/* Left: icon + time + commitment */}
        <div className="p-1 rounded-[5px] bg-privacy/10">
          <Shield className="w-3.5 h-3.5 text-privacy" />
        </div>
        <div className="flex-1 min-w-0">
          <span className="text-[10px] text-gray flex items-center gap-0.5">
            <Clock className="w-2.5 h-2.5" />
            {formatRelativeTime(note.createdAt)}
          </span>
          <code className="text-[10px] font-mono text-gray/60 block truncate">
            {note.commitmentHex.slice(0, 10)}...{note.commitmentHex.slice(-8)}
          </code>
        </div>

        {/* Right: amount styled like parent token row */}
        <div className="text-right shrink-0">
          <p className={cn(
            "text-sm font-semibold font-mono leading-tight tabular-nums",
            note.isSpent ? "text-gray" : "text-privacy"
          )}>
            {formatNoteAmount(note.amount, token)}
          </p>
          {usdValue > 0 && (
            <p className="text-caption text-gray font-mono tabular-nums">
              ${usdValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
