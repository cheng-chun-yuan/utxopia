"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Check, Copy, ShieldCheck } from "lucide-react";
import type { UTXOpiaKeys } from "@utxopia/sdk";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import {
  createVaultBackupPayload,
  getBackupIdentityForKeys,
  hasVaultBackup,
  markVaultBackupComplete,
} from "@/lib/vault-backup";
import { notifyCopied } from "@/lib/notifications";
import { cn } from "@/lib/utils";

interface VaultBackupCardProps {
  keys: UTXOpiaKeys | null;
  isViewOnly: boolean;
  depositCount: number;
  onBackupComplete?: () => void;
}

export function VaultBackupCard({
  keys,
  isViewOnly,
  depositCount,
  onBackupComplete,
}: VaultBackupCardProps) {
  const identity = useMemo(() => getBackupIdentityForKeys(keys), [keys]);
  const [isBackedUp, setIsBackedUp] = useState(() => hasVaultBackup(identity));
  const [hasCopiedBackup, setHasCopiedBackup] = useState(false);
  const { copied, copy } = useCopyToClipboard();

  if (!keys || isViewOnly || !identity || isBackedUp) return null;

  const hasFunds = depositCount > 0;
  const handleCopyBackup = () => {
    const payload = createVaultBackupPayload(identity);
    copy(JSON.stringify(payload, null, 2));
    setHasCopiedBackup(true);
    notifyCopied("Private wallet recovery backup");
  };

  const handleConfirmBackup = () => {
    markVaultBackupComplete(identity);
    setIsBackedUp(true);
    onBackupComplete?.();
  };

  return (
    <div className={cn(
      "mb-4 rounded-[12px] border p-3",
      hasFunds ? "bg-warning/10 border-warning/25" : "bg-muted/35 border-gray/15",
    )}>
      <div className="flex items-start gap-3">
        <div className={cn(
          "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
          hasFunds ? "bg-warning/15 text-warning" : "bg-privacy/10 text-privacy",
        )}>
          {hasFunds ? <AlertTriangle className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-body2-semibold text-foreground">
            Back up your private wallet
          </p>
          <p className="mt-0.5 text-caption text-gray">
            Your sign-in recovers the public account. This backup recovers private funds if this device or passkey is lost.
          </p>
          <div className="mt-3 rounded-[9px] border border-gray/15 bg-background/35 px-3 py-2">
            <p className="text-[11px] font-mono text-gray/60">
              Recovery backup: {"{ keys: \"...\", identity: \"...\" }"}
            </p>
          </div>
          <button
            onClick={handleCopyBackup}
            className={cn(
              "mt-3 inline-flex items-center gap-2 rounded-[9px] px-3 py-2",
              "text-caption font-semibold transition-colors cursor-pointer",
              hasFunds
                ? "bg-warning text-background hover:bg-warning/90"
                : "bg-privacy text-background hover:bg-privacy/90",
            )}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Backup copied" : "Copy recovery backup"}
          </button>
          <button
            onClick={handleConfirmBackup}
            disabled={!hasCopiedBackup}
            className={cn(
              "ml-2 mt-3 inline-flex items-center gap-2 rounded-[9px] px-3 py-2",
              "text-caption font-semibold transition-colors",
              hasCopiedBackup
                ? "bg-muted text-gray-light hover:bg-muted/80 cursor-pointer"
                : "bg-gray/10 text-gray/35 cursor-not-allowed",
            )}
          >
            <Check className="h-3.5 w-3.5" />
            I stored it safely
          </button>
        </div>
      </div>
    </div>
  );
}
