"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { HoldButton } from "@/components/ui/hold-button";

export interface ReviewModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recipientLabel: string;
  amountLabel: string;
  feeLabel: string;
  onConfirm: () => void;
  /** Optional warning row (e.g. BTC privacy notice). */
  warning?: string;
}

export function ReviewModal({
  open,
  onOpenChange,
  recipientLabel,
  amountLabel,
  feeLabel,
  onConfirm,
  warning,
}: ReviewModalProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[420px] max-w-[calc(100vw-32px)] bg-background border border-gray/20 rounded-2xl p-5 shadow-xl">
          <div className="flex items-center justify-between mb-4">
            <Dialog.Title className="text-base font-semibold">
              Review send
            </Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              className="p-1 rounded hover:bg-muted/60 text-muted-foreground"
            >
              <X className="w-4 h-4" />
            </Dialog.Close>
          </div>

          <div className="space-y-3 text-sm">
            <Row label="To" value={recipientLabel} />
            <Row label="Amount" value={amountLabel} />
            <Row label="Total fees" value={feeLabel} />
          </div>

          {warning && (
            <div className="mt-3 px-2 py-1.5 rounded bg-yellow-500/10 text-yellow-600 text-xs">
              {warning}
            </div>
          )}

          <div className="mt-5">
            <HoldButton
              onComplete={onConfirm}
              variant="primary"
              className="w-full"
            >
              Hold to send
            </HoldButton>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      <span className="font-mono text-xs text-right break-all">{value}</span>
    </div>
  );
}
