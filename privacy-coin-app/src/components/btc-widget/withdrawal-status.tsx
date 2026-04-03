"use client";

import { Clock, CheckCircle2, Loader2, AlertCircle, ExternalLink, Bitcoin } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatBtc, truncateMiddle } from "@/lib/utils/formatting";
import { useAegisStore, type ActiveWithdrawal, type WithdrawalStatus } from "@/stores/aegis-store";
import { getConfig } from "@aegis/sdk";
import { getSolanaExplorerTxUrl } from "@/lib/solana-network";

const STATUS_CONFIG: Record<WithdrawalStatus, {
  label: string;
  icon: typeof Clock;
  color: string;
  bgColor: string;
}> = {
  pending: {
    label: "Pending",
    icon: Clock,
    color: "text-warning",
    bgColor: "bg-warning/10",
  },
  processing: {
    label: "Processing",
    icon: Loader2,
    color: "text-sol",
    bgColor: "bg-sol/10",
  },
  broadcasting: {
    label: "Broadcasting",
    icon: Loader2,
    color: "text-purple",
    bgColor: "bg-purple/10",
  },
  confirmed: {
    label: "Confirmed",
    icon: CheckCircle2,
    color: "text-privacy",
    bgColor: "bg-privacy/10",
  },
  failed: {
    label: "Failed",
    icon: AlertCircle,
    color: "text-error",
    bgColor: "bg-error/10",
  },
};

function WithdrawalCard({ withdrawal }: { withdrawal: ActiveWithdrawal }) {
  const config = STATUS_CONFIG[withdrawal.status];
  const Icon = config.icon;
  const isAnimating = withdrawal.status === "processing" || withdrawal.status === "broadcasting";
  const esploraUrl = getConfig().esploraUrl.replace("/api", "");

  return (
    <div className="p-4 rounded-[12px] border border-gray/15 bg-muted">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-[6px] bg-btc/10">
            <Bitcoin className="w-4 h-4 text-btc" />
          </div>
          <span className="text-body2-semibold text-foreground">BTC Withdrawal</span>
        </div>
        <div className={cn("flex items-center gap-1.5 px-2 py-1 rounded-full", config.bgColor)}>
          <Icon className={cn("w-3.5 h-3.5", config.color, isAnimating && "animate-spin")} />
          <span className={cn("text-caption font-medium", config.color)}>
            {config.label}
          </span>
        </div>
      </div>

      {/* Details */}
      <div className="space-y-2">
        <div className="flex justify-between items-center text-body2">
          <span className="text-gray">Amount</span>
          <span className="text-foreground font-semibold">
            {formatBtc(Number(withdrawal.amountSats))} BTC
          </span>
        </div>
        <div className="flex justify-between items-center text-body2">
          <span className="text-gray">To</span>
          <span className="text-gray-light font-mono text-xs">
            {truncateMiddle(withdrawal.btcAddress, 8)}
          </span>
        </div>

        {withdrawal.btcTxid && (
          <div className="flex justify-between items-center text-body2">
            <span className="text-gray">BTC TX</span>
            <a
              href={`${esploraUrl}/tx/${withdrawal.btcTxid}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-btc text-xs hover:underline flex items-center gap-1"
            >
              {truncateMiddle(withdrawal.btcTxid, 8)}
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        )}

        {withdrawal.solanaSignature && (
          <div className="flex justify-between items-center text-body2">
            <span className="text-gray">Solana TX</span>
            <a
              href={getSolanaExplorerTxUrl(withdrawal.solanaSignature)}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-purple text-xs hover:underline flex items-center gap-1"
            >
              {truncateMiddle(withdrawal.solanaSignature, 8)}
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

export function WithdrawalStatusList() {
  const withdrawals = useAegisStore((s) => s.activeWithdrawals);

  if (withdrawals.length === 0) return null;

  return (
    <div className="space-y-3">
      <p className="text-body2-semibold text-gray-light uppercase tracking-wider text-xs">
        Active Withdrawals
      </p>
      {withdrawals.map((w) => (
        <WithdrawalCard key={w.id} withdrawal={w} />
      ))}
    </div>
  );
}
