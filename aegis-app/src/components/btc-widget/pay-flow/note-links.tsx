"use client";

/**
 * Note Link Components — displays claim links for Note-type outputs.
 * Used in both compose step (preview) and success step (shareable link).
 */

import { useState } from "react";
import { Copy, Check, FileText } from "lucide-react";
import { formatBtc } from "@/lib/utils/formatting";

/** Inline preview of the claim URL shown while composing a Note output */
export function NoteLinkPreview({ phrase }: { phrase: string }) {
  const [copied, setCopied] = useState(false);
  const claimUrl = typeof window !== "undefined"
    ? `${window.location.origin}/claim#note=${encodeURIComponent(phrase)}`
    : "";

  const handleCopy = () => {
    navigator.clipboard.writeText(claimUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="mt-1 space-y-0.5">
      <p className="text-[11px] font-mono text-gray/50 truncate">{claimUrl}</p>
      <button
        onClick={handleCopy}
        className="flex items-center gap-1 text-[11px] text-gray/60 hover:text-gray transition-colors cursor-pointer"
      >
        {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
        {copied ? "Copied!" : "Copy link"}
      </button>
    </div>
  );
}

/** Full claim link card shown in the success step */
export function NoteClaimLink({ phrase, amount }: { phrase: string; amount: number }) {
  const [copied, setCopied] = useState(false);
  const claimUrl = typeof window !== "undefined"
    ? `${window.location.origin}/claim#note=${encodeURIComponent(phrase)}`
    : "";

  const handleCopy = () => {
    navigator.clipboard.writeText(claimUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="p-3 rounded-[12px] bg-muted border border-gray/15">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4 text-gray-light" />
          <span className="text-body2-semibold text-foreground">
            Note: {formatBtc(amount)} zkBTC
          </span>
        </div>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-caption text-purple hover:text-purple/80 transition-colors"
        >
          {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
          {copied ? "Copied!" : "Copy Link"}
        </button>
      </div>
      <div className="p-2 bg-background rounded-[8px] break-all">
        <code className="text-[11px] font-mono text-gray">{claimUrl}</code>
      </div>
      <p className="text-[11px] text-gray mt-1.5">
        Share this link to let someone claim this note
      </p>
    </div>
  );
}
