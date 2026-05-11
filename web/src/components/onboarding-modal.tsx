"use client";

import { useState, useSyncExternalStore, useCallback } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Shield, ArrowDownToLine, Send, ArrowRight, X } from "lucide-react";
import { cn } from "@/lib/utils";

const ONBOARDING_STORAGE_KEY = "pcoin-onboarding-completed";

// Custom hook to check localStorage with SSR support
function useHasCompletedOnboarding() {
  const subscribe = useCallback((callback: () => void) => {
    window.addEventListener("storage", callback);
    return () => window.removeEventListener("storage", callback);
  }, []);

  const getSnapshot = useCallback(() => {
    return localStorage.getItem(ONBOARDING_STORAGE_KEY) === "true";
  }, []);

  const getServerSnapshot = useCallback(() => true, []); // Assume completed on server to avoid flash

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

interface OnboardingStep {
  title: string;
  description: string;
  icon: React.ReactNode;
}

const steps: OnboardingStep[] = [
  {
    title: "Send tokens privately",
    description:
      "Your transactions stay hidden. No one can see who sent what, how much, or to whom.",
    icon: <Shield className="w-8 h-8" />,
  },
  {
    title: "How it works",
    description:
      "Deposit any token. Send it privately to anyone. Cash out to your wallet or Bitcoin address anytime.",
    icon: <Send className="w-8 h-8" />,
  },
];

interface OnboardingModalProps {
  forceShow?: boolean;
  onComplete?: () => void;
}

export function OnboardingModal({ forceShow, onComplete }: OnboardingModalProps) {
  const hasCompleted = useHasCompletedOnboarding();
  const [dismissed, setDismissed] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);

  // Modal is open if forced, or if not completed and not dismissed
  const isOpen = forceShow || (!hasCompleted && !dismissed);

  const handleNext = () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      handleComplete();
    }
  };

  const handleSkip = () => {
    handleComplete();
  };

  const handleComplete = () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, "true");
    setDismissed(true);
    setCurrentStep(0);
    onComplete?.();
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setDismissed(true);
    }
  };

  const step = steps[currentStep];
  const isLastStep = currentStep === steps.length - 1;

  return (
    <Dialog.Root open={isOpen} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 animate-in fade-in-0" />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50",
            "w-[90vw] max-w-md p-6 rounded-[20px]",
            "bg-card border border-gray/30",
            "animate-in fade-in-0 zoom-in-95 slide-in-from-left-1/2 slide-in-from-top-[48%]",
            "focus:outline-none"
          )}
          aria-describedby="onboarding-description"
        >
          {/* Close button */}
          <Dialog.Close asChild>
            <button
              className="absolute right-4 top-4 p-1.5 rounded-full bg-gray/10 hover:bg-gray/20 text-gray transition-colors"
              aria-label="Close onboarding"
            >
              <X className="w-4 h-4" />
            </button>
          </Dialog.Close>

          {/* Step indicator */}
          <div className="flex justify-center gap-2 mb-6">
            {steps.map((_, index) => (
              <div
                key={index}
                className={cn(
                  "w-2 h-2 rounded-full transition-colors",
                  index === currentStep
                    ? "bg-privacy"
                    : index < currentStep
                    ? "bg-privacy/50"
                    : "bg-gray/30"
                )}
              />
            ))}
          </div>

          {/* Icon */}
          <div className="flex justify-center mb-4">
            <div className="p-4 rounded-full bg-privacy/10 text-privacy">
              {step.icon}
            </div>
          </div>

          {/* Content */}
          <Dialog.Title className="text-heading6 text-foreground text-center mb-3">
            {step.title}
          </Dialog.Title>
          <Dialog.Description
            id="onboarding-description"
            className="text-body2 text-gray text-center mb-8"
          >
            {step.description}
          </Dialog.Description>

          {/* Actions */}
          <div className="flex gap-3">
            {!isLastStep && (
              <button
                onClick={handleSkip}
                className={cn(
                  "flex-1 py-3 px-4 rounded-[12px]",
                  "text-body2 text-gray hover:text-gray-light",
                  "bg-gray/10 hover:bg-gray/15 transition-colors"
                )}
              >
                Skip
              </button>
            )}
            <button
              onClick={handleNext}
              className={cn(
                "flex-1 py-3 px-4 rounded-[12px]",
                "text-body2 text-background",
                "bg-privacy hover:bg-privacy/80 transition-colors",
                "flex items-center justify-center gap-2"
              )}
            >
              {isLastStep ? "Get Started" : "Next"}
              {!isLastStep && <ArrowRight className="w-4 h-4" />}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function useResetOnboarding() {
  return () => {
    localStorage.removeItem(ONBOARDING_STORAGE_KEY);
  };
}
