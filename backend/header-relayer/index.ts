/**
 * Bitcoin Block Header Relayer Service
 *
 * Continuously syncs Bitcoin block headers to Solana light client.
 * Uses the btc-light-client program for simple, transparent header relay.
 *
 * Environment Variables:
 *   SOLANA_RPC_URL     - Solana RPC endpoint (default: devnet)
 *   PROGRAM_ID         - BTC Light Client program ID
 *   RELAYER_KEYPAIR    - JSON array of keypair bytes
 *   POLL_INTERVAL_MS   - Polling interval in milliseconds (default: 30000)
 *   BITCOIN_NETWORK    - mainnet, testnet, or signet (default: testnet)
 *   START_BLOCK_HEIGHT - Block height to start syncing from (required)
 */

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  getTipHeight,
  getBlockHeaderByHeight,
  getBlockInfoByHeight,
  type BitcoinNetwork,
} from './mempool';
import {
  getLightClientTipHeight,
  blockHeaderExists,
  submitHeader,
  bytesToHex,
} from './solana';

// Configuration from environment
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || 'S6rgPjCeBhkYBejWyDR1zzU3sYCMob36LAf8tjwj8pn'
);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '30000', 10);
const POLL_AT_TIP_MS = parseInt(process.env.POLL_AT_TIP_MS || '300000', 10); // 5 min when at tip
const BITCOIN_NETWORK = (process.env.BITCOIN_NETWORK || 'testnet') as BitcoinNetwork;

// Required: START_BLOCK_HEIGHT to avoid syncing from genesis
const START_BLOCK_HEIGHT = process.env.START_BLOCK_HEIGHT
  ? BigInt(process.env.START_BLOCK_HEIGHT)
  : null;

// Parse relayer keypair from environment
function getRelayerKeypair(): Keypair {
  const keypairJson = process.env.RELAYER_KEYPAIR;
  if (!keypairJson) {
    throw new Error('RELAYER_KEYPAIR environment variable is required');
  }

  try {
    const keypairArray = JSON.parse(keypairJson);
    return Keypair.fromSecretKey(new Uint8Array(keypairArray));
  } catch (e) {
    throw new Error(`Failed to parse RELAYER_KEYPAIR: ${e}`);
  }
}

// Log with timestamp
function log(message: string, ...args: unknown[]) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`, ...args);
}

// Sleep helper
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Main sync loop - returns true if synced blocks, false if already at tip
async function syncHeaders(
  connection: Connection,
  relayer: Keypair,
  startBlockHeight: bigint
): Promise<boolean> {
  log('Syncing headers...');

  // Get on-chain tip height
  const onChainTip = await getLightClientTipHeight(connection, PROGRAM_ID, startBlockHeight);
  log(`On-chain tip height: ${onChainTip}`);

  // Get Bitcoin tip height
  const btcTip = await getTipHeight(BITCOIN_NETWORK);
  log(`Bitcoin ${BITCOIN_NETWORK} tip height: ${btcTip}`);

  // Determine starting point
  const effectiveStart = onChainTip < startBlockHeight - 1n ? startBlockHeight : onChainTip + 1n;

  // Calculate how many blocks to sync
  const blocksToSync = BigInt(btcTip) - effectiveStart + 1n;

  if (blocksToSync <= 0n) {
    log('Already synced to tip, nothing to do');
    return false; // At tip
  }

  log(`Need to sync ${blocksToSync} blocks (${effectiveStart} -> ${btcTip})`);

  // Sync blocks one by one
  for (let height = effectiveStart; height <= BigInt(btcTip); height++) {
    try {
      // Check if block header already exists on-chain
      const exists = await blockHeaderExists(connection, PROGRAM_ID, height);
      if (exists) {
        log(`Block ${height} already exists on-chain, skipping`);
        continue;
      }

      // Fetch block header from mempool.space
      log(`Fetching block ${height} header...`);
      const rawHeader = await getBlockHeaderByHeight(BITCOIN_NETWORK, Number(height));

      // Get block info for logging
      const blockInfo = await getBlockInfoByHeight(BITCOIN_NETWORK, Number(height));
      log(`Block ${height}: hash=${blockInfo.id.slice(0, 16)}..., timestamp=${new Date(blockInfo.timestamp * 1000).toISOString()}`);

      // Submit to Solana
      log(`Submitting block ${height} to Solana...`);
      const signature = await submitHeader(
        connection,
        PROGRAM_ID,
        relayer,
        rawHeader,
        height
      );

      log(`Submitted block ${height}: tx=${signature}`);

      // Small delay between submissions to avoid rate limiting
      await sleep(500);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check if it's a duplicate submission error (PDA already exists)
      if (errorMessage.includes('already in use') || errorMessage.includes('0x0')) {
        log(`Block ${height} already submitted, skipping`);
        continue;
      }

      // Check if chain continuity error
      if (errorMessage.includes('BlockNotConnected')) {
        log(`Block ${height} not connected to tip - light client may need reinitialization`);
        throw error;
      }

      log(`Error submitting block ${height}: ${errorMessage}`);
      throw error;
    }
  }

  log('Sync complete!');
  return true; // Synced blocks
}

// Main entry point
async function main() {
  log('Starting Bitcoin Block Header Relayer');
  log(`  Solana RPC: ${SOLANA_RPC_URL}`);
  log(`  Program ID: ${PROGRAM_ID.toBase58()}`);
  log(`  Bitcoin Network: ${BITCOIN_NETWORK}`);
  log(`  Poll Interval: ${POLL_INTERVAL_MS}ms`);

  // Validate start block height
  if (START_BLOCK_HEIGHT === null) {
    throw new Error(
      'START_BLOCK_HEIGHT environment variable is required.\n' +
        'Set it to a recent block height to avoid syncing from genesis.\n' +
        `Example: START_BLOCK_HEIGHT=2900000 for ${BITCOIN_NETWORK}`
    );
  }
  log(`  Start Block Height: ${START_BLOCK_HEIGHT}`);

  // Initialize relayer keypair
  const relayer = getRelayerKeypair();
  log(`  Relayer: ${relayer.publicKey.toBase58()}`);

  // Initialize Solana connection
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

  // Check relayer balance
  const balance = await connection.getBalance(relayer.publicKey);
  log(`  Relayer Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  if (balance < 0.01 * LAMPORTS_PER_SOL) {
    log('WARNING: Relayer balance is low! Each header submission costs ~0.002 SOL');
  }

  // Main loop with smart polling
  while (true) {
    let syncedBlocks = false;
    try {
      syncedBlocks = await syncHeaders(connection, relayer, START_BLOCK_HEIGHT);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log(`Sync error: ${errorMessage}`);
    }

    // Smart polling: faster when catching up, slower when at tip
    const sleepTime = syncedBlocks ? POLL_INTERVAL_MS : POLL_AT_TIP_MS;
    log(`Sleeping for ${sleepTime / 1000}s (${syncedBlocks ? 'catching up' : 'at tip'})...`);
    await sleep(sleepTime);
  }
}

// Run
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
