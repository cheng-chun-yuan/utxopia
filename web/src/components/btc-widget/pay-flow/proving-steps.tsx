"use client";

/**
 * Proving Sub-Steps — visual progress indicator for ZK proof generation.
 * Shows step-by-step progress from initialization through on-chain submission.
 */

import { CheckCircle2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const PROVING_SUB_STEPS = [
  { match: "Initializing", label: "Initializing" },
  { match: "Fetching", label: "Fetching Merkle proofs" },
  { match: "Deriving", label: "Deriving stealth keys" },
  { match: "Preparing", label: "Preparing outputs" },
  { match: "Signing", label: "Signing transaction" },
  { match: "Generating", label: "Generating ZK proof" },
  { match: "Submitting", label: "Submitting on-chain" },
];

function getProvingSubStepIndex(status: string): number {
  for (let i = PROVING_SUB_STEPS.length - 1; i >= 0; i--) {
    if (status.startsWith(PROVING_SUB_STEPS[i].match)) return i;
  }
  return 0;
}

export function ProvingSubSteps({ status }: { status: string }) {
  const currentIdx = getProvingSubStepIndex(status);

  return (
    <div className="w-full space-y-1.5">
      {PROVING_SUB_STEPS.map((sub, i) => {
        const isComplete = i < currentIdx;
        const isCurrent = i === currentIdx;
        const isPending = i > currentIdx;

        return (
          <div key={sub.match} className="flex items-center gap-3">
            <div className="w-5 h-5 flex items-center justify-center shrink-0">
              {isComplete ? (
                <CheckCircle2 className="w-4.5 h-4.5 text-success" />
              ) : isCurrent ? (
                <Loader2 className="w-4.5 h-4.5 text-purple animate-spin" />
              ) : (
                <div className="w-3.5 h-3.5 rounded-full border-2 border-gray/25" />
              )}
            </div>
            <span
              className={cn(
                "text-body2 transition-colors",
                isComplete && "text-success",
                isCurrent && "text-foreground font-medium",
                isPending && "text-gray/40",
              )}
            >
              {sub.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
