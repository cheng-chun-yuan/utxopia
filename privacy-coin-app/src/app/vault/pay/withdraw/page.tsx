"use client";

import { useState, Suspense } from "react";
import { Bitcoin } from "lucide-react";
import { FlowPageLayout } from "@/components/ui/flow-page-layout";
import { PaymentWizard } from "@/components/payment-wizard/payment-wizard";
import { ModeToggle } from "@/components/payment-wizard/mode-toggle";
import { withdrawConfig } from "@/components/payment-wizard/flows/withdraw-config";
import { PayFlow } from "@/components/btc-widget/pay-flow";

export default function WithdrawPage() {
  const [mode, setMode] = useState<"lite" | "pro">("lite");

  return (
    <FlowPageLayout
      backHref="/vault"
      backLabel="Back"
      width={mode === "pro" ? 520 : 460}
      badges={[{ icon: <Bitcoin className="w-full h-full" />, label: "Withdraw", color: "btc" }]}
      titleIcon={<Bitcoin className="w-full h-full" />}
      title="BTC Withdraw"
      description="Withdraw shielded BTC to a Bitcoin address"
    >
      <ModeToggle mode={mode} onChange={setMode} />
      {mode === "lite" ? (
        <PaymentWizard config={withdrawConfig} />
      ) : (
        <Suspense fallback={<div className="flex justify-center py-8"><div className="w-8 h-8 border-2 border-purple border-t-transparent rounded-full animate-spin" /></div>}>
          <PayFlow initialMode="btc_withdraw" />
        </Suspense>
      )}
    </FlowPageLayout>
  );
}
