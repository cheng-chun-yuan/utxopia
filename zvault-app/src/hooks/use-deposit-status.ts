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
  /**
   * Enable WebSocket for real-time updates
   * @default true
   */
  useWebSocket?: boolean;

  /**
   * Polling interval in ms when WebSocket is not available/connected
   * @default 10000 (10 seconds)
   */
  pollInterval?: number;

  /**
   * Callback when status changes
   */
  onStatusChange?: (status: DepositStatus, prevStatus?: DepositStatus) => void;

  /**
   * Callback when deposit becomes claimable
   */
  onClaimable?: () => void;

  /**
   * Callback when deposit fails
   */
  onError?: (error: string) => void;
}

export interface UseDepositStatusResult {
  /** Current deposit status */
  status: DepositStatus | null;
  /** Number of confirmations on the deposit transaction */
  confirmations: number;
  /** Number of confirmations on the sweep transaction */
  sweepConfirmations: number;
  /** Whether the deposit can be claimed */
  canClaim: boolean;
  /** Bitcoin transaction ID of the deposit */
  btcTxid: string | null;
  /** Bitcoin transaction ID of the sweep */
  sweepTxid: string | null;
  /** Solana transaction signature of the verification */
  solanaTx: string | null;
  /** Leaf index in the commitment tree */
  leafIndex: number | null;
  /** Error message if deposit failed */
  error: string | null;
  /** Whether the hook is loading initial data */
  isLoading: boolean;
  /** Whether WebSocket is connected */
  isConnected: boolean;
  /** Full deposit record */
  deposit: DepositStatusResponse | null;
  /** Manually refresh status */
  refresh: () => Promise<void>;
}

/**
 * Hook for tracking deposit status with WebSocket support
 *
 * @param depositId - The deposit ID to track
 * @param options - Configuration options
 */
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

  const prevStatusRef = useRef<DepositStatus | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pollTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Fetch deposit status
  const fetchStatus = useCallback(async () => {
    if (!depositId) return;

    try {
      const data = await getDepositStatus(depositId);
      setDeposit(data);

      // Check for status changes
      if (prevStatusRef.current !== data.status) {
        onStatusChange?.(data.status, prevStatusRef.current || undefined);

        // Check for claimable
        if (data.can_claim && !prevStatusRef.current) {
          onClaimable?.();
        } else if (data.can_claim && prevStatusRef.current && !isDepositTerminal(prevStatusRef.current)) {
          onClaimable?.();
        }

        // Check for errors
        if (data.status === "failed" && data.error) {
          onError?.(data.error);
        }

        prevStatusRef.current = data.status;
      }
    } catch (err) {
      console.error("Failed to fetch deposit status:", err);
      onError?.(err instanceof Error ? err.message : "Failed to fetch status");
    } finally {
      setIsLoading(false);
    }
  }, [depositId, onStatusChange, onClaimable, onError]);

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

        // Check for status changes
        if (prevStatusRef.current !== update.status) {
          onStatusChange?.(update.status, prevStatusRef.current || undefined);

          if (update.can_claim) {
            onClaimable?.();
          }

          if (update.status === "failed" && update.error) {
            onError?.(update.error);
          }

          prevStatusRef.current = update.status;
        }

        return updated;
      });
    },
    [onStatusChange, onClaimable, onError]
  );

  // Setup WebSocket connection
  useEffect(() => {
    if (!depositId || !useWebSocket) return;

    const { ws, unsubscribe } = subscribeToDepositStatus(depositId, {
      onStatusUpdate: handleStatusUpdate,
      onOpen: () => {
        setIsConnected(true);
        // Clear polling when WebSocket connects
        if (pollTimeoutRef.current) {
          clearTimeout(pollTimeoutRef.current);
          pollTimeoutRef.current = null;
        }
      },
      onClose: () => {
        setIsConnected(false);
        // Start polling as fallback
        if (!isDepositTerminal(prevStatusRef.current || "pending")) {
          startPolling();
        }
      },
      onError: () => {
        setIsConnected(false);
      },
    });

    wsRef.current = ws;

    return () => {
      unsubscribe();
      wsRef.current = null;
    };
  }, [depositId, useWebSocket, handleStatusUpdate]);

  // Polling function
  const startPolling = useCallback(() => {
    if (pollTimeoutRef.current) return;

    const poll = async () => {
      await fetchStatus();

      // Continue polling if not terminal and not connected via WebSocket
      if (
        !isConnected &&
        deposit &&
        !isDepositTerminal(deposit.status)
      ) {
        pollTimeoutRef.current = setTimeout(poll, pollInterval);
      }
    };

    poll();
  }, [fetchStatus, isConnected, deposit, pollInterval]);

  // Initial fetch and polling setup
  useEffect(() => {
    if (!depositId) {
      setDeposit(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    fetchStatus();

    // Start polling if WebSocket is disabled
    if (!useWebSocket) {
      startPolling();
    }

    return () => {
      if (pollTimeoutRef.current) {
        clearTimeout(pollTimeoutRef.current);
        pollTimeoutRef.current = null;
      }
    };
  }, [depositId, useWebSocket, fetchStatus, startPolling]);

  // Manual refresh
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
