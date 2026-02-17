/**
 * Initialize the Bitcoin Light Client on Solana
 *
 * Run once before starting the header relayer.
 *
 * Usage: bun run init
 */

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getBlockHashByHeight, type BitcoinNetwork } from './mempool';
import { initializeLightClient, getLightClientState, hexToBytes, bytesToHex } from './solana';

// Configuration from environment
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || 'S6rgPjCeBhkYBejWyDR1zzU3sYCMob36LAf8tjwj8pn'
);
const BITCOIN_NETWORK = (process.env.BITCOIN_NETWORK || 'testnet') as BitcoinNetwork;
const START_BLOCK_HEIGHT = process.env.START_BLOCK_HEIGHT
  ? BigInt(process.env.START_BLOCK_HEIGHT)
  : null;

// Parse relayer keypair
function getRelayerKeypair(): Keypair {
  const keypairJson = process.env.RELAYER_KEYPAIR;
  if (!keypairJson) {
    throw new Error('RELAYER_KEYPAIR environment variable is required');
  }
  const keypairArray = JSON.parse(keypairJson);
  return Keypair.fromSecretKey(new Uint8Array(keypairArray));
}

// Convert hex to bytes (reversed for Bitcoin internal byte order)
function hexToBytesReversed(hex: string): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[31 - i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function main() {
  console.log('=== Initialize Bitcoin Light Client ===\n');

  if (START_BLOCK_HEIGHT === null) {
    throw new Error('START_BLOCK_HEIGHT environment variable is required');
  }

  const relayer = getRelayerKeypair();
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

  console.log(`Solana RPC: ${SOLANA_RPC_URL}`);
  console.log(`Program ID: ${PROGRAM_ID.toBase58()}`);
  console.log(`Payer: ${relayer.publicKey.toBase58()}`);
  console.log(`Bitcoin Network: ${BITCOIN_NETWORK}`);
  console.log(`Start Block Height: ${START_BLOCK_HEIGHT}`);

  // Check balance
  const balance = await connection.getBalance(relayer.publicKey);
  console.log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL\n`);

  if (balance < 0.01 * LAMPORTS_PER_SOL) {
    throw new Error('Insufficient balance. Need at least 0.01 SOL');
  }

  // Check if already initialized
  const existingState = await getLightClientState(connection, PROGRAM_ID);
  if (existingState) {
    console.log('Light client already initialized!');
    console.log(`  Tip height: ${existingState.tipHeight}`);
    console.log(`  Tip hash: ${bytesToHex(existingState.tipHash).slice(0, 16)}...`);
    console.log(`  Header count: ${existingState.headerCount}`);
    return;
  }

  // Get the block hash for START_BLOCK_HEIGHT
  console.log(`Fetching block hash for height ${START_BLOCK_HEIGHT}...`);
  const blockHashHex = await getBlockHashByHeight(BITCOIN_NETWORK, Number(START_BLOCK_HEIGHT));
  console.log(`Block hash: ${blockHashHex}`);

  // Convert to internal byte order (reversed)
  const blockHash = hexToBytesReversed(blockHashHex);

  // Network ID: 0=mainnet, 1=testnet, 2=signet
  const networkId = BITCOIN_NETWORK === 'mainnet' ? 0 : BITCOIN_NETWORK === 'testnet' ? 1 : 2;

  // Initialize
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

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
