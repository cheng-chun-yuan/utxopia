"use client";

import { motion } from "framer-motion";
import { Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { VAULT_TOKENS } from "@/lib/supported-tokens";
import type { TokenPrices } from "@/hooks/use-token-prices";

interface VaultBalanceProps {
  balancesByToken: Record<string, bigint>;
  isLoading: boolean;
  tokenPrices: TokenPrices;
  onRefresh: () => void;
}

export function VaultBalance({
  balancesByToken,
  isLoading,
  tokenPrices,
  onRefresh,
}: VaultBalanceProps) {
  const totalUsd = getVaultUsdValue(balancesByToken, tokenPrices);
  const btcPrice = tokenPrices.btc || 0;
  const btcEquivalent = btcPrice > 0 ? totalUsd / btcPrice : 0;

  return (
    <div className="text-center py-6 mb-2">
      {isLoading ? (
        <Loader2 className="w-6 h-6 animate-spin text-privacy mx-auto mb-2" />
      ) : (
        <>
          <motion.p
            className="text-[36px] sm:text-[42px] font-bold text-foreground tracking-tight leading-none mb-1"
            key={totalUsd.toFixed(2)}
            initial={{ opacity: 0.6, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: "easeOut" }}
          >
            ${totalUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </motion.p>
          <p className="text-body2 text-gray/60 font-mono flex items-center justify-center gap-1.5">
            {btcEquivalent.toFixed(8)} BTC
            <button
              onClick={onRefresh}
              disabled={isLoading}
              className="p-0.5 rounded text-gray/30 hover:text-privacy transition-colors disabled:opacity-50 cursor-pointer"
              title="Refresh"
            >
              <RefreshCw className={cn("w-3 h-3", isLoading && "animate-spin")} />
            </button>
          </p>
        </>
      )}
    </div>
  );
}

function getVaultUsdValue(
  balancesByToken: Record<string, bigint>,
  tokenPrices: TokenPrices,
): number {
  return VAULT_TOKENS.reduce((total, token) => {
    const rawBalance = Number(balancesByToken?.[token.shieldedSymbol] ?? 0n);
    const price = tokenPrices[token.priceKey];
    if (!price) return total;
    return total + (rawBalance / 10 ** token.decimals) * price;
  }, 0);
}
