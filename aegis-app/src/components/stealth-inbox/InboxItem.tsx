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
      {/* Single-row: icon + label + time | amount + badge */}
      <div className="flex items-center gap-2">
        {/* Left: icon + label + time */}
        <div className="p-1 rounded-[5px] bg-privacy/10">
          <Shield className="w-3.5 h-3.5 text-privacy" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-caption text-foreground font-medium">Stealth Deposit</span>
            <span className="text-[10px] text-gray flex items-center gap-0.5">
              <Clock className="w-2.5 h-2.5" />
              {formatRelativeTime(note.createdAt)}
            </span>
          </div>
          <code className="text-[10px] font-mono text-gray/60 block truncate">
            {note.commitmentHex.slice(0, 10)}...{note.commitmentHex.slice(-8)}
          </code>
        </div>

        {/* Right: amount + badge */}
        <div className="text-right shrink-0">
          <p className={cn(
            "text-body2-semibold font-mono leading-tight",
            note.isSpent ? "text-gray" : "text-privacy"
          )}>
            {formatNoteAmount(note.amount, token)}
          </p>
          {usdValue > 0 ? (
            <p className="text-[10px] text-gray font-mono">
              ${usdValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          ) : (
            <span className={cn(
              "text-[10px] px-1.5 py-0.5 rounded-full inline-block",
              note.isSpent ? "bg-gray/10 text-gray" : "bg-privacy/10 text-privacy"
            )}>
              {note.isSpent ? "Spent" : "Spendable"}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
