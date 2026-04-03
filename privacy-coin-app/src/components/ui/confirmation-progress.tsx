"use client";

import { memo, useMemo } from "react";
import { motion } from "framer-motion";

interface ConfirmationProgressProps {
  confirmations: number;
  required: number;
}

export const ConfirmationProgress = memo(function ConfirmationProgress({
  confirmations,
  required,
}: ConfirmationProgressProps) {
  const pct = useMemo(
    () => Math.min((confirmations / required) * 100, 100),
    [confirmations, required]
  );
  const isComplete = pct >= 100;

  return (
    <div className="w-full bg-secondary rounded-full h-2 overflow-hidden relative">
      <motion.div
        className="h-2 rounded-full relative"
        style={{
          background: isComplete
            ? "linear-gradient(90deg, #14f195, #4ade80)"
            : "linear-gradient(90deg, #f7931a, #ffa940)",
        }}
        initial={{ width: 0 }}
        animate={{ width: `${pct}%` }}
        transition={{ duration: 0.5, ease: "easeOut" }}
      >
        {/* Pulsing glow on leading edge */}
        {!isComplete && pct > 0 && (
          <motion.div
            className="absolute right-0 top-0 bottom-0 w-4 rounded-full"
            style={{
              background: "radial-gradient(circle at right, rgba(247,147,26,0.6), transparent)",
            }}
            animate={{ opacity: [0.4, 1, 0.4] }}
            transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
          />
        )}
      </motion.div>

      {/* Completion flash */}
      {isComplete && (
        <motion.div
          className="absolute inset-0 rounded-full"
          style={{ background: "rgba(74, 222, 128, 0.3)" }}
          initial={{ opacity: 0 }}
          animate={{ opacity: [0.6, 0] }}
          transition={{ duration: 0.8 }}
        />
      )}
    </div>
  );
});

ConfirmationProgress.displayName = "ConfirmationProgress";
