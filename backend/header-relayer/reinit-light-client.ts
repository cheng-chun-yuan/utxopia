/**
 * Reinitialize the BTC Light Client to a new network/height.
 *
 * Authority-only: resets all state without closing the PDA.
 * Use this to switch networks (e.g., testnet3 → testnet4) or reset to a new height.
 *
 * Usage:
 *   DEPLOY_ENV=devnet bun run reinit
 */

import { Connection, Transaction, TransactionInstruction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getBlockHashByHeight } from './mempool';
import { deriveLightClientPda, getLightClientState, bytesToHex } from './solana';
import {
  SOLANA_RPC_URL,
  PROGRAM_ID,
  BITCOIN_NETWORK,
  START_BLOCK_HEIGHT,
  getRelayerKeypair,
  getNetworkId,
  logConfig,
} from './config';

const REINITIALIZE_DISC = 6;

function hexToBytesReversed(hex: string): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[31 - i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function main() {
  console.log('=== Reinitialize Bitcoin Light Client ===\n');

  if (START_BLOCK_HEIGHT === null) {
    throw new Error('START_BLOCK_HEIGHT is required');
  }

  const relayer = getRelayerKeypair();
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

  logConfig();
  console.log(`  Authority: ${relayer.publicKey.toBase58()}`);

  const balance = await connection.getBalance(relayer.publicKey);
  console.log(`  Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`);

  // Show current state
  const currentState = await getLightClientState(connection, PROGRAM_ID);
  if (!currentState) {
    throw new Error('Light client not initialized. Use `bun run init` first.');
  }
  console.log('Current state:');
  console.log(`  Tip height: ${currentState.tipHeight}`);
  console.log(`  Tip hash:   ${bytesToHex(currentState.tipHash).slice(0, 16)}...`);
  console.log(`  Network:    ${currentState.network}`);
  console.log(`  Headers:    ${currentState.headerCount}\n`);

  // Fetch block hash for START_BLOCK_HEIGHT
  console.log(`Fetching ${BITCOIN_NETWORK} block hash at height ${START_BLOCK_HEIGHT}...`);
  const blockHashHex = await getBlockHashByHeight(BITCOIN_NETWORK, Number(START_BLOCK_HEIGHT));
  console.log(`Block hash: ${blockHashHex}`);

  const blockHash = hexToBytesReversed(blockHashHex);
  const networkId = getNetworkId();

  // Build reinitialize instruction (disc=6)
  const data = Buffer.alloc(1 + 8 + 32 + 1);
  data.writeUInt8(REINITIALIZE_DISC, 0);
  data.writeBigUInt64LE(START_BLOCK_HEIGHT, 1);
  Buffer.from(blockHash).copy(data, 9);
  data.writeUInt8(networkId, 41);

  const [lightClientPda] = deriveLightClientPda(PROGRAM_ID);

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: lightClientPda, isSigner: false, isWritable: true },
      { pubkey: relayer.publicKey, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });

  console.log('\nSending reinitialize transaction...');
  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [relayer]);
  console.log(`Success! tx: ${sig}`);

  // Verify
  const newState = await getLightClientState(connection, PROGRAM_ID);
  if (newState) {
    console.log('\nNew state:');
    console.log(`  Tip height: ${newState.tipHeight}`);
    console.log(`  Tip hash:   ${bytesToHex(newState.tipHash)}`);
    console.log(`  Network:    ${newState.network} (${['mainnet','testnet','regtest'][newState.network]})`);
    console.log(`  Headers:    ${newState.headerCount}`);
  }

  console.log(`\nLight client reinitialized for ${BITCOIN_NETWORK} at block ${START_BLOCK_HEIGHT}.`);
  console.log('Run the header relayer: bun run start');
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
