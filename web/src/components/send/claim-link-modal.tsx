"use client";

import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Copy, Check, X, Loader2 } from "lucide-react";
import { TokenSourcePicker } from "./token-source-picker";
import { AmountField } from "./amount-field";

export interface ClaimLinkResult {
  url: string;
  secret: string;
}

export interface ClaimLinkModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Caller does the SDK work; modal only orchestrates UI. */
  onGenerate: (input: {
    sourceToken: string;
    amount: string;
  }) => Promise<ClaimLinkResult>;
  availableBaseUnits: bigint;
  decimals: number;
  unit: string;
  usdPerUnit: number | null;
  defaultToken?: string;
}

export function ClaimLinkModal({
  open,
  onOpenChange,
  onGenerate,
  availableBaseUnits,
  decimals,
  unit,
  usdPerUnit,
  defaultToken = "zkBTC",
}: ClaimLinkModalProps) {
  const [sourceToken, setSourceToken] = useState(defaultToken);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ClaimLinkResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const handleGenerate = async () => {
    setBusy(true);
    setErr(null);
    try {
      setResult(await onGenerate({ sourceToken, amount }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Couldn't generate link";
      setErr(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[460px] max-w-[calc(100vw-32px)] bg-background border border-gray/20 rounded-2xl p-5 shadow-xl">
          <div className="flex items-center justify-between mb-4">
            <Dialog.Title className="text-base font-semibold">
              Send via claim link
            </Dialog.Title>
            <Dialog.Close className="p-1 rounded hover:bg-muted/60 text-muted-foreground">
              <X className="w-4 h-4" />
            </Dialog.Close>
          </div>

          {!result ? (
            <div className="space-y-4">
              <TokenSourcePicker
                recipientType={"claim_link"}
                selected={sourceToken}
                onSelect={setSourceToken}
              />
              <AmountField
                value={amount}
                onChange={setAmount}
                decimals={decimals}
                unit={unit}
                availableBaseUnits={availableBaseUnits}
                usdPerUnit={usdPerUnit}
              />
              {err && <div className="text-xs text-red-500">{err}</div>}
              <button
                type="button"
                disabled={busy || !amount || amount === "0"}
                onClick={handleGenerate}
                className="w-full px-4 py-2.5 rounded-lg bg-privacy text-background text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                Generate claim link
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="rounded-lg border border-privacy/20 bg-privacy/8 px-3 py-2">
                <p className="text-sm font-semibold text-privacy">Private claim link created</p>
                <p className="mt-0.5 text-xs text-gray/70">
                  Share the link with the recipient. The secret unlocks the funds.
                </p>
              </div>
              <CopyRow label="Link" value={result.url} />
              <CopyRow label="Secret" value={result.secret} />
              <p className="text-[11px] text-muted-foreground">
                Share both. The recipient pastes the link, the secret unlocks
                the funds.
              </p>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="w-full px-4 py-2.5 rounded-lg bg-muted/60 text-sm font-medium"
              >
                Done
              </button>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div>
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <button
        type="button"
        onClick={onCopy}
        className="w-full px-3 py-2 rounded-lg bg-muted/40 border border-gray/15 text-xs font-mono text-left flex items-center justify-between gap-2 hover:border-privacy/30"
      >
        <span className="truncate">{value}</span>
        {copied ? (
          <Check className="w-3.5 h-3.5 text-privacy shrink-0" />
        ) : (
          <Copy className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        )}
      </button>
    </div>
  );
}
