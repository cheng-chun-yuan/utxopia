/**
 * Bitcoin Block Header Relayer Service
 *
 * Permissionless batch header submission via extend_blockchain.
 * Auto-detects chain reorgs (orphaned on-chain tip) and reinitializes
 * the light client to recover without manual intervention.
 *
 * Configuration via DEPLOY_ENV-prefixed env vars (see config.ts).
 */

import { Connection, Keypair, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  getTipHeight,
  getBlockHeaderByHeight,
  getBlockHashByHeight,
} from './mempool';
import {
  getLightClientState,
  getBlockHashAtHeight,
  extendBlockchain,
  computeBlockHash,
  bytesToHex,
  deriveLightClientPda,
  deriveHeightIndexPda,
  deriveBlockHeaderPda,
  buildReinitializeInstruction,
} from './solana';
import { hexToBytesReversed } from './utils';
import {
  SOLANA_RPC_URL,
  PROGRAM_ID,
  BITCOIN_NETWORK,
  POLL_INTERVAL_MS,
  POLL_AT_TIP_MS,
  START_BLOCK_HEIGHT,
  getRelayerKeypair,
  getNetworkId,
  logConfig,
  BATCH_SIZE,
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

// Reorg cooldown: prevent reinit loops
const REINIT_COOLDOWN_MS = 60_000;
let lastReinitTime = 0;

/**
 * Detect chain reorg and auto-reinitialize the light client.
 * Returns true if a reorg was detected and recovery was performed.
 */
async function detectAndHandleReorg(
  connection: Connection,
  relayer: Keypair,
): Promise<boolean> {
  // Cooldown guard
  const now = Date.now();
  if (now - lastReinitTime < REINIT_COOLDOWN_MS) {
    log(`[Reorg] Skipping check — cooldown active (${Math.round((REINIT_COOLDOWN_MS - (now - lastReinitTime)) / 1000)}s remaining)`);
    return false;
  }

  const state = await getLightClientState(connection, PROGRAM_ID);
  if (!state) return false;

  const onChainHex = Buffer.from(state.tipHash).reverse().toString('hex');
  const canonicalHash = await getBlockHashByHeight(BITCOIN_NETWORK, Number(state.tipHeight));

  if (onChainHex === canonicalHash) return false; // Not a reorg

  log(`[Reorg] Detected at height ${state.tipHeight}!`);
  log(`[Reorg]   On-chain hash: ${onChainHex}`);
  log(`[Reorg]   Canonical hash: ${canonicalHash}`);

  // Reinitialize 10 blocks behind current BTC tip
  const btcTip = await getTipHeight(BITCOIN_NETWORK);
  const reinitHeight = BigInt(btcTip - 10);
  const reinitHashHex = await getBlockHashByHeight(BITCOIN_NETWORK, Number(reinitHeight));
  const reinitHashBytes = hexToBytesReversed(reinitHashHex);

  const networkId = getNetworkId();
  const [lightClientPda] = deriveLightClientPda(PROGRAM_ID);
  const [heightIndexPda] = deriveHeightIndexPda(PROGRAM_ID, reinitHeight);
  const [blockHeaderPda] = deriveBlockHeaderPda(PROGRAM_ID, reinitHashBytes);

  const ix = buildReinitializeInstruction(
    PROGRAM_ID,
    lightClientPda,
    relayer.publicKey,
    heightIndexPda,
    blockHeaderPda,
    reinitHeight,
    reinitHashBytes,
    networkId,
  );

  log(`[Reorg] Reinitializing to height ${reinitHeight} (hash: ${reinitHashHex})...`);
  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [relayer]);
  log(`[Reorg] Reinitialized successfully! tx: ${sig}`);

  lastReinitTime = Date.now();
  return true;
}

/**
 * Sync headers in batches using extend_blockchain.
 * Returns true if synced blocks, false if already at tip.
 */
async function syncHeaders(
  connection: Connection,
  relayer: ReturnType<typeof getRelayerKeypair>,
  startBlockHeight: bigint
): Promise<boolean> {
  log('Syncing headers...');

  // Get on-chain state
  const state = await getLightClientState(connection, PROGRAM_ID);
  const onChainTip = state ? state.tipHeight : startBlockHeight - 1n;
  const tipHash = state ? state.tipHash : null;
  log(`On-chain tip height: ${onChainTip}`);

  // Get Bitcoin tip height
  const btcTip = await getTipHeight(BITCOIN_NETWORK);
  log(`Bitcoin ${BITCOIN_NETWORK} tip height: ${btcTip}`);

  const effectiveStart = onChainTip < startBlockHeight - 1n ? startBlockHeight : onChainTip + 1n;
  const blocksToSync = BigInt(btcTip) - effectiveStart + 1n;

  if (blocksToSync <= 0n) {
    log('Already synced to tip, nothing to do');
    return false;
  }

  log(`Need to sync ${blocksToSync} blocks (${effectiveStart} -> ${btcTip})`);

  // Get the parent block hash (the current tip hash)
  let parentHash: Uint8Array;
  if (tipHash) {
    parentHash = new Uint8Array(tipHash);
  } else {
    // If light client just initialized, get hash from HeightIndex at start height
    const hashAtStart = await getBlockHashAtHeight(connection, PROGRAM_ID, onChainTip);
    if (!hashAtStart) {
      log('ERROR: Cannot find parent block hash on-chain');
      return false;
    }
    parentHash = hashAtStart;
  }

  let parentHeight = onChainTip;
  let height = effectiveStart;
  let syncedAny = false;

  while (height <= BigInt(btcTip)) {
    // Determine batch size (min 2, max BATCH_SIZE, capped by remaining blocks)
    const remaining = BigInt(btcTip) - height + 1n;
    const batchSize = Math.max(2, Math.min(BATCH_SIZE, Number(remaining)));

    // If only 1 block left, we can't submit (min batch = 2), wait for more
    if (remaining < 2n) {
      log(`Only ${remaining} block remaining, need at least 2 for a batch. Waiting...`);
      break;
    }

    // Fetch batch of raw headers
    const rawHeaders: Uint8Array[] = [];
    for (let i = 0; i < batchSize; i++) {
      const h = height + BigInt(i);
      if (h > BigInt(btcTip)) break;

      const rawHeader = await getBlockHeaderByHeight(BITCOIN_NETWORK, Number(h));
      rawHeaders.push(rawHeader);

      const hash = computeBlockHash(rawHeader);
      log(`  Block ${h}: hash=${bytesToHex(hash).slice(0, 16)}...`);
    }

    if (rawHeaders.length < 2) {
      log('Not enough headers for a batch, waiting...');
      break;
    }

    try {
      log(`Submitting batch of ${rawHeaders.length} headers (${height} -> ${height + BigInt(rawHeaders.length - 1)})...`);

      const signature = await extendBlockchain(
        connection,
        PROGRAM_ID,
        relayer,
        parentHash,
        rawHeaders,
        parentHeight,
      );

      log(`Batch submitted: tx=${signature}`);

      // Update parent for next batch
      const lastHeader = rawHeaders[rawHeaders.length - 1];
      parentHash = computeBlockHash(lastHeader);
      parentHeight = height + BigInt(rawHeaders.length - 1);
      height = parentHeight + 1n;
      syncedAny = true;

      // Small delay between batches
      await sleep(500);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check if it's a duplicate (PDA already exists)
      if (errorMessage.includes('already in use') || errorMessage.includes('0x0')) {
        log(`Batch starting at ${height} contains already-submitted headers, skipping...`);
        // Try to advance past this batch
        const lastHeader = rawHeaders[rawHeaders.length - 1];
        parentHash = computeBlockHash(lastHeader);
        parentHeight = height + BigInt(rawHeaders.length - 1);
        height = parentHeight + 1n;
        continue;
      }

      log(`Error submitting batch at height ${height}: ${errorMessage}`);

      // Check for chain reorg before giving up
      const reorgHandled = await detectAndHandleReorg(connection, relayer);
      if (reorgHandled) {
        return true; // Exit syncHeaders so the main loop retries with fresh state
      }

      throw error;
    }
  }

  if (syncedAny) {
    log('Sync complete!');
  }
  return syncedAny;
}

// Main entry point
async function main() {
  log('Starting Bitcoin Block Header Relayer (Permissionless Batch Mode)');
  logConfig();

  if (START_BLOCK_HEIGHT === null) {
    throw new Error(
      'START_BLOCK_HEIGHT is required.\n' +
        'Set it to a recent block height to avoid syncing from genesis.\n' +
        `Example: START_BLOCK_HEIGHT=75000 for ${BITCOIN_NETWORK}`
    );
  }

  const relayer = getRelayerKeypair();
  log(`  Relayer: ${relayer.publicKey.toBase58()}`);

  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

  const balance = await connection.getBalance(relayer.publicKey);
  log(`  Relayer Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  if (balance < 0.01 * LAMPORTS_PER_SOL) {
    log('WARNING: Relayer balance is low! Each batch costs ~0.01 SOL');
  }

  // Main loop with smart polling
  while (true) {
    let syncedBlocks = false;
    try {
      syncedBlocks = await syncHeaders(connection, relayer, START_BLOCK_HEIGHT);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log(`Sync error: ${errorMessage}`);

      // Attempt reorg recovery on any sync failure
      try {
        await detectAndHandleReorg(connection, relayer);
      } catch (reorgErr: unknown) {
        const reorgMsg = reorgErr instanceof Error ? reorgErr.message : String(reorgErr);
        log(`[Reorg] Recovery check failed: ${reorgMsg}`);
      }
    }

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
