"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Send } from "lucide-react";
import { FlowPageLayout } from "@/components/ui/flow-page-layout";
import { PayFlow } from "@/components/btc-widget/pay-flow";

function PayFlowWithParams() {
  const searchParams = useSearchParams();

  const initialMode = searchParams.get("mode") as "public" | "stealth" | null;
  const commitment = searchParams.get("commitment");
  const leafIndex = searchParams.get("leafIndex");
  const amount = searchParams.get("amount");

  return (
    <PayFlow
      initialMode={initialMode || undefined}
      preselectedNote={
        commitment && leafIndex && amount
          ? { commitment, leafIndex: Number(leafIndex), amount: BigInt(amount) }
          : undefined
      }
    />
  );
}

export default function PayPage() {
  return (
    <FlowPageLayout
      backHref="/bridge"
      backLabel="Back"
      badges={[
        {
          icon: <Send className="w-full h-full" />,
          label: "Pay",
          color: "purple",
        },
      ]}
      titleIcon={<Send className="w-full h-full" />}
      title="Pay with zkBTC"
      description="Send zkBTC publicly or privately"
    >
      <Suspense fallback={<div className="flex items-center justify-center py-8"><div className="w-8 h-8 border-2 border-purple border-t-transparent rounded-full animate-spin" /></div>}>
        <PayFlowWithParams />
      </Suspense>
    </FlowPageLayout>
  );
}
