"use client";

import { useState, Suspense } from "react";
import { ArrowUpFromLine } from "lucide-react";
import { FlowPageLayout } from "@/components/ui/flow-page-layout";
import { PaymentWizard } from "@/components/payment-wizard/payment-wizard";
import { ModeToggle } from "@/components/payment-wizard/mode-toggle";
import { unshieldConfig } from "@/components/payment-wizard/flows/unshield-config";
import { PayFlow } from "@/components/btc-widget/pay-flow";

export default function UnshieldPage() {
  const [mode, setMode] = useState<"lite" | "pro">("lite");

  return (
    <FlowPageLayout
      backHref="/vault"
      backLabel="Back"
      width={mode === "pro" ? 520 : 460}
      badges={[{ icon: <ArrowUpFromLine className="w-full h-full" />, label: "Unshield", color: "privacy" }]}
      titleIcon={<ArrowUpFromLine className="w-full h-full" />}
      title="Unshield"
      description="Withdraw shielded tokens to your Solana wallet"
    >
      <ModeToggle mode={mode} onChange={setMode} />
      {mode === "lite" ? (
        <PaymentWizard config={unshieldConfig} />
      ) : (
        <Suspense fallback={<div className="flex justify-center py-8"><div className="w-8 h-8 border-2 border-purple border-t-transparent rounded-full animate-spin" /></div>}>
          <PayFlow initialMode="public" />
        </Suspense>
      )}
    </FlowPageLayout>
  );
}
