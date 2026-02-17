"use client";

import { useState, useCallback } from "react";
import { Connection, Transaction } from "@solana/web3.js";

export type TransactionStatus =
  | "idle"
  | "signing"
  | "submitting"
  | "confirming"
  | "success"
  | "error";

interface UseTransactionOptions {
  onSuccess?: (signature: string) => void;
  onError?: (error: Error) => void;
}

/**
 * Shared hook for Solana transaction submission flow.
 * Handles signing, submitting, and confirming transactions.
 */
export function useTransaction(options?: UseTransactionOptions) {
  const [status, setStatus] = useState<TransactionStatus>("idle");
  const [signature, setSignature] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (
      connection: Connection,
      transaction: Transaction,
      signTransaction: (tx: Transaction) => Promise<Transaction>
    ) => {
      setStatus("signing");
      setError(null);
      setSignature(null);

      try {
        // Get recent blockhash
        const { blockhash, lastValidBlockHeight } =
          await connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;

        // Sign
        const signedTx = await signTransaction(transaction);

        setStatus("submitting");

        // Submit
        const sig = await connection.sendRawTransaction(signedTx.serialize(), {
          skipPreflight: false,
          preflightCommitment: "confirmed",
        });

        setStatus("confirming");

        // Confirm
        const confirmation = await connection.confirmTransaction(
          { signature: sig, blockhash, lastValidBlockHeight },
          "confirmed"
        );

        if (confirmation.value.err) {
          throw new Error(
            `Transaction failed: ${JSON.stringify(confirmation.value.err)}`
          );
        }

        setSignature(sig);
        setStatus("success");
        options?.onSuccess?.(sig);

        return sig;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Transaction failed";
        setError(message);
        setStatus("error");
        options?.onError?.(err instanceof Error ? err : new Error(message));
        throw err;
      }
    },
    [options]
  );

  const reset = useCallback(() => {
    setStatus("idle");
    setSignature(null);
    setError(null);
  }, []);

  return {
    status,
    signature,
    error,
    submit,
    reset,
    isIdle: status === "idle",
    isLoading: ["signing", "submitting", "confirming"].includes(status),
    isSuccess: status === "success",
    isError: status === "error",
  };
}
