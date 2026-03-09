import { useState, useCallback } from "react";
import { useAegisStore } from "@/stores/aegis-store";

export type ClaimStep = "idle" | "proving" | "submitting" | "success" | "error";

export interface ClaimableDeposit {
  commitment: string;
  amount: number;
  leafIndex: number;
}

export function useClaim() {
  const [step, setStep] = useState<ClaimStep>("idle");
  const [proofProgress, setProofProgress] = useState(0);
  const [txSignature, setTxSignature] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inboxNotes = useAegisStore((s) => s.inboxNotes);

  // Claimable = unspent notes (simplified; real impl checks on-chain claim status)
  const claimable: ClaimableDeposit[] = inboxNotes
    .filter((n) => !n.spent)
    .map((n) => ({
      commitment: n.commitment,
      amount: n.amount,
      leafIndex: n.leafIndex,
    }));

  const claim = useCallback(async (deposit: ClaimableDeposit) => {
    setStep("proving");
    setProofProgress(0);
    setError(null);
    try {
      // TODO: Wire to actual SDK:
      // 1. Generate 1x2 JoinSplit proof (claim proof)
      // 2. Build transact instruction
      // 3. Submit to Solana

      // Simulate proof (~2-3s on native)
      for (let i = 0; i <= 100; i += 20) {
        await new Promise((r) => setTimeout(r, 400));
        setProofProgress(i / 100);
      }

      setStep("submitting");
      await new Promise((r) => setTimeout(r, 1000));

      setTxSignature("placeholder_claim_sig");
      setStep("success");
    } catch (e: unknown) {
      const message =
        e instanceof Error ? e.message : "Claim failed";
      setError(message);
      setStep("error");
    }
  }, []);

  const reset = useCallback(() => {
    setStep("idle");
    setProofProgress(0);
    setTxSignature(null);
    setError(null);
  }, []);

  return { claimable, step, proofProgress, txSignature, error, claim, reset };
}
