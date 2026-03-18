"use client";

import { Suspense, useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { Send } from "lucide-react";
import { FlowPageLayout } from "@/components/ui/flow-page-layout";
import { PayFlow } from "@/components/btc-widget/pay-flow";

function PayFlowWithParams() {
  const searchParams = useSearchParams();

  const initialMode = searchParams.get("mode") as "public" | "stealth" | "btc_withdraw" | null;
  const commitment = searchParams.get("commitment");
  const leafIndex = searchParams.get("leafIndex");
  const amount = searchParams.get("amount");

  // Read note from hash fragment (#note=) — never sent to server
  // Fall back to query param (?note=) for backward compatibility
  const [noteParam, setNoteParam] = useState<string | null>(null);

  useEffect(() => {
    const hash = window.location.hash;
    if (hash.includes("note=")) {
      const match = hash.match(/note=([^&#]+)/);
      if (match) {
        setNoteParam(decodeURIComponent(match[1]));
        return;
      }
    }
    // Legacy fallback
    const qp = searchParams.get("note");
    if (qp) setNoteParam(qp);
  }, [searchParams]);

  return (
    <PayFlow
      initialMode={initialMode || undefined}
      preselectedNote={
        commitment && leafIndex && amount
          ? { commitment, leafIndex: Number(leafIndex), amount: BigInt(amount) }
          : undefined
      }
      initialSecretPhrase={noteParam || undefined}
    />
  );
}

export default function PayPage() {
  return (
    <FlowPageLayout
      backHref="/vault"
      backLabel="Back"
      width={520}
      badges={[
        {
          icon: <Send className="w-full h-full" />,
          label: "Pay",
          color: "purple",
        },
      ]}
      titleIcon={<Send className="w-full h-full" />}
      title="Private Transfer"
      description="Send shielded tokens privately"
    >
      <Suspense fallback={<div className="flex items-center justify-center py-8"><div className="w-8 h-8 border-2 border-purple border-t-transparent rounded-full animate-spin" /></div>}>
        <PayFlowWithParams />
      </Suspense>
    </FlowPageLayout>
  );
}
