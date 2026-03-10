import { useState, useEffect, useCallback, useRef } from "react";
import { API_BASE } from "@/lib/api";

export type DepositStatus =
  | "pending"
  | "detected"
  | "confirmed"
  | "verified"
  | "claimable"
  | "error";

interface DepositStatusResult {
  status: DepositStatus;
  confirmations?: number;
  txid?: string;
  error?: string;
}

export function useDepositStatus(depositAddress: string | null) {
  const [result, setResult] = useState<DepositStatusResult>({
    status: "pending",
  });
  const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(
    undefined,
  );

  const poll = useCallback(async () => {
    if (!depositAddress) return;
    try {
      const res = await fetch(
        `${API_BASE}/deposits/status?address=${depositAddress}`,
      );
      if (res.ok) {
        const data = await res.json();
        setResult(data);
        // Stop polling on terminal states
        if (data.status === "claimable" || data.status === "error") {
          if (intervalRef.current) clearInterval(intervalRef.current);
        }
      }
    } catch {
      // silently retry on next interval
    }
  }, [depositAddress]);

  useEffect(() => {
    if (!depositAddress) return;
    poll();
    intervalRef.current = setInterval(poll, 10_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [depositAddress, poll]);

  return result;
}
