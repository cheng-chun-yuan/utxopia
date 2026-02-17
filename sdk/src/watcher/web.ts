/**
 * Web Deposit Watcher
 *
 * Browser implementation using:
 * - localStorage for persistence
 * - WebSocket for real-time transaction detection
 */

import { BaseDepositWatcher } from "./base";
import {
  WatcherCallbacks,
  WatcherConfig,
  StorageAdapter,
  MempoolWsMessage,
} from "./types";

/**
 * localStorage-based storage adapter
 */
const WEB_STORAGE: StorageAdapter = {
  async get(key: string): Promise<string | null> {
    if (typeof window === "undefined" || !window.localStorage) {
      return null;
    }
    return localStorage.getItem(key);
  },

  async set(key: string, value: string): Promise<void> {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }
    localStorage.setItem(key, value);
  },

  async remove(key: string): Promise<void> {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }
    localStorage.removeItem(key);
  },
};

/**
 * Web-based deposit watcher for browsers
 *
 * Features:
 * - Real-time transaction detection via mempool.space WebSocket
 * - Automatic persistence to localStorage
 * - Reconnection on disconnect
 * - Confirmation tracking
 */
export class WebDepositWatcher extends BaseDepositWatcher {
  private ws: WebSocket | null = null;
  private reconnectTimeout?: ReturnType<typeof setTimeout>;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private baseReconnectDelay: number = 1000;

  constructor(
    callbacks: WatcherCallbacks = {},
    config: Partial<WatcherConfig> = {}
  ) {
    super(WEB_STORAGE, callbacks, config);
  }

  // =========================================================================
  // WebSocket Implementation
  // =========================================================================

  connectWebSocket(): void {
    // Don't connect if we're in a non-browser environment
    if (typeof WebSocket === "undefined") {
      console.warn("WebSocket not available, falling back to polling");
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
  // Polling fallback (override to make it public for manual triggering)
  // =========================================================================

  protected startPolling(): void {
    // Clear existing polling interval
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }

    // Start polling
    this.pollingInterval = setInterval(
      () => this.pollAddresses(),
      this.config.pollingInterval
    );

    // Also poll immediately
    this.pollAddresses();
  }
}

/**
 * Create a web deposit watcher instance
 *
 * @param callbacks - Event callbacks
 * @param config - Watcher configuration
 * @returns WebDepositWatcher instance
 *
 * @example
 * ```typescript
 * const watcher = createWebWatcher({
 *   onDetected: (deposit) => console.log('Detected!', deposit.txid),
 *   onConfirmed: (deposit) => console.log('Confirmed!', deposit.confirmations),
 * });
 *
 * await watcher.init();
 * const deposit = await watcher.createDeposit(100_000n);
 * console.log('Send BTC to:', deposit.taprootAddress);
 * ```
 */
export function createWebWatcher(
  callbacks: WatcherCallbacks = {},
  config: Partial<WatcherConfig> = {}
): WebDepositWatcher {
  return new WebDepositWatcher(callbacks, config);
}
