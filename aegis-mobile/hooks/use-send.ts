import { useState, useCallback } from "react";

export type SendStep =
  | "recipient"
  | "amount"
  | "confirm"
  | "proving"
  | "submitting"
  | "success"
  | "error";

interface SendState {
  step: SendStep;
  recipient: string;
  resolvedAddress: string | null;
  amountSats: number;
  txSignature: string | null;
  error: string | null;
  proofProgress: number;
}

const INITIAL_STATE: SendState = {
  step: "recipient",
  recipient: "",
  resolvedAddress: null,
  amountSats: 0,
  txSignature: null,
  error: null,
  proofProgress: 0,
};

export function useSend() {
  const [state, setState] = useState<SendState>(INITIAL_STATE);

  const setRecipient = useCallback((recipient: string) => {
    setState((s) => ({ ...s, recipient, step: "amount" }));
  }, []);

  const setAmount = useCallback((amountSats: number) => {
    setState((s) => ({ ...s, amountSats, step: "confirm" }));
  }, []);

  const confirm = useCallback(async () => {
    setState((s) => ({ ...s, step: "proving" }));
    try {
      // TODO: Wire to actual SDK flow:
      // 1. Resolve recipient (SNS or stealth address)
      // 2. Select notes from inbox
      // 3. Generate JoinSplit proof via mobile prover
      // 4. Build transact instruction
      // 5. Submit to Solana

      // Simulate proof generation progress
      for (let i = 0; i <= 100; i += 10) {
        await new Promise((r) => setTimeout(r, 200));
        setState((s) => ({ ...s, proofProgress: i / 100 }));
      }

      setState((s) => ({ ...s, step: "submitting" }));

      // Simulate submission
      await new Promise((r) => setTimeout(r, 1000));

      setState((s) => ({
        ...s,
        step: "success",
        txSignature: "placeholder_tx_sig",
      }));
    } catch (e: unknown) {
      const message =
        e instanceof Error ? e.message : "Transaction failed";
      setState((s) => ({
        ...s,
        step: "error",
        error: message,
      }));
    }
  }, []);

  const reset = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  return { ...state, setRecipient, setAmount, confirm, reset };
}
