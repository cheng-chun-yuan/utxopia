"use client";

import { CheckCircle2, ExternalLink } from "lucide-react";

interface SuccessCardProps {
  title?: string;
  message?: string;
  txSignature?: string;
  network?: "devnet" | "mainnet";
}

/**
 * Standardized success display card used across all flows.
 */
export function SuccessCard({
  title = "Success",
  message,
  txSignature,
  network = "devnet",
}: SuccessCardProps) {
  const explorerUrl = txSignature
    ? `https://orbmarkets.io/tx/${txSignature}?cluster=${network}`
    : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 p-3 bg-success/10 border border-success/20 rounded-[12px]">
        <CheckCircle2 className="w-5 h-5 text-success" />
        <span className="text-body2 text-success">{title}</span>
      </div>

      {message && (
        <p className="text-body2 text-gray-light">{message}</p>
      )}

      {explorerUrl && (
        <div className="p-3 bg-muted border border-gray/15 rounded-[12px]">
          <p className="text-caption text-gray mb-1">Transaction</p>
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-caption font-mono text-privacy hover:underline break-all flex items-center gap-1"
          >
            {txSignature!.slice(0, 20)}...{txSignature!.slice(-20)}
            <ExternalLink className="w-3 h-3 shrink-0" />
          </a>
        </div>
      )}
    </div>
  );
}
