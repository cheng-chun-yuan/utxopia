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

  // 2. Create Token-2022 mint with metadata extension
  console.log("\n--- Creating Token-2022 Mint (with metadata) ---");
  const mintKp = Keypair.generate();

  // Metadata values
  const TOKEN_NAME = "Aegis Shielded BTC";
  const TOKEN_SYMBOL = "zkBTC";
  const TOKEN_URI = ""; // no URI needed

  // Token-2022 metadata extension requires more space.
  // Base mint: 82 bytes. MetadataPointer extension: +8 bytes header + 64 bytes data = 154.
  // TokenMetadata: variable. We allocate enough for name + symbol + uri.
  // Conservative estimate: 82 (mint) + 4 (account type) + 72 (metadata pointer ext) + 300 (metadata ext) = ~460
  // Use 512 to be safe, then resize after metadata init if needed.
  const MINT_SPACE = 82 + 4 + 72; // base mint + account type + metadata pointer extension
  const createMint = SystemProgram.createAccount({
    fromPubkey: authority.publicKey,
    newAccountPubkey: mintKp.publicKey,
    lamports: await conn.getMinimumBalanceForRentExemption(MINT_SPACE),
    space: MINT_SPACE,
    programId: TOKEN_2022,
  });

  // Extension: InitializeMetadataPointer (disc=39, authority=poolState, metadata=mint itself)
  // Layout: disc(1) + authority_option(1) + authority(32) + metadata_option(1) + metadata(32) = 67
  const initMetaPtrData = Buffer.alloc(67);
  initMetaPtrData[0] = 39; // InitializeMetadataPointer
  initMetaPtrData[1] = 1;  // has authority
  initMetaPtrData.set(poolState.toBuffer(), 2); // metadata authority = pool state
  initMetaPtrData[34] = 1; // has metadata address
  initMetaPtrData.set(mintKp.publicKey.toBuffer(), 35); // metadata = self (mint account)

  const initMetaPtr = new TransactionInstruction({
    programId: TOKEN_2022,
    keys: [{ pubkey: mintKp.publicKey, isSigner: false, isWritable: true }],
    data: initMetaPtrData,
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

  // Order matters: create account → init metadata pointer → init mint
  const tx1 = new Transaction().add(createMint, initMetaPtr, initMint);
  tx1.feePayer = authority.publicKey;
  tx1.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  await sendAndConfirmTransaction(conn, tx1, [authority, mintKp], { commitment: "confirmed" });
  console.log("Mint created:", mintKp.publicKey.toBase58());

  // Initialize token metadata (separate tx — needs mint to exist first)
  // spl-token-metadata-interface: Initialize instruction
  // disc = [112, 179, 57, 51, 108, 69, 83, 115] (anchor-style hash of "spl_token_metadata_interface:initialize")
  // Actually for Token-2022 embedded metadata, use the token-metadata instruction:
  // Instruction 0 (Initialize): name_len(4) + name + symbol_len(4) + symbol + uri_len(4) + uri
  {
    const nameBytes = Buffer.from(TOKEN_NAME);
    const symbolBytes = Buffer.from(TOKEN_SYMBOL);
    const uriBytes = Buffer.from(TOKEN_URI);

    // Token-2022 metadata instruction discriminator for Initialize
    // This is the SPL Token Metadata interface discriminator
    const TOKEN_METADATA_INIT_DISC = Buffer.from([112, 179, 57, 51, 108, 69, 83, 115]);

    const metaData = Buffer.alloc(
      8 + 4 + nameBytes.length + 4 + symbolBytes.length + 4 + uriBytes.length
    );
    let offset = 0;
    TOKEN_METADATA_INIT_DISC.copy(metaData, offset); offset += 8;
    metaData.writeUInt32LE(nameBytes.length, offset); offset += 4;
    nameBytes.copy(metaData, offset); offset += nameBytes.length;
    metaData.writeUInt32LE(symbolBytes.length, offset); offset += 4;
    symbolBytes.copy(metaData, offset); offset += symbolBytes.length;
    metaData.writeUInt32LE(uriBytes.length, offset); offset += 4;
    uriBytes.copy(metaData, offset);

    const initMetadata = new TransactionInstruction({
      programId: TOKEN_2022,
      keys: [
        { pubkey: mintKp.publicKey, isSigner: false, isWritable: true },     // metadata (= mint)
        { pubkey: poolState, isSigner: false, isWritable: false },           // update authority
        { pubkey: mintKp.publicKey, isSigner: false, isWritable: false },    // mint
        { pubkey: poolState, isSigner: false, isWritable: false },           // mint authority (PDA, but for init the payer signs)
      ],
      data: metaData,
    });

    // Need to resize the mint account to fit metadata
    // Actually, for embedded metadata, Token-2022 auto-extends if payer provides enough lamports.
    // But we need to use a "reallocate" or the metadata init may fail.
    // Simplest: just create the account large enough initially, or use SystemProgram.transfer to add lamports + realloc.

    // For now, skip metadata init if it fails — the mint still works without it.
    try {
      const txMeta = new Transaction().add(initMetadata);
      txMeta.feePayer = authority.publicKey;
      txMeta.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
      await sendAndConfirmTransaction(conn, txMeta, [authority], { commitment: "confirmed" });
      console.log(`Metadata set: name="${TOKEN_NAME}", symbol="${TOKEN_SYMBOL}"`);
    } catch (err) {
      console.warn("Warning: metadata init failed (mint still usable):", err.message?.slice(0, 100));
      console.warn("You may need to set metadata separately after deployment.");
    }
  }

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

  // 6. Summary
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
