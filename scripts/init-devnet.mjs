#!/usr/bin/env node
/**
 * Initialize Aegis program on devnet (fresh deploy)
 *
 * Creates: Token-2022 mint, pool vault ATA, frost vault ATA, pool state PDA, commitment tree PDA.
 * Registers tokens: zkBTC, wSOL (NATIVE_MINT_2022), tUSDC, tUSDT.
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
  process.env.AEGIS_PROGRAM_ID || "8fqRet9WB5PECvKfWmzTPSusJgQz1onzxTLfHD75XKim"
);
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const RPC_URL = process.env.RPC_URL || "http://localhost:8899";

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

  // Check if already initialized (force fresh fetch, no preflight cache)
  const existingPool = await conn.getAccountInfo(poolState, { commitment: "processed" });
  if (existingPool && existingPool.data && existingPool.data.length > 0 && existingPool.data[0] === 0x01) {
    const mint = new PublicKey(existingPool.data.slice(36, 68));
    console.log("\nPool already initialized!");
    console.log("zkBTC Mint:", mint.toBase58());
    console.log("Pool Vault:", ata(mint, poolState).toBase58());
    return;
  }

  // 2. Create Token-2022 mint (plain, no metadata extension for localnet simplicity)
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

  // 5. Register zkBTC as a token in the multi-token registry
  console.log("\n--- Registering zkBTC Token ---");
  {
    // Derive TokenConfig PDA: seeds = ["token_config", mint_pubkey]
    const [tokenConfigPda, tcBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_config"), mintKp.publicKey.toBuffer()],
      AEGIS_PROGRAM_ID,
    );

    // register_token instruction data: service_fee(8) + min_deposit(8) + max_deposit(8) + deposit_cap(8) = 32 bytes
    const regData = Buffer.alloc(1 + 32);
    regData[0] = 28; // disc = REGISTER_TOKEN
    // service_fee = 1000 sats (flat fee for BTC operations)
    regData.writeBigUInt64LE(1000n, 1);
    // min_deposit = 5000 sats
    regData.writeBigUInt64LE(5000n, 9);
    // max_deposit = 100 BTC in sats
    regData.writeBigUInt64LE(10_000_000_000n, 17);
    // deposit_cap = 21M BTC in sats
    regData.writeBigUInt64LE(2_100_000_000_000_000n, 25);

    await send(conn, authority, new TransactionInstruction({
      programId: AEGIS_PROGRAM_ID,
      data: regData,
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: poolState, isSigner: false, isWritable: false },
        { pubkey: mintKp.publicKey, isSigner: false, isWritable: false },
        { pubkey: tokenConfigPda, isSigner: false, isWritable: true },
        { pubkey: poolVault, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    }));
    console.log("TokenConfig PDA:", tokenConfigPda.toBase58());
  }

  // 6. Register wSOL (NATIVE_MINT_2022) as a token for SOL shielding
  console.log("\n--- Registering wSOL Token ---");
  {
    const NATIVE_MINT_2022 = new PublicKey("9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP");

    // Create wSOL vault ATA (Token-2022 native mint, owned by pool state PDA)
    const wsolVault = ata(NATIVE_MINT_2022, poolState);
    const createWsolVault = new TransactionInstruction({
      programId: ATA_PROGRAM,
      data: Buffer.alloc(0),
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: wsolVault, isSigner: false, isWritable: true },
        { pubkey: poolState, isSigner: false, isWritable: false },
        { pubkey: NATIVE_MINT_2022, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
      ],
    });

    const txWsolAta = new Transaction().add(createWsolVault);
    txWsolAta.feePayer = authority.publicKey;
    txWsolAta.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    await sendAndConfirmTransaction(conn, txWsolAta, [authority], { commitment: "confirmed" });
    console.log("wSOL Vault:", wsolVault.toBase58());

    // Derive TokenConfig PDA for wSOL
    const [wsolTokenConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_config"), NATIVE_MINT_2022.toBuffer()],
      AEGIS_PROGRAM_ID,
    );

    // register_token: service_fee(8) + min_deposit(8) + max_deposit(8) + deposit_cap(8) = 32 bytes
    const regData = Buffer.alloc(1 + 32);
    regData[0] = 28; // disc = REGISTER_TOKEN
    // service_fee = 0 (no flat fee for SOL)
    regData.writeBigUInt64LE(0n, 1);
    // min_deposit = 10_000_000 lamports (0.01 SOL)
    regData.writeBigUInt64LE(10_000_000n, 9);
    // max_deposit = 1000 SOL in lamports
    regData.writeBigUInt64LE(1_000_000_000_000n, 17);
    // deposit_cap = 100_000 SOL in lamports
    regData.writeBigUInt64LE(100_000_000_000_000n, 25);

    await send(conn, authority, new TransactionInstruction({
      programId: AEGIS_PROGRAM_ID,
      data: regData,
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: poolState, isSigner: false, isWritable: false },
        { pubkey: NATIVE_MINT_2022, isSigner: false, isWritable: false },
        { pubkey: wsolTokenConfigPda, isSigner: false, isWritable: true },
        { pubkey: wsolVault, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    }));
    console.log("wSOL TokenConfig PDA:", wsolTokenConfigPda.toBase58());
    console.log("NATIVE_MINT_2022:", NATIVE_MINT_2022.toBase58());
  }

  // 7. Register tUSDC (6 decimals) for SPL USDC shielding
  console.log("\n--- Registering tUSDC Token ---");
  const usdcMintKp = Keypair.generate();
  {
    // Create Token-2022 mint with 6 decimals
    const createMint = SystemProgram.createAccount({
      fromPubkey: authority.publicKey,
      newAccountPubkey: usdcMintKp.publicKey,
      lamports: await conn.getMinimumBalanceForRentExemption(82),
      space: 82,
      programId: TOKEN_2022,
    });
    const initMintData = Buffer.alloc(67);
    initMintData[0] = 20; // InitializeMint2
    initMintData[1] = 6;  // decimals
    initMintData.set(authority.publicKey.toBuffer(), 2); // mint authority = deployer (for test minting)
    initMintData[34] = 0; // no freeze authority
    const initMint = new TransactionInstruction({
      programId: TOKEN_2022,
      keys: [{ pubkey: usdcMintKp.publicKey, isSigner: false, isWritable: true }],
      data: initMintData,
    });
    const txMint = new Transaction().add(createMint, initMint);
    txMint.feePayer = authority.publicKey;
    txMint.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    await sendAndConfirmTransaction(conn, txMint, [authority, usdcMintKp], { commitment: "confirmed" });
    console.log("tUSDC Mint:", usdcMintKp.publicKey.toBase58());

    // Create vault ATA
    const usdcVault = ata(usdcMintKp.publicKey, poolState);
    const createUsdcVault = new TransactionInstruction({
      programId: ATA_PROGRAM,
      data: Buffer.alloc(0),
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: usdcVault, isSigner: false, isWritable: true },
        { pubkey: poolState, isSigner: false, isWritable: false },
        { pubkey: usdcMintKp.publicKey, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
      ],
    });
    const txAta = new Transaction().add(createUsdcVault);
    txAta.feePayer = authority.publicKey;
    txAta.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    await sendAndConfirmTransaction(conn, txAta, [authority], { commitment: "confirmed" });
    console.log("tUSDC Vault:", usdcVault.toBase58());

    // Register token
    const [usdcTokenConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_config"), usdcMintKp.publicKey.toBuffer()],
      AEGIS_PROGRAM_ID,
    );
    const regData = Buffer.alloc(1 + 32);
    regData[0] = 28;
    regData.writeBigUInt64LE(0n, 1);              // service_fee = 0
    regData.writeBigUInt64LE(100_000n, 9);         // min_deposit = 0.1 USDC
    regData.writeBigUInt64LE(1_000_000_000_000n, 17);  // max_deposit = 1M USDC
    regData.writeBigUInt64LE(10_000_000_000_000n, 25); // deposit_cap = 10M USDC
    await send(conn, authority, new TransactionInstruction({
      programId: AEGIS_PROGRAM_ID,
      data: regData,
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: poolState, isSigner: false, isWritable: false },
        { pubkey: usdcMintKp.publicKey, isSigner: false, isWritable: false },
        { pubkey: usdcTokenConfigPda, isSigner: false, isWritable: true },
        { pubkey: usdcVault, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    }));
    console.log("tUSDC TokenConfig PDA:", usdcTokenConfigPda.toBase58());
  }

  // 8. Register tUSDT (6 decimals) for SPL USDT shielding
  console.log("\n--- Registering tUSDT Token ---");
  const usdtMintKp = Keypair.generate();
  {
    const createMint = SystemProgram.createAccount({
      fromPubkey: authority.publicKey,
      newAccountPubkey: usdtMintKp.publicKey,
      lamports: await conn.getMinimumBalanceForRentExemption(82),
      space: 82,
      programId: TOKEN_2022,
    });
    const initMintData = Buffer.alloc(67);
    initMintData[0] = 20; // InitializeMint2
    initMintData[1] = 6;  // decimals
    initMintData.set(authority.publicKey.toBuffer(), 2); // mint authority = deployer
    initMintData[34] = 0;
    const initMint = new TransactionInstruction({
      programId: TOKEN_2022,
      keys: [{ pubkey: usdtMintKp.publicKey, isSigner: false, isWritable: true }],
      data: initMintData,
    });
    const txMint = new Transaction().add(createMint, initMint);
    txMint.feePayer = authority.publicKey;
    txMint.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    await sendAndConfirmTransaction(conn, txMint, [authority, usdtMintKp], { commitment: "confirmed" });
    console.log("tUSDT Mint:", usdtMintKp.publicKey.toBase58());

    // Create vault ATA
    const usdtVault = ata(usdtMintKp.publicKey, poolState);
    const createUsdtVault = new TransactionInstruction({
      programId: ATA_PROGRAM,
      data: Buffer.alloc(0),
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: usdtVault, isSigner: false, isWritable: true },
        { pubkey: poolState, isSigner: false, isWritable: false },
        { pubkey: usdtMintKp.publicKey, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
      ],
    });
    const txAta = new Transaction().add(createUsdtVault);
    txAta.feePayer = authority.publicKey;
    txAta.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    await sendAndConfirmTransaction(conn, txAta, [authority], { commitment: "confirmed" });
    console.log("tUSDT Vault:", usdtVault.toBase58());

    // Register token
    const [usdtTokenConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_config"), usdtMintKp.publicKey.toBuffer()],
      AEGIS_PROGRAM_ID,
    );
    const regData = Buffer.alloc(1 + 32);
    regData[0] = 28;
    regData.writeBigUInt64LE(0n, 1);
    regData.writeBigUInt64LE(100_000n, 9);
    regData.writeBigUInt64LE(1_000_000_000_000n, 17);
    regData.writeBigUInt64LE(10_000_000_000_000n, 25);
    await send(conn, authority, new TransactionInstruction({
      programId: AEGIS_PROGRAM_ID,
      data: regData,
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: poolState, isSigner: false, isWritable: false },
        { pubkey: usdtMintKp.publicKey, isSigner: false, isWritable: false },
        { pubkey: usdtTokenConfigPda, isSigner: false, isWritable: true },
        { pubkey: usdtVault, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
    }));
    console.log("tUSDT TokenConfig PDA:", usdtTokenConfigPda.toBase58());
  }

  // 9. Summary
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
  console.log("wSOL Mint:       ", "9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP");
  console.log("tUSDC Mint:      ", usdcMintKp.publicKey.toBase58());
  console.log("tUSDT Mint:      ", usdtMintKp.publicKey.toBase58());
  console.log("\nUpdate sdk/src/config.ts with:");
  console.log(`  zkbtcMint: "${mintKp.publicKey.toBase58()}",`);
  console.log(`  poolStatePda: "${poolState.toBase58()}",`);
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
