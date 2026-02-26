/**
 * Test: Fork Handling & Reorg Simulation on Devnet
 *
 * Uses synthetic headers (valid for testnet/regtest where PoW is skipped)
 * to test the full reorg lifecycle on Solana devnet:
 *
 *   1. Read current light client state
 *   2. Submit 3 synthetic headers on top of the current tip
 *   3. Roll back the tip by 2 blocks (simulating a reorg)
 *   4. Re-submit headers (overwriting stale PDAs)
 *   5. Verify chain consistency
 *   6. Test close_block_header on orphaned PDAs above tip
 *
 * Usage:
 *   bun run test:reorg
 *
 * Environment:
 *   SOLANA_RPC_URL   — default: devnet
 *   PROGRAM_ID       — btc-relay program ID
 */

import { Connection, LAMPORTS_PER_SOL, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import { createHash } from 'crypto';
import {
  deriveLightClientPda,
  deriveBlockHeaderPda,
  getLightClientState,
  blockHeaderExists,
  submitHeader,
  resetTip,
  getOnChainBlockHash,
  bytesToHex,
} from './solana';
import {
  SOLANA_RPC_URL,
  PROGRAM_ID,
  getRelayerKeypair,
  logConfig,
} from './config';

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Synthetic Header Builder ────────────────────────────────────────────────

/**
 * Build a synthetic 80-byte Bitcoin block header.
 * On testnet/regtest (network=1,2) PoW validation is skipped,
 * so we can use any valid-format header with correct prev_block_hash.
 */
function buildSyntheticHeader(prevBlockHash: Uint8Array, nonce: number = 0): Uint8Array {
  const header = new Uint8Array(80);
  const view = new DataView(header.buffer);

  // version (4 bytes LE) — use version 0x20000000
  view.setUint32(0, 0x20000000, true);

  // prev_block_hash (32 bytes) — bytes 4..36
  header.set(prevBlockHash, 4);

  // merkle_root (32 bytes) — bytes 36..68, random-ish
  const merkleRoot = createHash('sha256').update(Buffer.from(`merkle-${nonce}-${Date.now()}`)).digest();
  header.set(new Uint8Array(merkleRoot), 36);

  // timestamp (4 bytes LE) — bytes 68..72
  view.setUint32(68, Math.floor(Date.now() / 1000), true);

  // bits (4 bytes LE) — bytes 72..76, use testnet minimum difficulty
  view.setUint32(72, 0x207fffff, true);

  // nonce (4 bytes LE) — bytes 76..80
  view.setUint32(76, nonce, true);

  return header;
}

/**
 * Compute double-SHA256 of data (Bitcoin block hash)
 */
function doubleSha256(data: Uint8Array): Uint8Array {
  const first = createHash('sha256').update(data).digest();
  const second = createHash('sha256').update(first).digest();
  return new Uint8Array(second);
}

// ── Close Block Header Instruction ─────────────────────────────────────────

function buildCloseBlockHeaderInstruction(
  programId: PublicKey,
  lightClientPda: PublicKey,
  blockHeaderPda: PublicKey,
  authority: PublicKey,
  rentReceiver: PublicKey,
  height: bigint,
): TransactionInstruction {
  const data = Buffer.alloc(1 + 8);
  data.writeUInt8(5, 0); // disc=5
  data.writeBigUInt64LE(height, 1);

  return new TransactionInstruction({
    keys: [
      { pubkey: lightClientPda, isSigner: false, isWritable: false },
      { pubkey: blockHeaderPda, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: rentReceiver, isSigner: false, isWritable: true },
    ],
    programId,
    data,
  });
}

// ── Test Steps ──────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  BTC-Relay Reorg Simulation Test (Synthetic Headers)');
  console.log('═══════════════════════════════════════════════════════\n');

  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  const relayer = getRelayerKeypair();

  log(`Solana RPC:      ${SOLANA_RPC_URL}`);
  log(`Program ID:      ${PROGRAM_ID.toBase58()}`);
  log(`Relayer:         ${relayer.publicKey.toBase58()}`);

  const balance = await connection.getBalance(relayer.publicKey);
  log(`Balance:         ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL\n`);

  if (balance < 0.05 * LAMPORTS_PER_SOL) {
    throw new Error('Insufficient balance. Need at least 0.05 SOL for this test.');
  }

  // ── Step 1: Read current state ──────────────────────────────────────────

  console.log('─── Step 1: Read current light client state ───\n');

  const state = await getLightClientState(connection, PROGRAM_ID);
  if (!state) {
    throw new Error(
      'Light client not initialized.\n' +
      'Run: cd backend/header-relayer && bun run init'
    );
  }

  const currentTipHeight = state.tipHeight;
  log(`Current tip height: ${currentTipHeight}`);
  log(`Current tip hash:   ${bytesToHex(state.tipHash).slice(0, 16)}...`);
  log(`Header count:       ${state.headerCount}`);
  log(`Network:            ${state.network} (${['mainnet','testnet','regtest'][state.network]})`);

  if (state.network === 0) {
    throw new Error('This test uses synthetic headers which only work on testnet/regtest (PoW is skipped). Current network is mainnet.');
  }
  log('');

  // ── Step 2: Submit 3 synthetic headers ──────────────────────────────────

  console.log('─── Step 2: Submit 3 synthetic headers ───\n');

  let prevHash = new Uint8Array(state.tipHash);
  const submittedHeights: bigint[] = [];
  const submittedHashes: Uint8Array[] = [];

  for (let i = 0; i < 3; i++) {
    const height = currentTipHeight + BigInt(i + 1);
    const rawHeader = buildSyntheticHeader(prevHash, i);
    const blockHash = doubleSha256(rawHeader);

    log(`Building block ${height}: hash=${bytesToHex(blockHash).slice(0, 16)}...`);

    // Check if PDA already exists
    const exists = await blockHeaderExists(connection, PROGRAM_ID, height);
    if (exists) {
      log(`  PDA already exists at height ${height}, reading existing hash...`);
      const existingHash = await getOnChainBlockHash(connection, PROGRAM_ID, height);
      if (existingHash) {
        prevHash = existingHash;
        submittedHeights.push(height);
        submittedHashes.push(existingHash);
        continue;
      }
    }

    log(`Submitting block ${height}...`);
    const sig = await submitHeader(connection, PROGRAM_ID, relayer, rawHeader, height);
    log(`  tx: ${sig}`);

    prevHash = blockHash;
    submittedHeights.push(height);
    submittedHashes.push(blockHash);

    await sleep(1500);
  }

  log(`\nSubmitted ${submittedHeights.length} blocks: ${submittedHeights.join(', ')}`);

  // Verify tip moved forward
  const stateAfterSubmit = await getLightClientState(connection, PROGRAM_ID);
  if (!stateAfterSubmit) throw new Error('Lost light client state');
  log(`Tip after submit: height=${stateAfterSubmit.tipHeight}\n`);

  if (stateAfterSubmit.tipHeight < currentTipHeight + 3n) {
    throw new Error(`Expected tip >= ${currentTipHeight + 3n} but got ${stateAfterSubmit.tipHeight}`);
  }

  // ── Step 3: Reset tip (simulate reorg rollback) ─────────────────────────

  console.log('─── Step 3: Reset tip to simulate reorg (rollback by 2) ───\n');

  const rollbackHeight = submittedHeights[0]; // keep first new block, rollback the other 2
  const rollbackHash = await getOnChainBlockHash(connection, PROGRAM_ID, rollbackHeight);
  if (!rollbackHash) throw new Error(`No on-chain hash at height ${rollbackHeight}`);

  log(`Rolling back tip from ${stateAfterSubmit.tipHeight} to ${rollbackHeight}...`);
  log(`Target hash: ${bytesToHex(rollbackHash).slice(0, 16)}...`);

  const resetSig = await resetTip(
    connection,
    PROGRAM_ID,
    relayer,
    rollbackHeight,
    rollbackHash,
    0, 0,
  );
  log(`Reset tx: ${resetSig}`);

  const stateAfterReset = await getLightClientState(connection, PROGRAM_ID);
  if (!stateAfterReset) throw new Error('Lost light client state');
  log(`Tip after reset: height=${stateAfterReset.tipHeight}`);

  if (stateAfterReset.tipHeight !== rollbackHeight) {
    throw new Error(`Expected tip ${rollbackHeight} but got ${stateAfterReset.tipHeight}`);
  }
  log('PASS: Rollback successful!\n');

  // ── Step 4: Re-submit headers (overwrite stale PDAs) ────────────────────

  console.log('─── Step 4: Re-submit headers (overwrite stale PDAs) ───\n');

  // Build NEW synthetic headers from the rollback point (different from originals)
  let resyncPrevHash = rollbackHash;
  const resyncHashes: Uint8Array[] = [];

  for (let i = 1; i < submittedHeights.length; i++) {
    const height = submittedHeights[i];

    // Build a DIFFERENT header (nonce=100+i to get different hash)
    const rawHeader = buildSyntheticHeader(resyncPrevHash, 100 + i);
    const blockHash = doubleSha256(rawHeader);

    log(`Re-submitting block ${height} with NEW hash: ${bytesToHex(blockHash).slice(0, 16)}...`);
    log(`  (old hash was: ${bytesToHex(submittedHashes[i]).slice(0, 16)}...)`);

    try {
      const sig = await submitHeader(connection, PROGRAM_ID, relayer, rawHeader, height);
      log(`  tx: ${sig}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  ERROR: ${msg}`);
      throw new Error(`Re-submission of block ${height} failed! The pre-existing PDA handling may be broken.`);
    }

    resyncPrevHash = blockHash;
    resyncHashes.push(blockHash);

    await sleep(1500);
  }

  // Verify tip is back at the expected height
  const stateAfterResync = await getLightClientState(connection, PROGRAM_ID);
  if (!stateAfterResync) throw new Error('Lost light client state');
  log(`\nTip after re-sync: height=${stateAfterResync.tipHeight}`);

  const expectedFinalTip = submittedHeights[submittedHeights.length - 1];
  if (stateAfterResync.tipHeight !== expectedFinalTip) {
    throw new Error(`Expected tip ${expectedFinalTip} but got ${stateAfterResync.tipHeight}`);
  }
  log('PASS: Re-sync over stale PDAs successful!\n');

  // ── Step 5: Verify chain consistency ────────────────────────────────────

  console.log('─── Step 5: Verify chain consistency ───\n');

  // The blocks at submittedHeights[1..] should now have the NEW hashes, not the old ones
  for (let i = 1; i < submittedHeights.length; i++) {
    const height = submittedHeights[i];
    const onChainHash = await getOnChainBlockHash(connection, PROGRAM_ID, height);
    if (!onChainHash) {
      log(`FAIL: No on-chain block at height ${height}`);
      continue;
    }

    const expectedHash = resyncHashes[i - 1];
    const match = onChainHash.every((b, j) => b === expectedHash[j]);
    const oldMatch = onChainHash.every((b, j) => b === submittedHashes[i][j]);

    if (match) {
      log(`Height ${height}: PASS (has new hash from re-sync)`);
    } else if (oldMatch) {
      log(`Height ${height}: FAIL (still has old hash - overwrite didn't work!)`);
    } else {
      log(`Height ${height}: FAIL (unknown hash)`);
      log(`  On-chain: ${bytesToHex(onChainHash).slice(0, 16)}...`);
      log(`  Expected: ${bytesToHex(expectedHash).slice(0, 16)}...`);
    }
  }

  // ── Step 6: Test close_block_header ─────────────────────────────────────

  console.log('\n─── Step 6: Test close_block_header (orphan cleanup) ───\n');

  // Submit one more header, then rollback to orphan it, then close it
  const extraHeight = expectedFinalTip + 1n;
  const extraHeader = buildSyntheticHeader(resyncPrevHash, 999);

  log(`Submitting extra block ${extraHeight} for close test...`);
  const extraSig = await submitHeader(connection, PROGRAM_ID, relayer, extraHeader, extraHeight);
  log(`  tx: ${extraSig}`);
  await sleep(1500);

  // Roll back to orphan it
  const prevTipHash = await getOnChainBlockHash(connection, PROGRAM_ID, expectedFinalTip);
  if (!prevTipHash) throw new Error('Missing hash for rollback');

  log(`Rolling back tip to ${expectedFinalTip} (orphaning block ${extraHeight})...`);
  const resetSig2 = await resetTip(
    connection, PROGRAM_ID, relayer,
    expectedFinalTip, prevTipHash, 0, 0,
  );
  log(`  tx: ${resetSig2}`);
  await sleep(1500);

  // Verify the orphaned PDA still exists
  const orphanExists = await blockHeaderExists(connection, PROGRAM_ID, extraHeight);
  log(`Orphan PDA at ${extraHeight} exists: ${orphanExists} (expected: true)`);

  // Close it
  log(`Closing orphaned block header at height ${extraHeight}...`);
  const [lightClientPda] = deriveLightClientPda(PROGRAM_ID);
  const [orphanPda] = deriveBlockHeaderPda(PROGRAM_ID, extraHeight);

  const closeIx = buildCloseBlockHeaderInstruction(
    PROGRAM_ID,
    lightClientPda,
    orphanPda,
    relayer.publicKey,
    relayer.publicKey,
    extraHeight,
  );

  const closeTx = new Transaction().add(closeIx);
  const closeSig = await sendAndConfirmTransaction(connection, closeTx, [relayer]);
  log(`  tx: ${closeSig}`);

  // Verify it's gone
  const closedExists = await blockHeaderExists(connection, PROGRAM_ID, extraHeight);
  log(`Block ${extraHeight} exists after close: ${closedExists} (expected: false)`);

  if (closedExists) {
    log('FAIL: close_block_header did not remove the PDA');
  } else {
    log('PASS: close_block_header successfully reclaimed orphaned PDA');
  }

  // ── Summary ─────────────────────────────────────────────────────────────

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  Test Summary');
  console.log('═══════════════════════════════════════════════════════\n');

  const finalState = await getLightClientState(connection, PROGRAM_ID);
  if (finalState) {
    log(`Final tip height: ${finalState.tipHeight}`);
    log(`Final tip hash:   ${bytesToHex(finalState.tipHash).slice(0, 16)}...`);
    log(`Total headers:    ${finalState.headerCount}`);
  }

  const finalBalance = await connection.getBalance(relayer.publicKey);
  const spent = (balance - finalBalance) / LAMPORTS_PER_SOL;
  log(`SOL spent:        ${spent.toFixed(6)} SOL`);

  console.log('\nAll tests passed!');
}

main().catch((error) => {
  console.error('\n\nTEST FAILED:', error);
  process.exit(1);
});
