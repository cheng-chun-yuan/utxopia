#!/usr/bin/env bun
/**
 * Test Demo Stealth Deposit with SDK
 */

import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import {
  AEGIS_PROGRAM_ID,
  derivePoolStatePDA,
  deriveCommitmentTreePDA,
  generateStealthAddress,
  encryptAmount,
} from "@aegis/sdk";
import { poseidon2Hash } from "@aegis/sdk";
import * as fs from "fs";
import * as path from "path";

const RPC_URL = "https://api.devnet.solana.com";

// Load wallet
function loadKeypair(keyPath: string): Keypair {
  const absolutePath = keyPath.replace("~", process.env.HOME || "");
  const secretKey = JSON.parse(fs.readFileSync(absolutePath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

async function main() {
  console.log("=".repeat(60));
  console.log("Test Demo Stealth Deposit");
  console.log("=".repeat(60));

  const connection = new Connection(RPC_URL, "confirmed");
  const authority = loadKeypair("~/.config/solana/id.json");

  console.log(`\nAuthority: ${authority.publicKey.toBase58()}`);
  console.log(`Program: ${AEGIS_PROGRAM_ID}`);

  // Derive PDAs
  const [poolStatePDA] = await derivePoolStatePDA();
  const [commitmentTreePDA] = await deriveCommitmentTreePDA();

  console.log(`Pool State: ${poolStatePDA}`);
  console.log(`Commitment Tree: ${commitmentTreePDA}`);

  // Generate stealth address for test
  console.log("\n=== Generating Stealth Address ===");

  // Generate random keys for testing
  const viewingPrivKey = new Uint8Array(32);
  crypto.getRandomValues(viewingPrivKey);

  // Use SDK to generate stealth address
  const stealthResult = await generateStealthAddress(
    viewingPrivKey, // viewing private key (for testing)
    viewingPrivKey  // spending key (same for testing)
  );

  console.log(`Ephemeral Pub: ${Buffer.from(stealthResult.ephemeralPub).toString("hex").slice(0, 32)}...`);
  console.log(`Stealth Pub X: ${Buffer.from(stealthResult.stealthPubX).toString("hex").slice(0, 32)}...`);

  // Create commitment
  const amount = 10000n; // 10,000 sats (this will be fixed by contract anyway)
  const commitment = await poseidon2Hash(stealthResult.stealthPubX, amount);
  console.log(`Commitment: ${Buffer.from(commitment).toString("hex").slice(0, 32)}...`);

  // Encrypt amount
  const encryptedAmount = encryptAmount(amount, stealthResult.sharedSecret);
  console.log(`Encrypted Amount: ${Buffer.from(encryptedAmount).toString("hex")}`);

  // Derive stealth announcement PDA
  const [stealthAnnouncementPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("stealth"), stealthResult.ephemeralPub.slice(1, 33)],
    new PublicKey(AEGIS_PROGRAM_ID as string)
  );
  console.log(`Stealth Announcement PDA: ${stealthAnnouncementPDA.toBase58()}`);

  // Get zBTC mint and pool vault
  const zbtcMint = new PublicKey("BdUFQhqKpzYVHVg8cQoh7JdpSoHFtwKM4A48AFAjKFAK");
  const [poolVault] = PublicKey.findProgramAddressSync(
    [
      new PublicKey(poolStatePDA as string).toBuffer(),
      TOKEN_2022_PROGRAM_ID.toBuffer(),
      zbtcMint.toBuffer(),
    ],
    new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
  );

  // Build instruction data for ADD_DEMO_STEALTH (discriminator 13)
  const instructionData = Buffer.alloc(74);
  instructionData[0] = 13; // Discriminator
  Buffer.from(stealthResult.ephemeralPub).copy(instructionData, 1);
  Buffer.from(commitment).copy(instructionData, 34);
  Buffer.from(encryptedAmount).copy(instructionData, 66);

  console.log("\n=== Building Transaction ===");

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: new PublicKey(poolStatePDA as string), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(commitmentTreePDA as string), isSigner: false, isWritable: true },
      { pubkey: stealthAnnouncementPDA, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: zbtcMint, isSigner: false, isWritable: true },
      { pubkey: poolVault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId: new PublicKey(AEGIS_PROGRAM_ID as string),
    data: instructionData,
  });

  const tx = new Transaction().add(ix);

  console.log("Sending transaction...");

  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [authority], {
      commitment: "confirmed",
    });
    console.log(`\n✓ Demo Stealth Deposit successful!`);
    console.log(`Signature: ${sig}`);
    console.log(`\nView on Solscan: https://solscan.io/tx/${sig}?cluster=devnet`);

    // Verify the announcement was created
    const annInfo = await connection.getAccountInfo(stealthAnnouncementPDA);
    if (annInfo) {
      console.log(`\n✓ Stealth Announcement created (${annInfo.data.length} bytes)`);
    }

  } catch (err: any) {
    console.error(`\n✗ Transaction failed:`, err.message);
    if (err.logs) {
      console.error("Logs:", err.logs.slice(-10));
    }
  }

  console.log("\n=== Test Complete ===");
}

main().catch(console.error);
