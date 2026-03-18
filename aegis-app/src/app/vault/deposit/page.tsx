"use client";

import { ArrowDownToLine, Shield } from "lucide-react";
import { FlowPageLayout } from "@/components/ui/flow-page-layout";
import { ShieldFlow } from "@/components/shield-flow";

export default function DepositPage() {
  return (
    <FlowPageLayout
      backHref="/vault"
      backLabel="Back"
      width={520}
      badges={[
        {
          icon: <Shield className="w-full h-full" />,
          label: "Shield",
          color: "privacy",
        },
      ]}
      titleIcon={<ArrowDownToLine className="w-full h-full" />}
      title="Shield Tokens"
      description="Deposit any token into the privacy pool"
    >
      <ShieldFlow />
    </FlowPageLayout>
  );
}
