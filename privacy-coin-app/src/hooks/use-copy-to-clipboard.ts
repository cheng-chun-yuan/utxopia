"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { COPY_TIMEOUT_MS } from "@/lib/constants";

interface UseCopyToClipboardOptions {
  timeout?: number;
}

export function useCopyToClipboard(options: UseCopyToClipboardOptions = {}) {
  const { timeout = COPY_TIMEOUT_MS } = options;
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const copy = useCallback(
    (text: string) => {
      navigator.clipboard.writeText(text).catch(console.error);
      setCopied(true);

      // Clear existing timeout
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      timeoutRef.current = setTimeout(() => {
        setCopied(false);
        timeoutRef.current = null;
      }, timeout);
    },
    [timeout]
  );

  const reset = useCallback(() => {
    setCopied(false);
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return { copied, copy, reset };
}
