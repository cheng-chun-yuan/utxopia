/**
 * React Native / Expo Deposit Watcher
 *
 * React Native implementation using:
 * - AsyncStorage for persistence
 * - Built-in WebSocket for real-time transaction detection
 *
 * Note: This module requires @react-native-async-storage/async-storage
 * to be installed in your React Native/Expo project.
 */

import { BaseDepositWatcher } from "./base";
import {
  WatcherCallbacks,
  WatcherConfig,
  StorageAdapter,
  MempoolWsMessage,
} from "./types";

// Type for AsyncStorage (to avoid direct import)
interface AsyncStorageStatic {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

// Will be set by the user via setAsyncStorage()
let asyncStorageInstance: AsyncStorageStatic | null = null;

/**
 * Set the AsyncStorage instance for React Native
 *
 * Must be called before creating a NativeDepositWatcher.
 *
 * @example
 * ```typescript
 * import AsyncStorage from '@react-native-async-storage/async-storage';
 * import { setAsyncStorage, createNativeWatcher } from '@zvault/sdk/watcher/native';
 *
 * setAsyncStorage(AsyncStorage);
 *
 * const watcher = createNativeWatcher({
 *   onDetected: (deposit) => console.log('Detected!'),
 * });
 * ```
 */
export function setAsyncStorage(storage: AsyncStorageStatic): void {
  asyncStorageInstance = storage;
}

/**
 * AsyncStorage-based storage adapter
 */
const NATIVE_STORAGE: StorageAdapter = {
  async get(key: string): Promise<string | null> {
    if (!asyncStorageInstance) {
      console.warn(
        "[DepositWatcher] AsyncStorage not set. Call setAsyncStorage() first."
      );
      return null;
    }
    return asyncStorageInstance.getItem(key);
  },

  async set(key: string, value: string): Promise<void> {
    if (!asyncStorageInstance) {
      console.warn(
        "[DepositWatcher] AsyncStorage not set. Call setAsyncStorage() first."
      );
      return;
    }
    await asyncStorageInstance.setItem(key, value);
  },

  async remove(key: string): Promise<void> {
    if (!asyncStorageInstance) {
      console.warn(
        "[DepositWatcher] AsyncStorage not set. Call setAsyncStorage() first."
      );
      return;
    }
    await asyncStorageInstance.removeItem(key);
  },
};

/**
 * React Native deposit watcher
 *
 * Features:
 * - Real-time transaction detection via mempool.space WebSocket
 * - Automatic persistence to AsyncStorage
 * - Background reconnection
 * - Confirmation tracking
 */
export class NativeDepositWatcher extends BaseDepositWatcher {
  private ws: WebSocket | null = null;
  private reconnectTimeout?: ReturnType<typeof setTimeout>;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private baseReconnectDelay: number = 1000;

  constructor(
    callbacks: WatcherCallbacks = {},
    config: Partial<WatcherConfig> = {}
  ) {
    super(NATIVE_STORAGE, callbacks, config);
  }

  // =========================================================================
  // WebSocket Implementation
  // =========================================================================

  connectWebSocket(): void {
    // React Native has built-in WebSocket support
    if (typeof WebSocket === "undefined") {
      console.warn("[DepositWatcher] WebSocket not available");
      this.startPolling();
      return;
    }

    // Don't reconnect if already connected
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    // Close existing connection
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    try {
      this.ws = new WebSocket(this.config.wsUrl);

      this.ws.onopen = () => {
        console.log("[DepositWatcher] WebSocket connected");
        this.reconnectAttempts = 0;

        // Resubscribe to all watched addresses
        for (const deposit of this.deposits.values()) {
          if (deposit.status === "waiting" || deposit.status === "detected") {
            this.subscribeToAddress(deposit.taprootAddress);
          }
        }
      };

      this.ws.onmessage = (event: MessageEvent) => {
        try {
          const data: MempoolWsMessage = JSON.parse(event.data);

          // Handle address transaction notifications
          if (data["address-transactions"]) {
            this.handleTransactions(data["address-transactions"]);
          }
        } catch (err) {
          console.error("[DepositWatcher] Failed to parse WebSocket message:", err);
        }
      };

      this.ws.onerror = (error: Event) => {
        console.error("[DepositWatcher] WebSocket error:", error);
      };

      this.ws.onclose = (event: CloseEvent) => {
        console.log(
          `[DepositWatcher] WebSocket closed: ${event.code} ${event.reason}`
        );
        this.ws = null;

        // Attempt to reconnect
        this.scheduleReconnect();
      };
    } catch (err) {
      console.error("[DepositWatcher] Failed to create WebSocket:", err);
      this.scheduleReconnect();
    }
  }

  disconnectWebSocket(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = undefined;
    }

    if (this.ws) {
      this.ws.onclose = null; // Prevent reconnection
      this.ws.close();
      this.ws = null;
    }
  }

  protected subscribeToAddress(address: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ "track-address": address }));
      console.log(`[DepositWatcher] Subscribed to address: ${address}`);
    }
  }

  // =========================================================================
  // Reconnection Logic
  // =========================================================================

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(
        "[DepositWatcher] Max reconnection attempts reached, falling back to polling"
      );
      this.startPolling();
      return;
    }

    // Exponential backoff with jitter
    const delay =
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts) +
      Math.random() * 1000;

    console.log(
      `[DepositWatcher] Reconnecting in ${Math.round(delay)}ms (attempt ${
        this.reconnectAttempts + 1
      }/${this.maxReconnectAttempts})`
    );

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectAttempts++;
      this.connectWebSocket();
    }, delay);
  }

  // =========================================================================
  // Polling fallback
  // =========================================================================

  protected startPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }

    this.pollingInterval = setInterval(
      () => this.pollAddresses(),
      this.config.pollingInterval
    );

    // Poll immediately
    this.pollAddresses();
  }
}

/**
 * Create a React Native deposit watcher instance
 *
 * Note: You must call setAsyncStorage() with your AsyncStorage instance
 * before calling init() on the watcher.
 *
 * @param callbacks - Event callbacks
 * @param config - Watcher configuration
 * @returns NativeDepositWatcher instance
 *
 * @example
 * ```typescript
 * import AsyncStorage from '@react-native-async-storage/async-storage';
 * import { setAsyncStorage, createNativeWatcher } from '@zvault/sdk/watcher/native';
 *
 * setAsyncStorage(AsyncStorage);
 *
 * const watcher = createNativeWatcher({
 *   onDetected: (deposit) => {
 *     console.log('Deposit detected!', deposit.txid);
 *   },
 *   onConfirming: (deposit, confirmations) => {
 *     console.log(`Confirmations: ${confirmations}/${deposit.requiredConfirmations}`);
 *   },
 *   onConfirmed: (deposit) => {
 *     console.log('Ready to verify!');
 *   },
 * });
 *
 * await watcher.init();
 *
 * const deposit = await watcher.createDeposit(100_000n);
 * console.log('Send BTC to:', deposit.taprootAddress);
 * console.log('Share this link:', deposit.claimLink);
 * ```
 */
export function createNativeWatcher(
  callbacks: WatcherCallbacks = {},
  config: Partial<WatcherConfig> = {}
): NativeDepositWatcher {
  return new NativeDepositWatcher(callbacks, config);
}
