/**
 * Network configuration — single source of truth for all addresses.
 *
 * Reads from networks.json (checked into repo). No env vars needed
 * for program IDs, mints, or backend URLs.
 *
 * Only RPC URL and backend URL can be overridden via env vars
 * (for custom RPC providers or local development).
 */

import networksJson from "./networks.json";

export type NetworkId = "devnet" | "testnet" | "mainnet" | "localnet";

export interface NetworkConfig {
  solana: {
    rpcUrl: string;
    privacyCoinProgramId: string;
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

export function detectNetwork(): NetworkId {
  const env =
    process.env.NEXT_PUBLIC_NETWORK ||
    process.env.UTXOPIA_NETWORK ||
    "devnet";
  if (env === "mainnet" || env === "mainnet-beta") return "mainnet";
  if (env === "testnet") return "testnet";
  if (env === "localnet") return "localnet";
  return "devnet";
}

export function getNetworkConfig(network?: NetworkId): NetworkConfig {
  const net = network ?? detectNetwork();
  const cfg = { ...networks[net] };
  if (!cfg) throw new Error(`Unknown network: ${net}`);

  // Allow env var overrides for URLs only
  const rpcOverride =
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL || process.env.SOLANA_RPC_URL;
  if (rpcOverride) cfg.solana = { ...cfg.solana, rpcUrl: rpcOverride };

  const backendOverride =
    process.env.NEXT_PUBLIC_BACKEND_URL || process.env.BACKEND_URL || process.env.BACKEND_API_URL;
  if (backendOverride) cfg.backend = { ...cfg.backend, url: backendOverride };

  return cfg;
}
