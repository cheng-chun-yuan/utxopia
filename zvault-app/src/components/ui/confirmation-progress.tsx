"use client";

import { memo, useMemo } from "react";

interface ConfirmationProgressProps {
  confirmations: number;
  required: number;
}

export const ConfirmationProgress = memo(function ConfirmationProgress({
  confirmations,
  required,
}: ConfirmationProgressProps) {
  const width = useMemo(
    () => `${(confirmations / required) * 100}%`,
    [confirmations, required]
  );

  return (
    <div className="w-full bg-secondary rounded-full h-2">
      <div
        className="bg-primary h-2 rounded-full transition-all"
        style={{ width }}
      />
    </div>
  );
});

ConfirmationProgress.displayName = "ConfirmationProgress";
