"use client";

import Image from "next/image";
import Link from "next/link";
import { ArrowDownToLine, ArrowRight, ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { VAULT_TOKENS } from "@/lib/supported-tokens";
import type { TokenPrices } from "@/hooks/use-token-prices";

interface VaultTokenListProps {
  balancesByToken: Record<string, bigint>;
  depositCount: number;
  isLoading: boolean;
  tokenPrices: TokenPrices;
}

export function VaultTokenList({
  balancesByToken,
  depositCount,
  isLoading,
  tokenPrices,
}: VaultTokenListProps) {
  const hasAnyBalance = VAULT_TOKENS.some(
    (token) => Number(balancesByToken?.[token.shieldedSymbol] ?? 0n) > 0,
  );

  const sortedTokens = [...VAULT_TOKENS].sort((a, b) => {
    const aRaw = Number(balancesByToken?.[a.shieldedSymbol] ?? 0n);
    const bRaw = Number(balancesByToken?.[b.shieldedSymbol] ?? 0n);
    if (aRaw > 0 && bRaw === 0) return -1;
    if (aRaw === 0 && bRaw > 0) return 1;
    const aUsd = (aRaw / 10 ** a.decimals) * (tokenPrices[a.priceKey] || 0);
    const bUsd = (bRaw / 10 ** b.decimals) * (tokenPrices[b.priceKey] || 0);
    return bUsd - aUsd;
  });

  return (
    <div className="mb-5">
      <div className="flex items-center justify-between px-1 mb-2">
        <span className="text-[11px] text-gray/50 uppercase tracking-wider font-medium">Tokens</span>
        {depositCount > 0 && (
          <Link
            href="/vault/activity?tab=notes"
            className="flex items-center gap-0.5 text-[11px] text-privacy/60 hover:text-privacy transition-colors cursor-pointer"
          >
            View All
            <ChevronRight className="w-3 h-3" />
          </Link>
        )}
      </div>

      <div className="rounded-[14px] border border-gray/10 overflow-hidden divide-y divide-gray/8">
        {!hasAnyBalance && !isLoading ? (
          <VaultTokenEmptyState />
        ) : (
          sortedTokens.map((token) => {
            const rawBalance = Number(balancesByToken?.[token.shieldedSymbol] ?? 0n);
            const balanceNum = rawBalance / 10 ** token.decimals;
            const hasBalance = rawBalance > 0;
            const maxDec = Math.min(token.decimals, 6);
            const balance = balanceNum.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: maxDec });
            const price = tokenPrices[token.priceKey];
            const usdValue = price ? (rawBalance / 10 ** token.decimals) * price : 0;

            return (
              <div key={token.symbol} className={cn("flex items-center gap-3 px-4 h-[60px] transition-colors", hasBalance ? "hover:bg-muted/40" : "opacity-40")}>
                <Image src={token.shieldedLogo} alt={token.shieldedSymbol} width={36} height={36} className="rounded-full" />
                <div className="flex-1 min-w-0">
                  <p className="text-body2-semibold text-foreground">{token.shieldedSymbol}</p>
                  <p className="text-[11px] text-gray/50">{token.name}</p>
                </div>
                <div className="text-right">
                  {isLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin text-privacy ml-auto" />
                  ) : hasBalance ? (
                    <>
                      <p className="text-body2-semibold text-foreground font-mono">{balance}</p>
                      <p className="text-[11px] text-gray/45 font-mono">
                        ${usdValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </p>
                    </>
                  ) : (
                    <p className="text-body2 text-gray/30 font-mono">0.00</p>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function VaultTokenEmptyState() {
  return (
    <div className="flex flex-col items-center py-8 px-4">
      <div className="w-12 h-12 rounded-full bg-privacy/10 border border-privacy/20 flex items-center justify-center mb-3">
        <ArrowDownToLine className="w-5 h-5 text-privacy" />
      </div>
      <p className="text-sm font-medium text-foreground mb-1">Ready to go private?</p>
      <p className="text-xs text-gray/50 text-center mb-4">
        Deposit BTC or any Solana token to start.
      </p>
      <Link
        href="/vault/deposit"
        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-privacy hover:bg-privacy/85 text-background text-sm font-medium transition-all duration-200 cursor-pointer active:scale-[0.98]"
      >
        Make Your First Deposit
        <ArrowRight className="w-3.5 h-3.5" />
      </Link>
    </div>
  );
}
