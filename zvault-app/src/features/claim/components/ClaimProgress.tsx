"use client";

import { Shield, Send, Radio, Zap, Coins } from "lucide-react";
import { FlowProgress, type ProgressStep } from "@/features/shared/components";
import type { ClaimProgress as ClaimProgressType } from "../types";

const PROGRESS_STEPS: ProgressStep<ClaimProgressType>[] = [
  {
    id: "generating_proof",
    label: "Generating Proof",
    description: "Creating ZK proof for privacy",
    icon: <Shield className="w-4 h-4" />,
  },
  {
    id: "submitting",
    label: "Submitting",
    description: "Sending to relayer",
    icon: <Send className="w-4 h-4" />,
  },
  {
    id: "relaying",
    label: "Relaying",
    description: "Processing transaction",
    icon: <Radio className="w-4 h-4" />,
  },
  {
    id: "confirming",
    label: "Confirming",
    description: "Waiting for Solana",
    icon: <Zap className="w-4 h-4" />,
  },
];

function getProgressLabel(progress: ClaimProgressType): string {
  switch (progress) {
    case "generating_proof":
      return "Generating ZK proof...";
    case "submitting":
      return "Submitting to relayer...";
    case "relaying":
      return "Relayer processing...";
    case "confirming":
      return "Confirming on Solana...";
    case "complete":
      return "Complete!";
    default:
      return "";
  }
}

interface ClaimProgressIndicatorProps {
  progress: ClaimProgressType;
}

export function ClaimProgressIndicator({ progress }: ClaimProgressIndicatorProps) {
  if (progress === "idle") return null;

  const completedStep = progress === "complete" ? "confirming" : undefined;

  return (
    <div className="flex flex-col py-4">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="relative w-12 h-12">
          <div className="absolute inset-0 rounded-full border-4 border-gray/15" />
          <div className="absolute inset-0 rounded-full border-4 border-purple border-t-transparent animate-spin" />
          <div className="absolute inset-0 flex items-center justify-center">
            <Coins className="w-5 h-5 text-purple" />
          </div>
        </div>
        <div>
          <p className="text-body2-semibold text-foreground">Claiming zBTC</p>
          <p className="text-caption text-gray">{getProgressLabel(progress)}</p>
        </div>
      </div>

      {/* Progress indicator */}
      <div className="p-4 bg-muted border border-gray/15 rounded-[12px]">
        <FlowProgress
          steps={PROGRESS_STEPS}
          currentStep={progress}
          completedStep={completedStep}
        />
      </div>

      {/* Privacy note */}
      <div className="mt-4 flex items-center gap-2 p-3 bg-privacy/10 border border-privacy/20 rounded-[12px]">
        <Shield className="w-4 h-4 text-privacy shrink-0" />
        <p className="text-caption text-privacy">
          Your transaction is being relayed privately. No direct link to your deposit.
        </p>
      </div>
    </div>
  );
}
