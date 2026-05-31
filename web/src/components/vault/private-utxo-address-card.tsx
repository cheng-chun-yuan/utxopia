"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

interface PrivateUtxoAddressCardProps {
  address: string;
  description: string;
  cardClassName?: string;
  buttonClassName?: string;
  codeClassName?: string;
}

export function PrivateUtxoAddressCard({
  address,
  description,
  cardClassName,
  buttonClassName,
  codeClassName,
}: PrivateUtxoAddressCardProps) {
  const [copied, setCopied] = useState(false);

  async function copyAddress() {
    await navigator.clipboard?.writeText(address);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className={cn("rounded-[14px] border p-4", cardClassName)}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-foreground">Private UTXO address</p>
          <p className="text-xs text-gray">{description}</p>
        </div>
        <button
          type="button"
          onClick={copyAddress}
          className={cn(
            "inline-flex h-9 w-9 items-center justify-center rounded-[8px] border transition-colors",
            buttonClassName,
          )}
          aria-label="Copy private UTXO address"
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </button>
      </div>
      <code className={cn("block break-all rounded-[10px] bg-background/60 p-3 font-mono text-[11px]", codeClassName)}>
        {address}
      </code>
    </div>
  );
}
