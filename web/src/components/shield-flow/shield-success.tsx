"use client";

import { CheckCircle2, ExternalLink } from "lucide-react";
import type { WalletDepositResult } from "@/hooks/use-btc-deposit";
import { getMempoolExplorerUrl } from "@/lib/btc-network";
import { getSolanaExplorerTxUrl } from "@/lib/solana-network";
import { cn } from "@/lib/utils";
import type { SHIELD_TOKENS } from "@/lib/supported-tokens";

type ShieldToken = (typeof SHIELD_TOKENS)[number];

interface ShieldSuccessProps {
  className?: string;
  selectedToken: ShieldToken;
  txSig: string | null;
  walletDepositResult: WalletDepositResult | null;
  onReset: () => void;
}

export function ShieldSuccess({
  className,
  selectedToken,
  txSig,
  walletDepositResult,
  onReset,
}: ShieldSuccessProps) {
  const isBtc = selectedToken.isBtcNative;

  return (
    <div className={cn("space-y-4 text-center py-6", className)}>
      <div className={cn("inline-flex p-3 rounded-full border", isBtc ? "bg-btc/10 border-btc/20" : "bg-privacy/10 border-privacy/20")}>
        <CheckCircle2 className={cn("w-8 h-8", isBtc ? "text-btc" : "text-privacy")} />
      </div>
      <h3 className="text-lg font-semibold text-foreground">
        {isBtc ? "BTC Shielded!" : "Tokens Shielded!"}
      </h3>
      <p className="text-caption text-gray">
        {isBtc && walletDepositResult
          ? "Your BTC deposit has been broadcast. The backend will automatically detect, sweep, and verify it."
          : `Your ${selectedToken.symbol} tokens are now private commitments.`}
      </p>
      {txSig && (
        <a
          href={getSolanaExplorerTxUrl(txSig)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-caption text-sol hover:text-sol/80 transition-colors"
        >
          View transaction <ExternalLink className="w-3 h-3" />
        </a>
      )}
      {walletDepositResult?.txid && (
        <a
          href={`${getMempoolExplorerUrl()}/tx/${walletDepositResult.txid}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-caption text-btc hover:text-btc/80 transition-colors"
        >
          View on mempool.space <ExternalLink className="w-3 h-3" />
        </a>
      )}
      <div className="pt-2">
        <button
          onClick={onReset}
          className="px-5 py-2 rounded-[10px] bg-muted border border-gray/15 text-body2 text-gray-light hover:text-foreground hover:bg-muted/80 transition-colors cursor-pointer"
        >
          Shield more
        </button>
      </div>
    </div>
  );
}
