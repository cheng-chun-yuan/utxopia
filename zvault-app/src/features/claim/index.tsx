"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, Gift, Shield } from "lucide-react";
import { cn } from "@/lib/utils";
import { ErrorCard } from "@/features/shared/components";
import { ClaimForm, ClaimProgressIndicator, ClaimSuccess } from "./components";
import { useClaimFlow } from "./hooks/use-claim-flow";
import { parseClaimUrl } from "@zvault/sdk";

function ClaimContent() {
  const searchParams = useSearchParams();
  const parsed = parseClaimUrl(searchParams);
  const initialNote = typeof parsed === "string" ? parsed : undefined;

  const {
    step,
    claimProgress,
    error,
    mounted,
    secretPhrase,
    verifyResult,
    claimResult,
    splitResult,
    splitLoading,
    connected,
    publicKey,
    setSecretPhrase,
    parseClaimLink,
    pasteFromClipboard,
    verify,
    claim,
    split,
    reset,
    getClaimLinkUrl,
  } = useClaimFlow(initialNote);

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pastedText = e.clipboardData.getData("text");
    if (
      pastedText.includes("note=") ||
      pastedText.includes("?n=") ||
      pastedText.includes("/claim")
    ) {
      e.preventDefault();
      parseClaimLink(pastedText);
    }
  };

  if (!mounted) {
    return (
      <main className="min-h-screen bg-background hacker-bg noise-overlay flex flex-col items-center justify-center p-4">
        <div className="w-16 h-16 rounded-full border-4 border-gray/15 border-t-purple animate-spin" />
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background hacker-bg noise-overlay flex flex-col items-center justify-center p-4">
      {/* Header */}
      <div className="w-full max-w-[480px] mb-4 flex items-center justify-between relative z-10">
        <Link
          href="/bridge"
          className="inline-flex items-center gap-2 text-body2 text-gray hover:text-gray-light transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Bridge
        </Link>
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-purple/10 border border-purple/20">
          <Gift className="w-3 h-3 text-purple" />
          <span className="text-caption text-purple">Claim</span>
        </div>
      </div>

      {/* Widget */}
      <div
        className={cn(
          "bg-card border border-solid border-gray/30 p-4",
          "w-[480px] max-w-[calc(100vw-32px)] rounded-[16px]",
          "glow-border cyber-corners relative z-10"
        )}
      >
        <h1 className="text-heading5 text-foreground mb-2">Claim zBTC Tokens</h1>
        <p className="text-body2 text-gray mb-6">
          Enter your secret phrase to claim your zBTC.
        </p>

        {step === "input" && (
          <ClaimForm
            secretPhrase={secretPhrase}
            onSecretPhraseChange={setSecretPhrase}
            onPaste={handlePaste}
            onPasteFromClipboard={pasteFromClipboard}
            onVerify={verify}
            onClaim={claim}
            verifyResult={verifyResult}
            claimLinkUrl={getClaimLinkUrl()}
            error={error}
            connected={connected}
            publicKey={publicKey}
          />
        )}

        {step === "verifying" && (
          <div className="flex flex-col items-center py-8">
            <div className="relative w-16 h-16 mb-4">
              <div className="absolute inset-0 rounded-full border-4 border-gray/15" />
              <div className="absolute inset-0 rounded-full border-4 border-privacy border-t-transparent animate-spin" />
              <div className="absolute inset-0 flex items-center justify-center">
                <Shield className="w-6 h-6 text-privacy" />
              </div>
            </div>
            <p className="text-body2 text-gray-light">Verifying claim...</p>
            <p className="text-caption text-gray">Looking up deposit on-chain</p>
          </div>
        )}

        {step === "claiming" && <ClaimProgressIndicator progress={claimProgress} />}

        {step === "success" && claimResult && (
          <ClaimSuccess
            result={claimResult}
            splitResult={splitResult}
            splitLoading={splitLoading}
            onSplit={split}
            onReset={reset}
          />
        )}

        {step === "error" && (
          <div className="space-y-4">
            <ErrorCard title="Claim failed" message={error || "Unknown error"} />
            <button onClick={reset} className="btn-primary w-full">
              Try Again
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

export function ClaimFeature() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-background hacker-bg noise-overlay flex flex-col items-center justify-center p-4">
          <div className="w-16 h-16 rounded-full border-4 border-gray/15 border-t-purple animate-spin" />
        </main>
      }
    >
      <ClaimContent />
    </Suspense>
  );
}
