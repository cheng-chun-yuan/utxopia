"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  Copy,
  Download,
  PlusCircle,
  Send,
  ShieldCheck,
} from "lucide-react";
import type { UTXOpiaKeys } from "@utxopia/sdk";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import {
  createVaultBackupPayload,
  downloadVaultBackup,
  getBackupIdentityForKeys,
  markVaultBackupComplete,
} from "@/lib/vault-backup";
import { notifyCopied } from "@/lib/notifications";
import { cn } from "@/lib/utils";

interface VaultFirstStepsProps {
  keys: UTXOpiaKeys | null;
  hasBackup: boolean;
  hasFunds: boolean;
  depositHref?: string;
  onBackupComplete?: () => void;
}

export function VaultFirstSteps({
  keys,
  hasBackup,
  hasFunds,
  depositHref = "/vault/deposit",
  onBackupComplete,
}: VaultFirstStepsProps) {
  const identity = useMemo(() => getBackupIdentityForKeys(keys), [keys]);
  // Backup is required before sending, so stay expanded until it's done.
  const [isExpanded, setIsExpanded] = useState(!hasBackup);
  const [hasSavedBackup, setHasSavedBackup] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const { copied, copy } = useCopyToClipboard();

  if (hasFunds && hasBackup) return null;

  const doneCount = (hasFunds ? 1 : 0) + (hasBackup ? 1 : 0);

  const handleDownloadBackup = () => {
    if (!identity) return;
    downloadVaultBackup(identity);
    setDownloaded(true);
    setHasSavedBackup(true);
  };

  const handleCopyBackup = () => {
    if (!identity) return;
    const payload = createVaultBackupPayload(identity);
    copy(JSON.stringify(payload, null, 2));
    setHasSavedBackup(true);
    notifyCopied("Private wallet recovery backup");
  };

  const handleConfirmBackup = () => {
    if (!identity) return;
    markVaultBackupComplete(identity);
    onBackupComplete?.();
  };

  return (
    <div className="mb-4 rounded-[12px] border border-privacy/15 bg-privacy/5">
      <button
        onClick={() => setIsExpanded((open) => !open)}
        aria-expanded={isExpanded}
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-[12px] px-3 py-2.5 text-left transition-colors hover:bg-privacy/5"
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-privacy" />
        <span className="text-caption font-semibold text-foreground">
          Set up your wallet
        </span>
        <span className="text-caption text-gray">{doneCount} of 3 done</span>
        <ChevronDown
          className={cn(
            "ml-auto h-3.5 w-3.5 shrink-0 text-gray transition-transform",
            isExpanded && "rotate-180",
          )}
        />
      </button>

      {isExpanded && (
        <div className="space-y-2 px-3 pb-3">
          {/* Step 1: Add funds */}
          <div
            className={cn(
              "flex items-start gap-2.5 rounded-[9px] px-2.5 py-2",
              hasFunds ? "bg-privacy/5" : "bg-muted/30",
            )}
          >
            <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
              {hasFunds ? (
                <CheckCircle2 className="h-4 w-4 text-privacy" />
              ) : (
                <Circle className="h-4 w-4 text-gray/45" />
              )}
            </div>
            <PlusCircle className={cn("mt-0.5 h-4 w-4 shrink-0", hasFunds ? "text-privacy" : "text-gray/60")} />
            <div className="min-w-0 flex-1">
              <p className={cn("text-caption font-semibold", hasFunds ? "text-privacy" : "text-foreground")}>
                Add funds
              </p>
              <p className="text-[11px] text-gray/60">
                Deposit to your own private address by default.
              </p>
            </div>
            {!hasFunds && (
              <Link
                href={depositHref}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-[8px] bg-privacy px-3 py-1.5 text-caption font-semibold text-background transition-colors hover:bg-privacy/90"
              >
                Add funds
              </Link>
            )}
          </div>

          {/* Step 2: Back up private wallet */}
          <div
            className={cn(
              "rounded-[9px] px-2.5 py-2",
              hasBackup ? "bg-privacy/5" : "bg-muted/30",
            )}
          >
            <div className="flex items-start gap-2.5">
              <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
                {hasBackup ? (
                  <CheckCircle2 className="h-4 w-4 text-privacy" />
                ) : (
                  <Circle className="h-4 w-4 text-gray/45" />
                )}
              </div>
              <ShieldCheck className={cn("mt-0.5 h-4 w-4 shrink-0", hasBackup ? "text-privacy" : "text-gray/60")} />
              <div className="min-w-0">
                <p className={cn("text-caption font-semibold", hasBackup ? "text-privacy" : "text-foreground")}>
                  Back up private wallet
                </p>
                <p className="text-[11px] text-gray/60">
                  Required before sending. Keeps private funds recoverable.
                </p>
              </div>
            </div>
            {!hasBackup && identity && keys && (
              <div className="mt-2 flex flex-wrap items-center gap-2 pl-[30px]">
                <button
                  onClick={handleDownloadBackup}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-[8px] bg-privacy px-3 py-1.5 text-caption font-semibold text-background transition-colors hover:bg-privacy/90"
                >
                  {downloaded ? <Check className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />}
                  {downloaded ? "Backup downloaded" : "Download backup (.json)"}
                </button>
                <button
                  onClick={handleCopyBackup}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-[8px] bg-muted px-3 py-1.5 text-caption font-semibold text-gray-light transition-colors hover:bg-muted/80"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? "Copied" : "Copy"}
                </button>
                <button
                  onClick={handleConfirmBackup}
                  disabled={!hasSavedBackup}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-[8px] px-3 py-1.5 text-caption font-semibold transition-colors",
                    hasSavedBackup
                      ? "cursor-pointer bg-muted text-gray-light hover:bg-muted/80"
                      : "cursor-not-allowed bg-gray/10 text-gray/35",
                  )}
                >
                  <Check className="h-3.5 w-3.5" />
                  I stored it safely
                </button>
              </div>
            )}
          </div>

          {/* Step 3: Send privately */}
          <div className="flex items-start gap-2.5 rounded-[9px] bg-muted/30 px-2.5 py-2">
            <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
              <Circle className="h-4 w-4 text-gray/45" />
            </div>
            <Send className="mt-0.5 h-4 w-4 shrink-0 text-gray/60" />
            <div className="min-w-0 flex-1">
              <p className="text-caption font-semibold text-foreground">Send privately</p>
              <p className="text-[11px] text-gray/60">
                Pay a private address, chain wallet, Bitcoin address, or claim link.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
