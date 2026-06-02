"use client";

import { Send } from "lucide-react";
import { FlowPageLayout } from "@/components/ui/flow-page-layout";
import { SendForm } from "@/components/send/send-form";

export default function SendPage() {
  return (
    <FlowPageLayout
      backHref="/vault"
      backLabel="Back"
      width={460}
      badges={[
        {
          icon: <Send className="w-full h-full" />,
          label: "Send",
          color: "privacy",
        },
      ]}
      titleIcon={<Send className="w-full h-full" />}
      title="Send"
      description="Pay a Bitcoin address, chain wallet, private address, or claim link."
    >
      <SendForm />
    </FlowPageLayout>
  );
}
