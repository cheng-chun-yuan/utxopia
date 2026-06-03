"use client";

import { Send } from "lucide-react";
import { FlowPageLayout } from "@/components/ui/flow-page-layout";
import { SendForm } from "@/components/send/send-form";
import { useChainEnvironment } from "@/lib/chain-environment";
import { getChainAdapter } from "@/lib/chain-registry";

export default function SendPage() {
  const chainEnv = useChainEnvironment();
  const chainLabel = getChainAdapter(chainEnv.config).id === "sui" ? "Sui" : "Solana";

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
      description={`Pay a Bitcoin address, ${chainLabel} wallet, private address, or claim link.`}
    >
      <SendForm />
    </FlowPageLayout>
  );
}
