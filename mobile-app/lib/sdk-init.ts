/**
 * SDK Initialization for React Native
 *
 * Sets up AsyncStorage, Poseidon, and proof system.
 * Must be called before using SDK functions.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { setAsyncStorage, initPoseidon, isPoseidonReady } from '@zvault/sdk';
import { initializeProofSystem, isProofSystemReady, type InitProgress } from './proof';

let isInitialized = false;
let isProofReady = false;
let initPromise: Promise<void> | null = null;

export type SDKInitProgress = {
  stage: 'sdk' | 'proof';
  message: string;
  proofProgress?: InitProgress;
};

/**
 * Initialize the zVault SDK for React Native
 *
 * Sets up:
 * - AsyncStorage for deposit watcher persistence
 * - Poseidon hash function for ZK proofs
 * - Native Groth16 proof system (circuits + snarkjs)
 *
 * Safe to call multiple times - initialization only happens once.
 */
export async function initSDK(
  onProgress?: (progress: SDKInitProgress) => void
): Promise<void> {
  // Return existing promise if initialization is in progress
  if (initPromise) {
    return initPromise;
  }

  // Skip if already initialized
  if (isInitialized) {
    return;
  }

  initPromise = (async () => {
    try {
      onProgress?.({ stage: 'sdk', message: 'Initializing SDK...' });
      console.log('[SDK] Initializing zVault SDK...');

      // Set up AsyncStorage for deposit watcher
      setAsyncStorage(AsyncStorage);
      console.log('[SDK] AsyncStorage configured');

      // Initialize Poseidon if not already ready
      if (!isPoseidonReady()) {
        await initPoseidon();
        console.log('[SDK] Poseidon initialized');
      }

      isInitialized = true;
      console.log('[SDK] Core SDK initialized');

      // Initialize proof system (may download SRS on first run)
      onProgress?.({ stage: 'proof', message: 'Initializing proof system...' });

      isProofReady = await initializeProofSystem((proofProgress) => {
        onProgress?.({
          stage: 'proof',
          message: proofProgress.message,
          proofProgress,
        });
      });

      if (isProofReady) {
        console.log('[SDK] Proof system initialized');
      } else {
        console.warn('[SDK] Proof system not available - ZK proofs disabled');
      }

      console.log('[SDK] zVault SDK initialized successfully');
    } catch (error) {
      console.error('[SDK] Failed to initialize:', error);
      initPromise = null;
      throw error;
    }
  })();

  return initPromise;
}

/**
 * Check if SDK is initialized
 */
export function isSDKReady(): boolean {
  return isInitialized && isPoseidonReady();
}

/**
 * Check if proof system is ready
 */
export function canGenerateProofs(): boolean {
  return isProofReady;
}
