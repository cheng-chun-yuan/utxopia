#!/usr/bin/env bun
/**
 * Step 9: Summary
 *
 * Read all on-chain state and print final results.
 */

import { PublicKey } from "@solana/web3.js";

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
} from "./shared.js";

stepHeader(9, "Summary");

async function main() {
  const state = loadState();
  const AEGIS = new PublicKey(state.aegisProgramId);
  const [poolState] = derivePoolStatePDA(AEGIS);
  const [commitmentTree] = deriveCommitmentTreePDA(AEGIS);
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
  const [zkbtcTc] = deriveTokenConfigPDA(AEGIS, zkbtcMint);
  const tcInfo = await connection.getAccountInfo(zkbtcTc);
  if (tcInfo) {
    const tc = parseTokenConfig(Buffer.from(tcInfo.data));
    if (tc) {
      log(`zkBTC TokenConfig: shielded=${tc.totalShielded}, fees=${tc.accumulatedFees}`);
    }
  }

  // tUSDC TokenConfig
  if (state.tUsdcMint) {
    const [usdcTc] = deriveTokenConfigPDA(AEGIS, new PublicKey(state.tUsdcMint));
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
    const [wsolTc] = deriveTokenConfigPDA(AEGIS, new PublicKey(state.tWsolMint));
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
  if (state.demoNote) {
    log(`Demo deposit: leaf ${state.demoNote.leafIndex}, ${state.demoNote.amount} sats`);
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

  console.log("\nStep 9: Summary ................. PASS");
}

main().catch(err => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
