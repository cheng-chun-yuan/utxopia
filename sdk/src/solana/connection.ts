/**
 * Connection Adapter Factory
 *
 * Creates ConnectionAdapter instances for use with SDK functions.
 * Supports both @solana/kit and @solana/web3.js connections.
 */

import type { ConnectionAdapter } from "../stealth";

// =============================================================================
// Types
// =============================================================================

export interface RpcConfig {
  /** RPC endpoint URL */
  endpoint: string;
  /** Commitment level */
  commitment?: "processed" | "confirmed" | "finalized";
}

/**
 * Minimal interface for @solana/web3.js Connection-like objects
 */
export interface Web3Connection {
  getAccountInfo(
    publicKey: { toBase58(): string } | string,
    commitment?: string
  ): Promise<{ data: Buffer | Uint8Array } | null>;
}

/**
 * Minimal interface for @solana/kit Rpc-like objects
 */
export interface KitRpc {
  getAccountInfo(
    address: string,
    config?: { encoding: string }
  ): { send(): Promise<{ value: { data: string | string[] } | null }> };
}

// =============================================================================
// Connection Adapter Factory
// =============================================================================

/**
 * Create a ConnectionAdapter using fetch (works everywhere)
 *
 * This is the most portable option - works in browser, Node.js, and React Native.
 *
 * @param endpoint - Solana RPC endpoint URL
 * @returns ConnectionAdapter instance
 */
export function createFetchConnectionAdapter(endpoint: string): ConnectionAdapter {
  return {
    getAccountInfo: async (address: string) => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getAccountInfo",
          params: [address, { encoding: "base64" }],
        }),
      });

      const result = await response.json();

      if (!result.result?.value) {
        return null;
      }

      // Decode base64 data
      const base64Data = Array.isArray(result.result.value.data)
        ? result.result.value.data[0]
        : result.result.value.data;

      if (!base64Data) {
        return { data: new Uint8Array() };
      }

      // Decode base64 (works in browser and Node.js)
      const binaryString = typeof atob !== "undefined"
        ? atob(base64Data)
        : Buffer.from(base64Data, "base64").toString("binary");

      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      return { data: bytes };
    },
  };
}

/**
 * Create a ConnectionAdapter from @solana/web3.js Connection
 *
 * Use this when you already have a Connection instance from wallet adapter.
 *
 * @param connection - @solana/web3.js Connection instance
 * @returns ConnectionAdapter instance
 */
export function createConnectionAdapterFromWeb3(
  connection: Web3Connection
): ConnectionAdapter {
  return {
    getAccountInfo: async (address: string) => {
      // Handle both string and PublicKey-like objects
      const info = await connection.getAccountInfo(address);
      if (!info) return null;
      return { data: new Uint8Array(info.data) };
    },
  };
}

/**
 * Create a ConnectionAdapter from @solana/kit Rpc
 *
 * Use this when using the modern @solana/kit library.
 *
 * @param rpc - @solana/kit Rpc instance
 * @returns ConnectionAdapter instance
 */
export function createConnectionAdapterFromKit(rpc: KitRpc): ConnectionAdapter {
  return {
    getAccountInfo: async (address: string) => {
      const result = await rpc
        .getAccountInfo(address, { encoding: "base64" })
        .send();

      if (!result.value) {
        return null;
      }

      // Decode base64 data
      const base64Data = typeof result.value.data === "string"
        ? result.value.data
        : result.value.data[0];

      if (!base64Data) {
        return { data: new Uint8Array() };
      }

      // Decode base64
      const binaryString = typeof atob !== "undefined"
        ? atob(base64Data)
        : Buffer.from(base64Data, "base64").toString("binary");

      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      return { data: bytes };
    },
  };
}

// =============================================================================
// Cached Connection Adapter
// =============================================================================

let cachedAdapter: ConnectionAdapter | null = null;
let cachedEndpoint: string | null = null;

/**
 * Get or create a cached ConnectionAdapter
 *
 * Caches the adapter for the given endpoint to avoid creating multiple instances.
 *
 * @param endpoint - Solana RPC endpoint URL
 * @returns ConnectionAdapter instance
 */
export function getConnectionAdapter(endpoint: string): ConnectionAdapter {
  if (cachedAdapter && cachedEndpoint === endpoint) {
    return cachedAdapter;
  }

  cachedAdapter = createFetchConnectionAdapter(endpoint);
  cachedEndpoint = endpoint;
  return cachedAdapter;
}

/**
 * Clear the cached ConnectionAdapter
 */
export function clearConnectionAdapterCache(): void {
  cachedAdapter = null;
  cachedEndpoint = null;
}
