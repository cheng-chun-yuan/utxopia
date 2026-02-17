"use client";

import { CheckCircle, Circle, Loader2, XCircle } from "lucide-react";
import {
  type DepositStatus,
  getDepositProgress,
  getStatusMessage,
} from "@/lib/api/deposits";

interface DepositProgressProps {
  status: DepositStatus;
  confirmations: number;
  sweepConfirmations: number;
  className?: string;
}

interface ProgressStep {
  id: string;
  label: string;
  statuses: DepositStatus[];
}

const PROGRESS_STEPS: ProgressStep[] = [
  {
    id: "pending",
    label: "Waiting for Deposit",
    statuses: ["pending"],
  },
  {
    id: "confirming",
    label: "Confirming",
    statuses: ["detected", "confirming"],
  },
  {
    id: "sweeping",
    label: "Pool Sweep",
    statuses: ["confirmed", "sweeping", "sweep_confirming"],
  },
  {
    id: "verifying",
    label: "SPV Verification",
    statuses: ["verifying"],
  },
  {
    id: "ready",
    label: "Ready to Claim",
    statuses: ["ready"],
  },
];

function getStepStatus(
  step: ProgressStep,
  currentStatus: DepositStatus
): "complete" | "current" | "pending" | "failed" {
  if (currentStatus === "failed") {
    return "failed";
  }

  if (currentStatus === "claimed") {
    return "complete";
  }

  const allStatuses: DepositStatus[] = [
    "pending",
    "detected",
    "confirming",
    "confirmed",
    "sweeping",
    "sweep_confirming",
    "verifying",
    "ready",
  ];

  const currentIndex = allStatuses.indexOf(currentStatus);
  const stepFirstStatus = step.statuses[0];
  const stepLastStatus = step.statuses[step.statuses.length - 1];
  const stepFirstIndex = allStatuses.indexOf(stepFirstStatus);
  const stepLastIndex = allStatuses.indexOf(stepLastStatus);

  if (currentIndex > stepLastIndex) {
    return "complete";
  }

  if (step.statuses.includes(currentStatus)) {
    return "current";
  }

  return "pending";
}

export function DepositProgress({
  status,
  confirmations,
  sweepConfirmations,
  className = "",
}: DepositProgressProps) {
  const progress = getDepositProgress(status, confirmations, sweepConfirmations);
  const statusMessage = getStatusMessage(status);

  return (
    <div className={`space-y-4 ${className}`}>
      {/* Progress Bar */}
      <div className="relative">
        <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
          <div
            className={`h-full transition-all duration-500 ease-out ${
              status === "failed" ? "bg-red-500" : "bg-emerald-500"
            }`}
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="absolute -top-1 text-xs text-zinc-400 right-0">
          {progress}%
        </div>
      </div>

      {/* Status Message */}
      <div className="flex items-center gap-2 text-sm">
        {status === "failed" ? (
          <XCircle className="h-4 w-4 text-red-500" />
        ) : status === "claimed" ? (
          <CheckCircle className="h-4 w-4 text-emerald-500" />
        ) : (
          <Loader2 className="h-4 w-4 animate-spin text-amber-500" />
        )}
        <span className="text-zinc-300">{statusMessage}</span>
        {status === "confirming" && (
          <span className="text-zinc-500">({confirmations}/1)</span>
        )}
        {status === "sweep_confirming" && (
          <span className="text-zinc-500">({sweepConfirmations}/2)</span>
        )}
      </div>

      {/* Steps */}
      <div className="flex justify-between mt-4">
        {PROGRESS_STEPS.map((step, index) => {
          const stepStatus = getStepStatus(step, status);
          return (
            <div key={step.id} className="flex flex-col items-center flex-1">
              <div className="relative flex items-center justify-center w-full">
                {/* Connecting Line */}
                {index > 0 && (
                  <div
                    className={`absolute left-0 right-1/2 h-0.5 top-1/2 -translate-y-1/2 ${
                      stepStatus === "complete" || stepStatus === "current"
                        ? "bg-emerald-500"
                        : stepStatus === "failed"
                        ? "bg-red-500/50"
                        : "bg-zinc-700"
                    }`}
                  />
                )}
                {index < PROGRESS_STEPS.length - 1 && (
                  <div
                    className={`absolute left-1/2 right-0 h-0.5 top-1/2 -translate-y-1/2 ${
                      stepStatus === "complete"
                        ? "bg-emerald-500"
                        : "bg-zinc-700"
                    }`}
                  />
                )}

                {/* Step Indicator */}
                <div
                  className={`relative z-10 flex items-center justify-center w-8 h-8 rounded-full border-2 transition-colors ${
                    stepStatus === "complete"
                      ? "bg-emerald-500 border-emerald-500"
                      : stepStatus === "current"
                      ? "bg-zinc-900 border-amber-500"
                      : stepStatus === "failed"
                      ? "bg-zinc-900 border-red-500"
                      : "bg-zinc-900 border-zinc-700"
                  }`}
                >
                  {stepStatus === "complete" ? (
                    <CheckCircle className="w-5 h-5 text-white" />
                  ) : stepStatus === "current" ? (
                    <Loader2 className="w-4 h-4 animate-spin text-amber-500" />
                  ) : stepStatus === "failed" ? (
                    <XCircle className="w-5 h-5 text-red-500" />
                  ) : (
                    <Circle className="w-4 h-4 text-zinc-600" />
                  )}
                </div>
              </div>

              {/* Step Label */}
              <span
                className={`mt-2 text-xs text-center ${
                  stepStatus === "complete"
                    ? "text-emerald-400"
                    : stepStatus === "current"
                    ? "text-amber-400"
                    : stepStatus === "failed"
                    ? "text-red-400"
                    : "text-zinc-500"
                }`}
              >
                {step.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default DepositProgress;
