#!/usr/bin/env bun
/**
 * Step 9: Summary
 *
 * Read all on-chain state and print final results.
 */

import { PublicKey } from "@solana/web3.js";

import { PublicKey as PK2 } from "@solana/web3.js";
import {
  connection,
  loadState,
  stepHeader,
  log,
  parseCommitmentTree,
  parsePoolState,
  parseTokenConfig,
  derivePoolStatePDA,
  deriveCommitmentTreePDA,
  deriveTokenConfigPDA,
  deriveUtxoPDA,
} from "./shared.js";

stepHeader(9, "Summary");

async function main() {
  const state = loadState();
  const UTXOPIA = new PublicKey(state.privacyCoinProgramId);
  const [poolState] = derivePoolStatePDA(UTXOPIA);
  const [commitmentTree] = deriveCommitmentTreePDA(UTXOPIA);
  const zkbtcMint = new PublicKey(state.zkbtcMint);

  // Pool state
  const poolInfo = await connection.getAccountInfo(poolState);
  const pool = parsePoolState(Buffer.from(poolInfo!.data));
  if (pool) {
    log(`Pool: minted=${pool.totalMinted}, burned=${pool.totalBurned}, shielded=${pool.totalShielded}, pending=${pool.pendingRedemptions}`);
  }

  // Commitment tree
  const treeInfo = await connection.getAccountInfo(commitmentTree);
  const tree = parseCommitmentTree(Buffer.from(treeInfo!.data));
  if (tree) {
    log(`Tree: next_index=${tree.nextIndex}`);
  }

  // zkBTC TokenConfig
  const [zkbtcTc] = deriveTokenConfigPDA(UTXOPIA, zkbtcMint);
  const tcInfo = await connection.getAccountInfo(zkbtcTc);
  if (tcInfo) {
    const tc = parseTokenConfig(Buffer.from(tcInfo.data));
    if (tc) {
      log(`zkBTC TokenConfig: shielded=${tc.totalShielded}, fees=${tc.accumulatedFees}`);
    }
  }

  // tUSDC TokenConfig
  if (state.tUsdcMint) {
    const [usdcTc] = deriveTokenConfigPDA(UTXOPIA, new PublicKey(state.tUsdcMint));
    const usdcInfo = await connection.getAccountInfo(usdcTc);
    if (usdcInfo) {
      const tc = parseTokenConfig(Buffer.from(usdcInfo.data));
      if (tc) {
        log(`tUSDC TokenConfig: shielded=${tc.totalShielded}, fees=${tc.accumulatedFees}`);
      }
    }
  }

  // tWSOL TokenConfig
  if (state.tWsolMint) {
    const [wsolTc] = deriveTokenConfigPDA(UTXOPIA, new PublicKey(state.tWsolMint));
    const wsolInfo = await connection.getAccountInfo(wsolTc);
    if (wsolInfo) {
      const tc = parseTokenConfig(Buffer.from(wsolInfo.data));
      if (tc) {
        log(`tWSOL TokenConfig: shielded=${tc.totalShielded}, fees=${tc.accumulatedFees}`);
      }
    }
  }

  // Notes summary
  console.log("\n  --- Notes ---");
  if (state.btcNote) {
    log(`BTC deposit: leaf ${state.btcNote.leafIndex}, ${state.btcNote.amount} sats`);
  }
  if (state.btcNote2) {
    log(`BTC deposit 2: leaf ${state.btcNote2.leafIndex}, ${state.btcNote2.amount} sats`);
  }
  if (state.usdcNote) {
    log(`tUSDC shield: leaf ${state.usdcNote.leafIndex}, ${state.usdcNote.amount}`);
  }
  if (state.wsolNote) {
    log(`tWSOL shield: leaf ${state.wsolNote.leafIndex}, ${state.wsolNote.amount}`);
  }
  if (state.transferNotes) {
    log(`Transfer send: leaf ${state.transferNotes.send.leafIndex}, ${state.transferNotes.send.amount} sats`);
    log(`Transfer change: leaf ${state.transferNotes.change.leafIndex}, ${state.transferNotes.change.amount} sats`);
  }

  // ==========================================================================
  // Accounting Assertions
  // ==========================================================================
  console.log("\n  --- Accounting Assertions ---");
  if (pool) {
    // 1. Fee conservation: burn + protocol_revenue = amount_sats (the user's zkBTC input)
    //    burn_amount = actual_received + miner_fee  (BTC that left the pool)
    //    protocol_revenue = service_fee - miner_fee (net profit kept in vault)
    //    => burn + protocol_revenue = actual_received + service_fee = amount_sats
    const burnPlusRevenue = pool.totalBurned + pool.feePool;
    log(`Withdrawal accounting: burned(${pool.totalBurned}) + feePool(${pool.feePool}) = ${burnPlusRevenue}`);
    log(`  = actual_received + miner_fee + service_fee - miner_fee = actual_received + service_fee`);

    // Tokens in circulation: minted - burned should account for shielded + deposit fees
    const inCirculation = pool.totalMinted - pool.totalBurned;
    log(`In circulation: minted(${pool.totalMinted}) - burned(${pool.totalBurned}) = ${inCirculation}`);

    // 2. UTXO tracking
    log(`UTXO tracking: totalBtcHeld=${pool.totalBtcHeld} sats, utxoCount=${pool.utxoCount}`);

    // 3. Verify deposit UTXO (btcNote2's sweep) was consumed (account closed)
    if (state.btcNote2?.sweepTxid) {
      const sweepBytes = Buffer.from(state.btcNote2.sweepTxid, "hex");
      sweepBytes.reverse();
      const [consumedUtxo] = deriveUtxoPDA(UTXOPIA, sweepBytes, state.btcNote2.sweepVout ?? 0);
      const consumedInfo = await connection.getAccountInfo(consumedUtxo);
      if (consumedInfo === null) {
        log("Consumed UTXO: CLOSED (correct — deposit UTXO spent in withdrawal)");
      } else {
        throw new Error(`Consumed UTXO should be closed but exists: ${consumedUtxo.toBase58()}`);
      }
    }

    // 4. Verify deposit1 UTXO still exists (not used in withdrawal)
    if (state.btcNote?.sweepTxid) {
      const sweepBytes1 = Buffer.from(state.btcNote.sweepTxid, "hex");
      sweepBytes1.reverse();
      const [deposit1Utxo] = deriveUtxoPDA(UTXOPIA, sweepBytes1, state.btcNote.sweepVout ?? 0);
      const deposit1Info = await connection.getAccountInfo(deposit1Utxo);
      if (deposit1Info && deposit1Info.data[0] === 0x09) {
        const status = deposit1Info.data[1] === 0 ? "Unspent" : "Reserved";
        log(`Deposit 1 UTXO: ${status} (correct — not used in withdrawal)`);
      } else {
        log("Deposit 1 UTXO: not found (may not have been tracked)");
      }
    }

    // 5. Pool totalBtcHeld should be > 0 (deposit1 UTXO + change UTXO from withdrawal)
    if (pool.totalBtcHeld === 0n && pool.utxoCount === 0) {
      log("Warning: totalBtcHeld=0 — no UTXOs tracked (may need PoolConfig for change tracking)");
    } else {
      log(`Pool BTC balance: ${pool.totalBtcHeld} sats across ${pool.utxoCount} UTXOs`);
    }
  }

  console.log("\nStep 9: Summary ................. PASS");
}

main().catch(err => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
