/**
 * Prover Hook (Groth16 JoinSplit)
 *
 * Wraps SDK's JoinSplit proof generation with React state management.
 * All private transfers (claim, split, send) use unified JoinSplit(N,M) proofs.
 */

"use client";

import { useState, useCallback } from "react";
import {
  initProver,
  generateJoinSplitProof,
  proofToBytes,
  type JoinSplitProofInputs,
  type ProofData,
} from "@zvault/sdk";

interface ProverState {
  isInitialized: boolean;
  isGenerating: boolean;
  progress: string | null;
  error: string | null;
  initialize: () => Promise<void>;
  generateProof: (inputs: JoinSplitProofInputs) => Promise<{
    proof: ProofData;
    proofBytes: Uint8Array;
  }>;
}

export function useProver(): ProverState {
  const [isInitialized, setIsInitialized] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const initialize = useCallback(async () => {
    try {
      setProgress("Initializing prover...");
      await initProver();
      setIsInitialized(true);
      setProgress(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to initialize prover");
      setProgress(null);
    }
  }, []);

  const generateProof = useCallback(
    async (inputs: JoinSplitProofInputs) => {
      setIsGenerating(true);
      setError(null);
      setProgress(
        `Generating JoinSplit(${inputs.nInputs}x${inputs.nOutputs}) proof...`
      );
      try {
        const proof = await generateJoinSplitProof(inputs);
        const bytes = proofToBytes(proof);
        setProgress(null);
        return { proof, proofBytes: bytes };
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Proof generation failed";
        setError(msg);
        throw err;
      } finally {
        setIsGenerating(false);
        setProgress(null);
      }
    },
    []
  );

  return {
    isInitialized,
    isGenerating,
    progress,
    error,
    initialize,
    generateProof,
  };
}
