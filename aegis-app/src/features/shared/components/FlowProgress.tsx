"use client";

import { CheckCircle2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ProgressStep<T extends string> {
  id: T;
  label: string;
  description: string;
  icon: React.ReactNode;
}

interface FlowProgressProps<T extends string> {
  steps: ProgressStep<T>[];
  currentStep: T;
  completedStep?: T;
}

function getStepStatus<T extends string>(
  steps: ProgressStep<T>[],
  currentStep: T,
  completedStep: T | undefined,
  stepId: T
): "pending" | "active" | "complete" {
  const stepOrder = steps.map((s) => s.id);
  const currentIndex = stepOrder.indexOf(currentStep);
  const stepIndex = stepOrder.indexOf(stepId);

  if (completedStep && stepOrder.indexOf(completedStep) >= stepIndex) {
    return "complete";
  }
  if (stepIndex < currentIndex) return "complete";
  if (stepIndex === currentIndex) return "active";
  return "pending";
}

/**
 * Reusable progress indicator for multi-step flows.
 * Used across claim, pay, and other transaction flows.
 */
export function FlowProgress<T extends string>({
  steps,
  currentStep,
  completedStep,
}: FlowProgressProps<T>) {
  return (
    <div className="space-y-3">
      {steps.map((step, index) => {
        const status = getStepStatus(steps, currentStep, completedStep, step.id);
        const isLast = index === steps.length - 1;

        return (
          <div key={step.id} className="flex items-start gap-3">
            {/* Step indicator */}
            <div className="flex flex-col items-center">
              <div
                className={cn(
                  "w-8 h-8 rounded-full flex items-center justify-center transition-all duration-300",
                  status === "complete" && "bg-success/20 text-success",
                  status === "active" && "bg-purple/20 text-purple animate-pulse",
                  status === "pending" && "bg-gray/10 text-gray"
                )}
              >
                {status === "complete" ? (
                  <CheckCircle2 className="w-4 h-4" />
                ) : status === "active" ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  step.icon
                )}
              </div>
              {/* Connector line */}
              {!isLast && (
                <div
                  className={cn(
                    "w-0.5 h-6 mt-1 transition-colors duration-300",
                    status === "complete" ? "bg-success/40" : "bg-gray/20"
                  )}
                />
              )}
            </div>

            {/* Step content */}
            <div className="flex-1 pt-1">
              <p
                className={cn(
                  "text-body2-semibold transition-colors",
                  status === "complete" && "text-success",
                  status === "active" && "text-purple",
                  status === "pending" && "text-gray"
                )}
              >
                {step.label}
              </p>
              <p className="text-caption text-gray">{step.description}</p>
            </div>

            {/* Status badge */}
            <div className="pt-1">
              {status === "complete" && (
                <span className="text-caption text-success">Done</span>
              )}
              {status === "active" && (
                <span className="text-caption text-purple animate-pulse">
                  Processing...
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
