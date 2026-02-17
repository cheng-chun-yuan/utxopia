"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { notifyCopied } from "@/lib/notifications";

type CopyButtonVariant = "default" | "privacy" | "btc" | "sol";

interface CopyButtonProps {
  text: string;
  label: string;
  variant?: CopyButtonVariant;
  showToast?: boolean;
  className?: string;
  iconSize?: "sm" | "md";
}

const variantStyles: Record<CopyButtonVariant, string> = {
  default: "bg-gray/10 hover:bg-gray/20 text-gray",
  privacy: "bg-privacy/10 hover:bg-privacy/20 text-privacy",
  btc: "bg-btc/10 hover:bg-btc/20 text-btc",
  sol: "bg-sol/10 hover:bg-sol/20 text-sol",
};

const iconSizes = {
  sm: "w-3 h-3",
  md: "w-4 h-4",
};

export function CopyButton({
  text,
  label,
  variant = "default",
  showToast = true,
  className,
  iconSize = "md",
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (showToast) {
        notifyCopied(label);
      }
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  return (
    <button
      onClick={handleCopy}
      className={cn(
        "p-1.5 rounded-[6px] transition-colors",
        variantStyles[variant],
        className
      )}
      title={`Copy ${label.toLowerCase()}`}
      aria-label={`Copy ${label.toLowerCase()} to clipboard`}
    >
      {copied ? (
        <Check className={cn(iconSizes[iconSize], "text-success")} />
      ) : (
        <Copy className={iconSizes[iconSize]} />
      )}
    </button>
  );
}

interface CopyFieldProps {
  value: string;
  label: string;
  variant?: CopyButtonVariant;
  truncate?: boolean;
  className?: string;
}

export function CopyField({
  value,
  label,
  variant = "default",
  truncate = true,
  className,
}: CopyFieldProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 p-3 bg-background/50 rounded-[10px]",
        className
      )}
    >
      <code
        className={cn(
          "flex-1 text-caption font-mono",
          truncate && "truncate",
          variant === "privacy" && "text-privacy",
          variant === "btc" && "text-btc",
          variant === "sol" && "text-sol",
          variant === "default" && "text-gray-light"
        )}
      >
        {value}
      </code>
      <CopyButton
        text={value}
        label={label}
        variant={variant}
        iconSize="sm"
      />
    </div>
  );
}
