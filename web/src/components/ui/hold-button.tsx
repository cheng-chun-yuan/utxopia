"use client";

import { useState, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";

/**
 * Visual variants — pick by *meaning*, not color:
 *  - "primary": affirmative commit (sending, signing). Dark base so the
 *    button is restrained at rest; privacy-green progress fill conveys
 *    the hold-and-commit motion.
 *  - "warning": destructive or sensitive action (exporting a viewing
 *    key, revealing a secret). Bitcoin orange so the user knows they're
 *    leaving the safe path.
 */
export type HoldVariant = "primary" | "warning";

interface HoldButtonProps {
  onComplete: () => void;
  holdDuration?: number;
  variant?: HoldVariant;
  children: React.ReactNode;
  /** Extra utility classes — appended last, so size/layout overrides win. */
  className?: string;
  title?: string;
  disabled?: boolean;
}

const VARIANT_STYLES: Record<
  HoldVariant,
  { base: string; progress: string }
> = {
  primary: {
    base: cn(
      "bg-muted/60 text-foreground border border-gray/15",
      "hover:bg-muted/80 active:bg-muted",
    ),
    progress: "bg-privacy/35",
  },
  warning: {
    base: cn(
      "bg-btc/10 text-btc border border-btc/20",
      "hover:bg-btc/15 active:bg-btc/20",
    ),
    progress: "bg-btc/30",
  },
};

export function HoldButton({
  onComplete,
  holdDuration = 1500,
  variant = "primary",
  children,
  className,
  title,
  disabled = false,
}: HoldButtonProps) {
  const [holding, setHolding] = useState(false);
  const [progress, setProgress] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef(0);

  const startHold = useCallback(() => {
    if (disabled) return;
    setHolding(true);
    setProgress(0);
    startTimeRef.current = Date.now();

    intervalRef.current = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current;
      const pct = Math.min(elapsed / holdDuration, 1);
      setProgress(pct);

      if (pct >= 1) {
        if (intervalRef.current) clearInterval(intervalRef.current);
        intervalRef.current = null;
        setHolding(false);
        setProgress(0);
        onComplete();
      }
    }, 16);
  }, [holdDuration, onComplete, disabled]);

  const cancelHold = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setHolding(false);
    setProgress(0);
  }, []);

  const styles = VARIANT_STYLES[variant];

  return (
    <button
      type="button"
      onMouseDown={startHold}
      onMouseUp={cancelHold}
      onMouseLeave={cancelHold}
      onTouchStart={startHold}
      onTouchEnd={cancelHold}
      onTouchCancel={cancelHold}
      disabled={disabled}
      title={title}
      className={cn(
        "relative overflow-hidden select-none transition-colors duration-200",
        "px-4 py-3 rounded-lg text-sm font-medium",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        styles.base,
        className,
      )}
    >
      {holding && (
        <div
          className={cn(
            "absolute inset-0 pointer-events-none transition-none",
            styles.progress,
          )}
          style={{ width: `${progress * 100}%` }}
          aria-hidden
        />
      )}
      <span className="relative z-10 flex items-center justify-center gap-1.5">
        {children}
      </span>
    </button>
  );
}
