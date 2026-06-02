"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { VAULT_TOKENS } from "@/lib/supported-tokens";
import type { RecipientType } from "./recipient-detect";

export interface TokenSourcePickerProps {
  recipientType: RecipientType | "claim_link" | null;
  selected: string;
  onSelect: (symbol: string) => void;
  className?: string;
}

function allowedFor(recipientType: TokenSourcePickerProps["recipientType"]) {
  if (recipientType === "btc") {
    return VAULT_TOKENS.filter((t) => t.shieldedSymbol === "zkBTC");
  }
  // stealth_sns | stealth_meta | spl_wallet | claim_link | null → any vault token
  return VAULT_TOKENS;
}

export function TokenSourcePicker({
  recipientType,
  selected,
  onSelect,
  className,
}: TokenSourcePickerProps) {
  const [open, setOpen] = useState(false);
  const tokens = allowedFor(recipientType);
  const disabled = recipientType === "btc";
  const current = tokens.find((t) => t.shieldedSymbol === selected) ?? tokens[0];

  return (
    <div className={cn("relative", className)}>
      <label className="block text-xs text-muted-foreground mb-1.5">From</label>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "w-full flex items-center justify-between px-3 py-2.5 rounded-lg",
          "bg-muted/40 border border-gray/15 text-sm",
          disabled && "opacity-60 cursor-not-allowed",
          !disabled && "hover:border-privacy/30",
        )}
        title={
          disabled
            ? "Bitcoin addresses can only receive zkBTC. To send other tokens, use a chain wallet or private address."
            : undefined
        }
      >
        <span className="flex items-center gap-2">
          <span className="font-medium">
            {current?.shieldedSymbol ?? "zkBTC"}
          </span>
          <span className="text-muted-foreground text-xs">
            {current?.name ?? "Bitcoin"}
          </span>
        </span>
        {!disabled && <ChevronDown className="w-4 h-4 text-muted-foreground" />}
      </button>

      {open && !disabled && (
        <div className="absolute z-10 mt-1 w-full bg-background border border-gray/20 rounded-lg shadow-lg overflow-hidden">
          {tokens.map((t) => (
            <button
              key={t.shieldedSymbol}
              type="button"
              onClick={() => {
                onSelect(t.shieldedSymbol);
                setOpen(false);
              }}
              className={cn(
                "w-full text-left px-3 py-2 flex items-center gap-2 text-sm",
                "hover:bg-muted/60",
                t.shieldedSymbol === selected && "bg-privacy/10 text-privacy",
              )}
            >
              <span className="font-medium">{t.shieldedSymbol}</span>
              <span className="text-muted-foreground text-xs">{t.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
