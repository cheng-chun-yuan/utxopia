"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
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

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
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
    <motion.button
      onClick={handleCopy}
      className={cn(
        "p-1.5 rounded-[6px] transition-colors",
        variantStyles[variant],
        className
      )}
      title={`Copy ${label.toLowerCase()}`}
      aria-label={`Copy ${label.toLowerCase()} to clipboard`}
      whileTap={{ scale: 0.85 }}
      animate={copied ? {
        boxShadow: ["0 0 12px rgba(74,222,128,0.4)", "0 0 0 rgba(74,222,128,0)"],
      } : {}}
      transition={{ duration: 0.5 }}
    >
      <AnimatePresence mode="wait" initial={false}>
        {copied ? (
          <motion.span
            key="check"
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: [1.3, 1], opacity: 1 }}
            exit={{ scale: 0.5, opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <Check className={cn(iconSizes[iconSize], "text-success")} />
          </motion.span>
        ) : (
          <motion.span
            key="copy"
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.5, opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <Copy className={iconSizes[iconSize]} />
          </motion.span>
        )}
      </AnimatePresence>
    </motion.button>
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
