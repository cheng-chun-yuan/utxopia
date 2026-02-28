/**
 * Reset the BTC Light Client to a new block height.
 *
 * Uses the reinitialize instruction (authority-only emergency reset).
 * In the new permissionless architecture, there is no reset_tip — use
 * reinitialize to point to a new genesis block instead.
 *
 * Usage:
 *   DEPLOY_ENV=devnet bun run reset
 *   DEPLOY_ENV=devnet RESET_HEIGHT=75000 bun run reset
 */

import { Connection, Transaction, TransactionInstruction, SystemProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getLightClientState, deriveLightClientPda, deriveBlockHeaderPda, deriveHeightIndexPda, bytesToHex } from './solana';
import { getTipHeight, getBlockHashByHeight } from './mempool';
import {
  SOLANA_RPC_URL,
  PROGRAM_ID,
  BITCOIN_NETWORK,
  getRelayerKeypair,
  getNetworkId,
  logConfig,
} from './config';

const REINITIALIZE_DISC = 4;

function hexToBytesReversed(hex: string): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[31 - i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function main() {
  console.log('=== Reset BTC Light Client (via Reinitialize) ===\n');

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

  const blockHashBytes = hexToBytesReversed(blockHashHex);
  const networkId = getNetworkId();

  // Build reinitialize instruction (disc=4)
  const data = Buffer.alloc(1 + 8 + 32 + 1);
  data.writeUInt8(REINITIALIZE_DISC, 0);
  data.writeBigUInt64LE(BigInt(targetHeight), 1);
  Buffer.from(blockHashBytes).copy(data, 9);
  data.writeUInt8(networkId, 41);

  const [lightClientPda] = deriveLightClientPda(PROGRAM_ID);
  const [heightIndexPda] = deriveHeightIndexPda(PROGRAM_ID, BigInt(targetHeight));
  const [blockHeaderPda] = deriveBlockHeaderPda(PROGRAM_ID, blockHashBytes);

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: lightClientPda, isSigner: false, isWritable: true },
      { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: heightIndexPda, isSigner: false, isWritable: true },
      { pubkey: blockHeaderPda, isSigner: false, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });

  console.log('\nSending reinitialize transaction...');
  const tx = new Transaction().add(ix);
  const signature = await sendAndConfirmTransaction(connection, tx, [relayer]);
  console.log(`\nSuccess! Transaction: ${signature}`);

  // Verify
  const newState = await getLightClientState(connection, PROGRAM_ID);
  if (newState) {
    console.log(`\nNew on-chain state:`);
    console.log(`  Tip height: ${newState.tipHeight}`);
    console.log(`  Tip hash:   ${bytesToHex(newState.tipHash)}`);
  }

  console.log(`\nLight client reinitialized at ${BITCOIN_NETWORK} block ${targetHeight}.`);
  console.log('You can now run the header relayer: bun run start');
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
