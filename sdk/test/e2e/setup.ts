/**
 * E2E Test Setup
 *
 * Shared setup utilities for E2E tests with solana-test-validator.
 * Provides validator detection, configuration loading, and test utilities.
 *
 * Prerequisites:
 * - solana-test-validator running with devnet features:
 *   solana-test-validator --clone-feature-set --url devnet --reset
 * - Programs deployed to localnet:
 *   cd contracts && bun run deploy:localnet
 * - Circuits compiled:
 *   cd circuits && bun run compile:all && bun run copy-to-sdk
 */

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  address,
  type Rpc,
  type RpcSubscriptions,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
  type KeyPairSigner,
  type Address,
} from "@solana/kit";
import * as fs from "fs";
import * as path from "path";

import { setConfig, getConfig, createConfig, LOCALNET_CONFIG, DEVNET_CONFIG, type NetworkConfig } from "../../src/config";
import { address as kitAddress } from "@solana/kit";
import { initPoseidon } from "../../src/poseidon";
import { initProver, setCircuitPath, isProverAvailable, circuitExists } from "../../src/prover/web";

// =============================================================================
// Types
// =============================================================================

export interface LocalnetConfig {
  network: string;
  rpcUrl: string;
  programs: {
    UTXOpia: string;
    btcLightClient: string;
    groth16Verifier?: string;
    chadbuffer?: string;
  };
  accounts: {
    poolState: string;
    commitmentTree: string;
    zkbtcMint: string;
    poolVault: string;
    authority?: string;
  };
  btcLightClient?: {
    pda: string;
    startHeight: string;
    startHash?: string;
    network?: string;
  };
  createdAt?: string;
}

export interface E2ETestContext {
  /** Legacy @solana/web3.js Connection */
  connection: Connection;
  /** Legacy @solana/web3.js Keypair */
  payer: Keypair;
  /** @solana/kit RPC client */
  rpc: Rpc<SolanaRpcApi>;
  /** @solana/kit RPC subscriptions client */
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  /** @solana/kit KeyPairSigner */
  payerSigner: KeyPairSigner;
  /** SDK network config */
  config: NetworkConfig;
  /** Localnet deployment config */
  localnetConfig: LocalnetConfig;
  /** Skip on-chain tests (validator not available) */
  skipOnChain: boolean;
  /** Skip proof tests (circuits not compiled) */
  skipProof: boolean;
  /** Prover is available and initialized */
  proverReady: boolean;
}

// =============================================================================
// Constants
// =============================================================================

/** Detect network from environment variable (default: devnet) */
export const NETWORK = (process.env.NETWORK || "devnet") as "localnet" | "devnet";
export const IS_DEVNET = NETWORK === "devnet";

/** RPC URLs based on network */
export const RPC_URL = IS_DEVNET
  ? "https://api.devnet.solana.com"
  : "http://127.0.0.1:8899";
export const WS_URL = IS_DEVNET
  ? "wss://api.devnet.solana.com"
  : "ws://127.0.0.1:8900";

export const TEST_TIMEOUT = 120_000; // 2 minutes for basic tests
export const PROOF_TIMEOUT = 300_000; // 5 minutes for real proof generation
export const REAL_PROOF_SIZE = 256; // Groth16 proof = 2 G1 + 1 G2 on BN254 = 256 bytes

const LOCALNET_CONFIG_PATH = path.resolve(
  __dirname,
  "../../../contracts/.localnet-config.json"
);

// Use the Solana CLI configured keypair (matches deploy script)
const DEFAULT_KEYPAIR_PATH = path.join(
  process.env.HOME || "~",
  ".config/solana/johnny.json"
);

// Fallback keypair path if johnny.json doesn't exist
const FALLBACK_KEYPAIR_PATH = path.join(
  process.env.HOME || "~",
  ".config/solana/id.json"
);

// =============================================================================
// Validator Detection
// =============================================================================

/**
 * Check if the local validator is running
 */
export async function isValidatorRunning(connection?: Connection): Promise<boolean> {
  const conn = connection || new Connection(RPC_URL, "confirmed");
  try {
    await conn.getVersion();
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait for validator to be ready with retries
 */
export async function waitForValidator(
  maxRetries: number = 5,
  delayMs: number = 1000
): Promise<boolean> {
  const connection = new Connection(RPC_URL, "confirmed");

  for (let i = 0; i < maxRetries; i++) {
    if (await isValidatorRunning(connection)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return false;
}

// =============================================================================
// Configuration Loading
// =============================================================================

/**
 * Load localnet configuration from .localnet-config.json
 */
export function loadLocalnetConfig(): LocalnetConfig | null {
  try {
    if (!fs.existsSync(LOCALNET_CONFIG_PATH)) {
      console.warn(`Localnet config not found at: ${LOCALNET_CONFIG_PATH}`);
      return null;
    }

    const content = fs.readFileSync(LOCALNET_CONFIG_PATH, "utf-8");
    return JSON.parse(content) as LocalnetConfig;
  } catch (error) {
    console.warn(`Failed to load localnet config: ${error}`);
    return null;
  }
}

/**
 * Load or generate a test keypair
 */
export function loadKeypair(keypairPath?: string): Keypair {
  // Try paths in order: explicit path, default, fallback
  const pathsToTry = keypairPath
    ? [keypairPath]
    : [DEFAULT_KEYPAIR_PATH, FALLBACK_KEYPAIR_PATH];

  for (const filePath of pathsToTry) {
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf-8");
        const secretKey = new Uint8Array(JSON.parse(content));
        return Keypair.fromSecretKey(secretKey);
      }
    } catch (error) {
      console.warn(`Failed to load keypair from ${filePath}: ${error}`);
    }
  }

  // Generate a new keypair for testing
  console.log("Generating new test keypair...");
  return Keypair.generate();
}

// =============================================================================
// Test Setup
// =============================================================================

/**
 * Request airdrop and wait for confirmation
 */
export async function airdrop(
  connection: Connection,
  pubkey: PublicKey,
  lamports: number = 2 * LAMPORTS_PER_SOL
): Promise<string> {
  const sig = await connection.requestAirdrop(pubkey, lamports);
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

/** Prover initialization state */
let proverInitialized = false;
let proverAvailable = false;

/**
 * Initialize all required modules for E2E testing
 *
 * @returns Object indicating which features are available
 */
export async function initializeTestEnvironment(): Promise<{
  poseidonReady: boolean;
  proverReady: boolean;
  circuitsAvailable: {
    joinsplit: boolean;
  };
}> {
  // Set circuit path for prover
  setCircuitPath("./circuits");

  // Initialize Poseidon hasher
  await initPoseidon();
  const poseidonReady = true;

  // Check circuit availability (JoinSplit circuits)
  const circuitsAvailable = {
    joinsplit: await circuitExists("joinsplit_1x1"),
  };

  // Initialize WASM prover if circuits are available
  let proverReady = false;
  if (circuitsAvailable.joinsplit) {
    try {
      await initProver();
      proverReady = await isProverAvailable();
      proverInitialized = true;
      proverAvailable = proverReady;
      console.log("[Setup] Prover initialized successfully");
    } catch (error) {
      console.warn("[Setup] Failed to initialize prover:", error);
    }
  } else {
    console.warn("[Setup] No JoinSplit circuit artifacts found in ./circuits - proof tests will be skipped");
    console.warn("[Setup] Run: cd circuits && bun run compile:all && bun run copy-to-sdk");
  }

  return { poseidonReady, proverReady, circuitsAvailable };
}

/**
 * Check if prover is ready for use
 */
export function isProverReady(): boolean {
  return proverInitialized && proverAvailable;
}

/**
 * Create a complete E2E test context
 *
 * Returns a context object with all necessary components for E2E testing.
 * Sets skipOnChain=true if validator is not available.
 * Sets skipProof=true if circuits are not compiled.
 */
export async function createTestContext(): Promise<E2ETestContext> {
  // Load localnet config (only relevant for localnet)
  const localnetConfig = loadLocalnetConfig();

  // Configure based on network
  if (IS_DEVNET) {
    // Use devnet config directly
    setConfig("devnet");
    console.log("[Setup] Using devnet configuration");
  } else {
    // Localnet: check validator availability first
    const validatorRunning = await isValidatorRunning();
    if (!validatorRunning) {
      console.warn("[Setup] Local validator not running");
    }

    // Set SDK config to localnet, overriding with actual deployed addresses from localnet config
    if (localnetConfig && localnetConfig.programs?.UTXOpia && localnetConfig.accounts?.poolState) {
      const customConfig = createConfig(LOCALNET_CONFIG, {
        // Override with actual deployed addresses
        utxopiaProgramId: kitAddress(localnetConfig.programs.UTXOpia),
        btcLightClientProgramId: kitAddress(localnetConfig.programs.btcLightClient),
        chadbufferProgramId: localnetConfig.programs.chadbuffer
          ? kitAddress(localnetConfig.programs.chadbuffer)
          : LOCALNET_CONFIG.chadbufferProgramId,
        groth16VerifierProgramId: localnetConfig.programs.groth16Verifier
          ? kitAddress(localnetConfig.programs.groth16Verifier)
          : LOCALNET_CONFIG.groth16VerifierProgramId,
        poolStatePda: kitAddress(localnetConfig.accounts.poolState),
        commitmentTreePda: kitAddress(localnetConfig.accounts.commitmentTree),
        zkbtcMint: kitAddress(localnetConfig.accounts.zkbtcMint),
        poolVault: kitAddress(localnetConfig.accounts.poolVault),
      });
      setConfig(customConfig);
    } else {
      setConfig("localnet");
    }
  }
  const config = getConfig();

  // Create legacy connection
  const connection = new Connection(RPC_URL, "confirmed");

  // Create @solana/kit RPC clients
  const rpc = createSolanaRpc(RPC_URL);
  const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);

  // Load or generate payer keypair
  const payer = loadKeypair();

  // Create @solana/kit KeyPairSigner from the same keypair
  const payerSigner = await createKeyPairSignerFromBytes(payer.secretKey);

  // Determine if we should skip on-chain tests
  let skipOnChain = false;

  if (IS_DEVNET) {
    // Devnet: check connectivity and balance
    try {
      const balance = await connection.getBalance(payer.publicKey);
      if (balance < 0.1 * LAMPORTS_PER_SOL) {
        console.log(`[Devnet] Low balance (${balance / LAMPORTS_PER_SOL} SOL), requesting airdrop...`);
        try {
          await airdrop(connection, payer.publicKey, 2 * LAMPORTS_PER_SOL);
          console.log("[Devnet] Airdrop successful");
        } catch (airdropError) {
          console.warn("[Devnet] Airdrop failed (rate limited?), check balance manually:", airdropError);
        }
      } else {
        console.log(`[Devnet] Payer balance: ${balance / LAMPORTS_PER_SOL} SOL`);
      }
    } catch (error) {
      console.warn("[Devnet] Failed to connect:", error);
      skipOnChain = true;
    }
  } else {
    // Localnet: check validator
    const validatorRunning = await isValidatorRunning();
    skipOnChain = !validatorRunning;

    if (validatorRunning && !localnetConfig) {
      console.warn("Validator running but no localnet config found. On-chain tests will be skipped.");
      skipOnChain = true;
    }

    // Try to fund the payer if validator is running
    if (!skipOnChain) {
      try {
        const balance = await connection.getBalance(payer.publicKey);
        if (balance < LAMPORTS_PER_SOL) {
          console.log(`Airdropping 2 SOL to test payer: ${payer.publicKey.toBase58()}`);
          await airdrop(connection, payer.publicKey);
        }
      } catch (error) {
        console.warn("Failed to airdrop to payer:", error);
        skipOnChain = true;
      }
    }
  }

  // Check prover availability
  const proverReady = isProverReady();
  const skipProof = !proverReady;

  if (skipProof) {
    console.warn("[Setup] Proof tests will be skipped (prover not ready)");
  }

  // Build config object from SDK config (correct addresses for the network)
  const networkConfig: LocalnetConfig = {
    network: NETWORK,
    rpcUrl: RPC_URL,
    programs: {
      UTXOpia: config.utxopiaProgramId.toString(),
      btcLightClient: config.btcLightClientProgramId.toString(),
      groth16Verifier: config.groth16VerifierProgramId.toString(),
      chadbuffer: config.chadbufferProgramId.toString(),
    },
    accounts: {
      poolState: config.poolStatePda.toString(),
      commitmentTree: config.commitmentTreePda.toString(),
      zkbtcMint: config.zkbtcMint.toString(),
      poolVault: config.poolVault.toString(),
    },
  };

  return {
    connection,
    payer,
    rpc,
    rpcSubscriptions,
    payerSigner,
    config,
    // For devnet: always use SDK config addresses
    // For localnet: prefer localnetConfig file if available (for fresh deployments)
    localnetConfig: IS_DEVNET ? networkConfig : (localnetConfig || networkConfig),
    skipOnChain,
    skipProof,
    proverReady,
  };
}

/**
 * Log test environment status
 */
export function logTestEnvironment(ctx: E2ETestContext): void {
  console.log("\n" + "=".repeat(60));
  console.log("E2E Test Environment");
  console.log("=".repeat(60));
  console.log(`Network: ${ctx.config.network}`);
  console.log(`RPC URL: ${RPC_URL}`);
  console.log(`Payer: ${ctx.payer.publicKey.toBase58()}`);
  console.log(`Skip On-Chain Tests: ${ctx.skipOnChain}`);
  console.log(`Skip Proof Tests: ${ctx.skipProof}`);
  console.log(`Prover Ready: ${ctx.proverReady}`);
  console.log(`UTXOpia Program: ${ctx.localnetConfig.programs.UTXOpia}`);
  console.log(`Pool State: ${ctx.localnetConfig.accounts.poolState}`);
  console.log(`Commitment Tree: ${ctx.localnetConfig.accounts.commitmentTree}`);
  console.log("=".repeat(60) + "\n");
}

// =============================================================================
// Test Utilities
// =============================================================================

/**
 * Wait for a transaction to confirm
 */
export async function waitForConfirmation(
  connection: Connection,
  signature: string,
  commitment: "confirmed" | "finalized" = "confirmed"
): Promise<void> {
  await connection.confirmTransaction(signature, commitment);
}

/**
 * Get account data or null if not found
 */
export async function getAccountData(
  connection: Connection,
  pubkey: PublicKey
): Promise<Buffer | null> {
  const info = await connection.getAccountInfo(pubkey);
  return info?.data || null;
}

/**
 * Check if a program is deployed
 */
export async function isProgramDeployed(
  connection: Connection,
  programId: PublicKey
): Promise<boolean> {
  try {
    const info = await connection.getAccountInfo(programId);
    return info !== null && info.executable;
  } catch {
    return false;
  }
}
