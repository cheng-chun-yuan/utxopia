/**
 * Devnet Integration Test — Shared Setup
 *
 * Provides test context for all devnet integration tests.
 * Loads env, configures SDK, connects to Solana + Esplora.
 */

import * as fs from "fs";
import * as path from "path";
import { config as dotenvConfig } from "dotenv";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createKeyPairSignerFromBytes,
  type Rpc,
  type RpcSubscriptions,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
  type KeyPairSigner,
  type Address,
} from "@solana/kit";

import { setConfig, getConfig, type NetworkConfig } from "@zvault/sdk";

// =============================================================================
// Test Mode Detection
// =============================================================================

export const TEST_MODE = process.env.TEST_MODE || "devnet";
export const IS_LOCAL = TEST_MODE === "local";

// Load environment — local mode uses .env.local, devnet mode uses .env + .env.devnet-test
if (IS_LOCAL) {
  dotenvConfig({ path: path.resolve(__dirname, "../.env.local"), override: true });
} else {
  dotenvConfig({ path: path.resolve(__dirname, "../.env") });
  dotenvConfig({ path: path.resolve(__dirname, "../.env.devnet-test") });
}

// =============================================================================
// Types
// =============================================================================

export interface TestContext {
  /** Legacy @solana/web3.js Connection */
  connection: Connection;
  /** Legacy Keypair */
  payer: Keypair;
  /** @solana/kit RPC */
  rpc: Rpc<SolanaRpcApi>;
  /** @solana/kit subscriptions */
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  /** @solana/kit signer */
  payerSigner: KeyPairSigner;
  /** SDK config */
  config: NetworkConfig;
  /** FROST signer URLs */
  frostSignerUrls: string[];
  /** Backend API URL */
  backendApiUrl: string;
  /** Esplora URL */
  esploraUrl: string;
  /** FROST group pubkey (hex) */
  groupPubKey: string;
}

// =============================================================================
// Configuration
// =============================================================================

export const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
export const SOLANA_WS_URL = process.env.SOLANA_WS_URL || "wss://api.devnet.solana.com";
export const ESPLORA_URL = process.env.ESPLORA_URL || "https://mempool.space/testnet4/api";
export const BACKEND_API_URL = process.env.BACKEND_API_URL || "http://localhost:3001";
export const FROST_SIGNER_URLS = [
  process.env.FROST_SIGNER_1_URL || "http://localhost:8081",
  process.env.FROST_SIGNER_2_URL || "http://localhost:8082",
  process.env.FROST_SIGNER_3_URL || "http://localhost:8083",
];
export const FROST_GROUP_PUBKEY = process.env.FROST_GROUP_PUBKEY || "";

export const TEST_DEPOSIT_AMOUNT_SATS = parseInt(process.env.TEST_DEPOSIT_AMOUNT_SATS || "10000");
export const TEST_TIMEOUT = parseInt(process.env.TEST_TIMEOUT_MS || "120000");
export const PROOF_TIMEOUT = parseInt(process.env.PROOF_TIMEOUT_MS || "300000");

// =============================================================================
// Setup Functions
// =============================================================================

/**
 * Load payer keypair from file
 */
function loadPayer(): Keypair {
  const keypairPath = (process.env.SOLANA_KEYPAIR_PATH || "~/.config/solana/johnny.json")
    .replace("~", process.env.HOME || "");

  if (fs.existsSync(keypairPath)) {
    const bytes = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
    return Keypair.fromSecretKey(new Uint8Array(bytes));
  }

  console.warn("Payer keypair not found, generating ephemeral key");
  return Keypair.generate();
}

/**
 * Create the shared test context
 */
export async function createTestContext(): Promise<TestContext> {
  // Configure SDK for the target network
  setConfig(IS_LOCAL ? "localnet" : "devnet");
  const config = getConfig();

  // Create connections
  const connection = new Connection(SOLANA_RPC_URL, "confirmed");
  const rpc = createSolanaRpc(SOLANA_RPC_URL);
  const rpcSubscriptions = createSolanaRpcSubscriptions(SOLANA_WS_URL);

  // Load payer
  const payer = loadPayer();
  const payerSigner = await createKeyPairSignerFromBytes(payer.secretKey);

  // Check balance and airdrop if needed
  try {
    const balance = await connection.getBalance(payer.publicKey);
    if (balance < 0.1 * LAMPORTS_PER_SOL) {
      console.log(`Low balance (${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL), requesting airdrop...`);
      try {
        const sig = await connection.requestAirdrop(payer.publicKey, 2 * LAMPORTS_PER_SOL);
        await connection.confirmTransaction(sig, "confirmed");
        console.log("Airdrop successful");
      } catch (e) {
        console.warn("Airdrop failed (rate limited?):", e);
      }
    }
  } catch (e) {
    console.warn("Could not check balance:", e);
  }

  return {
    connection,
    payer,
    rpc,
    rpcSubscriptions,
    payerSigner,
    config,
    frostSignerUrls: FROST_SIGNER_URLS,
    backendApiUrl: BACKEND_API_URL,
    esploraUrl: ESPLORA_URL,
    groupPubKey: FROST_GROUP_PUBKEY,
  };
}

/**
 * Log test environment info
 */
export function logContext(ctx: TestContext) {
  console.log(`\n--- ${IS_LOCAL ? "Local" : "Devnet"} Test Context ---`);
  console.log(`  Mode: ${TEST_MODE}`);
  console.log(`  Solana RPC: ${SOLANA_RPC_URL}`);
  console.log(`  Payer: ${ctx.payer.publicKey.toBase58()}`);
  console.log(`  zVault: ${ctx.config.zvaultProgramId}`);
  console.log(`  BTC Relay: ${ctx.config.btcLightClientProgramId}`);
  console.log(`  Backend: ${ctx.backendApiUrl}`);
  console.log(`  FROST signers: ${ctx.frostSignerUrls.length}`);
  console.log(`  Group pubkey: ${ctx.groupPubKey ? ctx.groupPubKey.slice(0, 16) + "..." : "(not set)"}`);
  console.log("---\n");
}

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Fetch JSON from a URL with timeout
 */
export async function fetchJson(url: string, timeoutMs = 10000): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * Post JSON to a URL with timeout
 */
export async function postJson(url: string, body: any, timeoutMs = 30000): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * Poll a condition until it returns true or timeout
 */
export async function pollUntil(
  fn: () => Promise<boolean>,
  intervalMs: number,
  timeoutMs: number,
  label = "condition"
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    console.log(`  Waiting for ${label}... (${Math.round((Date.now() - start) / 1000)}s)`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timeout waiting for ${label} after ${timeoutMs}ms`);
}

/**
 * Sleep for ms
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
