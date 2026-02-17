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

  /** BTC Light Client program ID */
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

  /** Bitcoin network (testnet3, mainnet) */
  bitcoinNetwork: "testnet" | "mainnet";

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
    poolDeposit: string;
    poolWithdraw: string;
    poolClaimYield: string;
    poolCompound: string;
  };
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
 * Devnet Configuration (v2.1.0)
 *
 * Fresh deployment 2026-02-02:
 * - Simplified instruction format (no proof_source byte for split/partial-public)
 * - Instruction introspection pattern for verifier
 * - Program ID: 2qQPgW6LpzokD1Uemhy2Ng5Xjhr6VuHwJgC2GamUKzQB
 */
export const DEVNET_CONFIG: NetworkConfig = {
  network: "devnet",

  // Program IDs (fresh deployment 2026-02-16, BJJ+Ed25519)
  zvaultProgramId: address("2qQPgW6LpzokD1Uemhy2Ng5Xjhr6VuHwJgC2GamUKzQB"),
  btcLightClientProgramId: address("HntN4u2Hh3FpTao9UHPanXuAyqUmDqwuL69YgNs5JCYi"),
  chadbufferProgramId: CHADBUFFER_PROGRAM_ID,
  token2022ProgramId: TOKEN_2022_PROGRAM_ID,
  ataProgramId: ATA_PROGRAM_ID,

  // Deployed Accounts (fresh deployment 2026-02-16)
  poolStatePda: address("GTB3YoRBfTV91RvgtVkYuGcbkBZBPAv12yhv8g4YHxbj"),
  commitmentTreePda: address("2SWg4ykwWiW3vX9vRQZsB7kxE3mRvq2omAiAz8h7XEfq"),
  zbtcMint: address("7n9XpcBRUmbUiKx1Q8Q1QF4ArkS8jzKEvbmTQ5CGBuWv"),
  poolVault: address("DNk7wTTuaPG4P3r4MTmTptAGxtcJNFFKMxVSY9bVtKBk"),

  // RPC Endpoints
  solanaRpcUrl: "https://api.devnet.solana.com",
  solanaWsUrl: "wss://api.devnet.solana.com",

  // Bitcoin Network
  bitcoinNetwork: "testnet",
  esploraUrl: "https://blockstream.info/testnet/api",

  // Circuit CDN (Groth16 artifacts: .wasm, .zkey files)
  circuitCdnUrl: "https://circuits.amidoggy.xyz",

  // Groth16 Verifier: verification is inline in the zVault program (no separate verifier program)
  groth16VerifierProgramId: address("2qQPgW6LpzokD1Uemhy2Ng5Xjhr6VuHwJgC2GamUKzQB"),

  // VK Hashes (SHA256 of serialized VK bytes, generated from circom trusted setup)
  vkHashes: {
    claim: "7af0e702e7b595fbdb62fd268e6c529481003e07957e0f60e4fb23cd9fe6a77f",
    split: "00fb9e4c3fcc7b99fec5191370b516537f74831ad868a18c4ab2d519f332cc4f",
    spendPartialPublic: "732126aaec8355efdfb1b96aee1c9014506c99815a81057edbefd775b1b10663",
    poolDeposit: "30cf9ac0a1793419b946c8dd147d203c6d60de73c451626198050838da590e7b",
    poolWithdraw: "5abd084ea01083b8dda38e5b339336c0f7b423b7c7464701227411bdd8f6ec04",
    poolClaimYield: "80b6763d827eda4d639b683018676bf94b1c180bd0f06f74fd711f797a252aaa",
    poolCompound: "0000000000000000000000000000000000000000000000000000000000000000",
  },
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
  esploraUrl: "https://blockstream.info/api",

  // Circuit CDN
  circuitCdnUrl: "https://cdn.jsdelivr.net/npm/@zvault/sdk@latest/circuits",

  // Groth16 Verifier (placeholder)
  groth16VerifierProgramId: address("11111111111111111111111111111111"),

  // VK Hashes (placeholder - update when deployed)
  vkHashes: {
    claim: "0000000000000000000000000000000000000000000000000000000000000000",
    split: "0000000000000000000000000000000000000000000000000000000000000000",
    spendPartialPublic: "171daac7e5ff45e2d0e736ac0d28f5fe8e0cc8fc9961efa4dd9ee18e4413f755",
    poolDeposit: "0000000000000000000000000000000000000000000000000000000000000000",
    poolWithdraw: "0000000000000000000000000000000000000000000000000000000000000000",
    poolClaimYield: "0000000000000000000000000000000000000000000000000000000000000000",
    poolCompound: "0000000000000000000000000000000000000000000000000000000000000000",
  },
};

/**
 * Localnet Configuration (for local development)
 * Synced with .localnet-config.json (2026-01-30)
 */
export const LOCALNET_CONFIG: NetworkConfig = {
  network: "localnet",

  // Program IDs (synced with .localnet-config.json)
  zvaultProgramId: address("zKeyrLmpT8W9o8iRvhizuSihLAFLhfAGBvfM638Pbw8"),
  btcLightClientProgramId: address("S6rgPjCeBhkYBejWyDR1zzU3sYCMob36LAf8tjwj8pn"),
  chadbufferProgramId: LOCALNET_CHADBUFFER_PROGRAM_ID,
  token2022ProgramId: TOKEN_2022_PROGRAM_ID,
  ataProgramId: ATA_PROGRAM_ID,

  // Deployed Accounts (synced with .localnet-config.json 2026-01-30)
  poolStatePda: address("ELGSdquznDBd6uUkWsBAmguMBmtuur7D5kapwoyZq44J"),
  commitmentTreePda: address("5p7WERgzB6AHcga19QehvaTfbiVoM1Bg6drkwzYHYamq"),
  zbtcMint: address("GU5DQFtz48SkSaLyHnL5fq7LN8MNiz9X5ujuLw7gjP2J"),
  poolVault: address("C9e9SiHUCXBE4QQYJs7rhExJL1xUjkPb4sXJXz7wMDwi"),

  // RPC Endpoints
  solanaRpcUrl: "http://127.0.0.1:8899",
  solanaWsUrl: "ws://127.0.0.1:8900",

  // Bitcoin Network (use testnet for local dev)
  bitcoinNetwork: "testnet",
  esploraUrl: "https://blockstream.info/testnet/api",

  // Circuit CDN (use local files for development)
  circuitCdnUrl: "/circuits",

  // Groth16 Verifier: verification is inline in the zVault program
  groth16VerifierProgramId: address("zKeyrLmpT8W9o8iRvhizuSihLAFLhfAGBvfM638Pbw8"),

  // VK Hashes (same as devnet - generated from same trusted setup)
  vkHashes: {
    claim: "7af0e702e7b595fbdb62fd268e6c529481003e07957e0f60e4fb23cd9fe6a77f",
    split: "00fb9e4c3fcc7b99fec5191370b516537f74831ad868a18c4ab2d519f332cc4f",
    spendPartialPublic: "732126aaec8355efdfb1b96aee1c9014506c99815a81057edbefd775b1b10663",
    poolDeposit: "30cf9ac0a1793419b946c8dd147d203c6d60de73c451626198050838da590e7b",
    poolWithdraw: "5abd084ea01083b8dda38e5b339336c0f7b423b7c7464701227411bdd8f6ec04",
    poolClaimYield: "80b6763d827eda4d639b683018676bf94b1c180bd0f06f74fd711f797a252aaa",
    poolCompound: "0000000000000000000000000000000000000000000000000000000000000000",
  },
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
// Convenience Exports (for backwards compatibility)
// =============================================================================

/** Default zVault program ID (from current config) - Hurb4hZa5FR3VFMyDnrrVcHfVrDXHEazR7rX91PB42Ly */
export const ZVAULT_PROGRAM_ID: Address = DEVNET_CONFIG.zvaultProgramId;

/** Default BTC Light Client program ID (from current config) */
export const BTC_LIGHT_CLIENT_PROGRAM_ID: Address = DEVNET_CONFIG.btcLightClientProgramId;

// =============================================================================
// Version Info
// =============================================================================

export const SDK_VERSION = "2.0.3";

export const DEPLOYMENT_INFO = {
  version: SDK_VERSION,
  deployedAt: "2026-02-01",
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
