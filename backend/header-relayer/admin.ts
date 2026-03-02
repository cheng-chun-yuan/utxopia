/**
 * Admin CLI for the Bitcoin Light Client on Solana
 *
 * Subcommands:
 *   init           Initialize light client (first time)
 *   reinit         Re-initialize to START_BLOCK_HEIGHT
 *   reset [height] Reset to BTC tip or specific height
 *
 * Usage:
 *   DEPLOY_ENV=devnet bun run admin.ts init
 *   DEPLOY_ENV=devnet bun run admin.ts reinit
 *   DEPLOY_ENV=devnet bun run admin.ts reset
 *   DEPLOY_ENV=devnet bun run admin.ts reset 75000
 */

import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getBlockHashByHeight, getTipHeight } from './mempool';
import {
  initializeLightClient,
  getLightClientState,
  deriveLightClientPda,
  deriveBlockHeaderPda,
  deriveHeightIndexPda,
  buildReinitializeInstruction,
} from './solana';
import {
  SOLANA_RPC_URL,
  PROGRAM_ID,
  BITCOIN_NETWORK,
  START_BLOCK_HEIGHT,
  getRelayerKeypair,
  getNetworkId,
  logConfig,
} from './config';
import { hexToBytesReversed, bytesToHex } from './utils';
import { Transaction, sendAndConfirmTransaction } from '@solana/web3.js';

async function cmdInit(connection: Connection, relayer: ReturnType<typeof getRelayerKeypair>) {
  console.log('=== Initialize Bitcoin Light Client ===\n');

  if (START_BLOCK_HEIGHT === null) {
    throw new Error('START_BLOCK_HEIGHT is required');
  }

  logConfig();
  console.log(`  Payer: ${relayer.publicKey.toBase58()}`);

  const balance = await connection.getBalance(relayer.publicKey);
  console.log(`  Balance: ${balance / LAMPORTS_PER_SOL} SOL\n`);

  if (balance < 0.01 * LAMPORTS_PER_SOL) {
    throw new Error('Insufficient balance. Need at least 0.01 SOL');
  }

  const existingState = await getLightClientState(connection, PROGRAM_ID);
  if (existingState) {
    console.log('Light client already initialized!');
    console.log(`  Tip height: ${existingState.tipHeight}`);
    console.log(`  Tip hash: ${bytesToHex(existingState.tipHash).slice(0, 16)}...`);
    console.log(`  Header count: ${existingState.headerCount}`);
    return;
  }

  console.log(`Fetching block hash for height ${START_BLOCK_HEIGHT}...`);
  const blockHashHex = await getBlockHashByHeight(BITCOIN_NETWORK, Number(START_BLOCK_HEIGHT));
  console.log(`Block hash: ${blockHashHex}`);

  const blockHash = hexToBytesReversed(blockHashHex);
  const networkId = getNetworkId();

  console.log('\nInitializing light client...');
  try {
    const signature = await initializeLightClient(
      connection,
      PROGRAM_ID,
      relayer,
      START_BLOCK_HEIGHT,
      blockHash,
      networkId
    );

    console.log(`\nSuccess! Transaction: ${signature}`);
    console.log(`\nLight client initialized with:`);
    console.log(`  - Start height: ${START_BLOCK_HEIGHT}`);
    console.log(`  - Start hash: ${blockHashHex}`);
    console.log(`  - Network: ${BITCOIN_NETWORK} (${networkId})`);
    console.log(`\nYou can now run the header relayer: bun run start`);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('already in use')) {
      console.log('\nLight client already initialized!');
    } else {
      throw error;
    }
  }
}

async function cmdReinit(connection: Connection, relayer: ReturnType<typeof getRelayerKeypair>) {
  console.log('=== Reinitialize Bitcoin Light Client ===\n');

  if (START_BLOCK_HEIGHT === null) {
    throw new Error('START_BLOCK_HEIGHT is required');
  }

  logConfig();
  console.log(`  Authority: ${relayer.publicKey.toBase58()}`);

  const balance = await connection.getBalance(relayer.publicKey);
  console.log(`  Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`);

  const currentState = await getLightClientState(connection, PROGRAM_ID);
  if (!currentState) {
    throw new Error('Light client not initialized. Use `bun run admin init` first.');
  }
  console.log('Current state:');
  console.log(`  Tip height: ${currentState.tipHeight}`);
  console.log(`  Tip hash:   ${bytesToHex(currentState.tipHash).slice(0, 16)}...`);
  console.log(`  Network:    ${currentState.network}`);
  console.log(`  Headers:    ${currentState.headerCount}\n`);

  console.log(`Fetching ${BITCOIN_NETWORK} block hash at height ${START_BLOCK_HEIGHT}...`);
  const blockHashHex = await getBlockHashByHeight(BITCOIN_NETWORK, Number(START_BLOCK_HEIGHT));
  console.log(`Block hash: ${blockHashHex}`);

  const blockHash = hexToBytesReversed(blockHashHex);
  const networkId = getNetworkId();

  await sendReinitialize(connection, relayer, BigInt(Number(START_BLOCK_HEIGHT)), blockHash, networkId);

  console.log(`\nLight client reinitialized for ${BITCOIN_NETWORK} at block ${START_BLOCK_HEIGHT}.`);
  console.log('Run the header relayer: bun run start');
}

async function cmdReset(connection: Connection, relayer: ReturnType<typeof getRelayerKeypair>, heightArg?: string) {
  console.log('=== Reset BTC Light Client (via Reinitialize) ===\n');

  logConfig();
  console.log(`  Authority: ${relayer.publicKey.toBase58()}`);

  const balance = await connection.getBalance(relayer.publicKey);
  console.log(`  Balance: ${balance / LAMPORTS_PER_SOL} SOL\n`);

  const state = await getLightClientState(connection, PROGRAM_ID);
  if (!state) {
    throw new Error('Light client not initialized. Run `bun run admin init` first.');
  }
  console.log('Current on-chain state:');
  console.log(`  Tip height: ${state.tipHeight}`);
  console.log(`  Tip hash:   ${bytesToHex(state.tipHash)}`);
  console.log(`  Headers:    ${state.headerCount}\n`);

  let targetHeight: number;
  if (heightArg) {
    targetHeight = parseInt(heightArg, 10);
  } else if (process.env.RESET_HEIGHT) {
    targetHeight = parseInt(process.env.RESET_HEIGHT, 10);
  } else {
    console.log(`Fetching current ${BITCOIN_NETWORK} tip height...`);
    targetHeight = await getTipHeight(BITCOIN_NETWORK);
  }

  console.log(`Target height: ${targetHeight}`);

  console.log(`Fetching block hash for height ${targetHeight}...`);
  const blockHashHex = await getBlockHashByHeight(BITCOIN_NETWORK, targetHeight);
  console.log(`Block hash:    ${blockHashHex}`);

  const blockHashBytes = hexToBytesReversed(blockHashHex);
  const networkId = getNetworkId();

  await sendReinitialize(connection, relayer, BigInt(targetHeight), blockHashBytes, networkId);

  console.log(`\nLight client reinitialized at ${BITCOIN_NETWORK} block ${targetHeight}.`);
  console.log('You can now run the header relayer: bun run start');
}

async function sendReinitialize(
  connection: Connection,
  relayer: ReturnType<typeof getRelayerKeypair>,
  height: bigint,
  blockHash: Uint8Array,
  networkId: number
) {
  const [lightClientPda] = deriveLightClientPda(PROGRAM_ID);
  const [heightIndexPda] = deriveHeightIndexPda(PROGRAM_ID, height);
  const [blockHeaderPda] = deriveBlockHeaderPda(PROGRAM_ID, blockHash);

  const ix = buildReinitializeInstruction(
    PROGRAM_ID,
    lightClientPda,
    relayer.publicKey,
    heightIndexPda,
    blockHeaderPda,
    height,
    blockHash,
    networkId
  );

  console.log('\nSending reinitialize transaction...');
  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [relayer]);
  console.log(`Success! tx: ${sig}`);

  const newState = await getLightClientState(connection, PROGRAM_ID);
  if (newState) {
    console.log('\nNew state:');
    console.log(`  Tip height: ${newState.tipHeight}`);
    console.log(`  Tip hash:   ${bytesToHex(newState.tipHash)}`);
    console.log(`  Network:    ${newState.network} (${['mainnet', 'testnet3', 'testnet4', 'regtest'][newState.network]})`);
    console.log(`  Headers:    ${newState.headerCount}`);
  }
}

async function main() {
  const [subcommand, ...args] = process.argv.slice(2);

  if (!subcommand || !['init', 'reinit', 'reset'].includes(subcommand)) {
    console.log('Usage: bun run admin.ts <command> [args]');
    console.log('');
    console.log('Commands:');
    console.log('  init           Initialize light client (first time)');
    console.log('  reinit         Re-initialize to START_BLOCK_HEIGHT');
    console.log('  reset [height] Reset to BTC tip or specific height');
    process.exit(1);
  }

  const relayer = getRelayerKeypair();
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

  switch (subcommand) {
    case 'init':
      await cmdInit(connection, relayer);
      break;
    case 'reinit':
      await cmdReinit(connection, relayer);
      break;
    case 'reset':
      await cmdReset(connection, relayer, args[0]);
      break;
  }
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
