#!/usr/bin/env bun
/**
 * Initialize Aegis program (fresh deploy).
 *
 * Creates: Token-2022 mint, pool vault ATA, frost vault ATA,
 *          pool state PDA, commitment tree PDA.
 * Then calls register-token.ts for each token.
 *
 * Usage: bun run scripts/init-devnet.ts
 *
 * Env vars:
 *   AEGIS_PROGRAM_ID — required (env var or state file)
 *
 * NOTE: deploy-devnet.sh parses stdout for "Mint created:", "Pool State PDA:",
 *       "tUSDC Mint:", etc. Do not change output format without updating it.
 */

import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { INSTRUCTION_DISCRIMINATORS } from "@aegis/sdk";
import { loadKeypair, getStateFilePath, detectNetwork, sendTx, TOKEN_2022, ATA_PROGRAM } from "./lib/common.ts";
import { Connection } from "@solana/web3.js";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

function resolveProgramId(): PublicKey {
  if (process.env.AEGIS_PROGRAM_ID) return new PublicKey(process.env.AEGIS_PROGRAM_ID);
  const f = getStateFilePath();
  if (fs.existsSync(f)) {
    const s = JSON.parse(fs.readFileSync(f, "utf-8"));
    if (s.aegisProgramId) return new PublicKey(s.aegisProgramId);
  }
  throw new Error("AEGIS_PROGRAM_ID required (env var or state file)");
}

function deriveATA(mint: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_2022.toBuffer(), mint.toBuffer()], ATA_PROGRAM,
  )[0];
}

function makeCreateAtaIx(payer: PublicKey, vault: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ATA_PROGRAM, data: Buffer.alloc(0),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
    ],
  });
}

async function main() {
  const rpcUrl = process.env.RPC_URL || (detectNetwork() === "localnet" ? "http://127.0.0.1:8899" : "https://api.devnet.solana.com");
  const conn = new Connection(rpcUrl, "confirmed");
  const authority = loadKeypair();
  const programId = resolveProgramId();

  const [poolState, poolBump] = PublicKey.findProgramAddressSync([Buffer.from("pool_state")], programId);
  const [commitTree, treeBump] = PublicKey.findProgramAddressSync([Buffer.from("commitment_tree")], programId);
  console.log("Authority:", authority.publicKey.toBase58());
  console.log("Program:", programId.toBase58());
  console.log("Pool State PDA:", poolState.toBase58());
  console.log("Commitment Tree PDA:", commitTree.toBase58());

  // Check if already initialized
  const existingPool = await conn.getAccountInfo(poolState);
  if (existingPool?.data?.length && existingPool.data[0] === 0x01) {
    const mint = new PublicKey(existingPool.data.slice(36, 68));
    console.log("\nPool already initialized!");
    console.log("zkBTC Mint:", mint.toBase58());
    console.log("Pool Vault:", deriveATA(mint, poolState).toBase58());
    return;
  }

  // 1. Create Token-2022 mint (0 decimals)
  const mintKp = Keypair.generate();
  const initMintData = Buffer.alloc(67);
  initMintData[0] = 20; initMintData[1] = 0;
  initMintData.set(poolState.toBuffer(), 2); initMintData[34] = 0;

  await sendAndConfirmTransaction(conn,
    new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: authority.publicKey, newAccountPubkey: mintKp.publicKey,
        lamports: await conn.getMinimumBalanceForRentExemption(82), space: 82, programId: TOKEN_2022,
      }),
      new TransactionInstruction({ programId: TOKEN_2022, keys: [{ pubkey: mintKp.publicKey, isSigner: false, isWritable: true }], data: initMintData }),
    ), [authority, mintKp], { commitment: "confirmed" });
  console.log("Mint created:", mintKp.publicKey.toBase58());

  // 2. Create ATAs
  const poolVault = deriveATA(mintKp.publicKey, poolState);
  const frostVault = deriveATA(mintKp.publicKey, authority.publicKey);
  await sendAndConfirmTransaction(conn,
    new Transaction().add(
      makeCreateAtaIx(authority.publicKey, poolVault, poolState, mintKp.publicKey),
      makeCreateAtaIx(authority.publicKey, frostVault, authority.publicKey, mintKp.publicKey),
    ), [authority], { commitment: "confirmed" });
  console.log("Pool Vault:", poolVault.toBase58());
  console.log("Frost Vault:", frostVault.toBase58());

  // 3. Initialize Pool
  const initData = Buffer.alloc(3);
  initData[0] = INSTRUCTION_DISCRIMINATORS.INITIALIZE; initData[1] = poolBump; initData[2] = treeBump;
  await sendTx(conn, authority, new TransactionInstruction({
    programId, data: initData,
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: commitTree, isSigner: false, isWritable: true },
      { pubkey: mintKp.publicKey, isSigner: false, isWritable: false },
      { pubkey: poolVault, isSigner: false, isWritable: false },
      { pubkey: frostVault, isSigner: false, isWritable: false },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  }));
  console.log("Pool initialized!");

  // 4. Register tokens via register-token.ts
  const reg = path.join(SCRIPTS_DIR, "register-token.ts");
  const run = (mint: string, args: string, label: string) => {
    try { execSync(`bun run ${reg} ${mint} ${args}`, { stdio: "inherit", env: { ...process.env } }); }
    catch { console.log(`${label} registration skipped`); }
  };

  run(mintKp.publicKey.toBase58(), "--service-fee 1000 --min-deposit 5000 --max-deposit 10000000000 --deposit-cap 2100000000000000", "zkBTC");
  run("9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP", "--service-fee 0 --min-deposit 10000000 --max-deposit 1000000000000 --deposit-cap 100000000000000", "wSOL");

  // 5. Create test stablecoins
  for (const label of ["tUSDC", "tUSDT"]) {
    const stableMintKp = Keypair.generate();
    const stableInitData = Buffer.alloc(67);
    stableInitData[0] = 20; stableInitData[1] = 6;
    stableInitData.set(authority.publicKey.toBuffer(), 2); stableInitData[34] = 0;

    await sendAndConfirmTransaction(conn,
      new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: authority.publicKey, newAccountPubkey: stableMintKp.publicKey,
          lamports: await conn.getMinimumBalanceForRentExemption(82), space: 82, programId: TOKEN_2022,
        }),
        new TransactionInstruction({ programId: TOKEN_2022, keys: [{ pubkey: stableMintKp.publicKey, isSigner: false, isWritable: true }], data: stableInitData }),
      ), [authority, stableMintKp], { commitment: "confirmed" });
    console.log(`${label} Mint:`, stableMintKp.publicKey.toBase58());
    run(stableMintKp.publicKey.toBase58(), "--service-fee 0 --min-deposit 100000 --max-deposit 1000000000000 --deposit-cap 10000000000000", label);
  }

  console.log("\n=== INITIALIZATION COMPLETE ===");
  console.log("Program:", programId.toBase58());
  console.log("zkBTC Mint:", mintKp.publicKey.toBase58());
}

main().catch(err => { console.error("Error:", err); process.exit(1); });
