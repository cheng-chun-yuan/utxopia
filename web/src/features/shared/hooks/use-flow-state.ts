"use client";

import { useState, useCallback } from "react";

/**
 * Shared hook for managing flow state across all features.
 * Eliminates duplicated step/error/loading state patterns.
 */
export function useFlowState<TStep extends string>(initialStep: TStep) {
  const [step, setStep] = useState<TStep>(initialStep);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reset = useCallback(() => {
    setStep(initialStep);
    setError(null);
    setLoading(false);
  }, [initialStep]);

  const setErrorAndStop = useCallback((message: string) => {
    setError(message);
    setLoading(false);
  }, []);

  const startLoading = useCallback(() => {
    setError(null);
    setLoading(true);
  }, []);

  const stopLoading = useCallback(() => {
    setLoading(false);
  }, []);

  return {
    step,
    setStep,
    error,
    setError,
    loading,
    setLoading,
    reset,
    setErrorAndStop,
    startLoading,
    stopLoading,
  };
}
