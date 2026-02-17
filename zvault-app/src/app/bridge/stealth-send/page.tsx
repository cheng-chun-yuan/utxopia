"use client";

import { Suspense } from "react";
import { Send, Shield, Loader2 } from "lucide-react";
import { FlowPageLayout } from "@/components/ui/flow-page-layout";
import { StealthSendFlow } from "@/components/stealth-send-flow";

function StealthSendFlowWrapper() {
  return <StealthSendFlow />;
}

export default function StealthSendPage() {
  return (
    <FlowPageLayout
      backHref="/bridge"
      backLabel="Back"
      badges={[
        {
          icon: <Shield className="w-full h-full" />,
          label: "Private",
          color: "privacy",
        },
      ]}
      titleIcon={<Send className="w-full h-full" />}
      title="Stealth Send"
      description="Send BTC privately to a stealth address"
      width={480}
    >
      <Suspense fallback={<div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-privacy" /></div>}>
        <StealthSendFlowWrapper />
      </Suspense>
    </FlowPageLayout>
  );
}
