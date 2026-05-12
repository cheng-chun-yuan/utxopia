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

export type NetworkId =
  | "devnet"
  | "devnet-regtest"
  | "testnet"
  | "mainnet"
  | "localnet";

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

/** Display metadata for each network — surfaced in /settings so users
 *  understand which stack they're switching into. */
export interface NetworkMeta {
  id: NetworkId;
  label: string;
  /** Short tagline shown next to the radio button. */
  tagline: string;
  /** One-paragraph description of what this network is + what works. */
  description: string;
  /** Notable caveats / known limitations. */
  caveats: string[];
  /** Whether this network is generally usable (e.g. has a deployed program). */
  enabled: boolean;
}

export const NETWORK_META: NetworkMeta[] = [
  {
    id: "devnet",
    label: "Devnet (production)",
    tagline: "Real testnet4 BTC + Solana devnet",
    description:
      "The live demo stack: Solana devnet program + testnet4 Bitcoin via mempool.space. Full deposit/transact/unshield/redeem with the production Ika dWallet for BTC redemption.",
    caveats: [
      "Bitcoin testnet4 blocks take ~10 minutes — deposits + redemptions are slow.",
      "Requires testnet4 BTC from a faucet to send a deposit.",
    ],
    enabled: true,
  },
  {
    id: "devnet-regtest",
    label: "Hybrid (devnet + local regtest)",
    tagline: "Solana devnet + local regtest BTC — fast iteration",
    description:
      "A second UTXOpia program on Solana devnet wired to local regtest Bitcoin. Same on-chain trust model as production, but BTC blocks mine instantly so the deposit → JoinSplit → unshield loop runs in seconds rather than minutes.",
    caveats: [
      "Regtest BTC has zero real-world value. State is reset whenever the local docker stack restarts.",
      "BTC redemption (complete_redemption → Ika CPI) is not yet wired — works with a placeholder demo key for now.",
      "Backend must be reachable at the configured URL. For local dev, `docker compose -f docker-compose.hybrid.yml up -d` exposes it at localhost:3020.",
    ],
    enabled: true,
  },
  {
    id: "localnet",
    label: "Localnet",
    tagline: "Surfpool validator + regtest",
    description:
      "Fully local stack: Surfpool offline validator, regtest BTC, programs deployed via txtx runbook. Used by the E2E test suite.",
    caveats: ["Requires `surfpool start -y --offline` running locally."],
    enabled: true,
  },
  {
    id: "testnet",
    label: "Testnet",
    tagline: "(not deployed)",
    description: "Reserved for a future Solana testnet deployment.",
    caveats: ["Program IDs not yet populated."],
    enabled: false,
  },
  {
    id: "mainnet",
    label: "Mainnet",
    tagline: "(not deployed)",
    description: "Reserved for the eventual mainnet launch.",
    caveats: ["Not deployed."],
    enabled: false,
  },
];

const networks = networksJson as Record<NetworkId, NetworkConfig>;

const STORAGE_KEY = "utxopia.network";

export function detectNetwork(): NetworkId {
  // 1. localStorage (per-browser user preference, set via /settings)
  if (typeof window !== "undefined") {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored && stored in networks) return stored as NetworkId;
    } catch {
      // localStorage may be unavailable (SSR, privacy mode) — fall through.
    }
  }

  // 2. env vars (build-time default)
  const env =
    process.env.NEXT_PUBLIC_NETWORK ||
    process.env.UTXOPIA_NETWORK ||
    "devnet";
  if (env === "mainnet" || env === "mainnet-beta") return "mainnet";
  if (env === "testnet") return "testnet";
  if (env === "localnet") return "localnet";
  if (env === "devnet-regtest" || env === "hybrid") return "devnet-regtest";
  return "devnet";
}

/** Persist the user's network choice. Caller is responsible for triggering
 *  any reload needed to re-read network config in long-lived modules. */
export function setNetwork(network: NetworkId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, network);
  } catch {
    // ignore — best-effort
  }
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
