"use client";

import type { RefObject } from "react";
import Image from "next/image";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SHIELD_TOKENS } from "@/lib/supported-tokens";

type ShieldToken = (typeof SHIELD_TOKENS)[number];

interface TokenSelectorProps {
  selectedToken: ShieldToken;
  availableTokens: readonly ShieldToken[];
  dropdownOpen: boolean;
  dropdownRef: RefObject<HTMLDivElement | null>;
  onOpenChange: (open: boolean) => void;
  onSelect: (token: ShieldToken) => void;
}

export function TokenSelector({
  selectedToken,
  availableTokens,
  dropdownOpen,
  dropdownRef,
  onOpenChange,
  onSelect,
}: TokenSelectorProps) {
  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => onOpenChange(!dropdownOpen)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] bg-background/60 border border-gray/15 hover:border-gray/30 transition-colors cursor-pointer"
      >
        <Image src={selectedToken.logo} alt={selectedToken.symbol} width={20} height={20} className="rounded-full" />
        <span className="text-sm font-semibold text-foreground">{selectedToken.symbol}</span>
        <ChevronDown className={cn("w-3.5 h-3.5 text-gray transition-transform", dropdownOpen && "rotate-180")} />
      </button>
      {dropdownOpen && (
        <div className="absolute right-0 top-full mt-1 w-[200px] bg-card border border-gray/20 rounded-[12px] shadow-xl z-50 overflow-hidden">
          {availableTokens.map((token) => (
            <button
              key={token.symbol}
              onClick={() => {
                onSelect(token);
                onOpenChange(false);
              }}
              className={cn(
                "w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-muted/50 transition-colors cursor-pointer",
                selectedToken.symbol === token.symbol && "bg-privacy/5",
              )}
            >
              <Image src={token.logo} alt={token.symbol} width={20} height={20} className="rounded-full" />
              <div className="flex-1 text-left">
                <div className="text-sm font-medium text-foreground">{token.symbol}</div>
                <div className="text-[10px] text-gray">{token.name}</div>
              </div>
              {token.isBtcNative && (
                <span className="px-1.5 py-0.5 rounded bg-btc/10 text-[8px] text-btc font-semibold uppercase">Native</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
