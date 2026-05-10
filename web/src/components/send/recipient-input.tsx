"use client";

import { Check, X, Loader2, Clipboard } from "lucide-react";
import { useCallback } from "react";
import { cn } from "@/lib/utils";
import { detectRecipient, type DetectionResult } from "./recipient-detect";

export interface RecipientInputProps {
  value: string;
  onChange: (next: string) => void;
  /** True while async resolution (SNS) is in flight. */
  resolving?: boolean;
  className?: string;
}

function statusFor(
  value: string,
  resolving: boolean,
): {
  detection: DetectionResult;
  tone: "neutral" | "ok" | "warn" | "bad";
  label: string;
} {
  if (resolving) {
    return {
      detection: { type: "empty", confidence: "low" },
      tone: "warn",
      label: "Resolving SNS name…",
    };
  }
  const detection = detectRecipient(value);
  if (detection.type === "empty") {
    return { detection, tone: "neutral", label: "" };
  }
  if (detection.type === "invalid") {
    return {
      detection,
      tone: "bad",
      label: detection.reason ?? "Not a valid recipient",
    };
  }
  if (detection.type === "ambiguous") {
    return {
      detection,
      tone: "warn",
      label: "Ambiguous — try a longer or clearer address",
    };
  }
  return { detection, tone: "ok", label: detection.reason ?? "Looks valid" };
}

export function RecipientInput({
  value,
  onChange,
  resolving = false,
  className,
}: RecipientInputProps) {
  const { tone, label } = statusFor(value, resolving);

  const onPasteFromClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      onChange(text.trim());
    } catch {
      // ignore — clipboard permission denied
    }
  }, [onChange]);

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="relative">
        <input
          aria-label="Recipient"
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Paste address or .btcpro.sol name"
          className={cn(
            "w-full px-3 py-3 pr-10 rounded-lg",
            "bg-muted/40 border text-sm font-mono",
            "focus:outline-none focus:ring-2 focus:ring-privacy/40",
            tone === "bad" && "border-red-500/40",
            tone === "ok" && "border-privacy/30",
            tone === "warn" && "border-yellow-500/30",
            tone === "neutral" && "border-gray/15",
          )}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          onClick={onPasteFromClipboard}
          aria-label="Paste from clipboard"
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded hover:bg-muted/60 text-muted-foreground"
        >
          <Clipboard className="w-4 h-4" />
        </button>
      </div>
      {label && (
        <div
          className={cn(
            "flex items-center gap-1.5 text-xs",
            tone === "ok" && "text-privacy",
            tone === "warn" && "text-yellow-500",
            tone === "bad" && "text-red-500",
          )}
        >
          {tone === "ok" && <Check className="w-3 h-3" />}
          {tone === "warn" && <Loader2 className="w-3 h-3 animate-spin" />}
          {tone === "bad" && <X className="w-3 h-3" />}
          <span>{label}</span>
        </div>
      )}
    </div>
  );
}
