"use client";

import { Component, Suspense, useState, useEffect, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { Send, AlertTriangle } from "lucide-react";
import { FlowPageLayout } from "@/components/ui/flow-page-layout";
import { PayFlow } from "@/components/btc-widget/pay-flow";

class PayFlowErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center py-12 gap-4 text-center">
          <AlertTriangle className="w-10 h-10 text-yellow-500" />
          <h3 className="text-lg font-semibold text-white">Something went wrong</h3>
          <p className="text-sm text-zinc-400 max-w-xs">
            {this.state.error?.message || "An unexpected error occurred in the payment flow."}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-500 transition-colors text-sm"
          >
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

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
      <PayFlowErrorBoundary>
        <Suspense fallback={<div className="flex items-center justify-center py-8"><div className="w-8 h-8 border-2 border-purple border-t-transparent rounded-full animate-spin" /></div>}>
          <PayFlowWithParams />
        </Suspense>
      </PayFlowErrorBoundary>
    </FlowPageLayout>
  );
}
