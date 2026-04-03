"use client";

import { useState, Suspense } from "react";
import { Send } from "lucide-react";
import { FlowPageLayout } from "@/components/ui/flow-page-layout";
import { PaymentWizard } from "@/components/payment-wizard/payment-wizard";
import { ModeToggle } from "@/components/payment-wizard/mode-toggle";
import { transferConfig } from "@/components/payment-wizard/flows/transfer-config";
import { PayFlow } from "@/components/btc-widget/pay-flow";

export default function TransferPage() {
  const [mode, setMode] = useState<"lite" | "pro">("lite");

  const txCount = typeof window !== "undefined"
    ? parseInt(localStorage.getItem("aegis-tx-count") || "0", 10)
    : 0;
  const showProToggle = txCount > 0;

  return (
    <FlowPageLayout
      backHref="/vault"
      backLabel="Back"
      width={mode === "pro" ? 520 : 460}
      badges={[{ icon: <Send className="w-full h-full" />, label: "Send", color: "purple" }]}
      titleIcon={<Send className="w-full h-full" />}
      title="Send"
      description="Send tokens privately to anyone"
    >
      {showProToggle && <ModeToggle mode={mode} onChange={setMode} />}
      {mode === "lite" ? (
        <PaymentWizard config={transferConfig} />
      ) : (
        <Suspense fallback={<div className="flex justify-center py-8"><div className="w-8 h-8 border-2 border-purple border-t-transparent rounded-full animate-spin" /></div>}>
          <PayFlow initialMode="stealth" />
        </Suspense>
      )}
    </FlowPageLayout>
  );
}
