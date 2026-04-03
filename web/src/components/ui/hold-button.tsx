"use client";

import { useState, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";

interface HoldButtonProps {
  onComplete: () => void;
  holdDuration?: number;
  children: React.ReactNode;
  className?: string;
  progressClassName?: string;
  title?: string;
}

export function HoldButton({
  onComplete,
  holdDuration = 1500,
  children,
  className,
  progressClassName,
  title,
}: HoldButtonProps) {
  const [holding, setHolding] = useState(false);
  const [progress, setProgress] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef(0);

  const startHold = useCallback(() => {
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
  }, [holdDuration, onComplete]);

  const cancelHold = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setHolding(false);
    setProgress(0);
  }, []);

  return (
    <button
      onMouseDown={startHold}
      onMouseUp={cancelHold}
      onMouseLeave={cancelHold}
      onTouchStart={startHold}
      onTouchEnd={cancelHold}
      onTouchCancel={cancelHold}
      className={cn("relative overflow-hidden select-none", className)}
      title={title}
    >
      {/* Progress fill */}
      {holding && (
        <div
          className={cn(
            "absolute inset-0 opacity-20 transition-none pointer-events-none",
            progressClassName || "bg-btc"
          )}
          style={{ width: `${progress * 100}%` }}
        />
      )}
      <span className="relative z-10 flex items-center gap-1.5">
        {children}
      </span>
    </button>
  );
}
