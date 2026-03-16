"use client";

import { useState } from "react";
import { ArrowDownToLine, Shield } from "lucide-react";
import { FlowPageLayout } from "@/components/ui/flow-page-layout";
import { DepositFlow } from "@/components/btc-widget/deposit-flow";
import { ShieldFlow } from "@/components/shield-flow";
import { BitcoinIcon } from "@/components/bitcoin-wallet-selector";

type DepositMode = "btc" | "spl";

export default function DepositPage() {
  const [mode, setMode] = useState<DepositMode>("btc");

  return (
    <FlowPageLayout
      backHref="/vault"
      backLabel="Back"
      badges={[
        {
          icon: mode === "btc"
            ? <BitcoinIcon className="w-full h-full" />
            : <Shield className="w-full h-full" />,
          label: mode === "btc" ? "BTC Deposit" : "Shield Token",
          color: mode === "btc" ? "btc" : "privacy",
        },
      ]}
      titleIcon={<ArrowDownToLine className="w-full h-full" />}
      title={mode === "btc" ? "Deposit BTC" : "Shield SPL Token"}
      description={
        mode === "btc"
          ? "Send BTC to receive private shielded tokens"
          : "Deposit any supported SPL token into the privacy pool"
      }
    >
      {/* Mode Tabs */}
      <div className="flex gap-2 mb-6">
        <button
          onClick={() => setMode("btc")}
          className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
            mode === "btc"
              ? "bg-orange-500/20 text-orange-300 border border-orange-500/30"
              : "bg-zinc-800/50 text-zinc-400 border border-zinc-700 hover:border-zinc-600"
          }`}
        >
          <span className="flex items-center justify-center gap-2">
            <BitcoinIcon className="w-4 h-4" />
            BTC Deposit
          </span>
        </button>
        <button
          onClick={() => setMode("spl")}
          className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
            mode === "spl"
              ? "bg-blue-500/20 text-blue-300 border border-blue-500/30"
              : "bg-zinc-800/50 text-zinc-400 border border-zinc-700 hover:border-zinc-600"
          }`}
        >
          <span className="flex items-center justify-center gap-2">
            <Shield className="w-4 h-4" />
            Shield Token
          </span>
        </button>
      </div>

      {/* Flow Content */}
      {mode === "btc" ? <DepositFlow /> : <ShieldFlow />}
    </FlowPageLayout>
  );
}
