"use client";

import { ArrowDownToLine } from "lucide-react";
import { FlowPageLayout } from "@/components/ui/flow-page-layout";
import { DepositFlow } from "@/components/btc-widget/deposit-flow";
import { BitcoinIcon } from "@/components/bitcoin-wallet-selector";

export default function DepositPage() {
  return (
    <FlowPageLayout
      backHref="/bridge"
      backLabel="Back"
      badges={[
        {
          icon: <BitcoinIcon className="w-full h-full" />,
          label: "Deposit",
          color: "btc",
        },
      ]}
      titleIcon={<ArrowDownToLine className="w-full h-full" />}
      title="Deposit BTC"
      description="Send BTC to receive private zBTC tokens"
    >
      <DepositFlow />
    </FlowPageLayout>
  );
}
