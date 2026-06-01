"use client";

import { AlertTriangle } from "lucide-react";

interface BackupRequiredCalloutProps {
  visible: boolean;
}

export function BackupRequiredCallout({ visible }: BackupRequiredCalloutProps) {
  if (!visible) return null;

  return (
    <div className="rounded-[10px] border border-warning/25 bg-warning/10 p-3 text-caption text-warning">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          Back up your private vault from the Vault page before sending or withdrawing funds.
        </span>
      </div>
    </div>
  );
}
