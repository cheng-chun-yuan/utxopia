/**
 * Test the permissionless extend_blockchain instruction with batch submission.
 *
 * Tests:
 * 1. Read current light client state
 * 2. Submit a batch of 2 synthetic headers
 * 3. Verify chain advanced
 *
 * Usage:
 *   DEPLOY_ENV=devnet bun run test:reorg
 */

import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  getLightClientState,
  extendBlockchain,
  computeBlockHash,
  bytesToHex,
} from './solana';
import {
  SOLANA_RPC_URL,
  PROGRAM_ID,
  getRelayerKeypair,
  logConfig,
} from './config';

/**
 * Build a synthetic 80-byte Bitcoin block header for testing.
 * NOT valid PoW — only works on testnet/regtest networks that skip PoW checks.
 */
function buildSyntheticHeader(prevBlockHash: Uint8Array, nonce: number = 0): Uint8Array {
  const header = new Uint8Array(80);
  const view = new DataView(header.buffer);

  // version (LE)
  view.setUint32(0, 0x20000000, true);

  // prev_block_hash (32 bytes at offset 4)
  header.set(prevBlockHash, 4);

  // merkle_root (32 bytes at offset 36) — random
  const merkleRoot = new Uint8Array(32);
  for (let i = 0; i < 32; i++) merkleRoot[i] = (nonce + i * 7) & 0xff;
  header.set(merkleRoot, 36);

  // timestamp (offset 68)
  view.setUint32(68, Math.floor(Date.now() / 1000), true);

  // bits (offset 72) — easy target for testnet
  view.setUint32(72, 0x207fffff, true);

  // nonce (offset 76)
  view.setUint32(76, nonce, true);

  return header;
}

async function main() {
  console.log('=== Test Batch Header Submission ===\n');

  const relayer = getRelayerKeypair();
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  logConfig();

  const balance = await connection.getBalance(relayer.publicKey);
  console.log(`  Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`);

  // Step 1: Read current state
  console.log('Step 1: Reading current light client state...');
  const state = await getLightClientState(connection, PROGRAM_ID);
  if (!state) {
    throw new Error('Light client not initialized. Run `bun run init` first.');
  }

  console.log(`  Tip height: ${state.tipHeight}`);
  console.log(`  Tip hash:   ${bytesToHex(state.tipHash).slice(0, 16)}...`);
  console.log(`  Network:    ${state.network}`);
  console.log(`  Headers:    ${state.headerCount}`);

  if (state.network === 0) {
    throw new Error('Cannot use synthetic headers on mainnet (PoW check would fail)');
  }

  // Step 2: Build and submit 2 synthetic headers
  console.log('\nStep 2: Submitting batch of 2 synthetic headers...');

  const parentHash = new Uint8Array(state.tipHash);
  const parentHeight = state.tipHeight;

  const header1 = buildSyntheticHeader(parentHash, 1);
  const hash1 = computeBlockHash(header1);
  console.log(`  Header 1: prev=${bytesToHex(parentHash).slice(0, 16)}..., hash=${bytesToHex(hash1).slice(0, 16)}...`);

  const header2 = buildSyntheticHeader(hash1, 2);
  const hash2 = computeBlockHash(header2);
  console.log(`  Header 2: prev=${bytesToHex(hash1).slice(0, 16)}..., hash=${bytesToHex(hash2).slice(0, 16)}...`);

  const sig = await extendBlockchain(
    connection,
    PROGRAM_ID,
    relayer,
    parentHash,
    [header1, header2],
    parentHeight,
  );
  console.log(`  Transaction: ${sig}`);

  // Step 3: Verify chain advanced
  console.log('\nStep 3: Verifying chain advanced...');
  const newState = await getLightClientState(connection, PROGRAM_ID);
  if (!newState) {
    throw new Error('Could not read updated state');
  }

  console.log(`  New tip height: ${newState.tipHeight} (expected: ${parentHeight + 2n})`);
  console.log(`  New tip hash:   ${bytesToHex(newState.tipHash).slice(0, 16)}...`);
  console.log(`  Headers:        ${newState.headerCount}`);

  if (newState.tipHeight !== parentHeight + 2n) {
    throw new Error(`Tip height mismatch: expected ${parentHeight + 2n}, got ${newState.tipHeight}`);
  }

  const expectedHash = bytesToHex(hash2);
  const actualHash = bytesToHex(newState.tipHash);
  if (actualHash !== expectedHash) {
    throw new Error(`Tip hash mismatch: expected ${expectedHash}, got ${actualHash}`);
  }

  console.log('\nAll tests passed!');
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
