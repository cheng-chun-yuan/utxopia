/**
 * Reset the BTC Light Client tip on devnet to a real testnet block.
 *
 * Fetches the current testnet tip (or a specified height) from mempool.space,
 * then calls the reset_tip instruction on the devnet btc-relay program.
 *
 * Usage:
 *   bun run reset
 *   RESET_HEIGHT=2900000 bun run reset
 *
 * Environment (from .env):
 *   SOLANA_RPC_URL   — Solana RPC (default: devnet)
 *   PROGRAM_ID       — btc-relay program ID
 *   RELAYER_KEYPAIR  — JSON array of authority keypair bytes
 *   BITCOIN_NETWORK  — mainnet | testnet | signet
 *   RESET_HEIGHT     — optional: specific block height (default: current tip)
 */

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getLightClientState, resetTip, bytesToHex } from './solana';
import type { BitcoinNetwork } from './mempool';

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || 'DeDut4fkjbWBPY4FRUU3q9BUcvwTisHczj1EQmqX5avS'
);
const BITCOIN_NETWORK = (process.env.BITCOIN_NETWORK || 'testnet') as BitcoinNetwork;

function getRelayerKeypair(): Keypair {
  const keypairJson = process.env.RELAYER_KEYPAIR;
  if (!keypairJson) {
    throw new Error('RELAYER_KEYPAIR environment variable is required');
  }
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(keypairJson)));
}

function hexToBytesReversed(hex: string): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[31 - i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function getMempoolBaseUrl(): string {
  switch (BITCOIN_NETWORK) {
    case 'mainnet': return 'https://mempool.space/api';
    case 'testnet': return 'https://mempool.space/testnet/api';
    case 'signet': return 'https://mempool.space/signet/api';
    default: throw new Error(`Unsupported network for reset: ${BITCOIN_NETWORK}`);
  }
}

async function main() {
  console.log('=== Reset BTC Light Client Tip ===\n');

  const relayer = getRelayerKeypair();
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

  console.log(`Solana RPC: ${SOLANA_RPC_URL}`);
  console.log(`Program ID: ${PROGRAM_ID.toBase58()}`);
  console.log(`Authority: ${relayer.publicKey.toBase58()}`);

  const balance = await connection.getBalance(relayer.publicKey);
  console.log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL\n`);

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
  const baseUrl = getMempoolBaseUrl();
  let targetHeight: number;

  if (process.env.RESET_HEIGHT) {
    targetHeight = parseInt(process.env.RESET_HEIGHT, 10);
  } else {
    console.log(`Fetching current ${BITCOIN_NETWORK} tip height...`);
    const res = await fetch(`${baseUrl}/blocks/tip/height`);
    if (!res.ok) throw new Error(`Failed to get tip height: ${res.status}`);
    targetHeight = parseInt(await res.text(), 10);
  }

  console.log(`Target height: ${targetHeight}`);

  // Fetch real block hash
  console.log(`Fetching block hash for height ${targetHeight}...`);
  const hashRes = await fetch(`${baseUrl}/block-height/${targetHeight}`);
  if (!hashRes.ok) throw new Error(`Failed to get block hash: ${hashRes.status}`);
  const blockHashHex = await hashRes.text();
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
    blockHashBytes
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
