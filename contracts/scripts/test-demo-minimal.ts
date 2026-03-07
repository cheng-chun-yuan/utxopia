#!/usr/bin/env bun
/**
 * Minimal Demo Stealth Test
 *
 * Tests if devnet feature is enabled by sending a demo stealth instruction
 * with minimal data to see what error we get.
 */

import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import * as fs from "fs";

const RPC_URL = "https://api.devnet.solana.com";

// From .devnet-config.json (verified)
const AEGIS_PROGRAM = new PublicKey("zKeyrLmpT8W9o8iRvhizuSihLAFLhfAGBvfM638Pbw8");
const POOL_STATE = new PublicKey("ELGSdquznDBd6uUkWsBAmguMBmtuur7D5kapwoyZq44J");
const COMMITMENT_TREE = new PublicKey("5p7WERgzB6AHcga19QehvaTfbiVoM1Bg6drkwzYHYamq");
const ZKBTC_MINT = new PublicKey("56gihX59Zy3coM9B1PYXLPoFEzjNuPEVhskCZcKq3VKx");
const POOL_VAULT = new PublicKey("J3dRjxc441qNitZBhPNrrmS5moWY89Fp1g97ayuQSDSj");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

// Pool authority from on-chain state
const POOL_AUTHORITY = new PublicKey("uFBMJSxoGkHj2NyncPzAkhNWsGSQirQcRjUnGfEfWg1");

function loadKeypair(keyPath: string): Keypair {
  const absolutePath = keyPath.replace("~", process.env.HOME || "");
  const secretKey = JSON.parse(fs.readFileSync(absolutePath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

async function main() {
  console.log("=".repeat(60));
  console.log("Minimal Demo Stealth Test");
  console.log("=".repeat(60));

  const connection = new Connection(RPC_URL, "confirmed");

  // Try johnny.json first (same as deploy scripts)
  let payer: Keypair;
  try {
    payer = loadKeypair("~/.config/solana/johnny.json");
  } catch {
    payer = loadKeypair("~/.config/solana/id.json");
  }

  console.log(`\nPayer: ${payer.publicKey.toBase58()}`);
  console.log(`Pool Authority: ${POOL_AUTHORITY.toBase58()}`);
  console.log(`Is payer authority: ${payer.publicKey.equals(POOL_AUTHORITY)}`);

  const balance = await connection.getBalance(payer.publicKey);
  console.log(`Payer balance: ${balance / 1e9} SOL`);

  // Create minimal test data (discriminator 13 = ADD_DEMO_STEALTH + dummy data)
  // ephemeral_pub (33) + commitment (32) + encrypted_amount (8) = 73 + 1 discriminator = 74
  const instructionData = Buffer.alloc(74);
  instructionData[0] = 13; // ADD_DEMO_STEALTH discriminator

  // Fill with random bytes for testing
  for (let i = 1; i < 74; i++) {
    instructionData[i] = i % 256;
  }

  // Derive announcement PDA from the dummy ephemeral pub (bytes 1-33 minus prefix = bytes 2-33)
  const ephemeralPubSliced = instructionData.slice(2, 34);
  const [announcementPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("stealth"), ephemeralPubSliced],
    AEGIS_PROGRAM
  );

  console.log(`\nAnnouncement PDA: ${announcementPda.toBase58()}`);

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: POOL_STATE, isSigner: false, isWritable: true },
      { pubkey: COMMITMENT_TREE, isSigner: false, isWritable: true },
      { pubkey: announcementPda, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ZKBTC_MINT, isSigner: false, isWritable: true },
      { pubkey: POOL_VAULT, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
    ],
    programId: AEGIS_PROGRAM,
    data: instructionData,
  });

  const tx = new Transaction().add(ix);

  console.log("\nSending transaction...");
  console.log("Expected behaviors:");
  console.log("- If devnet feature NOT enabled: 'InvalidInstructionData' error");
  console.log("- If devnet feature enabled but wrong authority: 'Unauthorized' error");
  console.log("- If devnet feature enabled and correct authority: 'InvalidSeeds' (dummy data) or success");
  console.log();

  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
      commitment: "confirmed",
    });
    console.log(`✓ Success: ${sig}`);
  } catch (err: any) {
    console.log(`Error: ${err.message}`);
    if (err.logs) {
      console.log("\nProgram logs:");
      for (const log of err.logs) {
        console.log(`  ${log}`);
      }
    }
  }

  console.log("\n" + "=".repeat(60));
}

main().catch(console.error);
