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
      "Fully local stack: Surfpool offline validator, regtest BTC, programs deployed via txtx runbook. Used by the E2E test suite — not surfaced as an end-user option.",
    caveats: ["Requires `surfpool start -y --offline` running locally."],
    enabled: false,
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
/** Cookie name — same key, browser-readable, sent on every same-origin request
 *  so server-side API routes can route to the right backend per request. */
const COOKIE_NAME = "utxopia.network";

function isKnownNetwork(value: string | null | undefined): value is NetworkId {
  return !!value && value in networks;
}

/** Parse our cookie value out of an HTTP `Cookie:` header. */
export function parseNetworkCookie(cookieHeader: string | null): NetworkId | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === COOKIE_NAME && isKnownNetwork(v)) return v;
  }
  return null;
}

/** Server-side helper: resolve the network for a single request based on its
 *  cookies. Falls back to env-var default. Use this in API routes instead of
 *  the bare `detectNetwork()` (which only knows about the build-time env). */
export function detectNetworkFromRequest(req: Request): NetworkId {
  const cookieNet = parseNetworkCookie(req.headers.get("cookie"));
  if (cookieNet) return cookieNet;
  return detectNetwork();
}

export function detectNetwork(): NetworkId {
  // 1. localStorage (per-browser user preference, set via /settings)
  if (typeof window !== "undefined") {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (isKnownNetwork(stored)) return stored;
    } catch {
      // localStorage may be unavailable (SSR, privacy mode) — fall through.
    }

    // 2. cookie fallback (in case localStorage was cleared but cookie remains)
    const cookieNet = parseNetworkCookie(document.cookie);
    if (cookieNet) return cookieNet;
  }

  // 3. env vars (build-time default)
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

/** Persist the user's network choice. Writes both localStorage (so client-only
 *  reads stay synchronous) and a cookie (so server-side API routes can resolve
 *  the right backend per request). Caller still needs to reload the page if
 *  long-lived modules captured a previous value. */
export function setNetwork(network: NetworkId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, network);
  } catch {
    // ignore — best-effort
  }
  try {
    // 1 year, same-site lax (sent on top-level navigation + XHR to same origin)
    const maxAge = 60 * 60 * 24 * 365;
    document.cookie = `${COOKIE_NAME}=${network}; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
  } catch {
    // ignore
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
