"use client";

/**
 * React Hook for Deposit Watching
 *
 * Universal hook that works in both React (web) and React Native.
 * Automatically detects platform and uses appropriate watcher.
 *
 * Features:
 * - Real-time deposit detection
 * - Confirmation progress tracking
 * - Automatic persistence
 * - TypeScript support
 */

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { WebDepositWatcher, createWebWatcher } from "../watcher/web";
import { NativeDepositWatcher, createNativeWatcher } from "../watcher/native";
import {
  PendingDeposit,
  WatcherCallbacks,
  WatcherConfig,
  DepositStatus,
} from "../watcher/types";
import { BaseDepositWatcher } from "../watcher/base";

/**
 * Detect if running in React Native
 */
function isReactNative(): boolean {
  return (
    typeof navigator !== "undefined" && navigator.product === "ReactNative"
  );
}

/**
 * Hook state
 */
export interface UseDepositWatcherState {
  /** All pending deposits */
  deposits: PendingDeposit[];

  /** Whether the watcher is initialized */
  isReady: boolean;

  /** Loading state during initialization */
  isLoading: boolean;

  /** Error state */
  error: Error | null;
}

/**
 * Hook actions
 */
export interface UseDepositWatcherActions {
  /** Create a new deposit to watch */
  createDeposit: (amount: bigint, baseUrl?: string) => Promise<PendingDeposit>;

  /** Manually watch an existing deposit */
  watchDeposit: (deposit: PendingDeposit) => Promise<void>;

  /** Get a deposit by ID */
  getDeposit: (id: string) => PendingDeposit | undefined;

  /** Get deposits by status */
  getDepositsByStatus: (status: DepositStatus) => PendingDeposit[];

  /** Remove a deposit from tracking */
  removeDeposit: (id: string) => Promise<void>;

  /** Mark deposit as verified */
  markVerified: (id: string, leafIndex: number) => Promise<void>;

  /** Mark deposit as claimed */
  markClaimed: (id: string) => Promise<void>;

  /** Manually refresh a deposit's status */
  refreshDeposit: (id: string) => Promise<PendingDeposit | undefined>;

  /** Manually refresh all deposits */
  refreshAll: () => Promise<void>;
}

/**
 * Hook return type
 */
export type UseDepositWatcherReturn = UseDepositWatcherState &
  UseDepositWatcherActions;

/**
 * Hook options
 */
export interface UseDepositWatcherOptions extends Partial<WatcherConfig> {
  /** Custom callbacks (in addition to hook state updates) */
  callbacks?: WatcherCallbacks;

  /** Auto-initialize on mount (default: true) */
  autoInit?: boolean;
}

/**
 * React hook for watching Bitcoin deposits
 *
 * @param options - Configuration options
 * @returns State and actions for deposit management
 *
 * @example
 * ```tsx
 * function DepositScreen() {
 *   const {
 *     deposits,
 *     isReady,
 *     createDeposit,
 *     getDepositsByStatus,
 *   } = useDepositWatcher({
 *     requiredConfirmations: 6,
 *     callbacks: {
 *       onConfirmed: (deposit) => {
 *         console.log('Ready to verify on Solana!');
 *       },
 *     },
 *   });
 *
 *   const handleDeposit = async () => {
 *     const deposit = await createDeposit(100_000n);
 *     // Show QR code for deposit.taprootAddress
 *   };
 *
 *   const waitingDeposits = getDepositsByStatus('waiting');
 *   const confirmingDeposits = getDepositsByStatus('confirming');
 *   const readyToClaim = getDepositsByStatus('confirmed');
 *
 *   return (
 *     <div>
 *       <button onClick={handleDeposit}>Create Deposit</button>
 *
 *       {confirmingDeposits.map(d => (
 *         <div key={d.id}>
 *           {d.confirmations}/{d.requiredConfirmations} confirmations
 *         </div>
 *       ))}
 *     </div>
 *   );
 * }
 * ```
 */
export function useDepositWatcher(
  options: UseDepositWatcherOptions = {}
): UseDepositWatcherReturn {
  const { callbacks: userCallbacks, autoInit = true, ...config } = options;

  // State
  const [deposits, setDeposits] = useState<PendingDeposit[]>([]);
  const [isReady, setIsReady] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Watcher ref
  const watcherRef = useRef<BaseDepositWatcher | null>(null);

  // Store user callbacks in ref to avoid stale closures
  const userCallbacksRef = useRef(userCallbacks);
  userCallbacksRef.current = userCallbacks;

  // Store config in ref to avoid re-initialization
  const configRef = useRef(config);

  // Update deposits state from watcher
  const syncDeposits = useCallback(() => {
    if (watcherRef.current) {
      setDeposits([...watcherRef.current.getAllDeposits()]);
    }
  }, []);

  // Memoize internal callbacks to prevent recreation on every render
  const internalCallbacks = useMemo<WatcherCallbacks>(() => ({
    onDetected: (deposit) => {
      syncDeposits();
      userCallbacksRef.current?.onDetected?.(deposit);
    },
    onConfirming: (deposit, confirmations) => {
      syncDeposits();
      userCallbacksRef.current?.onConfirming?.(deposit, confirmations);
    },
    onConfirmed: (deposit) => {
      syncDeposits();
      userCallbacksRef.current?.onConfirmed?.(deposit);
    },
    onVerified: (deposit) => {
      syncDeposits();
      userCallbacksRef.current?.onVerified?.(deposit);
    },
    onClaimed: (deposit) => {
      syncDeposits();
      userCallbacksRef.current?.onClaimed?.(deposit);
    },
    onError: (deposit, err) => {
      syncDeposits();
      userCallbacksRef.current?.onError?.(deposit, err);
    },
    onStatusChange: (deposit, oldStatus, newStatus) => {
      syncDeposits();
      userCallbacksRef.current?.onStatusChange?.(deposit, oldStatus, newStatus);
    },
  }), [syncDeposits]);

  // Initialize watcher on mount
  useEffect(() => {
    if (!autoInit) {
      setIsLoading(false);
      return;
    }

    let watcher: BaseDepositWatcher;
    let mounted = true;

    // Create platform-specific watcher
    if (isReactNative()) {
      watcher = createNativeWatcher(internalCallbacks, configRef.current);
    } else {
      watcher = createWebWatcher(internalCallbacks, configRef.current);
    }

    watcherRef.current = watcher;

    // Initialize
    watcher
      .init()
      .then(() => {
        if (mounted) {
          setIsReady(true);
          setIsLoading(false);
          syncDeposits();
        }
      })
      .catch((err) => {
        if (mounted) {
          setError(err);
          setIsLoading(false);
        }
      });

    // Cleanup on unmount
    return () => {
      mounted = false;
      watcher.destroy();
      watcherRef.current = null;
    };
  }, [autoInit, internalCallbacks, syncDeposits]);

  // Actions
  const createDeposit = useCallback(
    async (amount: bigint, baseUrl?: string): Promise<PendingDeposit> => {
      if (!watcherRef.current) {
        throw new Error("Watcher not initialized");
      }
      const deposit = await watcherRef.current.createDeposit(amount, baseUrl);
      syncDeposits();
      return deposit;
    },
    [syncDeposits]
  );

  const watchDeposit = useCallback(
    async (deposit: PendingDeposit): Promise<void> => {
      if (!watcherRef.current) {
        throw new Error("Watcher not initialized");
      }
      await watcherRef.current.watchDeposit(deposit);
      syncDeposits();
    },
    [syncDeposits]
  );

  const getDeposit = useCallback((id: string): PendingDeposit | undefined => {
    return watcherRef.current?.getDeposit(id);
  }, []);

  const getDepositsByStatus = useCallback(
    (status: DepositStatus): PendingDeposit[] => {
      return watcherRef.current?.getDepositsByStatus(status) || [];
    },
    []
  );

  const removeDeposit = useCallback(
    async (id: string): Promise<void> => {
      if (!watcherRef.current) {
        throw new Error("Watcher not initialized");
      }
      await watcherRef.current.removeDeposit(id);
      syncDeposits();
    },
    [syncDeposits]
  );

  const markVerified = useCallback(
    async (id: string, leafIndex: number): Promise<void> => {
      if (!watcherRef.current) {
        throw new Error("Watcher not initialized");
      }
      await watcherRef.current.markVerified(id, leafIndex);
      syncDeposits();
    },
    [syncDeposits]
  );

  const markClaimed = useCallback(
    async (id: string): Promise<void> => {
      if (!watcherRef.current) {
        throw new Error("Watcher not initialized");
      }
      await watcherRef.current.markClaimed(id);
      syncDeposits();
    },
    [syncDeposits]
  );

  const refreshDeposit = useCallback(
    async (id: string): Promise<PendingDeposit | undefined> => {
      if (!watcherRef.current) {
        throw new Error("Watcher not initialized");
      }
      const deposit = await watcherRef.current.refreshDeposit(id);
      syncDeposits();
      return deposit;
    },
    [syncDeposits]
  );

  const refreshAll = useCallback(async (): Promise<void> => {
    if (!watcherRef.current) {
      throw new Error("Watcher not initialized");
    }
    const allDeposits = watcherRef.current.getAllDeposits();
    for (const deposit of allDeposits) {
      await watcherRef.current.refreshDeposit(deposit.id);
    }
    syncDeposits();
  }, [syncDeposits]);

  return {
    // State
    deposits,
    isReady,
    isLoading,
    error,

    // Actions
    createDeposit,
    watchDeposit,
    getDeposit,
    getDepositsByStatus,
    removeDeposit,
    markVerified,
    markClaimed,
    refreshDeposit,
    refreshAll,
  };
}

/**
 * Simplified hook for a single deposit flow
 *
 * Use when you only need to track one deposit at a time.
 *
 * @example
 * ```tsx
 * function SingleDepositFlow() {
 *   const {
 *     deposit,
 *     status,
 *     confirmations,
 *     isDetected,
 *     isConfirmed,
 *     startDeposit,
 *   } = useSingleDeposit({
 *     requiredConfirmations: 6,
 *   });
 *
 *   return (
 *     <div>
 *       {!deposit && (
 *         <button onClick={() => startDeposit(100_000n)}>
 *           Deposit 0.001 BTC
 *         </button>
 *       )}
 *
 *       {deposit && !isDetected && (
 *         <div>
 *           <p>Send BTC to: {deposit.taprootAddress}</p>
 *           <QRCode value={deposit.taprootAddress} />
 *         </div>
 *       )}
 *
 *       {isDetected && !isConfirmed && (
 *         <p>Confirmations: {confirmations}/6</p>
 *       )}
 *
 *       {isConfirmed && (
 *         <button onClick={handleClaim}>Claim zBTC!</button>
 *       )}
 *     </div>
 *   );
 * }
 * ```
 */
export function useSingleDeposit(options: UseDepositWatcherOptions = {}) {
  const { deposits, isReady, isLoading, createDeposit, markVerified, markClaimed } =
    useDepositWatcher(options);

  // Track current deposit ID
  const [currentDepositId, setCurrentDepositId] = useState<string | null>(null);

  // Get current deposit
  const deposit = currentDepositId
    ? deposits.find((d) => d.id === currentDepositId)
    : null;

  // Start a new deposit
  const startDeposit = useCallback(
    async (amount: bigint, baseUrl?: string): Promise<PendingDeposit> => {
      const newDeposit = await createDeposit(amount, baseUrl);
      setCurrentDepositId(newDeposit.id);
      return newDeposit;
    },
    [createDeposit]
  );

  // Reset to start a new deposit
  const reset = useCallback(() => {
    setCurrentDepositId(null);
  }, []);

  // Computed state
  const status = deposit?.status || null;
  const confirmations = deposit?.confirmations || 0;
  const requiredConfirmations = deposit?.requiredConfirmations || 6;
  const txid = deposit?.txid || null;

  const isWaiting = status === "waiting";
  const isDetected = status === "detected" || status === "confirming";
  const isConfirming = status === "confirming";
  const isConfirmed = status === "confirmed";
  const isVerified = status === "verified";
  const isClaimed = status === "claimed";

  return {
    // State
    deposit,
    status,
    confirmations,
    requiredConfirmations,
    txid,
    isReady,
    isLoading,

    // Computed booleans
    isWaiting,
    isDetected,
    isConfirming,
    isConfirmed,
    isVerified,
    isClaimed,

    // Actions
    startDeposit,
    markVerified: (leafIndex: number) =>
      currentDepositId ? markVerified(currentDepositId, leafIndex) : Promise.resolve(),
    markClaimed: () =>
      currentDepositId ? markClaimed(currentDepositId) : Promise.resolve(),
    reset,
  };
}
