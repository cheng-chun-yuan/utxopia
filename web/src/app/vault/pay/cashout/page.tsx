"use client";

import { useState, Suspense } from "react";
import { ArrowUpFromLine, Bitcoin, Wallet } from "lucide-react";
import { cn } from "@/lib/utils";
import { FlowPageLayout } from "@/components/ui/flow-page-layout";
import { PaymentWizard } from "@/components/payment-wizard/payment-wizard";
import { ModeToggle } from "@/components/payment-wizard/mode-toggle";
import { unshieldConfig } from "@/components/payment-wizard/flows/unshield-config";
import { withdrawConfig } from "@/components/payment-wizard/flows/withdraw-config";
import { PayFlow } from "@/components/btc-widget/pay-flow";

type CashOutTarget = "solana" | "bitcoin";

export default function CashOutPage() {
  const [target, setTarget] = useState<CashOutTarget | null>(null);
  const [uiMode, setUiMode] = useState<"lite" | "pro">("lite");

  // Show tx count from localStorage to decide if Pro toggle is visible
  const txCount = typeof window !== "undefined"
    ? parseInt(localStorage.getItem("aegis-tx-count") || "0", 10)
    : 0;
  const showProToggle = txCount > 0;

  // Destination picker
  if (!target) {
    return (
      <FlowPageLayout
        backHref="/vault"
        backLabel="Back"
        width={460}
        badges={[{ icon: <ArrowUpFromLine className="w-full h-full" />, label: "Cash Out", color: "btc" }]}
        titleIcon={<ArrowUpFromLine className="w-full h-full" />}
        title="Cash Out"
        description="Where do you want your tokens?"
      >
        <div className="space-y-3 py-2">
          <button
            onClick={() => setTarget("solana")}
            className={cn(
              "w-full flex items-center gap-4 p-4 rounded-xl",
              "bg-muted/40 border border-gray/15 hover:border-privacy/30 hover:bg-privacy/5",
              "transition-all duration-200 cursor-pointer group"
            )}
          >
            <div className="w-11 h-11 rounded-full bg-privacy/10 border border-privacy/20 flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform">
              <Wallet className="w-5 h-5 text-privacy" />
            </div>
            <div className="text-left">
              <p className="text-sm font-medium text-foreground">Solana Wallet</p>
              <p className="text-xs text-gray/50">Withdraw tokens to your connected wallet</p>
            </div>
          </button>

          <button
            onClick={() => setTarget("bitcoin")}
            className={cn(
              "w-full flex items-center gap-4 p-4 rounded-xl",
              "bg-muted/40 border border-gray/15 hover:border-btc/30 hover:bg-btc/5",
              "transition-all duration-200 cursor-pointer group"
            )}
          >
            <div className="w-11 h-11 rounded-full bg-btc/10 border border-btc/20 flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform">
              <Bitcoin className="w-5 h-5 text-btc" />
            </div>
            <div className="text-left">
              <p className="text-sm font-medium text-foreground">Bitcoin Address</p>
              <p className="text-xs text-gray/50">Withdraw BTC to any Bitcoin address</p>
            </div>
          </button>
        </div>
      </FlowPageLayout>
    );
  }

  // Flow based on selected target
  const config = target === "solana" ? unshieldConfig : withdrawConfig;
  const flowTitle = target === "solana" ? "Cash Out to Solana" : "Cash Out to Bitcoin";
  const flowDesc = target === "solana" ? "Withdraw tokens to your Solana wallet" : "Withdraw BTC to a Bitcoin address";
  const flowIcon = target === "solana" ? <Wallet className="w-full h-full" /> : <Bitcoin className="w-full h-full" />;
  const flowColor = target === "solana" ? "privacy" as const : "btc" as const;
  const initialMode = target === "solana" ? "public" as const : "btc_withdraw" as const;

  return (
    <FlowPageLayout
      backHref="/vault/pay/cashout"
      backLabel="Back"
      width={uiMode === "pro" ? 520 : 460}
      badges={[{ icon: flowIcon, label: "Cash Out", color: flowColor }]}
      titleIcon={flowIcon}
      title={flowTitle}
      description={flowDesc}
    >
      {showProToggle && <ModeToggle mode={uiMode} onChange={setUiMode} />}
      {uiMode === "lite" ? (
        <PaymentWizard config={config} />
      ) : (
        <Suspense fallback={<div className="flex justify-center py-8"><div className="w-8 h-8 border-2 border-purple border-t-transparent rounded-full animate-spin" /></div>}>
          <PayFlow initialMode={initialMode} />
        </Suspense>
      )}
    </FlowPageLayout>
  );
}
