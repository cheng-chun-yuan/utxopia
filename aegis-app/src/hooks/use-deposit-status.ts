"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  getDepositStatus,
  subscribeToDepositStatus,
  type DepositStatusResponse,
  type DepositStatus,
  type DepositStatusUpdate,
  isDepositTerminal,
} from "@/lib/api/deposits";

export interface UseDepositStatusOptions {
  useWebSocket?: boolean;
  pollInterval?: number;
  onStatusChange?: (status: DepositStatus, prevStatus?: DepositStatus) => void;
  onClaimable?: () => void;
  onError?: (error: string) => void;
}

export interface UseDepositStatusResult {
  status: DepositStatus | null;
  confirmations: number;
  sweepConfirmations: number;
  canClaim: boolean;
  btcTxid: string | null;
  sweepTxid: string | null;
  solanaTx: string | null;
  leafIndex: number | null;
  error: string | null;
  isLoading: boolean;
  isConnected: boolean;
  deposit: DepositStatusResponse | null;
  refresh: () => Promise<void>;
}

export function useDepositStatus(
  depositId: string | null,
  options: UseDepositStatusOptions = {}
): UseDepositStatusResult {
  const {
    useWebSocket = true,
    pollInterval = 10000,
    onStatusChange,
    onClaimable,
    onError,
  } = options;

  const [deposit, setDeposit] = useState<DepositStatusResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isConnected, setIsConnected] = useState(false);

  // Use refs for callbacks and mutable state to avoid dependency churn
  const prevStatusRef = useRef<DepositStatus | null>(null);
  const onStatusChangeRef = useRef(onStatusChange);
  const onClaimableRef = useRef(onClaimable);
  const onErrorRef = useRef(onError);
  const isConnectedRef = useRef(false);
  const depositRef = useRef<DepositStatusResponse | null>(null);

  // Keep refs in sync
  onStatusChangeRef.current = onStatusChange;
  onClaimableRef.current = onClaimable;
  onErrorRef.current = onError;
  isConnectedRef.current = isConnected;
  depositRef.current = deposit;

  // Stable fetch function — no state in deps
  const fetchStatus = useCallback(async () => {
    if (!depositId) return;

    try {
      const data = await getDepositStatus(depositId);
      setDeposit(data);

      if (prevStatusRef.current !== data.status) {
        onStatusChangeRef.current?.(data.status, prevStatusRef.current || undefined);

        if (data.can_claim && (!prevStatusRef.current || !isDepositTerminal(prevStatusRef.current))) {
          onClaimableRef.current?.();
        }

        if (data.status === "failed" && data.error) {
          onErrorRef.current?.(data.error);
        }

        prevStatusRef.current = data.status;
      }
    } catch (err) {
      console.error("Failed to fetch deposit status:", err);
      onErrorRef.current?.(err instanceof Error ? err.message : "Failed to fetch status");
    } finally {
      setIsLoading(false);
    }
  }, [depositId]); // Only depends on depositId

  // Handle WebSocket updates
  const handleStatusUpdate = useCallback(
    (update: DepositStatusUpdate) => {
      setDeposit((prev) => {
        if (!prev) return prev;

        const updated: DepositStatusResponse = {
          ...prev,
          status: update.status,
          confirmations: update.confirmations,
          sweep_confirmations: update.sweep_confirmations,
          can_claim: update.can_claim,
          error: update.error,
          updated_at: Date.now() / 1000,
        };

        if (prevStatusRef.current !== update.status) {
          onStatusChangeRef.current?.(update.status, prevStatusRef.current || undefined);

          if (update.can_claim) {
            onClaimableRef.current?.();
          }

          if (update.status === "failed" && update.error) {
            onErrorRef.current?.(update.error);
          }

          prevStatusRef.current = update.status;
        }

        return updated;
      });
    },
    []
  );

  // WebSocket setup
  useEffect(() => {
    if (!depositId || !useWebSocket) return;

    const { ws, unsubscribe } = subscribeToDepositStatus(depositId, {
      onStatusUpdate: handleStatusUpdate,
      onOpen: () => setIsConnected(true),
      onClose: () => setIsConnected(false),
      onError: () => setIsConnected(false),
    });

    return () => {
      unsubscribe();
    };
  }, [depositId, useWebSocket, handleStatusUpdate]);

  // Initial fetch + polling (stable — no dep on deposit state)
  useEffect(() => {
    if (!depositId) {
      setDeposit(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    fetchStatus();

    // Set up interval-based polling as fallback
    const intervalId = setInterval(() => {
      // Skip polling if WebSocket is connected or deposit is terminal
      if (isConnectedRef.current) return;
      const d = depositRef.current;
      if (d && isDepositTerminal(d.status)) return;
      fetchStatus();
    }, pollInterval);

    return () => clearInterval(intervalId);
  }, [depositId, pollInterval, fetchStatus]);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    await fetchStatus();
  }, [fetchStatus]);

  return {
    status: deposit?.status || null,
    confirmations: deposit?.confirmations || 0,
    sweepConfirmations: deposit?.sweep_confirmations || 0,
    canClaim: deposit?.can_claim || false,
    btcTxid: deposit?.btc_txid || null,
    sweepTxid: deposit?.sweep_txid || null,
    solanaTx: deposit?.solana_tx || null,
    leafIndex: deposit?.leaf_index ?? null,
    error: deposit?.error || null,
    isLoading,
    isConnected,
    deposit,
    refresh,
  };
}

export default useDepositStatus;
