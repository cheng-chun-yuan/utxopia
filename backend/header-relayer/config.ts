/**
 * Centralized configuration for the header relayer.
 *
 * Uses DEPLOY_ENV to select prefixed environment variables:
 *
 *   DEPLOY_ENV=devnet  → reads DEVNET_SOLANA_RPC_URL, DEVNET_PROGRAM_ID, etc.
 *   DEPLOY_ENV=testnet → reads TESTNET_SOLANA_RPC_URL, TESTNET_PROGRAM_ID, etc.
 *   DEPLOY_ENV=mainnet → reads MAINNET_SOLANA_RPC_URL, MAINNET_PROGRAM_ID, etc.
 *
 * Falls back to unprefixed vars (SOLANA_RPC_URL, PROGRAM_ID, etc.) for backwards compat.
 *
 * Example .env:
 *   DEPLOY_ENV=devnet
 *
 *   DEVNET_SOLANA_RPC_URL=https://api.devnet.solana.com
 *   DEVNET_PROGRAM_ID=DeDut4fkjbWBPY4FRUU3q9BUcvwTisHczj1EQmqX5avS
 *   DEVNET_RELAYER_KEYPAIR=[50,128,114,...]
 *   DEVNET_BITCOIN_NETWORK=testnet4
 *   DEVNET_START_BLOCK_HEIGHT=75000
 *   DEVNET_POLL_INTERVAL_MS=30000
 *
 *   MAINNET_SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
 *   MAINNET_PROGRAM_ID=...
 *   MAINNET_RELAYER_KEYPAIR=[...]
 *   MAINNET_BITCOIN_NETWORK=mainnet
 *   MAINNET_START_BLOCK_HEIGHT=880000
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { BitcoinNetwork } from './mempool';

// ── Load root .env (project-wide config, lower priority than local .env) ────
const __dirname_resolved = typeof __dirname !== 'undefined'
  ? __dirname
  : dirname(fileURLToPath(import.meta.url));

function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  const content = readFileSync(path, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    // Don't override existing env vars (local .env / CLI take precedence)
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// Load root .env first (won't override anything already set)
loadEnvFile(resolve(__dirname_resolved, '../../.env'));

// ── Env resolution ──────────────────────────────────────────────────────────

const DEPLOY_ENV = process.env.DEPLOY_ENV || '';
const PREFIX = DEPLOY_ENV ? `${DEPLOY_ENV.toUpperCase()}_` : '';

/**
 * Read an env var with the deploy prefix, falling back to unprefixed.
 * e.g. DEPLOY_ENV=devnet → tries DEVNET_PROGRAM_ID, then PROGRAM_ID
 */
function env(name: string): string | undefined {
  if (PREFIX) {
    const prefixed = process.env[`${PREFIX}${name}`];
    if (prefixed !== undefined) return prefixed;
  }
  return process.env[name];
}

function envRequired(name: string): string {
  const value = env(name);
  if (!value) {
    const prefixedName = PREFIX ? `${PREFIX}${name}` : name;
    throw new Error(
      `Missing required env var: ${prefixedName}` +
      (PREFIX ? ` (or ${name})` : '') +
      `\nSet DEPLOY_ENV=${DEPLOY_ENV || '<env>'} and provide ${PREFIX}${name} in .env`
    );
  }
  return value;
}

// ── Exported config ─────────────────────────────────────────────────────────

export const SOLANA_RPC_URL = env('SOLANA_RPC_URL') || 'https://api.devnet.solana.com';

export const PROGRAM_ID = new PublicKey(
  env('PROGRAM_ID') || 'DeDut4fkjbWBPY4FRUU3q9BUcvwTisHczj1EQmqX5avS'
);

export const BITCOIN_NETWORK = (env('BITCOIN_NETWORK') || 'testnet4') as BitcoinNetwork;

export const POLL_INTERVAL_MS = parseInt(env('POLL_INTERVAL_MS') || '30000', 10);

export const POLL_AT_TIP_MS = parseInt(env('POLL_AT_TIP_MS') || '300000', 10);

export const START_BLOCK_HEIGHT: bigint | null = (() => {
  const val = env('START_BLOCK_HEIGHT');
  return val ? BigInt(val) : null;
})();

export const BATCH_SIZE = parseInt(env('BATCH_SIZE') || '5', 10);

export const BITCOIN_API_URL = env('BITCOIN_API_URL');

/**
 * Get the relayer keypair.
 * Tries <PREFIX>RELAYER_KEYPAIR env, then RELAYER_KEYPAIR, then default solana keypair.
 */
export function getRelayerKeypair(): Keypair {
  const keypairJson = env('RELAYER_KEYPAIR');
  if (keypairJson) {
    try {
      return Keypair.fromSecretKey(new Uint8Array(JSON.parse(keypairJson)));
    } catch (e) {
      throw new Error(`Failed to parse RELAYER_KEYPAIR: ${e}`);
    }
  }

  // Fall back to default solana keypair
  const defaultPath = process.env.HOME + '/.config/solana/johnny.json';
  try {
    const raw = readFileSync(defaultPath, 'utf-8');
    return Keypair.fromSecretKey(new Uint8Array(JSON.parse(raw)));
  } catch {
    throw new Error(
      `No RELAYER_KEYPAIR env var set and could not read default keypair at ${defaultPath}.\n` +
      `Set ${PREFIX}RELAYER_KEYPAIR in your .env or provide a default solana keypair.`
    );
  }
}

/**
 * Get the on-chain network ID from the Bitcoin network name.
 * 0=mainnet, 1=testnet3, 2=testnet4, 3=regtest
 */
export function getNetworkId(): number {
  switch (BITCOIN_NETWORK) {
    case 'mainnet': return 0;
    case 'testnet4': return 2;
    case 'regtest': return 3;
    default: return 1; // testnet (testnet3), signet
  }
}

/** Log the current deploy config */
export function logConfig() {
  const deployLabel = DEPLOY_ENV || '(none)';
  console.log(`  Deploy Env:      ${deployLabel}`);
  console.log(`  Solana RPC:      ${SOLANA_RPC_URL}`);
  console.log(`  Program ID:      ${PROGRAM_ID.toBase58()}`);
  console.log(`  Bitcoin Network: ${BITCOIN_NETWORK}`);
  if (START_BLOCK_HEIGHT !== null) {
    console.log(`  Start Height:    ${START_BLOCK_HEIGHT}`);
  }
  console.log(`  Poll Interval:   ${POLL_INTERVAL_MS}ms`);
}
