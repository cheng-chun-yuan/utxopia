/**
 * Bitcoin Block Header Relayer Service
 *
 * Continuously syncs Bitcoin block headers to Solana light client.
 *
 * Configuration via DEPLOY_ENV-prefixed env vars (see config.ts).
 * Example: DEPLOY_ENV=devnet bun run start
 */

import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  getTipHeight,
  getBlockHashByHeight,
  getBlockHeaderByHeight,
  getBlockInfoByHeight,
} from './mempool';
import {
  getLightClientState,
  getLightClientTipHeight,
  blockHeaderExists,
  submitHeader,
  getOnChainBlockHash,
  resetTip,
  bytesToHex,
  hexToBytes,
} from './solana';
import {
  SOLANA_RPC_URL,
  PROGRAM_ID,
  BITCOIN_NETWORK,
  POLL_INTERVAL_MS,
  POLL_AT_TIP_MS,
  START_BLOCK_HEIGHT,
  getRelayerKeypair,
  logConfig,
} from './config';

// Log with timestamp
function log(message: string, ...args: unknown[]) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`, ...args);
}

// Sleep helper
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Detect and handle reorgs by comparing on-chain tip hash with Bitcoin's hash at same height.
 * Returns true if a reorg was detected and handled (caller should re-sync).
 */
async function detectAndHandleReorg(
  connection: Connection,
  relayer: ReturnType<typeof getRelayerKeypair>,
  startBlockHeight: bigint
): Promise<boolean> {
  const state = await getLightClientState(connection, PROGRAM_ID);
  if (!state) return false;

  const onChainTipHeight = state.tipHeight;
  const onChainTipHash = state.tipHash;

  // Get Bitcoin's block hash at the on-chain tip height
  let btcHashHex: string;
  try {
    btcHashHex = await getBlockHashByHeight(BITCOIN_NETWORK, Number(onChainTipHeight));
  } catch {
    log(`Could not fetch Bitcoin hash at height ${onChainTipHeight}, skipping reorg check`);
    return false;
  }

  // Convert Bitcoin hash (BE hex) to LE bytes for comparison
  const btcHashLeBytes = hexToBytes(btcHashHex);
  // Bitcoin block hashes from API are in display order (BE), reverse to LE for on-chain comparison
  btcHashLeBytes.reverse();

  // Compare
  const match = onChainTipHash.every((b, i) => b === btcHashLeBytes[i]);
  if (match) return false;

  log(`REORG DETECTED at height ${onChainTipHeight}!`);
  log(`  On-chain: ${bytesToHex(new Uint8Array(onChainTipHash))}`);
  log(`  Bitcoin:  ${btcHashHex}`);

  // Walk backward to find common ancestor
  let ancestorHeight = onChainTipHeight;
  const minHeight = startBlockHeight;

  while (ancestorHeight > minHeight) {
    ancestorHeight -= 1n;

    const onChainHash = await getOnChainBlockHash(connection, PROGRAM_ID, ancestorHeight);
    if (!onChainHash) {
      log(`No on-chain block at height ${ancestorHeight}, stopping search`);
      break;
    }

    let btcAncestorHex: string;
    try {
      btcAncestorHex = await getBlockHashByHeight(BITCOIN_NETWORK, Number(ancestorHeight));
    } catch {
      log(`Could not fetch Bitcoin hash at height ${ancestorHeight}`);
      break;
    }

    const btcAncestorLe = hexToBytes(btcAncestorHex);
    btcAncestorLe.reverse();

    const ancestorMatch = onChainHash.every((b, i) => b === btcAncestorLe[i]);
    if (ancestorMatch) {
      log(`Common ancestor found at height ${ancestorHeight}: ${btcAncestorHex}`);

      // Reset tip to common ancestor
      log(`Resetting tip to height ${ancestorHeight}...`);
      const sig = await resetTip(
        connection,
        PROGRAM_ID,
        relayer,
        ancestorHeight,
        onChainHash,
      );
      log(`Reset tip complete: tx=${sig}`);
      return true;
    }
  }

  log(`ERROR: Could not find common ancestor above height ${minHeight}`);
  return false;
}

// Main sync loop - returns true if synced blocks, false if already at tip
async function syncHeaders(
  connection: Connection,
  relayer: ReturnType<typeof getRelayerKeypair>,
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
  logConfig();

  // Validate start block height
  if (START_BLOCK_HEIGHT === null) {
    throw new Error(
      'START_BLOCK_HEIGHT is required.\n' +
        'Set it to a recent block height to avoid syncing from genesis.\n' +
        `Example: START_BLOCK_HEIGHT=75000 for ${BITCOIN_NETWORK}`
    );
  }

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
      // Check for reorgs before syncing
      const reorgHandled = await detectAndHandleReorg(connection, relayer, START_BLOCK_HEIGHT);
      if (reorgHandled) {
        log('Reorg handled, re-syncing...');
        syncedBlocks = true; // force fast poll
      }

      syncedBlocks = await syncHeaders(connection, relayer, START_BLOCK_HEIGHT) || syncedBlocks;
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
