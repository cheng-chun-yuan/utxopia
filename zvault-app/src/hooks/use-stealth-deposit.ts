/**
 * useStealthDeposit Hook
 *
 * React hook for the backend-managed stealth deposit flow.
 *
 * Flow:
 * 1. Call prepareDeposit() with user's viewing/spending pubkeys
 * 2. Backend generates ephemeral key, returns BTC address
 * 3. User sends BTC to the address
 * 4. Hook automatically tracks status via WebSocket
 * 5. When status is "ready", user can scan their Stealth Inbox
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  prepareStealthDeposit,
  getStealthDepositStatus,
  subscribeToStealthDeposit,
  StealthDepositStatus,
  StealthDepositStatusResponse,
  StealthDepositStatusUpdate,
  isStealthDepositTerminal,
  getStealthStatusMessage,
  getStealthDepositProgress,
} from "@/lib/api/deposits";

export interface UseStealthDepositOptions {
  /** Callback when status changes */
  onStatusChange?: (
    status: StealthDepositStatus,
    prevStatus?: StealthDepositStatus
  ) => void;
  /** Callback when deposit is ready */
  onReady?: () => void;
  /** Callback on error */
  onError?: (error: string) => void;
  /** Poll interval in ms (default: 5000) */
  pollInterval?: number;
  /** Use WebSocket for real-time updates (default: true) */
  useWebSocket?: boolean;
}

export interface UseStealthDepositResult {
  /** Prepare a new stealth deposit address */
  prepareDeposit: (viewingPub: string, spendingPub: string) => Promise<void>;
  /** Current deposit ID */
  depositId: string | null;
  /** BTC address to send to */
  btcAddress: string | null;
  /** Ephemeral public key for ECDH */
  ephemeralPub: string | null;
  /** Current status */
  status: StealthDepositStatus | null;
  /** Human-readable status message */
  statusMessage: string;
  /** Actual amount received (after detection) */
  actualAmount: number | null;
  /** Deposit confirmations */
  confirmations: number;
  /** Sweep confirmations */
  sweepConfirmations: number;
  /** Progress percentage (0-100) */
  progress: number;
  /** Whether deposit is ready (user can scan inbox) */
  isReady: boolean;
  /** Whether deposit failed */
  isFailed: boolean;
  /** Whether currently loading */
  isLoading: boolean;
  /** WebSocket connected */
  isConnected: boolean;
  /** Error message */
  error: string | null;
  /** Reset state to prepare new deposit */
  reset: () => void;
  /** Manually refresh status */
  refresh: () => Promise<void>;
  /** Deposit txid (after detection) */
  depositTxid: string | null;
  /** Sweep txid (after sweep) */
  sweepTxid: string | null;
  /** Solana transaction signature */
  solanaTx: string | null;
  /** Leaf index in commitment tree */
  leafIndex: number | null;
  /** Expiration timestamp */
  expiresAt: number | null;
}

export function useStealthDeposit(
  options: UseStealthDepositOptions = {}
): UseStealthDepositResult {
  const {
    onStatusChange,
    onReady,
    onError,
    pollInterval = 5000,
    useWebSocket = true,
  } = options;

  // State
  const [depositId, setDepositId] = useState<string | null>(null);
  const [btcAddress, setBtcAddress] = useState<string | null>(null);
  const [ephemeralPub, setEphemeralPub] = useState<string | null>(null);
  const [status, setStatus] = useState<StealthDepositStatus | null>(null);
  const [actualAmount, setActualAmount] = useState<number | null>(null);
  const [confirmations, setConfirmations] = useState(0);
  const [sweepConfirmations, setSweepConfirmations] = useState(0);
  const [depositTxid, setDepositTxid] = useState<string | null>(null);
  const [sweepTxid, setSweepTxid] = useState<string | null>(null);
  const [solanaTx, setSolanaTx] = useState<string | null>(null);
  const [leafIndex, setLeafIndex] = useState<number | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs
  const prevStatusRef = useRef<StealthDepositStatus | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pollTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Computed
  const statusMessage = status ? getStealthStatusMessage(status) : "Not started";
  const progress = status
    ? getStealthDepositProgress(status, confirmations, sweepConfirmations)
    : 0;
  const isReady = status === "ready";
  const isFailed = status === "failed";

  // Update state from response
  const updateFromResponse = useCallback(
    (data: StealthDepositStatusResponse | StealthDepositStatusUpdate) => {
      const newStatus = data.status as StealthDepositStatus;

      if ("btc_address" in data) {
        setBtcAddress(data.btc_address);
        setEphemeralPub(data.ephemeral_pub);
        if (data.deposit_txid) setDepositTxid(data.deposit_txid);
        if (data.sweep_txid) setSweepTxid(data.sweep_txid);
        if (data.solana_tx) setSolanaTx(data.solana_tx);
        if (data.leaf_index !== undefined) setLeafIndex(data.leaf_index);
        if (data.expires_at) setExpiresAt(data.expires_at);
      }

      if ("actual_amount_sats" in data && data.actual_amount_sats !== undefined) {
        setActualAmount(data.actual_amount_sats);
      }

      setStatus(newStatus);
      setConfirmations(data.confirmations);
      setSweepConfirmations(data.sweep_confirmations);

      if (data.error) {
        setError(data.error);
        onError?.(data.error);
      }

      // Trigger callbacks on status change
      if (prevStatusRef.current !== newStatus) {
        onStatusChange?.(newStatus, prevStatusRef.current || undefined);

        if (newStatus === "ready") {
          onReady?.();
        }

        prevStatusRef.current = newStatus;
      }
    },
    [onStatusChange, onReady, onError]
  );

  // Fetch status
  const fetchStatus = useCallback(async () => {
    if (!depositId) return;

    try {
      const data = await getStealthDepositStatus(depositId);
      updateFromResponse(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to fetch status";
      setError(message);
      onError?.(message);
    }
  }, [depositId, updateFromResponse, onError]);

  // Prepare a new deposit
  const prepareDeposit = useCallback(
    async (viewingPub: string, spendingPub: string) => {
      setIsLoading(true);
      setError(null);

      try {
        const response = await prepareStealthDeposit(viewingPub, spendingPub);

        if (!response.success || !response.deposit_id) {
          throw new Error(response.error || "Failed to prepare deposit");
        }

        setDepositId(response.deposit_id);
        setBtcAddress(response.btc_address || null);
        setEphemeralPub(response.ephemeral_pub || null);
        setExpiresAt(response.expires_at || null);
        setStatus("pending");
        prevStatusRef.current = "pending";
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to prepare deposit";
        setError(message);
        onError?.(message);
      } finally {
        setIsLoading(false);
      }
    },
    [onError]
  );

  // Reset state
  const reset = useCallback(() => {
    // Cleanup WebSocket
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    // Cleanup polling
    if (pollTimeoutRef.current) {
      clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }

    // Reset state
    setDepositId(null);
    setBtcAddress(null);
    setEphemeralPub(null);
    setStatus(null);
    setActualAmount(null);
    setConfirmations(0);
    setSweepConfirmations(0);
    setDepositTxid(null);
    setSweepTxid(null);
    setSolanaTx(null);
    setLeafIndex(null);
    setExpiresAt(null);
    setIsLoading(false);
    setIsConnected(false);
    setError(null);
    prevStatusRef.current = null;
  }, []);

  // Polling fallback
  const startPolling = useCallback(() => {
    const poll = async () => {
      await fetchStatus();

      // Continue polling if not terminal
      if (status && !isStealthDepositTerminal(status)) {
        pollTimeoutRef.current = setTimeout(poll, pollInterval);
      }
    };

    poll();
  }, [fetchStatus, status, pollInterval]);

  // WebSocket effect
  useEffect(() => {
    if (!depositId || !useWebSocket) return;

    const { ws, unsubscribe } = subscribeToStealthDeposit(depositId, {
      onStatusUpdate: (update) => {
        updateFromResponse(update);
      },
      onOpen: () => {
        setIsConnected(true);
        // Clear polling when WS connects
        if (pollTimeoutRef.current) {
          clearTimeout(pollTimeoutRef.current);
          pollTimeoutRef.current = null;
        }
      },
      onClose: () => {
        setIsConnected(false);
        // Resume polling on disconnect if not terminal
        if (status && !isStealthDepositTerminal(status)) {
          startPolling();
        }
      },
      onError: () => {
        // Fall back to polling on error
        if (!pollTimeoutRef.current) {
          startPolling();
        }
      },
    });

    wsRef.current = ws;

    return () => {
      unsubscribe();
      wsRef.current = null;
    };
  }, [depositId, useWebSocket, updateFromResponse, status, startPolling]);

  // Start polling if not using WebSocket
  useEffect(() => {
    if (!depositId || useWebSocket) return;

    startPolling();

    return () => {
      if (pollTimeoutRef.current) {
        clearTimeout(pollTimeoutRef.current);
        pollTimeoutRef.current = null;
      }
    };
  }, [depositId, useWebSocket, startPolling]);

  // Initial fetch when depositId is set
  useEffect(() => {
    if (depositId && status === "pending") {
      fetchStatus();
    }
  }, [depositId, status, fetchStatus]);

  return {
    prepareDeposit,
    depositId,
    btcAddress,
    ephemeralPub,
    status,
    statusMessage,
    actualAmount,
    confirmations,
    sweepConfirmations,
    progress,
    isReady,
    isFailed,
    isLoading,
    isConnected,
    error,
    reset,
    refresh: fetchStatus,
    depositTxid,
    sweepTxid,
    solanaTx,
    leafIndex,
    expiresAt,
  };
}
