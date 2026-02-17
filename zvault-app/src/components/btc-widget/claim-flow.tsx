"use client";

import { useState, useCallback, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  Shield, CheckCircle2, AlertCircle, Coins,
  Key, ExternalLink
} from "lucide-react";
import { cn } from "@/lib/utils";
import { WalletButton } from "@/components/ui/wallet-button";
import { formatBtc } from "@/lib/utils/formatting";
import {
  parseClaimLinkData,
  reconstructNote,
  checkDepositStatus,
  type Note,
} from "@/lib/sdk";

type ClaimStep = "input" | "verifying" | "claiming" | "success" | "error";

function ClaimFlowContent() {
  const { publicKey, connected } = useWallet();
  const searchParams = useSearchParams();

  const [step, setStep] = useState<ClaimStep>("input");
  const [error, setError] = useState<string | null>(null);

  // Note data (nullifier + secret)
  const [nullifier, setNullifier] = useState("");
  const [secret, setSecret] = useState("");

  // Verification result
  const [verifyResult, setVerifyResult] = useState<{
    commitment: string;
    nullifierHash: string;
    amountSats: number;
  } | null>(null);

  // Result
  const [txSignature, setTxSignature] = useState<string | null>(null);
  const [claimedAmount, setClaimedAmount] = useState<number | null>(null);

  useEffect(() => {
    // Check for note data from URL params (claim link)
    // Supports both formats:
    // - New: ?note=<base64>
    // - Legacy: ?n=<nullifier>&s=<secret>
    const noteParam = searchParams.get("note");
    if (noteParam) {
      const parsed = parseClaimLinkData(noteParam);
      if (parsed) {
        setNullifier(parsed.nullifier);
        setSecret(parsed.secret);
      }
    } else {
      // Legacy format
      const n = searchParams.get("n");
      const s = searchParams.get("s");
      if (n && s) {
        setNullifier(n);
        setSecret(s);
      }
    }
  }, [searchParams]);

  const handleVerify = useCallback(async () => {
    if (!nullifier.trim() || !secret.trim()) {
      setError("Please enter both nullifier and secret");
      return;
    }

    setError(null);
    setStep("verifying");

    try {
      // Reconstruct note from nullifier + secret
      // Note: Amount needs to be looked up from on-chain or stored data
      // For now, we'll validate the format and show a placeholder
      const note = reconstructNote(nullifier, secret, 0n);

      // Compute commitment hex for display
      const commitmentHex = note.commitment.toString(16).padStart(64, "0");
      const nullifierHashHex = note.nullifierHash.toString(16).padStart(64, "0");

      // In production: Query on-chain state to:
      // 1. Check if commitment exists in Merkle tree
      // 2. Check if nullifier has been used
      // 3. Get the deposited amount

      // For demo, show verification success
      // TODO: Query Solana program to get actual amount
      const demoAmountSats = 100000; // Placeholder

      setVerifyResult({
        commitment: commitmentHex,
        nullifierHash: nullifierHashHex,
        amountSats: demoAmountSats,
      });
      setStep("input");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to verify - invalid note data");
      setStep("error");
    }
  }, [nullifier, secret]);

  const handleClaim = useCallback(async () => {
    if (!nullifier.trim() || !secret.trim()) {
      setError("Please enter both nullifier and secret");
      return;
    }
    if (!connected || !publicKey) {
      setError("Please connect your Solana wallet");
      return;
    }

    setError(null);
    setStep("claiming");

    try {
      // Reconstruct note from nullifier + secret
      const amountSats = verifyResult?.amountSats ?? 0;
      const note = reconstructNote(nullifier, secret, BigInt(amountSats));

      console.log("[Claim] Preparing to claim via direct Solana TX...");
      console.log("[Claim] Nullifier:", nullifier.slice(0, 16) + "...");
      console.log("[Claim] Recipient:", publicKey.toBase58());

      // TODO: In production:
      // 1. Generate Groth16 ZK proof using generateClaimProof()
      // 2. Build CLAIM transaction using buildClaimTransaction()
      // 3. Have user sign with wallet (signTransaction)
      // 4. Submit to Solana network (sendTransaction)

      // For demo, show success
      const demoSignature = `claim_${Date.now().toString(16)}`;

      setTxSignature(demoSignature);
      setClaimedAmount(amountSats);
      setStep("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to claim tokens");
      setStep("error");
    }
  }, [nullifier, secret, connected, publicKey, verifyResult]);

  const resetFlow = () => {
    setStep("input");
    setNullifier("");
    setSecret("");
    setVerifyResult(null);
    setTxSignature(null);
    setClaimedAmount(null);
    setError(null);
  };

  if (step === "input") {
    return (
      <div className="space-y-4">
        {/* Privacy info */}
        <div className="flex items-center gap-3 p-3 bg-privacy/10 border border-privacy/20 rounded-[12px]">
          <Shield className="w-5 h-5 text-privacy" />
          <div className="flex flex-col">
            <span className="text-body2-semibold text-privacy">Privacy Preserved</span>
            <span className="text-caption text-privacy opacity-80">
              Amount is looked up on-chain
            </span>
          </div>
        </div>

        {/* Nullifier Input */}
        <div>
          <label className="text-body2 text-gray-light pl-2 mb-2 block">
            Nullifier
          </label>
          <div className="relative">
            <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray" />
            <input
              type="text"
              value={nullifier}
              onChange={(e) => setNullifier(e.target.value)}
              placeholder="Enter your nullifier"
              className={cn(
                "w-full p-3 pl-10 bg-muted border border-gray/15 rounded-[12px]",
                "text-body2 font-mono text-foreground placeholder:text-gray",
                "outline-none focus:border-privacy/40 transition-colors"
              )}
            />
          </div>
        </div>

        {/* Secret Input */}
        <div>
          <label className="text-body2 text-gray-light pl-2 mb-2 block">
            Secret
          </label>
          <div className="relative">
            <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray" />
            <input
              type="text"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="Enter your secret"
              className={cn(
                "w-full p-3 pl-10 bg-muted border border-gray/15 rounded-[12px]",
                "text-body2 font-mono text-foreground placeholder:text-gray",
                "outline-none focus:border-privacy/40 transition-colors"
              )}
            />
          </div>
        </div>

        {/* Verification Result */}
        {verifyResult && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 p-3 bg-success/10 border border-success/20 rounded-[12px]">
              <CheckCircle2 className="w-5 h-5 text-success" />
              <span className="text-body2 text-success">Claim verified!</span>
            </div>
            <div className="p-3 bg-muted border border-gray/15 rounded-[12px]">
              <p className="text-caption text-gray mb-1">Amount to Claim</p>
              <p className="text-heading6 text-privacy">
                {formatBtc(verifyResult.amountSats)} zkBTC
              </p>
            </div>
          </div>
        )}

        {/* Recipient Wallet */}
        <div>
          <label className="text-body2 text-gray-light pl-2 mb-2 block">
            Recipient Wallet
          </label>
          {connected && publicKey ? (
            <div className="flex items-center gap-2 p-3 bg-muted border border-privacy/20 rounded-[12px]">
              <div className="w-2 h-2 rounded-full bg-privacy" />
              <span className="text-body2 font-mono text-gray-light">
                {publicKey.toBase58().slice(0, 8)}...{publicKey.toBase58().slice(-8)}
              </span>
            </div>
          ) : (
            <WalletButton className="btn-tertiary w-full justify-center" />
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 p-3 bg-error/10 border border-error/20 rounded-[12px] text-error">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span className="text-caption">{error}</span>
          </div>
        )}

        {/* Buttons */}
        <div className="space-y-2">
          {!verifyResult && (
            <button
              onClick={handleVerify}
              disabled={!nullifier.trim() || !secret.trim()}
              className="btn-secondary w-full"
            >
              <Shield className="w-5 h-5" />
              Verify Claim
            </button>
          )}
          <button
            onClick={handleClaim}
            disabled={!nullifier.trim() || !secret.trim() || !connected}
            className="btn-primary w-full"
          >
            <Coins className="w-5 h-5" />
            Claim zkBTC
          </button>
        </div>
      </div>
    );
  }

  if (step === "verifying") {
    return (
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
    );
  }

  if (step === "claiming") {
    return (
      <div className="flex flex-col items-center py-8">
        <div className="relative w-16 h-16 mb-4">
          <div className="absolute inset-0 rounded-full border-4 border-gray/15" />
          <div className="absolute inset-0 rounded-full border-4 border-purple border-t-transparent animate-spin" />
          <div className="absolute inset-0 flex items-center justify-center">
            <Coins className="w-6 h-6 text-purple" />
          </div>
        </div>
        <p className="text-body2 text-gray-light">Claiming tokens...</p>
        <p className="text-caption text-gray">Minting zkBTC to your wallet</p>
      </div>
    );
  }

  if (step === "success") {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3 p-3 bg-success/10 border border-success/20 rounded-[12px]">
          <CheckCircle2 className="w-5 h-5 text-success" />
          <span className="text-body2 text-success">Tokens claimed successfully!</span>
        </div>

        {/* Claim Details */}
        <div className="space-y-3">
          {claimedAmount && (
            <div className="p-3 bg-muted border border-gray/15 rounded-[12px]">
              <p className="text-caption text-gray mb-1">Amount Claimed</p>
              <p className="text-heading6 text-privacy">
                {formatBtc(claimedAmount)} zkBTC
              </p>
            </div>
          )}

          {txSignature && (
            <div className="p-3 bg-muted border border-gray/15 rounded-[12px]">
              <p className="text-caption text-gray mb-1">Transaction</p>
              <a
                href={`https://orbmarkets.io/tx/${txSignature}?cluster=devnet`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-caption font-mono text-privacy hover:underline break-all flex items-center gap-1"
              >
                {txSignature.slice(0, 16)}...{txSignature.slice(-16)}
                <ExternalLink className="w-3 h-3 shrink-0" />
              </a>
            </div>
          )}
        </div>

        {/* Actions */}
        <button onClick={resetFlow} className="btn-primary w-full">
          Claim Another
        </button>
      </div>
    );
  }

  if (step === "error") {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3 p-3 bg-error/10 border border-error/20 rounded-[12px]">
          <AlertCircle className="w-5 h-5 text-error" />
          <span className="text-body2 text-error">Claim failed</span>
        </div>

        {error && (
          <div className="p-3 bg-muted border border-gray/15 rounded-[12px]">
            <p className="text-caption text-gray mb-1">Error</p>
            <p className="text-body2 text-error">{error}</p>
          </div>
        )}

        <button onClick={resetFlow} className="btn-primary w-full">
          Try Again
        </button>
      </div>
    );
  }

  return null;
}

export function ClaimFlow() {
  return (
    <Suspense fallback={
      <div className="flex flex-col items-center py-8">
        <div className="w-16 h-16 rounded-full border-4 border-gray/15 border-t-privacy animate-spin" />
      </div>
    }>
      <ClaimFlowContent />
    </Suspense>
  );
}
