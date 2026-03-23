"use client";

import { CheckCircle2, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
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
              <AnimatePresence mode="wait" initial={false}>
                {status === "complete" ? (
                  <motion.div
                    key="complete"
                    className="w-8 h-8 rounded-full flex items-center justify-center bg-success/20 text-success"
                    initial={{ scale: 0.6, opacity: 0 }}
                    animate={{
                      scale: [1.15, 1],
                      opacity: 1,
                      boxShadow: ["0 0 16px rgba(74,222,128,0.3)", "0 0 0 rgba(74,222,128,0)"],
                    }}
                    transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                  >
                    <CheckCircle2 className="w-4 h-4" />
                  </motion.div>
                ) : status === "active" ? (
                  <motion.div
                    key="active"
                    className="w-8 h-8 rounded-full flex items-center justify-center bg-purple/20 text-purple"
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ duration: 0.3 }}
                  >
                    <Loader2 className="w-4 h-4 animate-spin" />
                  </motion.div>
                ) : (
                  <motion.div
                    key="pending"
                    className="w-8 h-8 rounded-full flex items-center justify-center bg-gray/10 text-gray"
                    initial={{ opacity: 0.5 }}
                    animate={{ opacity: 1 }}
                  >
                    {step.icon}
                  </motion.div>
                )}
              </AnimatePresence>
              {/* Connector line */}
              {!isLast && (
                <div className="relative w-0.5 h-6 mt-1 bg-gray/20 overflow-hidden">
                  <motion.div
                    className="absolute inset-0 bg-success/60"
                    initial={{ scaleY: 0 }}
                    animate={{ scaleY: status === "complete" ? 1 : 0 }}
                    transition={{ duration: 0.4, delay: 0.2, ease: "easeOut" }}
                    style={{ transformOrigin: "top" }}
                  />
                </div>
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
                <motion.span
                  className="text-caption text-success"
                  initial={{ opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.3 }}
                >
                  Done
                </motion.span>
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
