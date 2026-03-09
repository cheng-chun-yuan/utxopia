import { useState, useCallback } from "react";
import { resolveZkeyPath } from "@/lib/circuit-loader";

export function useProver() {
  const [isInitialized, setIsInitialized] = useState(false);
  const [isProving, setIsProving] = useState(false);
  const [progress, setProgress] = useState(0);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);

  const initialize = useCallback(async () => {
    if (isInitialized) return;
    try {
      const mobile = await import("@aegis/sdk/prover/mobile");
      mobile.setCircuitResolver(resolveZkeyPath);
      await mobile.initProver();
      setIsInitialized(true);
    } catch (e) {
      console.warn("mopro-ffi not available, native proving disabled:", e);
    }
  }, [isInitialized]);

  const generateProof = useCallback(
    async (inputs: any, circuitType?: string) => {
      if (!isInitialized) await initialize();
      setIsProving(true);
      setProgress(0);
      setDownloadProgress(null);
      try {
        const mobile = await import("@aegis/sdk/prover/mobile");
        const proof = await mobile.generateJoinSplitProof(
          inputs,
          circuitType,
          (p: number) => {
            setProgress(p);
          },
        );
        return proof;
      } finally {
        setIsProving(false);
        setProgress(1);
        setDownloadProgress(null);
      }
    },
    [isInitialized, initialize],
  );

  return {
    isInitialized,
    isProving,
    progress,
    downloadProgress,
    initialize,
    generateProof,
  };
}
