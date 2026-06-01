"use client";

import { Check, Eye } from "lucide-react";
import { exportViewOnlyKeys, encodeViewOnlyKeys, type UTXOpiaKeys } from "@utxopia/sdk";
import { HoldButton } from "@/components/ui/hold-button";
import { notifyCopied } from "@/lib/notifications";
import { cn } from "@/lib/utils";

interface ViewKeyModalProps {
  keys: UTXOpiaKeys;
  copied: boolean;
  onCopy: (value: string) => void;
  onClose: () => void;
}

export function ViewKeyModal({
  keys,
  copied,
  onCopy,
  onClose,
}: ViewKeyModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-md"
        onClick={onClose}
      />
      <div className={cn(
        "relative w-[90vw] max-w-[380px] rounded-[20px] p-6",
        "bg-card/95 backdrop-blur-xl border border-gray/20",
        "shadow-[0_0_80px_rgba(245,158,11,0.06)]",
        "animate-in fade-in-0 zoom-in-95 duration-200",
      )}>
        <div className="text-center mb-5">
          <div className="inline-flex p-3 rounded-full bg-btc/10 border border-btc/20 mb-3">
            <Eye className="w-5 h-5 text-btc" />
          </div>
          <h3 className="text-body1 font-bold text-foreground mb-1">Export Viewing Key</h3>
          <p className="text-caption text-gray">
            This key grants read-only access to your balances and transaction history. Do not share it publicly.
          </p>
        </div>

        <HoldButton
          onComplete={() => {
            const encoded = encodeViewOnlyKeys(exportViewOnlyKeys(keys));
            onCopy(encoded);
            notifyCopied("Viewing key");
            onClose();
          }}
          variant="warning"
          className="w-full"
          title="Hold to copy viewing key"
        >
          {copied ? <Check className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          {copied ? "Copied!" : "Hold to Copy"}
        </HoldButton>

        <button
          onClick={onClose}
          className="w-full mt-3 px-4 py-2 rounded-[10px] text-caption text-gray hover:text-gray-light hover:bg-gray/10 transition-colors cursor-pointer"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
