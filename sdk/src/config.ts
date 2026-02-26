/**
 * ZVault SDK Configuration
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

  /** zVault main program ID */
  zvaultProgramId: Address;

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

  /** zBTC Mint address (Token-2022) */
  zbtcMint: Address;

  /** Pool Vault (ATA for pool holding zBTC) */
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
 * Devnet Configuration (v3.1.0)
 *
 * Fresh deployment 2026-02-24:
 * - JoinSplit circuit architecture
 * - Program ID: 2dBmKyfLibkqdxgyEWUhHos3g56oU2wXLVrucY2dCpGV
 */
export const DEVNET_CONFIG: NetworkConfig = {
  network: "devnet",

  // Program IDs (fresh deployment 2026-02-24)
  zvaultProgramId: address("2dBmKyfLibkqdxgyEWUhHos3g56oU2wXLVrucY2dCpGV"),
  btcLightClientProgramId: address("DeDut4fkjbWBPY4FRUU3q9BUcvwTisHczj1EQmqX5avS"),
  chadbufferProgramId: CHADBUFFER_PROGRAM_ID,
  token2022ProgramId: TOKEN_2022_PROGRAM_ID,
  ataProgramId: ATA_PROGRAM_ID,

  // Deployed Accounts (fresh deployment 2026-02-24)
  poolStatePda: address("E6DVestxC5dn5ixvLa3FcYodcVtwUAyanpVPbs4y3p16"),
  commitmentTreePda: address("JCiGqC1a1rjfqk2dqcybU2e3FQjAQ19x8ts9fQCtTFCq"),
  zbtcMint: address("HthCYqDKyw11c2dUJz9s2dCnH314ktn6JTGEveZkT17N"),
  poolVault: address("DQizWHKHMhXsLF6712immeEKFpT93cCgF2qzdDTZqVRn"),

  // RPC Endpoints
  solanaRpcUrl: "https://api.devnet.solana.com",
  solanaWsUrl: "wss://api.devnet.solana.com",

  // Bitcoin Network
  bitcoinNetwork: "testnet4",
  esploraUrl: "https://mempool.space/testnet4/api",

  // Circuit CDN (Groth16 artifacts: .wasm, .zkey files)
  circuitCdnUrl: "https://circuits.amidoggy.xyz",

  // Groth16 Verifier: verification is inline in the zVault program (no separate verifier program)
  groth16VerifierProgramId: address("2dBmKyfLibkqdxgyEWUhHos3g56oU2wXLVrucY2dCpGV"),

  // VK Hashes (SHA256 of serialized VK bytes, generated from circom trusted setup)
  vkHashes: {
    claim: "7af0e702e7b595fbdb62fd268e6c529481003e07957e0f60e4fb23cd9fe6a77f",
    split: "00fb9e4c3fcc7b99fec5191370b516537f74831ad868a18c4ab2d519f332cc4f",
    spendPartialPublic: "732126aaec8355efdfb1b96aee1c9014506c99815a81057edbefd775b1b10663",
  },

  // JoinSplit VK hashes (populated after trusted setup for new circuits)
  joinSplitVkHashes: {
    "1x1": "da5c0e76c63f93dbf7a0f8caef8f811c07ffe0c1aa9c00fae32a2d8de8028ae3",
    "1x2": "077a63a672f8b2fa329f4aa0a758e8072f8d4548c7691e4183940e4403631b3f",
    "2x1": "31593b7345a0494e634c93650242245c249893085542435a3bb7521a609c7f48",
    "2x2": "7b237cfb5493f7a96bde50ab869f82d632e14fde310328d356c45e4529b96f29",
  },

  // Pool group key (POC — secp256k1 generator x-coord; replace with FROST group key)
  groupPubKey: "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
};

/**
 * Mainnet Configuration (placeholder - not yet deployed)
 */
export const MAINNET_CONFIG: NetworkConfig = {
  network: "mainnet",

  // Program IDs (placeholder - update when deployed)
  zvaultProgramId: address("11111111111111111111111111111111"),
  btcLightClientProgramId: address("11111111111111111111111111111111"),
  chadbufferProgramId: CHADBUFFER_PROGRAM_ID,
  token2022ProgramId: TOKEN_2022_PROGRAM_ID,
  ataProgramId: ATA_PROGRAM_ID,

  // Deployed Accounts (placeholder - update when deployed)
  poolStatePda: address("11111111111111111111111111111111"),
  commitmentTreePda: address("11111111111111111111111111111111"),
  zbtcMint: address("11111111111111111111111111111111"),
  poolVault: address("11111111111111111111111111111111"),

  // RPC Endpoints
  solanaRpcUrl: "https://api.mainnet-beta.solana.com",
  solanaWsUrl: "wss://api.mainnet-beta.solana.com",

  // Bitcoin Network
  bitcoinNetwork: "mainnet",
  esploraUrl: "https://mempool.space/api",

  // Circuit CDN
  circuitCdnUrl: "https://cdn.jsdelivr.net/npm/@zvault/sdk@latest/circuits",

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
};

/**
 * Localnet Configuration (for local development)
 * Synced with .localnet-config.json (2026-02-22)
 */
export const LOCALNET_CONFIG: NetworkConfig = {
  network: "localnet",

  // Program IDs
  zvaultProgramId: address("2dBmKyfLibkqdxgyEWUhHos3g56oU2wXLVrucY2dCpGV"),
  btcLightClientProgramId: address("DeDut4fkjbWBPY4FRUU3q9BUcvwTisHczj1EQmqX5avS"),
  chadbufferProgramId: LOCALNET_CHADBUFFER_PROGRAM_ID,
  token2022ProgramId: TOKEN_2022_PROGRAM_ID,
  ataProgramId: ATA_PROGRAM_ID,

  // Deployed Accounts (synced with .localnet-config.json 2026-02-23)
  poolStatePda: address("E6DVestxC5dn5ixvLa3FcYodcVtwUAyanpVPbs4y3p16"),
  commitmentTreePda: address("JCiGqC1a1rjfqk2dqcybU2e3FQjAQ19x8ts9fQCtTFCq"),
  zbtcMint: address("CHg1f85uxw4HrVkj3ianLezVAJTv29VcCWiBxjZ4YFdF"),
  poolVault: address("7vpuYKngG75Km1bbZ5TZJZzRn2BBtkh9BaqPS814tPLg"),

  // RPC Endpoints
  solanaRpcUrl: "http://127.0.0.1:8899",
  solanaWsUrl: "ws://127.0.0.1:8900",

  // Bitcoin Network (regtest for local dev)
  bitcoinNetwork: "regtest",
  esploraUrl: "http://localhost:2140",

  // Circuit CDN (use local files for development)
  circuitCdnUrl: "/circuits",

  // Groth16 Verifier: verification is inline in the zVault program
  groth16VerifierProgramId: address("RoqAPQgZ5ztdhV3jHBKgTmeLBAfyYcaBsjKiXHNwXf3"),

  // VK Hashes (same as devnet - generated from same trusted setup)
  vkHashes: {
    claim: "7af0e702e7b595fbdb62fd268e6c529481003e07957e0f60e4fb23cd9fe6a77f",
    split: "00fb9e4c3fcc7b99fec5191370b516537f74831ad868a18c4ab2d519f332cc4f",
    spendPartialPublic: "732126aaec8355efdfb1b96aee1c9014506c99815a81057edbefd775b1b10663",
  },

  joinSplitVkHashes: {
    "1x1": "da5c0e76c63f93dbf7a0f8caef8f811c07ffe0c1aa9c00fae32a2d8de8028ae3",
    "1x2": "077a63a672f8b2fa329f4aa0a758e8072f8d4548c7691e4183940e4403631b3f",
    "2x1": "31593b7345a0494e634c93650242245c249893085542435a3bb7521a609c7f48",
    "2x2": "7b237cfb5493f7a96bde50ab869f82d632e14fde310328d356c45e4529b96f29",
  },

  // Pool group key (POC — same as devnet for local dev)
  groupPubKey: "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
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
          "zVault is currently available on devnet only. " +
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
    if (network.network === "mainnet" && network.zvaultProgramId === MAINNET_CONFIG.zvaultProgramId) {
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

/** Default zVault program ID (from current config) */
export const ZVAULT_PROGRAM_ID: Address = DEVNET_CONFIG.zvaultProgramId;

/** BTC Light Client program ID (manages light client + block headers) */
export const BTC_LIGHT_CLIENT_PROGRAM_ID: Address = DEVNET_CONFIG.btcLightClientProgramId;

// =============================================================================
// Version Info
// =============================================================================

export const SDK_VERSION = "3.1.0";

/** JoinSplit Merkle tree depth */
export const JOINSPLIT_TREE_DEPTH = 16;

export const DEPLOYMENT_INFO = {
  version: SDK_VERSION,
  deployedAt: "2026-02-24",
  network: "devnet" as NetworkType,
  features: [
    "demo-stealth",
    "name-registry",
    "stealth-addresses",
    "reverse-lookup",
    "groth16-browser-proving",
  ],
  notes: "Client-side Groth16 proof generation via snarkjs",
};
