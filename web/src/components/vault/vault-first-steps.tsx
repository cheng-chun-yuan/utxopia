"use client";

import Link from "next/link";
import { CheckCircle2, Circle, PlusCircle, Send, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";

interface VaultFirstStepsProps {
  hasBackup: boolean;
  hasFunds: boolean;
  depositHref?: string;
}

const steps = [
  {
    id: "backup",
    title: "Back up private wallet",
    description: "Required before sending. Keeps private funds recoverable.",
    icon: ShieldCheck,
  },
  {
    id: "fund",
    title: "Add funds",
    description: "Deposit to your own private address by default.",
    icon: PlusCircle,
  },
  {
    id: "send",
    title: "Send privately",
    description: "Pay a private address, chain wallet, Bitcoin address, or claim link.",
    icon: Send,
  },
] as const;

export function VaultFirstSteps({ hasBackup, hasFunds, depositHref = "/vault/deposit" }: VaultFirstStepsProps) {
  const complete = {
    backup: hasBackup,
    fund: hasFunds,
    send: false,
  };

  if (hasFunds && hasBackup) return null;

  return (
    <div className="mb-4 rounded-[12px] border border-privacy/15 bg-privacy/5 p-3">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-body2-semibold text-foreground">Start here</p>
          <p className="mt-0.5 text-caption text-gray">
            Finish these once, then use the wallet normally.
          </p>
        </div>
        <Link
          href={depositHref}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-[8px] bg-privacy px-3 py-2 text-caption font-semibold text-background transition-colors hover:bg-privacy/90"
        >
          <PlusCircle className="h-3.5 w-3.5" />
          Add funds
        </Link>
      </div>

      <div className="space-y-2">
        {steps.map((step) => {
          const isDone = complete[step.id];
          const Icon = step.icon;
          return (
            <div
              key={step.id}
              className={cn(
                "flex items-start gap-2.5 rounded-[9px] px-2.5 py-2",
                isDone ? "bg-privacy/5" : "bg-muted/30",
              )}
            >
              <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
                {isDone ? (
                  <CheckCircle2 className="h-4 w-4 text-privacy" />
                ) : (
                  <Circle className="h-4 w-4 text-gray/45" />
                )}
              </div>
              <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", isDone ? "text-privacy" : "text-gray/60")} />
              <div className="min-w-0">
                <p className={cn("text-caption font-semibold", isDone ? "text-privacy" : "text-foreground")}>
                  {step.title}
                </p>
                <p className="text-[11px] text-gray/60">{step.description}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
