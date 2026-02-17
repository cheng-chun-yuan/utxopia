"use client";

import { useState, useCallback } from "react";

/**
 * Shared hook for clipboard operations with "Copied!" feedback.
 * Eliminates duplicated clipboard state across flows.
 */
export function useClipboard(resetDelay = 2000) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), resetDelay);
        return true;
      } catch (err) {
        console.error("Failed to copy:", err);
        return false;
      }
    },
    [resetDelay]
  );

  const reset = useCallback(() => {
    setCopied(false);
  }, []);

  return { copied, copy, reset };
}

/**
 * Multiple clipboard states for flows with multiple copy buttons.
 * Example: claim flow with "keep link" and "send link" copy buttons.
 */
export function useMultiClipboard<T extends string>(
  keys: T[],
  resetDelay = 2000
) {
  const [copiedStates, setCopiedStates] = useState<Record<T, boolean>>(
    () => keys.reduce((acc, key) => ({ ...acc, [key]: false }), {} as Record<T, boolean>)
  );

  const copy = useCallback(
    async (key: T, text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setCopiedStates((prev) => ({ ...prev, [key]: true }));
        setTimeout(() => {
          setCopiedStates((prev) => ({ ...prev, [key]: false }));
        }, resetDelay);
        return true;
      } catch (err) {
        console.error("Failed to copy:", err);
        return false;
      }
    },
    [resetDelay]
  );

  const isCopied = useCallback(
    (key: T) => copiedStates[key],
    [copiedStates]
  );

  const resetAll = useCallback(() => {
    setCopiedStates(
      keys.reduce((acc, key) => ({ ...acc, [key]: false }), {} as Record<T, boolean>)
    );
  }, [keys]);

  return { copy, isCopied, resetAll };
}
