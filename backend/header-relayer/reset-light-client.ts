/**
 * Reset the BTC Light Client tip to a real Bitcoin block.
 *
 * Fetches the current tip (or a specified height) from mempool.space,
 * then calls the reset_tip instruction.
 *
 * Usage:
 *   DEPLOY_ENV=devnet bun run reset
 *   DEPLOY_ENV=devnet RESET_HEIGHT=75000 bun run reset
 */

import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getLightClientState, resetTip, bytesToHex } from './solana';
import { getTipHeight, getBlockHashByHeight } from './mempool';
import {
  SOLANA_RPC_URL,
  PROGRAM_ID,
  BITCOIN_NETWORK,
  getRelayerKeypair,
  logConfig,
} from './config';

function hexToBytesReversed(hex: string): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[31 - i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function main() {
  console.log('=== Reset BTC Light Client Tip ===\n');

  const relayer = getRelayerKeypair();
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

  logConfig();
  console.log(`  Authority: ${relayer.publicKey.toBase58()}`);

  const balance = await connection.getBalance(relayer.publicKey);
  console.log(`  Balance: ${balance / LAMPORTS_PER_SOL} SOL\n`);

  // Show current on-chain state
  const state = await getLightClientState(connection, PROGRAM_ID);
  if (!state) {
    throw new Error('Light client not initialized. Run `bun run init` first.');
  }
  console.log('Current on-chain state:');
  console.log(`  Tip height: ${state.tipHeight}`);
  console.log(`  Tip hash:   ${bytesToHex(state.tipHash)}`);
  console.log(`  Headers:    ${state.headerCount}\n`);

  // Determine target height
  let targetHeight: number;

  if (process.env.RESET_HEIGHT) {
    targetHeight = parseInt(process.env.RESET_HEIGHT, 10);
  } else {
    console.log(`Fetching current ${BITCOIN_NETWORK} tip height...`);
    targetHeight = await getTipHeight(BITCOIN_NETWORK);
  }

  console.log(`Target height: ${targetHeight}`);

  // Fetch real block hash
  console.log(`Fetching block hash for height ${targetHeight}...`);
  const blockHashHex = await getBlockHashByHeight(BITCOIN_NETWORK, targetHeight);
  console.log(`Block hash:    ${blockHashHex}`);

  // Convert to internal byte order (reversed for Bitcoin)
  const blockHashBytes = hexToBytesReversed(blockHashHex);
  console.log(`Internal LE:   ${bytesToHex(blockHashBytes).slice(0, 16)}...\n`);

  // Send reset_tip transaction
  console.log('Sending reset_tip transaction...');
  const signature = await resetTip(
    connection,
    PROGRAM_ID,
    relayer,
    BigInt(targetHeight),
    blockHashBytes,
    0, 0,
  );

  console.log(`\nSuccess! Transaction: ${signature}`);

  // Verify
  const newState = await getLightClientState(connection, PROGRAM_ID);
  if (newState) {
    console.log(`\nNew on-chain state:`);
    console.log(`  Tip height: ${newState.tipHeight}`);
    console.log(`  Tip hash:   ${bytesToHex(newState.tipHash)}`);
  }

  console.log(`\nLight client tip reset to ${BITCOIN_NETWORK} block ${targetHeight}.`);
  console.log('You can now run the header relayer: bun run start');
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
