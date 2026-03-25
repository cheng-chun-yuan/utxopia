#!/usr/bin/env bun
/**
 * Re-initialize Aegis on devnet with a fresh program.
 * Creates zkBTC mint, pool vault, frost vault, initializes pool,
 * and registers wSOL + USDC + USDT + jupUSD tokens.
 */

import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  createMint, getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

const RPC_URL = "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("AjbX243s2JMFG2uhfTjKkadjPvQEPgcuyV3vfLJv36MT");

// Native wSOL mint (legacy Token program)
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

// New Token-2022 mints with metadata (created earlier)
const NEW_USDC_MINT = new PublicKey("HyzNNEUL3W2dyPGrZJ2XcpoASdQL99Smxz2yyBqJ8yj1");
const NEW_USDT_MINT = new PublicKey("EpvkQMMuqHQH1HajcD74WyabzjNxjJW53xtBpnHUwgQv");
const JUPUSD_MINT = new PublicKey("2Z82qqmoJsb5gtVzpHBYJrsmLPpV83VRG1aCqp2onG7t");

function loadKeypair(keyPath: string): Keypair {
  const absolutePath = keyPath.replace("~", process.env.HOME || "");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(absolutePath, "utf-8"))));
}

function buildInitializeIx(
  poolState: PublicKey, commitmentTree: PublicKey, zkbtcMint: PublicKey,
  poolVault: PublicKey, frostVault: PublicKey, authority: PublicKey,
  poolBump: number, treeBump: number
): TransactionInstruction {
  const data = Buffer.alloc(3);
  data[0] = 0; // INITIALIZE
  data[1] = poolBump;
  data[2] = treeBump;
  return new TransactionInstruction({
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: commitmentTree, isSigner: false, isWritable: true },
      { pubkey: zkbtcMint, isSigner: false, isWritable: false },
      { pubkey: poolVault, isSigner: false, isWritable: false },
      { pubkey: frostVault, isSigner: false, isWritable: false },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

function buildRegisterTokenIx(
  authority: PublicKey, poolState: PublicKey, mint: PublicKey,
  tokenConfig: PublicKey, vault: PublicKey,
  serviceFee: bigint, minDeposit: bigint, maxDeposit: bigint, depositCap: bigint,
): TransactionInstruction {
  const payload = Buffer.alloc(33);
  payload[0] = 8; // REGISTER_TOKEN
  payload.writeBigUInt64LE(serviceFee, 1);
  payload.writeBigUInt64LE(minDeposit, 9);
  payload.writeBigUInt64LE(maxDeposit, 17);
  payload.writeBigUInt64LE(depositCap, 25);
  return new TransactionInstruction({
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: poolState, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: tokenConfig, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data: payload,
  });
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const authority = loadKeypair("~/.config/solana/johnny.json");
  console.log(`Authority: ${authority.publicKey.toBase58()}`);
  console.log(`Program:   ${PROGRAM_ID.toBase58()}`);

  const [poolState, poolBump] = PublicKey.findProgramAddressSync([Buffer.from("pool_state")], PROGRAM_ID);
  const [commitmentTree, treeBump] = PublicKey.findProgramAddressSync([Buffer.from("commitment_tree")], PROGRAM_ID);
  console.log(`Pool State: ${poolState.toBase58()} (bump ${poolBump})`);
  console.log(`Commit Tree: ${commitmentTree.toBase58()} (bump ${treeBump})`);

  // 1. Create zkBTC Token-2022 mint (authority = pool PDA for CPI minting)
  console.log("\n─── Creating zkBTC mint ───");
  const zkbtcMint = await createMint(
    connection, authority, poolState, null, 8,
    Keypair.generate(), undefined, TOKEN_2022_PROGRAM_ID
  );
  console.log(`✓ zkBTC Mint: ${zkbtcMint.toBase58()}`);

  // 2. Create pool vault (owner = pool PDA)
  const poolVaultAccount = await getOrCreateAssociatedTokenAccount(
    connection, authority, zkbtcMint, poolState, true,
    undefined, undefined, TOKEN_2022_PROGRAM_ID
  );
  console.log(`✓ Pool Vault: ${poolVaultAccount.address.toBase58()}`);

  // 3. Create frost vault (owner = authority)
  const frostVaultAccount = await getOrCreateAssociatedTokenAccount(
    connection, authority, zkbtcMint, authority.publicKey, false,
    undefined, undefined, TOKEN_2022_PROGRAM_ID
  );
  console.log(`✓ Frost Vault: ${frostVaultAccount.address.toBase58()}`);

  // 4. Initialize pool
  console.log("\n─── Initializing pool ───");
  const initIx = buildInitializeIx(
    poolState, commitmentTree, zkbtcMint,
    poolVaultAccount.address, frostVaultAccount.address,
    authority.publicKey, poolBump, treeBump
  );
  const initSig = await sendAndConfirmTransaction(
    connection, new Transaction().add(initIx), [authority], { commitment: "confirmed" }
  );
  console.log(`✓ Pool initialized: ${initSig.slice(0, 40)}...`);

  // 5. Register tokens
  console.log("\n─── Registering tokens ───");

  const tokens = [
    {
      name: "wSOL (native)",
      mint: WSOL_MINT,
      tokenProgram: TOKEN_PROGRAM_ID,
      serviceFee: 0n,          // no fee for SOL
      minDeposit: 1_000_000n,  // 0.001 SOL
      maxDeposit: 100_000_000_000n, // 100 SOL
      depositCap: 10_000_000_000_000n, // 10,000 SOL
    },
    {
      name: "USDC",
      mint: NEW_USDC_MINT,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      serviceFee: 0n,
      minDeposit: 100_000n,     // 0.1 USDC
      maxDeposit: 1_000_000_000_000n, // 1M USDC
      depositCap: 100_000_000_000_000n,
    },
    {
      name: "USDT",
      mint: NEW_USDT_MINT,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      serviceFee: 0n,
      minDeposit: 100_000n,
      maxDeposit: 1_000_000_000_000n,
      depositCap: 100_000_000_000_000n,
    },
    {
      name: "jupUSD",
      mint: JUPUSD_MINT,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      serviceFee: 0n,
      minDeposit: 100_000n,
      maxDeposit: 1_000_000_000_000n,
      depositCap: 100_000_000_000_000n,
    },
  ];

  const results: Record<string, { mint: string; vault: string; tokenConfig: string }> = {};

  for (const t of tokens) {
    console.log(`\nRegistering ${t.name} (${t.mint.toBase58().slice(0, 8)}...):`);

    // Create vault for this token (owner = pool PDA)
    const vault = await getOrCreateAssociatedTokenAccount(
      connection, authority, t.mint, poolState, true,
      undefined, undefined, t.tokenProgram
    );
    console.log(`  Vault: ${vault.address.toBase58()}`);

    // Derive token config PDA
    const [tokenConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_config"), t.mint.toBuffer()], PROGRAM_ID
    );

    // Register
    const regIx = buildRegisterTokenIx(
      authority.publicKey, poolState, t.mint, tokenConfig, vault.address,
      t.serviceFee, t.minDeposit, t.maxDeposit, t.depositCap
    );
    const regSig = await sendAndConfirmTransaction(
      connection, new Transaction().add(regIx), [authority], { commitment: "confirmed" }
    );
    console.log(`  ✓ Registered: ${regSig.slice(0, 30)}...`);

    results[t.name] = {
      mint: t.mint.toBase58(),
      vault: vault.address.toBase58(),
      tokenConfig: tokenConfig.toBase58(),
    };
  }

  // Save devnet state
  const state = {
    aegisProgramId: PROGRAM_ID.toBase58(),
    btcLightClientId: "859B7kw1xDyY8rzSXY6pAPNxaAsPWrsaAPJk3iivd43g",
    zkbtcMint: zkbtcMint.toBase58(),
    poolState: poolState.toBase58(),
    commitmentTree: commitmentTree.toBase58(),
    poolVault: poolVaultAccount.address.toBase58(),
    frostVault: frostVaultAccount.address.toBase58(),
    poolAuthority: authority.publicKey.toBase58(),
    // Token mints
    wsolMint: WSOL_MINT.toBase58(),
    tUsdcMint: NEW_USDC_MINT.toBase58(),
    tUsdtMint: NEW_USDT_MINT.toBase58(),
    jupUsdMint: JUPUSD_MINT.toBase58(),
    // Token vaults
    wsolVault: results["wSOL (native)"]?.vault,
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
  console.log(`  Program:       ${PROGRAM_ID.toBase58()}`);
  console.log(`  Pool State:    ${poolState.toBase58()}`);
  console.log(`  zkBTC Mint:    ${zkbtcMint.toBase58()}`);
  console.log(`  wSOL Vault:    ${results["wSOL (native)"]?.vault}`);
  console.log();
  console.log(`  NEXT_PUBLIC_AEGIS_PROGRAM_ID=${PROGRAM_ID.toBase58()}`);
  console.log(`  NEXT_PUBLIC_ZKBTC_MINT=${zkbtcMint.toBase58()}`);
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  if (err.logs) err.logs.forEach((l: string) => console.error("  ", l));
  process.exit(1);
});
