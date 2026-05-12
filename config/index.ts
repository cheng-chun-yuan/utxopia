/**
 * Network configuration loader.
 *
 * Single source of truth for all program IDs, mint addresses, and service URLs.
 * Reads from config/networks.json — no env vars needed for public addresses.
 *
 * Usage:
 *   import { getNetworkConfig } from "@/config";  // or "../../config"
 *   const cfg = getNetworkConfig();  // auto-detects from NEXT_PUBLIC_NETWORK or UTXOPIA_NETWORK
 *   cfg.solana.utxopiaProgramId
 *   cfg.tokens.zkbtcMint
 *   cfg.bitcoin.poolAddress
 */

import networksJson from "./networks.json";

export type NetworkId = "devnet" | "testnet" | "mainnet";

export interface NetworkConfig {
  solana: {
    rpcUrl: string;
    utxopiaProgramId: string;
    btcLightClientId: string;
    chadbufferId: string;
  };
  tokens: {
    zkbtcMint: string;
    usdcMint: string;
    usdtMint: string;
    wsolMint: string;
  };
  bitcoin: {
    network: string;
    poolAddress: string;
    groupPubkey: string;
    explorerUrl: string;
  };
  backend: {
    url: string;
  };
}

const networks = networksJson as Record<NetworkId, NetworkConfig>;

/** Detect current network from env vars */
export function detectNetwork(): NetworkId {
  const env =
    (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_NETWORK) ||
    (typeof process !== "undefined" && process.env?.UTXOPIA_NETWORK) ||
    "devnet";
  if (env === "mainnet" || env === "mainnet-beta") return "mainnet";
  if (env === "testnet") return "testnet";
  return "devnet";
}

/** Get config for current or specified network */
export function getNetworkConfig(network?: NetworkId): NetworkConfig {
  const net = network ?? detectNetwork();
  const cfg = networks[net];
  if (!cfg) throw new Error(`Unknown network: ${net}`);

  // Allow env var overrides for RPC URL (the only thing that varies per deployment)
  if (typeof process !== "undefined") {
    const rpcOverride =
      process.env?.NEXT_PUBLIC_SOLANA_RPC_URL || process.env?.SOLANA_RPC_URL;
    if (rpcOverride) cfg.solana.rpcUrl = rpcOverride;

    const backendOverride =
      process.env?.NEXT_PUBLIC_BACKEND_URL || process.env?.BACKEND_URL;
    if (backendOverride) cfg.backend.url = backendOverride;
  }

  return cfg;
}

export default networks;
