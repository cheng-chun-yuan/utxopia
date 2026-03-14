#!/usr/bin/env node
/**
 * Initialize Aegis program on devnet (fresh deploy)
 *
 * Creates: Token-2022 mint, pool vault ATA, frost vault ATA, pool state PDA, commitment tree PDA
 * Then registers VK hashes.
 *
 * Usage: node scripts/init-devnet.mjs
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import fs from "fs";
import path from "path";

// =============================================================================
// Config
// =============================================================================

const AEGIS_PROGRAM_ID = new PublicKey(
  process.env.AEGIS_PROGRAM_ID || "7JJeVjVCy1fZqCDWvf41R7LuTWirTjX7Tp6suC2WVUMQ"
);
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const RPC_URL = "https://api.devnet.solana.com";

// Load keypair
const keypairPath = process.env.KEYPAIR_PATH || path.join(process.env.HOME, ".config/solana/johnny.json");
const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
const authority = Keypair.fromSecretKey(Uint8Array.from(keypairData));

console.log("Authority:", authority.publicKey.toBase58());
console.log("Program:", AEGIS_PROGRAM_ID.toBase58());

// =============================================================================
// Helpers
// =============================================================================

function pda(seeds, programId) {
  const bufSeeds = seeds.map(s => typeof s === "string" ? Buffer.from(s) : s);
  return PublicKey.findProgramAddressSync(bufSeeds, programId);
}

function ata(mint, owner) {
  const [addr] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_2022.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM
  );
  return addr;
}

async function send(conn, payer, ix) {
  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
  return sig;
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const balance = await conn.getBalance(authority.publicKey);
  console.log("Balance:", balance / 1e9, "SOL");

  // 1. Derive PDAs
  const [poolState, poolBump] = pda(["pool_state"], AEGIS_PROGRAM_ID);
  const [commitTree, treeBump] = pda(["commitment_tree"], AEGIS_PROGRAM_ID);
  console.log("\nPool State PDA:", poolState.toBase58());
  console.log("Commitment Tree PDA:", commitTree.toBase58());

  // Check if already initialized
  const existingPool = await conn.getAccountInfo(poolState);
  if (existingPool && existingPool.data.length > 0 && existingPool.data[0] === 0x01) {
    const mint = new PublicKey(existingPool.data.slice(36, 68));
    console.log("\nPool already initialized!");
    console.log("zkBTC Mint:", mint.toBase58());
    console.log("Pool Vault:", ata(mint, poolState).toBase58());
    return;
  }

  // 2. Create Token-2022 mint
  console.log("\n--- Creating Token-2022 Mint ---");
  const mintKp = Keypair.generate();
  const createMint = SystemProgram.createAccount({
    fromPubkey: authority.publicKey,
    newAccountPubkey: mintKp.publicKey,
    lamports: await conn.getMinimumBalanceForRentExemption(82),
    space: 82,
    programId: TOKEN_2022,
  });

  // InitializeMint2: disc=20, decimals=0, mintAuthority=poolState, freezeAuthority=none
  const initMintData = Buffer.alloc(67);
  initMintData[0] = 20; // InitializeMint2
  initMintData[1] = 0;  // decimals
  initMintData.set(poolState.toBuffer(), 2); // mint authority
  initMintData[34] = 0; // no freeze authority

  const initMint = new TransactionInstruction({
    programId: TOKEN_2022,
    keys: [{ pubkey: mintKp.publicKey, isSigner: false, isWritable: true }],
    data: initMintData,
  });

  const tx1 = new Transaction().add(createMint, initMint);
  tx1.feePayer = authority.publicKey;
  tx1.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  await sendAndConfirmTransaction(conn, tx1, [authority, mintKp], { commitment: "confirmed" });
  console.log("Mint created:", mintKp.publicKey.toBase58());

  // 3. Create ATAs (pool vault + frost vault)
  console.log("\n--- Creating ATAs ---");
  const poolVault = ata(mintKp.publicKey, poolState);
  const frostVault = ata(mintKp.publicKey, authority.publicKey);

  const makeAta = (vault, owner) => new TransactionInstruction({
    programId: ATA_PROGRAM,
    data: Buffer.alloc(0),
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mintKp.publicKey, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
    ],
  });

  const tx2 = new Transaction().add(makeAta(poolVault, poolState), makeAta(frostVault, authority.publicKey));
  tx2.feePayer = authority.publicKey;
  tx2.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  await sendAndConfirmTransaction(conn, tx2, [authority], { commitment: "confirmed" });
  console.log("Pool Vault:", poolVault.toBase58());
  console.log("Frost Vault:", frostVault.toBase58());

  // 4. Initialize Aegis Pool
  console.log("\n--- Initializing Pool ---");
  const initData = Buffer.alloc(3);
  initData[0] = 0; // disc = INITIALIZE
  initData[1] = poolBump;
  initData[2] = treeBump;

  await send(conn, authority, new TransactionInstruction({
    programId: AEGIS_PROGRAM_ID,
    data: initData,
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

  // 5. Summary
  console.log("\n========================================");
  console.log("DEPLOYMENT COMPLETE");
  console.log("========================================");
  console.log("Program ID:      ", AEGIS_PROGRAM_ID.toBase58());
  console.log("zkBTC Mint:      ", mintKp.publicKey.toBase58());
  console.log("Pool State PDA:  ", poolState.toBase58());
  console.log("Commitment Tree: ", commitTree.toBase58());
  console.log("Pool Vault:      ", poolVault.toBase58());
  console.log("Frost Vault:     ", frostVault.toBase58());
  console.log("Authority:       ", authority.publicKey.toBase58());
  console.log("\nUpdate sdk/src/config.ts with:");
  console.log(`  zkbtcMint: "${mintKp.publicKey.toBase58()}",`);
  console.log(`  poolStatePda: "${poolState.toBase58()}",`);
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
