/**
 * UTXOPIA SDK Configuration
 *
 * Centralized configuration for all network-specific addresses, endpoints, and settings.
 * This is the SINGLE SOURCE OF TRUTH for all on-chain addresses and configuration.
 *
 * When deploying to a new network or updating addresses:
 * 1. Update the relevant network config below
 * 2. Bump SDK version
 * 3. Publish to npm
 *
 * @module config
 */

import { address as _address, getAddressEncoder, getAddressDecoder, getProgramDerivedAddress, type Address } from "@solana/kit";

/**
 * Safe address wrapper — catches codec validation errors that occur during
 * Vercel's build phase when @solana/kit validates byte lengths at module load.
 * Returns the input string cast as Address on failure (safe for config objects
 * that are only used at runtime, not build time).
 */
export function address(input: string): Address {
  try {
    return _address(input);
  } catch {
    console.warn(`[utxopia-sdk] address() failed for "${input.slice(0, 12)}..." — returning raw string (build-time fallback)`);
    return input as Address;
  }
}

// =============================================================================
// Network Types
// =============================================================================

export type NetworkType = "devnet" | "mainnet" | "localnet";

export interface NetworkConfig {
  /** Network identifier */
  network: NetworkType;

  // -------------------------------------------------------------------------
  // Program IDs
  // -------------------------------------------------------------------------

  /** UTXOpia main program ID */
  utxopiaProgramId: Address;

  /** BTC Light Client program ID (manages light client + block headers for SPV) */
  btcLightClientProgramId: Address;

  /** ChadBuffer program ID (for SPV verification) */
  chadbufferProgramId: Address;

  /** Token-2022 program ID */
  token2022ProgramId: Address;

  /** Associated Token Account program ID */
  ataProgramId: Address;

  // -------------------------------------------------------------------------
  // Deployed Accounts (PDAs and Mints)
  // -------------------------------------------------------------------------

  /** Pool State PDA address */
  poolStatePda: Address;

  /** Commitment Tree PDA address */
  commitmentTreePda: Address;

  /** zkBTC Mint address (Token-2022) */
  zkbtcMint: Address;

  /** Pool Vault (ATA for pool holding zkBTC) */
  poolVault: Address;

  // -------------------------------------------------------------------------
  // RPC Endpoints
  // -------------------------------------------------------------------------

  /** Solana RPC endpoint */
  solanaRpcUrl: string;

  /** Solana WebSocket endpoint */
  solanaWsUrl: string;

  // -------------------------------------------------------------------------
  // Bitcoin Network
  // -------------------------------------------------------------------------

  /** Bitcoin network */
  bitcoinNetwork: "mainnet" | "testnet" | "testnet4" | "signet" | "regtest";

  /** Esplora API endpoint */
  esploraUrl: string;

  // -------------------------------------------------------------------------
  // Circuit CDN
  // -------------------------------------------------------------------------

  /** Base URL for circuit artifacts */
  circuitCdnUrl: string;

  // -------------------------------------------------------------------------
  // Groth16 Verifier (Client-side ZK)
  // -------------------------------------------------------------------------

  /** Groth16 verifier program ID (browser proof generation via snarkjs) */
  groth16VerifierProgramId: Address;

  // -------------------------------------------------------------------------
  // VK Hashes (for CPI verification)
  // -------------------------------------------------------------------------

  /** VK hashes for each circuit type (32 bytes each, hex-encoded) */
  vkHashes: {
    claim: string;
    split: string;
    spendPartialPublic: string;
  };

  /** VK hashes for JoinSplit variants, keyed by "NxM" (e.g., "1x2" -> "abc...") */
  joinSplitVkHashes: Record<string, string>;

  // -------------------------------------------------------------------------
  // Pool Keys
  // -------------------------------------------------------------------------

  /** FROST group public key (x-only, hex-encoded 64 chars = 32 bytes).
   *  Legacy. Used as the Taproot internal key only when `ikaDwalletXOnlyPubkey`
   *  is unset / all-zero. New deployments leave this all-zero and rely on Ika.
   *  Fetched once from GET /api/pool/info and cached. */
  groupPubKey: string;

  /** Ika dWallet x-only secp256k1 pubkey (hex, 64 chars = 32 bytes).
   *  When set (non-zero), this replaces `groupPubKey` as the Taproot internal
   *  key for deposit-address derivation. Read from `pool_config.ika_dwallet_xonly_pubkey`
   *  on chain. All-zero indicates a legacy FROST-controlled pool. */
  ikaDwalletXOnlyPubkey: string;

  /** BTC deposit custody mode.
   *  "sweep" keeps legacy per-deposit tweaked Taproot addresses.
   *  "direct" sends deposits directly to the Ika raw x-only vault address. */
  depositMode?: "sweep" | "direct" | "direct_vault" | "ika_direct";

  // -------------------------------------------------------------------------
  // SNS Subdomain Resolution (stealth address via .sol names)
  // -------------------------------------------------------------------------

  /** SPL Name Service program ID (stores name records / PDAs) */
  snsNameServiceProgramId: string;

  /** SNS Registrar program ID (for domain registration) */
  snsRegistrarProgramId: string;

  /** SNS Sub-Registrar program ID (for subdomain registration) */
  snsSubRegistrarProgramId: string;

  /** SNS root domain account (.sol TLD — differs per network) */
  snsRootDomain: string;

  /** Parent domain for stealth address subdomains (e.g., "utxopia" for *.utxopia.sol) */
  snsParentDomain: string;

  /** SNS reverse lookup class key (used for reverse name resolution) */
  snsReverseLookupClass: string;

  /** Stealth data version expected in SNS records */
  snsStealthDataVersion: number;
}

// =============================================================================
// Program IDs (Constants)
// =============================================================================

/** Legacy Token Program ID */
export const TOKEN_PROGRAM_ID: Address = address(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

/** Token-2022 Program ID */
export const TOKEN_2022_PROGRAM_ID: Address = address(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
);

/** Associated Token Account Program ID */
export const ATA_PROGRAM_ID: Address = address(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);

/** ChadBuffer Program ID (deployed to devnet 2025-01-30) */
export const CHADBUFFER_PROGRAM_ID: Address = address(
  "C5RpjtTMFXKVZCtXSzKXD4CDNTaWBg3dVeMfYvjZYHDF"
);

/** ChadBuffer Program ID for localnet testing */
export const LOCALNET_CHADBUFFER_PROGRAM_ID: Address = address(
  "EgWyMVFZewHmjJ9GGvVBTyaC376Xp7qu7CAFjWYPYYDv"
);

// =============================================================================
// Network Configurations
// =============================================================================

/**
 * Devnet Configuration (v3.3.0)
 *
 * Fresh deployment 2026-03-13:
 * - RedemptionRequest PDA now 98 bytes (service_fee locked at request time)
 * - Program ID: 7JJeVjVCy1fZqCDWvf41R7LuTWirTjX7Tp6suC2WVUMQ
 */
export const DEVNET_CONFIG: NetworkConfig = {
  network: "devnet",

  // Program IDs (devnet deployment 2026-03-25)
  utxopiaProgramId: address("AjbX243s2JMFG2uhfTjKkadjPvQEPgcuyV3vfLJv36MT"),
  btcLightClientProgramId: address("859B7kw1xDyY8rzSXY6pAPNxaAsPWrsaAPJk3iivd43g"),
  chadbufferProgramId: CHADBUFFER_PROGRAM_ID,
  token2022ProgramId: TOKEN_2022_PROGRAM_ID,
  ataProgramId: ATA_PROGRAM_ID,

  // Deployed Accounts (devnet deployment 2026-03-25)
  poolStatePda: address("Gq2UWqttgbT92Dn4dRAdQzJE3yHAEAi4GGZYY2VHEXMP"),
  commitmentTreePda: address("FMML3M5NU5kMS9nbMAeMhtZ1ecuzhGwM2oTaRVqWvhcQ"),
  zkbtcMint: address("5m3bbj8tzvGfS1ikv4zxa6zraFUVnff5yYWM51wCDQjB"),
  poolVault: address("6mXkh6qHunbRFUJtDxB55ZG3aDd9MxUyHV2Z2BpQi4HX"),

  // RPC Endpoints
  solanaRpcUrl: "https://api.devnet.solana.com",
  solanaWsUrl: "wss://api.devnet.solana.com",

  // Bitcoin Network
  bitcoinNetwork: "testnet4",
  esploraUrl: "https://mempool.space/testnet4/api",

  // Circuit CDN (Groth16 artifacts: .wasm, .zkey files)
  circuitCdnUrl: "https://circuits.amidoggy.xyz",

  // Groth16 Verifier: verification is inline in the UTXOpia program (no separate verifier program)
  groth16VerifierProgramId: address("AjbX243s2JMFG2uhfTjKkadjPvQEPgcuyV3vfLJv36MT"), // inline in utxopia program

  // VK Hashes (SHA256 of serialized VK bytes, generated from circom trusted setup)
  vkHashes: {
    claim: "7af0e702e7b595fbdb62fd268e6c529481003e07957e0f60e4fb23cd9fe6a77f",
    split: "00fb9e4c3fcc7b99fec5191370b516537f74831ad868a18c4ab2d519f332cc4f",
    spendPartialPublic: "732126aaec8355efdfb1b96aee1c9014506c99815a81057edbefd775b1b10663",
  },

  // JoinSplit VK hashes (populated after trusted setup for new circuits)
  joinSplitVkHashes: {
    "1x1": "2c21bba8396f58db95396b43591edcb724d19c75aecd20a385a6e1eeddc93272",
    "1x2": "b95add145fed1900bbca2cf44b0826c24c8b13ad6441fe6950dadd6e862e5701",
    "2x1": "81513149f518bbf6de31bc59349d48685bb08b3ef56f0f3eed4e2587d5ba1458",
    "2x2": "303bdc51d561ff0986e56e59129eeca42a929f0387e638902be00570ee1ab0c1",
    "1x3": "f30e533c1851b8e8e36fd0dd57bb4e08da0196fb28fa443405eac67ee912c4a6",
    "3x1": "ba42d39886cee0ef7542ce81fc7199f27f0fd18cd86ff1eecdefab2a1de553d7",
    "2x3": "9f88ace5197649135e22ec474caf0a67e3946e0c28f680e5815e0105c21e6645",
    "3x2": "04c156047b42c736a841154bae3f4df3e5afaef62aebf6df5394ee6aca7439c4",
    "1x4": "37edd144d5b938dba99f7a2d75e47a2770302860822f1fb724bdc6285da57678",
    "4x1": "4c17064df6986482d837a7815ac68b015901b6cec92730c4441d4c8c0b238d63",
  },

  // Pool group key (FROST 2-of-3 DKG output, x-only secp256k1) — legacy.
  groupPubKey: "29485d031f6ad1ab0c4ca7183bef6cb9ce2d914d0bec8dc842a6962f0fcc3362",
  // Ika dWallet x-only pubkey — populated by ./scripts/sync-env.sh from devnet-state.json.
  ikaDwalletXOnlyPubkey:
    "0000000000000000000000000000000000000000000000000000000000000000",

  // SNS Subdomain Resolution (devnet)
  snsNameServiceProgramId: "namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX",  // SPL Name Service (devnet)
  snsRegistrarProgramId: "snshBoEQ9jx4QoHBpZDQPYdNCtw7RMxJvYrKFEhwaPJ",    // SNS Registrar (devnet)
  snsSubRegistrarProgramId: "31tT5CmpphAtRL3mstu962zeYH7C6TEkJWLB5nYxciBB", // Sub-Registrar (devnet)
  snsRootDomain: "5eoDkP6vCQBXqDV9YN2NdUs3nmML3dMRNmEYpiyVNBm2",           // .sol TLD (devnet)
  snsParentDomain: "utxopia",
  snsReverseLookupClass: "7NbD1vprif6apthEZAqhRfYuhrqnuderB8qpnfXGCc8H",   // Reverse lookup class (devnet)
  snsStealthDataVersion: 1,
};

/**
 * Mainnet Configuration (placeholder - not yet deployed)
 */
export const MAINNET_CONFIG: NetworkConfig = {
  network: "mainnet",

  // Program IDs (placeholder - update when deployed)
  utxopiaProgramId: address("11111111111111111111111111111111"),
  btcLightClientProgramId: address("11111111111111111111111111111111"),
  chadbufferProgramId: CHADBUFFER_PROGRAM_ID,
  token2022ProgramId: TOKEN_2022_PROGRAM_ID,
  ataProgramId: ATA_PROGRAM_ID,

  // Deployed Accounts (placeholder - update when deployed)
  poolStatePda: address("11111111111111111111111111111111"),
  commitmentTreePda: address("11111111111111111111111111111111"),
  zkbtcMint: address("11111111111111111111111111111111"),
  poolVault: address("11111111111111111111111111111111"),

  // RPC Endpoints
  solanaRpcUrl: "https://api.mainnet-beta.solana.com",
  solanaWsUrl: "wss://api.mainnet-beta.solana.com",

  // Bitcoin Network
  bitcoinNetwork: "mainnet",
  esploraUrl: "https://mempool.space/api",

  // Circuit CDN
  circuitCdnUrl: "https://cdn.jsdelivr.net/npm/@utxopia/sdk@latest/circuits",

  // Groth16 Verifier (placeholder)
  groth16VerifierProgramId: address("11111111111111111111111111111111"),

  // VK Hashes (placeholder - update when deployed)
  vkHashes: {
    claim: "0000000000000000000000000000000000000000000000000000000000000000",
    split: "0000000000000000000000000000000000000000000000000000000000000000",
    spendPartialPublic: "171daac7e5ff45e2d0e736ac0d28f5fe8e0cc8fc9961efa4dd9ee18e4413f755",
  },

  joinSplitVkHashes: {},

  // Pool group key (placeholder — not yet deployed)
  groupPubKey: "0000000000000000000000000000000000000000000000000000000000000000",
  ikaDwalletXOnlyPubkey:
    "0000000000000000000000000000000000000000000000000000000000000000",

  // SNS Subdomain Resolution (mainnet)
  snsNameServiceProgramId: "namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX",  // SPL Name Service (mainnet)
  snsRegistrarProgramId: "jCebN34bUfdeUYJT13J1yG16XWQpt5PDx6Mse9GUqhR",    // SNS Registrar (mainnet)
  snsSubRegistrarProgramId: "2KkyPzjaAYaz2ojQZ9P3xYakLd96B5UH6a2isLaZ4Cgs", // Sub-Registrar (mainnet)
  snsRootDomain: "58PwtjSDuFHuUkYjH9BYod9SZaELfsvdrNMryy9iYNvo",           // .sol TLD (mainnet)
  snsParentDomain: "utxopia",
  snsReverseLookupClass: "33m47vH6Eav6jr5Ry86XjhRft2jRBLDnDgPSHoquXi2Z",   // Reverse lookup class (mainnet)
  snsStealthDataVersion: 1,
};

/**
 * Localnet Configuration (for local development)
 * Synced with .localnet-config.json (2026-02-22)
 */
export const LOCALNET_CONFIG: NetworkConfig = {
  network: "localnet",

  // Program IDs
  utxopiaProgramId: address("2dBmKyfLibkqdxgyEWUhHos3g56oU2wXLVrucY2dCpGV"),
  btcLightClientProgramId: address("Ho6UTeF8yFnRdCK15tSZtcJozvkDABJZWYxkgGyWAfyq"),
  chadbufferProgramId: LOCALNET_CHADBUFFER_PROGRAM_ID,
  token2022ProgramId: TOKEN_2022_PROGRAM_ID,
  ataProgramId: ATA_PROGRAM_ID,

  // Deployed Accounts (synced with .localnet-config.json 2026-02-23)
  poolStatePda: address("E6DVestxC5dn5ixvLa3FcYodcVtwUAyanpVPbs4y3p16"),
  commitmentTreePda: address("JCiGqC1a1rjfqk2dqcybU2e3FQjAQ19x8ts9fQCtTFCq"),
  zkbtcMint: address("CHg1f85uxw4HrVkj3ianLezVAJTv29VcCWiBxjZ4YFdF"),
  poolVault: address("7vpuYKngG75Km1bbZ5TZJZzRn2BBtkh9BaqPS814tPLg"),

  // RPC Endpoints
  solanaRpcUrl: "http://127.0.0.1:8899",
  solanaWsUrl: "ws://127.0.0.1:8900",

  // Bitcoin Network (regtest for local dev)
  bitcoinNetwork: "regtest",
  esploraUrl: "http://localhost:2140",

  // Circuit CDN (use local files for development)
  circuitCdnUrl: "/circuits",

  // Groth16 Verifier: verification is inline in the UTXOpia program
  groth16VerifierProgramId: address("RoqAPQgZ5ztdhV3jHBKgTmeLBAfyYcaBsjKiXHNwXf3"),

  // VK Hashes (same as devnet - generated from same trusted setup)
  vkHashes: {
    claim: "7af0e702e7b595fbdb62fd268e6c529481003e07957e0f60e4fb23cd9fe6a77f",
    split: "00fb9e4c3fcc7b99fec5191370b516537f74831ad868a18c4ab2d519f332cc4f",
    spendPartialPublic: "732126aaec8355efdfb1b96aee1c9014506c99815a81057edbefd775b1b10663",
  },

  joinSplitVkHashes: {
    "1x1": "2c21bba8396f58db95396b43591edcb724d19c75aecd20a385a6e1eeddc93272",
    "1x2": "b95add145fed1900bbca2cf44b0826c24c8b13ad6441fe6950dadd6e862e5701",
    "2x1": "81513149f518bbf6de31bc59349d48685bb08b3ef56f0f3eed4e2587d5ba1458",
    "2x2": "303bdc51d561ff0986e56e59129eeca42a929f0387e638902be00570ee1ab0c1",
  },

  // Pool group key (POC — same as devnet for local dev) — legacy fallback.
  groupPubKey: "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  // Ika dWallet x-only pubkey — populated by ./scripts/sync-env.sh from localnet-state.json.
  ikaDwalletXOnlyPubkey:
    "0000000000000000000000000000000000000000000000000000000000000000",

  // SNS Subdomain Resolution (not available on localnet)
  snsNameServiceProgramId: "",
  snsRegistrarProgramId: "",
  snsSubRegistrarProgramId: "",
  snsRootDomain: "",
  snsParentDomain: "",
  snsReverseLookupClass: "",
  snsStealthDataVersion: 1,
};

// =============================================================================
// Default Configuration
// =============================================================================

/** Current active configuration (defaults to devnet, overridden by env vars) */
let currentConfig: NetworkConfig = DEVNET_CONFIG;

// Eagerly apply env var overrides synchronously (program ID + mint only).
// PDA derivation happens async in initConfig(), but at least getConfig()
// returns the correct program ID immediately.
if (typeof process !== "undefined") {
  const _pid = process.env?.NEXT_PUBLIC_UTXOPIA_PROGRAM_ID || process.env?.UTXOPIA_PROGRAM_ID;
  const _mint = process.env?.NEXT_PUBLIC_ZKBTC_MINT || process.env?.UTXOPIA_ZKBTC_MINT;
  if (_pid) {
    currentConfig = { ...currentConfig, utxopiaProgramId: address(_pid), groth16VerifierProgramId: address(_pid) };
  }
  if (_mint) {
    currentConfig = { ...currentConfig, zkbtcMint: address(_mint) };
  }
}

/** Esplora URL for a given Bitcoin network */
function esploraUrlForNetwork(net: string): string {
  switch (net) {
    case "mainnet": return "https://mempool.space/api";
    case "testnet": return "https://mempool.space/testnet/api";
    case "testnet4": return "https://mempool.space/testnet4/api";
    case "signet": return "https://mempool.space/signet/api";
    default: return `https://mempool.space/${net}/api`;
  }
}

/**
 * Get the current network configuration.
 * Respects NEXT_PUBLIC_BTC_NETWORK env var to override Bitcoin network
 * (e.g., "testnet" for testnet3, "testnet4" for testnet4).
 */
export function getConfig(): NetworkConfig {
  const btcNetOverride =
    typeof process !== "undefined" && process.env?.NEXT_PUBLIC_BTC_NETWORK;
  if (btcNetOverride && btcNetOverride !== currentConfig.bitcoinNetwork) {
    return {
      ...currentConfig,
      bitcoinNetwork: btcNetOverride as NetworkConfig["bitcoinNetwork"],
      esploraUrl: esploraUrlForNetwork(btcNetOverride),
    };
  }
  return currentConfig;
}

/**
 * Set the network configuration
 *
 * @param network - Network type or custom config
 * @throws Error if mainnet is selected (not yet deployed)
 */
export function setConfig(network: NetworkType | NetworkConfig): void {
  if (typeof network === "string") {
    switch (network) {
      case "devnet":
        currentConfig = DEVNET_CONFIG;
        break;
      case "mainnet":
        throw new Error(
          "Mainnet is not yet deployed. " +
          "UTXOpia is currently available on devnet only. " +
          "Use setConfig('devnet') or wait for mainnet deployment announcement."
        );
      case "localnet":
        currentConfig = LOCALNET_CONFIG;
        break;
      default:
        throw new Error(`Unknown network: ${network}`);
    }
  } else {
    // Check if custom config is using placeholder mainnet addresses
    if (network.network === "mainnet" && network.utxopiaProgramId === MAINNET_CONFIG.utxopiaProgramId) {
      throw new Error(
        "Cannot use placeholder mainnet configuration. " +
        "Mainnet is not yet deployed."
      );
    }
    currentConfig = network;
  }
}

/**
 * Create a custom configuration by overriding specific values
 *
 * @param base - Base configuration to extend
 * @param overrides - Values to override
 */
export function createConfig(
  base: NetworkConfig,
  overrides: Partial<NetworkConfig>
): NetworkConfig {
  return { ...base, ...overrides };
}

// =============================================================================
// Environment-based Initialization
// =============================================================================

/**
 * Initialize SDK configuration with optional overrides.
 *
 * Reads `utxopiaProgramId` and `zkbtcMint` from params, then env vars, then
 * falls back to DEVNET_CONFIG defaults. All PDAs are auto-derived from these
 * two values.
 *
 * Env vars checked (in order):
 * - NEXT_PUBLIC_UTXOPIA_PROGRAM_ID / UTXOPIA_PROGRAM_ID
 * - NEXT_PUBLIC_ZKBTC_MINT / UTXOPIA_ZKBTC_MINT
 *
 * @example
 * // Use env vars (set NEXT_PUBLIC_UTXOPIA_PROGRAM_ID + NEXT_PUBLIC_ZKBTC_MINT)
 * await initConfig();
 *
 * // Or pass explicitly
 * await initConfig({ utxopiaProgramId: "...", zkbtcMint: "..." });
 */
export type NetworkId = "devnet" | "localnet" | "mainnet";

export async function initConfig(overrides?: {
  network?: NetworkId;
  utxopiaProgramId?: string;
  zkbtcMint?: string;
  solanaRpcUrl?: string;
  groupPubKey?: string;
  ikaDwalletXOnlyPubkey?: string;
  depositMode?: "sweep" | "direct" | "direct_vault" | "ika_direct";
}): Promise<NetworkConfig> {
  // Pick base config from network: param > env > devnet
  const networkId: NetworkId =
    overrides?.network ||
    (typeof process !== "undefined" && (process.env?.NEXT_PUBLIC_NETWORK || process.env?.UTXOPIA_NETWORK) as NetworkId) ||
    "devnet";

  const baseConfig = networkId === "localnet"
    ? LOCALNET_CONFIG
    : networkId === "mainnet"
      ? MAINNET_CONFIG
      : DEVNET_CONFIG;

  const config = { ...baseConfig };

  // Resolve program ID: param > env > base config default
  const programId =
    overrides?.utxopiaProgramId ||
    (typeof process !== "undefined" && (process.env?.NEXT_PUBLIC_UTXOPIA_PROGRAM_ID || process.env?.UTXOPIA_PROGRAM_ID)) ||
    undefined;

  // Resolve mint: param > env > default
  let mint =
    overrides?.zkbtcMint ||
    (typeof process !== "undefined" && (process.env?.NEXT_PUBLIC_ZKBTC_MINT || process.env?.UTXOPIA_ZKBTC_MINT)) ||
    undefined;

  // Resolve RPC URL for on-chain fetching
  const rpcUrl =
    overrides?.solanaRpcUrl ||
    (typeof process !== "undefined" && (process.env?.NEXT_PUBLIC_SOLANA_RPC_URL || process.env?.UTXOPIA_SOLANA_RPC)) ||
    undefined;

  if (programId) {
    config.utxopiaProgramId = address(programId);
    config.groth16VerifierProgramId = address(programId); // same program

    // Derive PDAs from program ID
    const [poolStatePda] = await getProgramDerivedAddress({
      programAddress: config.utxopiaProgramId,
      seeds: [new TextEncoder().encode("pool_state")],
    });
    const [commitmentTreePda] = await getProgramDerivedAddress({
      programAddress: config.utxopiaProgramId,
      seeds: [new TextEncoder().encode("commitment_tree")],
    });
    config.poolStatePda = poolStatePda;
    config.commitmentTreePda = commitmentTreePda;

    // If mint not provided, fetch from on-chain pool state (offset 36..68 = zkbtc_mint)
    if (!mint && rpcUrl) {
      try {
        const res = await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getAccountInfo",
            params: [poolStatePda.toString(), { encoding: "base64" }],
          }),
        });
        const json = await res.json() as { result?: { value?: { data?: [string, string] } } };
        const b64 = json.result?.value?.data?.[0];
        if (b64) {
          const data = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
          // Pool state layout: disc(1) + bump(1) + flags(1) + pad(1) + authority(32) + zkbtc_mint(32)
          if (data.length >= 68 && data[0] === 0x01) {
            const mintBytes = data.slice(36, 68);
            const decoder = getAddressDecoder();
            mint = decoder.decode(mintBytes).toString();
          }
        }
      } catch {
        // Silently fall back to default config mint
      }
    }
  }

  if (mint) {
    config.zkbtcMint = address(mint);

    // Derive pool vault (ATA: seeds = [owner, TOKEN_2022, mint] under ATA program)
    const encoder = getAddressEncoder();
    const [poolVault] = await getProgramDerivedAddress({
      programAddress: config.ataProgramId,
      seeds: [
        encoder.encode(config.poolStatePda),
        encoder.encode(config.token2022ProgramId),
        encoder.encode(config.zkbtcMint),
      ],
    });
    config.poolVault = poolVault;
  }

  // Apply groupPubKey override (legacy FROST)
  if (overrides?.groupPubKey) {
    config.groupPubKey = overrides.groupPubKey;
  }

  // Apply Ika dWallet x-only pubkey override (preferred for v2 pools)
  if (overrides?.ikaDwalletXOnlyPubkey) {
    config.ikaDwalletXOnlyPubkey = overrides.ikaDwalletXOnlyPubkey;
  }
  if (overrides?.depositMode) {
    config.depositMode = overrides.depositMode;
  }

  currentConfig = config;
  return config;
}

// =============================================================================
// Convenience Exports
// =============================================================================

/** Default UTXOpia program ID (from current config) */
export const UTXOPIA_PROGRAM_ID: Address = DEVNET_CONFIG.utxopiaProgramId;

/** BTC Light Client program ID (manages light client + block headers) */
export const BTC_LIGHT_CLIENT_PROGRAM_ID: Address = DEVNET_CONFIG.btcLightClientProgramId;

// =============================================================================
// Version Info
// =============================================================================

export const SDK_VERSION = "3.3.0";

/** JoinSplit Merkle tree depth */
export const JOINSPLIT_TREE_DEPTH = 16;

export const DEPLOYMENT_INFO = {
  version: SDK_VERSION,
  deployedAt: "2026-03-03",
  network: "devnet" as NetworkType,
  features: [
    "stealth-addresses",
    "groth16-browser-proving",
  ],
  notes: "Client-side Groth16 proof generation via snarkjs",
};
