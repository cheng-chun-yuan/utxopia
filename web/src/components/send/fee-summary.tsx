"use client";

import { AlertTriangle } from "lucide-react";
import type { RecipientType } from "./recipient-detect";

export interface FeeSummaryProps {
  recipientType: RecipientType | "claim_link" | null;
  networkFeeLabel: string;
  serviceFeeLabel: string;
}

export function FeeSummary({
  recipientType,
  networkFeeLabel,
  serviceFeeLabel,
}: FeeSummaryProps) {
  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">Network fee</span>
        <span className="font-mono">{networkFeeLabel}</span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">Service fee</span>
        <span className="font-mono">{serviceFeeLabel}</span>
      </div>
      {recipientType === "btc" && (
        <div className="mt-2 flex items-start gap-1.5 px-2 py-1.5 rounded bg-yellow-500/10 text-yellow-600 dark:text-yellow-400">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span className="text-[11px]">
            Cashing out to Bitcoin reveals the destination address on-chain.
          </span>
        </div>
      )}
    </div>
  );
}
