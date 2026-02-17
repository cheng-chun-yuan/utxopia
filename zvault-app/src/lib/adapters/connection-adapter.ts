/**
 * Solana Connection Adapters
 *
 * Provides two connection strategies:
 * 1. @solana/kit Rpc for pure RPC reads (modern, efficient)
 * 2. @solana/web3.js Connection for wallet adapter compatibility
 *
 * Uses SDK's connection adapter factory with app-specific configuration.
 */

import { createSolanaRpc, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  createFetchConnectionAdapter,
  createConnectionAdapterFromWeb3 as sdkCreateConnectionAdapterFromWeb3,
  type ConnectionAdapter,
} from "@zvault/sdk";
import { HELIUS_RPC_DEVNET } from "@/lib/helius";

// Re-export ConnectionAdapter type
export type { ConnectionAdapter };

// =============================================================================
// RPC URL Configuration
// =============================================================================

/**
 * Get the configured RPC URL.
 */
export function getRpcUrl(): string {
  return HELIUS_RPC_DEVNET || process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";
}

// =============================================================================
// @solana/kit Rpc (Modern - for pure reads)
// =============================================================================

/** Cached @solana/kit Rpc instance */
let cachedRpc: Rpc<SolanaRpcApi> | null = null;

/**
 * Get a singleton @solana/kit Rpc instance.
 * Use this for pure RPC reads (account fetching, state queries).
 */
export function getRpc(): Rpc<SolanaRpcApi> {
  if (!cachedRpc) {
    cachedRpc = createSolanaRpc(getRpcUrl());
  }
  return cachedRpc;
}

/**
 * Fetch account info using @solana/kit.
 * Returns null if account doesn't exist.
 */
export async function fetchAccountInfo(address: string): Promise<{ data: Uint8Array } | null> {
  const rpc = getRpc();
  const result = await rpc.getAccountInfo(address as Parameters<typeof rpc.getAccountInfo>[0], {
    encoding: "base64",
  }).send();

  if (!result.value) {
    return null;
  }

  // Decode base64 data
  const data = typeof result.value.data === "string"
    ? Uint8Array.from(atob(result.value.data), c => c.charCodeAt(0))
    : result.value.data[0]
      ? Uint8Array.from(atob(result.value.data[0]), c => c.charCodeAt(0))
      : new Uint8Array();

  return { data };
}

// =============================================================================
// @solana/web3.js Connection (Legacy - for wallet adapter)
// =============================================================================

/** Cached @solana/web3.js Connection instance */
let cachedConnection: Connection | null = null;

/**
 * Get a singleton @solana/web3.js Connection instance.
 * Use this for wallet adapter integration and transaction signing.
 */
export function getConnection(): Connection {
  if (!cachedConnection) {
    cachedConnection = new Connection(getRpcUrl(), "confirmed");
  }
  return cachedConnection;
}

// =============================================================================
// SDK ConnectionAdapter (for @zvault/sdk compatibility)
// =============================================================================

/**
 * Create a ConnectionAdapter that wraps @solana/kit Rpc
 * for use with @zvault/sdk functions.
 */
export function createConnectionAdapter(): ConnectionAdapter {
  return createFetchConnectionAdapter(getRpcUrl());
}

/**
 * Create a ConnectionAdapter from @solana/web3.js Connection.
 * Use this when you already have a Connection instance.
 */
export function createConnectionAdapterFromWeb3(connection: Connection): ConnectionAdapter {
  return sdkCreateConnectionAdapterFromWeb3({
    getAccountInfo: async (publicKey: string) => {
      const pk = new PublicKey(publicKey);
      const info = await connection.getAccountInfo(pk);
      return info ? { data: new Uint8Array(info.data) } : null;
    },
  });
}

/**
 * Get a ConnectionAdapter using @solana/kit.
 * Convenience function for SDK operations.
 */
export function getConnectionAdapter(): ConnectionAdapter {
  return createConnectionAdapter();
}
