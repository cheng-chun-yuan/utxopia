/**
 * Deposit Watcher Module
 *
 * Watch Bitcoin deposits in real-time and track confirmation progress.
 *
 * Platform-specific implementations:
 * - Web: Uses localStorage + WebSocket
 * - React Native: Uses AsyncStorage + WebSocket
 */

// Types
export {
  DepositStatus,
  PendingDeposit,
  WatcherCallbacks,
  WatcherConfig,
  StorageAdapter,
  SerializedDeposit,
  MempoolWsMessage,
  MempoolAddressTransaction,
  DEFAULT_WATCHER_CONFIG,
  serializeDeposit,
  deserializeDeposit,
  generateDepositId,
} from "./types";

// Base class (for custom implementations)
export { BaseDepositWatcher } from "./base";

// Web implementation
export { WebDepositWatcher, createWebWatcher } from "./web";

// React Native implementation
export {
  NativeDepositWatcher,
  createNativeWatcher,
  setAsyncStorage,
} from "./native";
