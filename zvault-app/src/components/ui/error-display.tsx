"use client";

import { AlertCircle, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

interface ErrorDisplayProps {
  error: string;
  title?: string;
  onRetry?: () => void;
  className?: string;
}

export function ErrorDisplay({
  error,
  title = "Error",
  onRetry,
  className,
}: ErrorDisplayProps) {
  return (
    <div
      className={cn(
        "p-4 bg-red-500/10 border border-red-500/20 rounded-[12px]",
        className
      )}
      role="alert"
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-body2-semibold text-red-400">{title}</p>
          <p className="text-caption text-gray mt-1 break-words">{error}</p>
        </div>
        {onRetry && (
          <button
            onClick={onRetry}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-[8px]",
              "bg-red-500/10 hover:bg-red-500/20 text-red-400",
              "text-caption transition-colors flex-shrink-0"
            )}
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Retry
          </button>
        )}
      </div>
    </div>
  );
}

interface InlineErrorProps {
  error: string;
  className?: string;
}

export function InlineError({ error, className }: InlineErrorProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 p-3 rounded-[10px] bg-red-500/10 border border-red-500/20",
        className
      )}
      role="alert"
    >
      <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
      <span className="text-body2 text-red-400">{error}</span>
    </div>
  );
}
