#!/usr/bin/env bun
/**
 * Re-initialize Aegis on devnet with a fresh program.
 * Creates zkBTC mint, pool vault, frost vault, initializes pool,
 * and registers wSOL + USDC + USDT + jupUSD tokens.
 */

import {
  PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  createMint, getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { INSTRUCTION_DISCRIMINATORS } from "@aegis/sdk";
import * as fs from "fs";
import * as path from "path";
import { setupScript, sendTx, type ScriptState } from "./lib/common.ts";

const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

async function main() {
  const { conn, authority, programId, poolState, poolBump, state: existingState } = setupScript("devnet");
  const [commitmentTree, treeBump] = PublicKey.findProgramAddressSync([Buffer.from("commitment_tree")], programId);

  console.log(`Authority: ${authority.publicKey.toBase58()}`);
  console.log(`Program:   ${programId.toBase58()}`);
  console.log(`Pool State: ${poolState.toBase58()} (bump ${poolBump})`);
  console.log(`Commit Tree: ${commitmentTree.toBase58()} (bump ${treeBump})`);

  // 1. Create zkBTC Token-2022 mint
  console.log("\n─── Creating zkBTC mint ───");
  const zkbtcMint = await createMint(
    conn, authority, poolState, null, 8,
    undefined, undefined, TOKEN_2022_PROGRAM_ID
  );
  console.log(`✓ zkBTC Mint: ${zkbtcMint.toBase58()}`);

  const poolVaultAccount = await getOrCreateAssociatedTokenAccount(
    conn, authority, zkbtcMint, poolState, true, undefined, undefined, TOKEN_2022_PROGRAM_ID
  );
  const frostVaultAccount = await getOrCreateAssociatedTokenAccount(
    conn, authority, zkbtcMint, authority.publicKey, false, undefined, undefined, TOKEN_2022_PROGRAM_ID
  );
  console.log(`✓ Pool Vault: ${poolVaultAccount.address.toBase58()}`);
  console.log(`✓ Frost Vault: ${frostVaultAccount.address.toBase58()}`);

  // 2. Initialize pool
  console.log("\n─── Initializing pool ───");
  const initData = Buffer.alloc(3);
  initData[0] = INSTRUCTION_DISCRIMINATORS.INITIALIZE;
  initData[1] = poolBump;
  initData[2] = treeBump;
  await sendTx(conn, authority, new TransactionInstruction({
    programId, data: initData,
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: commitmentTree, isSigner: false, isWritable: true },
      { pubkey: zkbtcMint, isSigner: false, isWritable: false },
      { pubkey: poolVaultAccount.address, isSigner: false, isWritable: false },
      { pubkey: frostVaultAccount.address, isSigner: false, isWritable: false },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  }));
  console.log("✓ Pool initialized");

  // 3. Register tokens
  console.log("\n─── Registering tokens ───");
  const tokens = [
    { name: "wSOL", mint: WSOL_MINT, tokenProgram: TOKEN_PROGRAM_ID,
      serviceFee: 0n, minDeposit: 1_000_000n, maxDeposit: 100_000_000_000n, depositCap: 10_000_000_000_000n },
    { name: "USDC", mint: new PublicKey(existingState.tUsdcMint!), tokenProgram: TOKEN_2022_PROGRAM_ID,
      serviceFee: 0n, minDeposit: 100_000n, maxDeposit: 1_000_000_000_000n, depositCap: 100_000_000_000_000n },
    { name: "USDT", mint: new PublicKey(existingState.tUsdtMint!), tokenProgram: TOKEN_2022_PROGRAM_ID,
      serviceFee: 0n, minDeposit: 100_000n, maxDeposit: 1_000_000_000_000n, depositCap: 100_000_000_000_000n },
    { name: "jupUSD", mint: new PublicKey(existingState.jupUsdMint!), tokenProgram: TOKEN_2022_PROGRAM_ID,
      serviceFee: 0n, minDeposit: 100_000n, maxDeposit: 1_000_000_000_000n, depositCap: 100_000_000_000_000n },
  ];

  const results: Record<string, { mint: string; vault: string }> = {};

  for (const t of tokens) {
    console.log(`\nRegistering ${t.name} (${t.mint.toBase58().slice(0, 8)}...):`);
    const vault = await getOrCreateAssociatedTokenAccount(
      conn, authority, t.mint, poolState, true, undefined, undefined, t.tokenProgram
    );
    const [tokenConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_config"), t.mint.toBuffer()], programId
    );

    const payload = Buffer.alloc(33);
    payload[0] = INSTRUCTION_DISCRIMINATORS.REGISTER_TOKEN;
    payload.writeBigUInt64LE(t.serviceFee, 1);
    payload.writeBigUInt64LE(t.minDeposit, 9);
    payload.writeBigUInt64LE(t.maxDeposit, 17);
    payload.writeBigUInt64LE(t.depositCap, 25);

    await sendTx(conn, authority, new TransactionInstruction({
      programId, data: payload,
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: poolState, isSigner: false, isWritable: false },
        { pubkey: t.mint, isSigner: false, isWritable: false },
        { pubkey: tokenConfig, isSigner: false, isWritable: true },
        { pubkey: vault.address, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    }));
    console.log(`  ✓ Registered`);
    results[t.name] = { mint: t.mint.toBase58(), vault: vault.address.toBase58() };
  }

  // 4. Save state
  const state: ScriptState = {
    aegisProgramId: programId.toBase58(),
    btcLightClientId: existingState.btcLightClientId,
    zkbtcMint: zkbtcMint.toBase58(),
    poolState: poolState.toBase58(),
    commitmentTree: commitmentTree.toBase58(),
    poolVault: poolVaultAccount.address.toBase58(),
    frostVault: frostVaultAccount.address.toBase58(),
    authority: authority.publicKey.toBase58(),
    wsolMint: WSOL_MINT.toBase58(),
    tUsdcMint: existingState.tUsdcMint,
    tUsdtMint: existingState.tUsdtMint,
    jupUsdMint: existingState.jupUsdMint,
    wsolVault: results["wSOL"]?.vault,
    tUsdcVault: results["USDC"]?.vault,
    tUsdtVault: results["USDT"]?.vault,
    jupUsdVault: results["jupUSD"]?.vault,
    createdAt: new Date().toISOString(),
    signingMode: "frost",
  };

  fs.writeFileSync(
    path.join(import.meta.dir, "devnet-state.json"),
    JSON.stringify(state, null, 2) + "\n"
  );

  console.log("\n" + "=".repeat(60));
  console.log("DEPLOYMENT COMPLETE");
  console.log("=".repeat(60));
  console.log(`  Program:    ${programId.toBase58()}`);
  console.log(`  Pool State: ${poolState.toBase58()}`);
  console.log(`  zkBTC Mint: ${zkbtcMint.toBase58()}`);
}

main().catch(err => {
  console.error("Error:", err.message || err);
  if (err.logs) err.logs.forEach((l: string) => console.error("  ", l));
  process.exit(1);
});
