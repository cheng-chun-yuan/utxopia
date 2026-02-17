"use client";

import { ExternalLink, RefreshCw, CheckCircle, AlertCircle } from "lucide-react";
import { useDepositStatus } from "@/hooks/use-deposit-status";
import { DepositProgress } from "./DepositProgress";
import { type DepositStatus as DepositStatusType } from "@/lib/api/deposits";

interface DepositStatusProps {
  depositId: string;
  onClaimReady?: () => void;
  onClaimClick?: () => void;
  showClaimButton?: boolean;
  className?: string;
}

export function DepositStatus({
  depositId,
  onClaimReady,
  onClaimClick,
  showClaimButton = true,
  className = "",
}: DepositStatusProps) {
  const {
    status,
    confirmations,
    sweepConfirmations,
    canClaim,
    btcTxid,
    sweepTxid,
    solanaTx,
    error,
    isLoading,
    isConnected,
    refresh,
  } = useDepositStatus(depositId, {
    onClaimable: onClaimReady,
  });

  if (isLoading && !status) {
    return (
      <div className={`animate-pulse space-y-4 ${className}`}>
        <div className="h-2 bg-zinc-800 rounded-full" />
        <div className="h-4 bg-zinc-800 rounded w-1/2" />
      </div>
    );
  }

  if (!status) {
    return (
      <div className={`text-center text-zinc-500 py-4 ${className}`}>
        <AlertCircle className="w-8 h-8 mx-auto mb-2 opacity-50" />
        <p>Deposit not found</p>
        <button
          onClick={refresh}
          disabled={isLoading}
          className="mt-3 flex items-center gap-1 mx-auto text-xs hover:text-zinc-300 transition-colors disabled:opacity-50"
        >
          <RefreshCw
            className={`w-3 h-3 ${isLoading ? "animate-spin" : ""}`}
          />
          Refresh
        </button>
      </div>
    );
  }

  return (
    <div className={`space-y-6 ${className}`}>
      {/* Progress Indicator */}
      <DepositProgress
        status={status}
        confirmations={confirmations}
        sweepConfirmations={sweepConfirmations}
      />

      {/* Transaction Details */}
      <div className="space-y-2 text-sm">
        {btcTxid && (
          <TransactionLink
            label="Deposit TX"
            txid={btcTxid}
            type="bitcoin"
            confirmations={confirmations}
            requiredConfirmations={1}
          />
        )}
        {sweepTxid && (
          <TransactionLink
            label="Sweep TX"
            txid={sweepTxid}
            type="bitcoin"
            confirmations={sweepConfirmations}
            requiredConfirmations={2}
          />
        )}
        {solanaTx && (
          <TransactionLink label="Solana TX" txid={solanaTx} type="solana" />
        )}
      </div>

      {/* Error Message */}
      {error && (
        <div className="bg-red-900/20 border border-red-500/50 rounded-lg p-3 text-red-400 text-sm">
          <AlertCircle className="inline-block w-4 h-4 mr-2" />
          {error}
        </div>
      )}

      {/* Claim Button */}
      {showClaimButton && canClaim && (
        <button
          onClick={onClaimClick}
          className="w-full py-3 px-4 bg-emerald-700 hover:bg-emerald-600 text-white font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
        >
          <CheckCircle className="w-5 h-5" />
          Claim zkBTC
        </button>
      )}

      {/* Footer with connection status and refresh */}
      <div className="flex items-center justify-between text-xs text-zinc-500">
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${
              isConnected ? "bg-emerald-500" : "bg-zinc-600"
            }`}
          />
          {isConnected ? "Live updates" : "Polling"}
        </div>
        <button
          onClick={refresh}
          disabled={isLoading}
          className="flex items-center gap-1 hover:text-zinc-300 transition-colors disabled:opacity-50"
        >
          <RefreshCw
            className={`w-3 h-3 ${isLoading ? "animate-spin" : ""}`}
          />
          Refresh
        </button>
      </div>
    </div>
  );
}

interface TransactionLinkProps {
  label: string;
  txid: string;
  type: "bitcoin" | "solana";
  confirmations?: number;
  requiredConfirmations?: number;
}

function TransactionLink({
  label,
  txid,
  type,
  confirmations,
  requiredConfirmations,
}: TransactionLinkProps) {
  const shortTxid = `${txid.slice(0, 8)}...${txid.slice(-8)}`;

  const explorerUrl =
    type === "bitcoin"
      ? `https://mempool.space/testnet/tx/${txid}`
      : `https://orbmarkets.io/tx/${txid}?cluster=devnet`;

  return (
    <div className="flex items-center justify-between text-zinc-400">
      <span>{label}</span>
      <div className="flex items-center gap-2">
        {confirmations !== undefined && requiredConfirmations && (
          <span
            className={`text-xs ${
              confirmations >= requiredConfirmations
                ? "text-emerald-400"
                : "text-amber-400"
            }`}
          >
            {confirmations}/{requiredConfirmations} conf
          </span>
        )}
        <a
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-zinc-300 hover:text-white flex items-center gap-1"
        >
          {shortTxid}
          <ExternalLink className="w-3 h-3" />
        </a>
      </div>
    </div>
  );
}

export default DepositStatus;
