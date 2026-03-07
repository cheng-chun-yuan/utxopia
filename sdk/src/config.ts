/**
 * AEGIS SDK Configuration
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

import { address, type Address } from "@solana/kit";

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

  /** Aegis main program ID */
  aegisProgramId: Address;

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
   *  Used as the Taproot internal key for deriving deposit addresses client-side.
   *  Fetched once from GET /api/pool/info and cached. */
  groupPubKey: string;

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

  /** Parent domain for stealth address subdomains (e.g., "btcpro" for *.btcpro.sol) */
  snsParentDomain: string;

  /** SNS reverse lookup class key (used for reverse name resolution) */
  snsReverseLookupClass: string;

  /** Stealth data version expected in SNS records */
  snsStealthDataVersion: number;
}

// =============================================================================
// Program IDs (Constants)
// =============================================================================

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
 * Fresh deployment 2026-03-03:
 * - Slim accounts: NullifierRecord 1B; stealth announcements emitted as events
 * - Event emission via sol_log_data
 * - Program ID: 25eTdotdeY9EqfJy5tfXSAD5Dg8XTL29sQYVgz1tJkTM
 */
export const DEVNET_CONFIG: NetworkConfig = {
  network: "devnet",

  // Program IDs (fresh deployment 2026-03-03)
  aegisProgramId: address("25eTdotdeY9EqfJy5tfXSAD5Dg8XTL29sQYVgz1tJkTM"),
  btcLightClientProgramId: address("Ho6UTeF8yFnRdCK15tSZtcJozvkDABJZWYxkgGyWAfyq"),
  chadbufferProgramId: CHADBUFFER_PROGRAM_ID,
  token2022ProgramId: TOKEN_2022_PROGRAM_ID,
  ataProgramId: ATA_PROGRAM_ID,

  // Deployed Accounts (fresh deployment 2026-03-03)
  poolStatePda: address("7Xr7MthZPc7YeHfU5SRmguxovhiDNhfestWgtPruUfjE"),
  commitmentTreePda: address("76bh2QB7c9L73yHea8AV7vthsDsuDCp2QqQToGcA3JdK"),
  zkbtcMint: address("8wCJtuj6ir9VxvjJ14EK4KpFffx4gSKV5ZJ1jYSdRzxN"),
  poolVault: address("ELFqueP7akYfkM7nTfWs3tTS5MJpGnbvMuBUxayKT6zb"),

  // RPC Endpoints
  solanaRpcUrl: "https://api.devnet.solana.com",
  solanaWsUrl: "wss://api.devnet.solana.com",

  // Bitcoin Network
  bitcoinNetwork: "testnet4",
  esploraUrl: "https://mempool.space/testnet4/api",

  // Circuit CDN (Groth16 artifacts: .wasm, .zkey files)
  circuitCdnUrl: "https://circuits.amidoggy.xyz",

  // Groth16 Verifier: verification is inline in the Aegis program (no separate verifier program)
  groth16VerifierProgramId: address("25eTdotdeY9EqfJy5tfXSAD5Dg8XTL29sQYVgz1tJkTM"),

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

  // Pool group key (FROST 2-of-3 DKG output, x-only secp256k1)
  groupPubKey: "d857a067bec0ae2027a6026ef73d2905f108b1a66de6d12d23a3feb42013b1dd",

  // SNS Subdomain Resolution (devnet)
  snsNameServiceProgramId: "namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX",  // SPL Name Service (devnet)
  snsRegistrarProgramId: "snshBoEQ9jx4QoHBpZDQPYdNCtw7RMxJvYrKFEhwaPJ",    // SNS Registrar (devnet)
  snsSubRegistrarProgramId: "31tT5CmpphAtRL3mstu962zeYH7C6TEkJWLB5nYxciBB", // Sub-Registrar (devnet)
  snsRootDomain: "5eoDkP6vCQBXqDV9YN2NdUs3nmML3dMRNmEYpiyVNBm2",           // .sol TLD (devnet)
  snsParentDomain: "btcpro",
  snsReverseLookupClass: "7NbD1vprif6apthEZAqhRfYuhrqnuderB8qpnfXGCc8H",   // Reverse lookup class (devnet)
  snsStealthDataVersion: 1,
};

/**
 * Mainnet Configuration (placeholder - not yet deployed)
 */
export const MAINNET_CONFIG: NetworkConfig = {
  network: "mainnet",

  // Program IDs (placeholder - update when deployed)
  aegisProgramId: address("11111111111111111111111111111111"),
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
  circuitCdnUrl: "https://cdn.jsdelivr.net/npm/@aegis/sdk@latest/circuits",

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

  // SNS Subdomain Resolution (mainnet)
  snsNameServiceProgramId: "namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX",  // SPL Name Service (mainnet)
  snsRegistrarProgramId: "jCebN34bUfdeUYJT13J1yG16XWQpt5PDx6Mse9GUqhR",    // SNS Registrar (mainnet)
  snsSubRegistrarProgramId: "2KkyPzjaAYaz2ojQZ9P3xYakLd96B5UH6a2isLaZ4Cgs", // Sub-Registrar (mainnet)
  snsRootDomain: "58PwtjSDuFHuUkYjH9BYod9SZaELfsvdrNMryy9iYNvo",           // .sol TLD (mainnet)
  snsParentDomain: "btcpro",
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
  aegisProgramId: address("2dBmKyfLibkqdxgyEWUhHos3g56oU2wXLVrucY2dCpGV"),
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

  // Groth16 Verifier: verification is inline in the Aegis program
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

  // Pool group key (POC — same as devnet for local dev)
  groupPubKey: "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",

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

/** Current active configuration (defaults to devnet) */
let currentConfig: NetworkConfig = DEVNET_CONFIG;

/**
 * Get the current network configuration
 */
export function getConfig(): NetworkConfig {
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
          "Aegis is currently available on devnet only. " +
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
    if (network.network === "mainnet" && network.aegisProgramId === MAINNET_CONFIG.aegisProgramId) {
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
// Convenience Exports
// =============================================================================

/** Default Aegis program ID (from current config) */
export const AEGIS_PROGRAM_ID: Address = DEVNET_CONFIG.aegisProgramId;

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
    "demo-stealth",
    "stealth-addresses",
    "groth16-browser-proving",
  ],
  notes: "Client-side Groth16 proof generation via snarkjs",
};
