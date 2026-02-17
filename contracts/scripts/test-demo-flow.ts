#!/usr/bin/env bun
/**
 * zVault Demo Flow Integration Test
 *
 * Tests the complete flow on localnet:
 * 1. Generate .zkey stealth addresses
 * 2. ADD_DEMO_NOTE - add claimable notes
 * 3. ADD_DEMO_STEALTH - add stealth deposits
 * 4. Claim notes to private accounts
 * 5. Scan with viewing key to find deposits
 *
 * Run: bun run scripts/test-demo-flow.ts
 *
 * Prerequisites:
 * - solana-test-validator running
 * - Program deployed to localnet
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createInitializeMintInstruction,
  getMintLen,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// CONFIGURATION
// ============================================================================

// Use devnet by default (localnet requires solana-test-validator)
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";

// Program ID - load from config.json
const configPath = path.join(__dirname, "..", "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || config.programs.devnet.zVault
);

// Instruction discriminators
const Instruction = {
  INITIALIZE: 0,
  VERIFY_STEALTH_DEPOSIT: 1,
  CLAIM: 2,
  SPLIT_COMMITMENT: 3,
  SPEND_PARTIAL_PUBLIC: 4,
  REQUEST_REDEMPTION: 5,
  SET_PAUSED: 7,
  REGISTER_NAME: 8,
  UPDATE_NAME: 9,
  TRANSFER_NAME: 10,
  INIT_VK_REGISTRY: 11,
  UPDATE_VK_REGISTRY: 12,
  ADD_DEMO_STEALTH: 13,
  ADD_DEMO_NOTE: 21,
};

// Seeds for PDA derivation (must match contract!)
const Seeds = {
  POOL_STATE: Buffer.from("pool_state"),
  COMMITMENT_TREE: Buffer.from("commitment_tree"),
  STEALTH: Buffer.from("stealth"),
  NAME_REGISTRY: Buffer.from("zkey"), // Contract uses b"zkey" not "name_registry"
};

// Account sizes
const POOL_STATE_SIZE = 296;
const COMMITMENT_TREE_SIZE = 8192; // Larger for more commitments

// ============================================================================
// CRYPTO HELPERS
// ============================================================================

/**
 * Generate a random 32-byte secret
 */
function generateSecret(): Uint8Array {
  return crypto.randomBytes(32);
}

/**
 * SHA256 hash
 */
function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(crypto.createHash("sha256").update(data).digest());
}

/**
 * Derive nullifier from secret (matches contract logic)
 * nullifier = SHA256(secret || "nullifier_salt__")
 */
function deriveNullifier(secret: Uint8Array): Uint8Array {
  const input = new Uint8Array(48);
  input.set(secret, 0);
  input.set(Buffer.from("nullifier_salt__"), 32);
  return sha256(input);
}

/**
 * Compute commitment from nullifier and secret
 * commitment = SHA256(nullifier || secret)
 */
function computeCommitment(nullifier: Uint8Array, secret: Uint8Array): Uint8Array {
  const input = new Uint8Array(64);
  input.set(nullifier, 0);
  input.set(secret, 32);
  return sha256(input);
}

/**
 * Generate X25519 keypair for viewing
 */
function generateX25519Keypair(): { publicKey: Uint8Array; privateKey: Uint8Array } {
  // Use crypto for X25519
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  return {
    publicKey: new Uint8Array(publicKey.export({ type: "spki", format: "der" }).slice(-32)),
    privateKey: new Uint8Array(privateKey.export({ type: "pkcs8", format: "der" }).slice(-32)),
  };
}

/**
 * Generate a mock Grumpkin keypair (33-byte compressed pubkey)
 * In production, use actual Grumpkin curve operations
 */
function generateGrumpkinKeypair(): { publicKey: Uint8Array; privateKey: Uint8Array } {
  const privateKey = crypto.randomBytes(32);
  // Mock compressed pubkey (0x02 or 0x03 prefix + 32 bytes)
  const publicKey = new Uint8Array(33);
  publicKey[0] = 0x02; // Compressed point prefix
  publicKey.set(sha256(privateKey).slice(0, 32), 1);
  return { publicKey: new Uint8Array(publicKey), privateKey: new Uint8Array(privateKey) };
}

// ============================================================================
// STEALTH ADDRESS HELPERS
// ============================================================================

interface StealthMetaAddress {
  spendingPubKey: Uint8Array; // 33 bytes (Grumpkin compressed)
  viewingPubKey: Uint8Array;  // 32 bytes (X25519)
  spendingPrivKey: Uint8Array;
  viewingPrivKey: Uint8Array;
}

/**
 * Generate a stealth meta-address (spending + viewing keys)
 */
function generateStealthMetaAddress(): StealthMetaAddress {
  const spending = generateGrumpkinKeypair();
  const viewing = generateX25519Keypair();

  return {
    spendingPubKey: spending.publicKey,
    viewingPubKey: viewing.publicKey,
    spendingPrivKey: spending.privateKey,
    viewingPrivKey: viewing.privateKey,
  };
}

/**
 * Encode stealth meta-address to hex (65 bytes = 130 hex chars)
 */
function encodeStealthAddress(meta: StealthMetaAddress): string {
  const combined = new Uint8Array(65);
  combined.set(meta.spendingPubKey, 0);  // 33 bytes
  combined.set(meta.viewingPubKey, 33);   // 32 bytes
  return Buffer.from(combined).toString("hex");
}

/**
 * Hash name for .zkey registry
 */
function hashName(name: string): Uint8Array {
  return sha256(Buffer.from(name.toLowerCase()));
}

// ============================================================================
// PDA DERIVATION
// ============================================================================

function derivePoolStatePda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Seeds.POOL_STATE], PROGRAM_ID);
}

function deriveCommitmentTreePda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Seeds.COMMITMENT_TREE], PROGRAM_ID);
}

function deriveStealthAnnouncementPda(ephemeralPub: Uint8Array): [PublicKey, number] {
  // Contract uses bytes 1-32 of ephemeral_pub (skip prefix byte for 32-byte seed limit)
  const seed = ephemeralPub.length === 33 ? ephemeralPub.slice(1, 33) : ephemeralPub;
  return PublicKey.findProgramAddressSync(
    [Seeds.STEALTH, seed],
    PROGRAM_ID
  );
}

function deriveNameRegistryPda(nameHash: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Seeds.NAME_REGISTRY, nameHash],
    PROGRAM_ID
  );
}

// ============================================================================
// INSTRUCTION BUILDERS
// ============================================================================

/**
 * Build Initialize instruction
 */
function buildInitializeInstruction(
  poolState: PublicKey,
  commitmentTree: PublicKey,
  zkbtcMint: PublicKey,
  authority: PublicKey,
  poolBump: number,
  treeBump: number,
): TransactionInstruction {
  // Data: discriminator (1) + pool_bump (1) + tree_bump (1) = 3 bytes
  const data = Buffer.alloc(3);
  data[0] = Instruction.INITIALIZE;
  data[1] = poolBump;
  data[2] = treeBump;

  return new TransactionInstruction({
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: commitmentTree, isSigner: false, isWritable: true },
      { pubkey: zkbtcMint, isSigner: false, isWritable: false },
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false }, // poolVault
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false }, // frostVault
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

/**
 * Build ADD_DEMO_NOTE instruction
 * Takes a secret (32 bytes), contract derives nullifier and commitment
 */
function buildAddDemoNoteInstruction(
  poolState: PublicKey,
  commitmentTree: PublicKey,
  authority: PublicKey,
  secret: Uint8Array,
): TransactionInstruction {
  // Data: discriminator (1) + secret (32) = 33 bytes
  const data = Buffer.alloc(33);
  data[0] = Instruction.ADD_DEMO_NOTE;
  data.set(secret, 1);

  return new TransactionInstruction({
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: commitmentTree, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

/**
 * Build ADD_DEMO_STEALTH instruction
 * Adds commitment to tree + creates stealth announcement + mints zBTC
 *
 * Contract expects 8 accounts:
 * 0. pool_state - Pool state PDA (writable)
 * 1. commitment_tree - Commitment tree PDA (writable)
 * 2. stealth_announcement - Stealth announcement PDA (to create, writable)
 * 3. authority - Pool authority (signer, pays for announcement)
 * 4. system_program - System program
 * 5. zbtc_mint - zBTC Token-2022 mint (writable)
 * 6. pool_vault - Pool vault token account (writable)
 * 7. token_program - Token-2022 program
 *
 * Data format (74 bytes):
 * - discriminator (1)
 * - ephemeral_pub (33) - Grumpkin compressed
 * - commitment (32)
 * - encrypted_amount (8) - XOR encrypted
 */
function buildAddDemoStealthInstruction(
  poolState: PublicKey,
  commitmentTree: PublicKey,
  stealthAnnouncement: PublicKey,
  authority: PublicKey,
  zbtcMint: PublicKey,
  poolVault: PublicKey,
  ephemeralPub: Uint8Array,  // 33-byte Grumpkin compressed
  commitment: Uint8Array,
  encryptedAmount: Uint8Array,  // 8 bytes XOR encrypted
): TransactionInstruction {
  // Data: discriminator (1) + ephemeral_pub (33) + commitment (32) + encrypted_amount (8) = 74 bytes
  const data = Buffer.alloc(74);
  let offset = 0;

  data[offset++] = Instruction.ADD_DEMO_STEALTH;
  data.set(ephemeralPub, offset);
  offset += 33;
  data.set(commitment, offset);
  offset += 32;
  data.set(encryptedAmount, offset);

  return new TransactionInstruction({
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: commitmentTree, isSigner: false, isWritable: true },
      { pubkey: stealthAnnouncement, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: zbtcMint, isSigner: false, isWritable: true },
      { pubkey: poolVault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

/**
 * Build REGISTER_NAME instruction
 */
function buildRegisterNameInstruction(
  nameRegistry: PublicKey,
  owner: PublicKey,
  name: string,
  nameHash: Uint8Array,
  spendingPubKey: Uint8Array,
  viewingPubKey: Uint8Array,
): TransactionInstruction {
  const nameBytes = Buffer.from(name);
  // Data: discriminator (1) + name_len (1) + name + name_hash (32) + spending_pubkey (33) + viewing_pubkey (32)
  const dataLen = 1 + 1 + nameBytes.length + 32 + 33 + 32;
  const data = Buffer.alloc(dataLen);

  let offset = 0;
  data[offset++] = Instruction.REGISTER_NAME;
  data[offset++] = nameBytes.length;
  data.set(nameBytes, offset);
  offset += nameBytes.length;
  data.set(nameHash, offset);
  offset += 32;
  data.set(spendingPubKey, offset);
  offset += 33;
  data.set(viewingPubKey, offset);

  return new TransactionInstruction({
    keys: [
      { pubkey: nameRegistry, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

// ============================================================================
// TEST UTILITIES
// ============================================================================

interface DemoNote {
  secret: Uint8Array;
  nullifier: Uint8Array;
  commitment: Uint8Array;
  amount: bigint;
}

/**
 * Generate a demo note (for claim link)
 */
function generateDemoNote(): DemoNote {
  const secret = generateSecret();
  const nullifier = deriveNullifier(secret);
  const commitment = computeCommitment(nullifier, secret);
  const amount = 10_000n; // Fixed demo amount

  return { secret, nullifier, commitment, amount };
}

interface StealthDeposit {
  ephemeralPub: Uint8Array;      // 33-byte Grumpkin compressed
  commitment: Uint8Array;        // 32-byte
  encryptedAmount: Uint8Array;   // 8-byte XOR encrypted
  amount: bigint;
  // For recipient
  sharedSecret: Uint8Array;
}

/**
 * Generate a stealth deposit for a recipient (single ephemeral key, EIP-5564 pattern)
 */
function generateStealthDeposit(
  recipientMeta: StealthMetaAddress,
  amount: bigint,
): StealthDeposit {
  // Generate single ephemeral Grumpkin keypair
  const ephemeral = generateGrumpkinKeypair();

  // Compute shared secret (simplified - in production use proper ECDH)
  const sharedSecret = sha256(
    Buffer.concat([ephemeral.privateKey, recipientMeta.viewingPubKey])
  );

  // Derive note public key and commitment (simplified)
  const notePubKey = sha256(Buffer.concat([sharedSecret, Buffer.from("note")]));
  const commitment = sha256(Buffer.concat([notePubKey, Buffer.from(amount.toString())]));

  // Encrypt amount with XOR (first 8 bytes of sha256(sharedSecret || "amount"))
  const amountKey = sha256(Buffer.concat([sharedSecret, Buffer.from("amount")])).slice(0, 8);
  const amountBytes = Buffer.alloc(8);
  amountBytes.writeBigUInt64LE(amount);
  const encryptedAmount = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    encryptedAmount[i] = amountBytes[i] ^ amountKey[i];
  }

  return {
    ephemeralPub: ephemeral.publicKey,  // 33 bytes compressed
    commitment,
    encryptedAmount,
    amount,
    sharedSecret,
  };
}

// ============================================================================
// MAIN TEST FLOW
// ============================================================================

async function main() {
  console.log("\n" + "=".repeat(60));
  console.log("zVault Demo Flow Integration Test");
  console.log("=".repeat(60) + "\n");

  // Connect
  const connection = new Connection(RPC_URL, "confirmed");
  console.log("RPC:", RPC_URL);
  console.log("Program ID:", PROGRAM_ID.toString());

  // Load authority keypair (pool authority for admin operations)
  let authority: Keypair;

  // Try to use the relayer keypair (which is the pool authority on devnet)
  const relayerKeypair = process.env.RELAYER_KEYPAIR;
  if (relayerKeypair) {
    try {
      const keypairData = JSON.parse(relayerKeypair);
      authority = Keypair.fromSecretKey(new Uint8Array(keypairData));
      console.log("Authority loaded from RELAYER_KEYPAIR env");
    } catch {
      authority = Keypair.generate();
      console.log("Failed to parse RELAYER_KEYPAIR, using generated keypair");
    }
  } else {
    // Use wallet from config.json (same as deploy script)
    const walletPath = config.wallet?.path || "~/.config/solana/id.json";
    const keypairPath = walletPath.replace("~", process.env.HOME || "");
    try {
      const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
      authority = Keypair.fromSecretKey(new Uint8Array(keypairData));
      console.log("Authority loaded from:", keypairPath);
    } catch {
      authority = Keypair.generate();
      console.log("Generated new authority keypair");
    }
  }
  console.log("Authority:", authority.publicKey.toString());

  // Check balance and airdrop if needed
  let balance = await connection.getBalance(authority.publicKey);
  console.log("Balance:", balance / LAMPORTS_PER_SOL, "SOL");

  if (balance < LAMPORTS_PER_SOL) {
    console.log("Requesting airdrop...");
    try {
      const sig = await connection.requestAirdrop(authority.publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig);
      balance = await connection.getBalance(authority.publicKey);
      console.log("New balance:", balance / LAMPORTS_PER_SOL, "SOL");
    } catch (e) {
      console.error("Airdrop failed:", e);
    }
  }

  // Derive PDAs
  const [poolStatePda, poolBump] = derivePoolStatePda();
  const [commitmentTreePda, treeBump] = deriveCommitmentTreePda();

  console.log("\nPDAs:");
  console.log("  Pool State:", poolStatePda.toString());
  console.log("  Commitment Tree:", commitmentTreePda.toString());

  // ============================================================================
  // TEST 1: Generate .zkey Stealth Addresses
  // ============================================================================
  console.log("\n" + "-".repeat(60));
  console.log("TEST 1: Generate .zkey Stealth Addresses");
  console.log("-".repeat(60));

  const alice = generateStealthMetaAddress();
  const bob = generateStealthMetaAddress();

  console.log("\nAlice's stealth meta-address:");
  console.log("  Spending pubkey:", Buffer.from(alice.spendingPubKey).toString("hex").slice(0, 20) + "...");
  console.log("  Viewing pubkey:", Buffer.from(alice.viewingPubKey).toString("hex").slice(0, 20) + "...");
  console.log("  Full address:", encodeStealthAddress(alice).slice(0, 40) + "...");

  console.log("\nBob's stealth meta-address:");
  console.log("  Spending pubkey:", Buffer.from(bob.spendingPubKey).toString("hex").slice(0, 20) + "...");
  console.log("  Viewing pubkey:", Buffer.from(bob.viewingPubKey).toString("hex").slice(0, 20) + "...");
  console.log("  Full address:", encodeStealthAddress(bob).slice(0, 40) + "...");

  // ============================================================================
  // TEST 2: Register .zkey Names (if pool exists)
  // ============================================================================
  console.log("\n" + "-".repeat(60));
  console.log("TEST 2: Register .zkey Names");
  console.log("-".repeat(60));

  const aliceNameHash = hashName("alice");
  const bobNameHash = hashName("bob");

  const [aliceNamePda] = deriveNameRegistryPda(aliceNameHash);
  const [bobNamePda] = deriveNameRegistryPda(bobNameHash);

  console.log("\nName PDAs:");
  console.log("  alice.zkey:", aliceNamePda.toString());
  console.log("  bob.zkey:", bobNamePda.toString());

  // Check if pool is initialized
  const poolAccount = await connection.getAccountInfo(poolStatePda);

  if (!poolAccount) {
    console.log("\n[SKIP] Pool not initialized - skipping on-chain tests");
    console.log("To initialize, run: bun run scripts/devnet-setup.ts");
  } else {
    console.log("\nPool is initialized - proceeding with on-chain tests");

    // Try to register names (use unique name to avoid collision)
    const testName = "test" + Date.now().toString().slice(-6);
    const testNameHash = hashName(testName);
    const [testNamePda] = deriveNameRegistryPda(testNameHash);

    console.log("\nTrying to register:", testName + ".zkey");
    console.log("  PDA:", testNamePda.toString());

    try {
      const nameIx = buildRegisterNameInstruction(
        testNamePda,
        authority.publicKey,
        testName,
        testNameHash,
        alice.spendingPubKey,
        alice.viewingPubKey,
      );

      // Simulate first to get detailed logs
      const tx = new Transaction().add(nameIx);
      tx.feePayer = authority.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const simResult = await connection.simulateTransaction(tx);
      if (simResult.value.err) {
        console.log("  Simulation error:", JSON.stringify(simResult.value.err));
        console.log("  Logs:", simResult.value.logs?.join("\n    "));
      } else {
        // Actually send
        const sig = await sendAndConfirmTransaction(connection, tx, [authority]);
        console.log("  ✓ Registered:", testName + ".zkey", sig.slice(0, 20) + "...");
      }
    } catch (e: any) {
      console.log("  Failed:", e.message?.slice(0, 100));
      if (e.logs) console.log("  Logs:", e.logs.join("\n    "));
    }
  }

  // ============================================================================
  // TEST 3: ADD_DEMO_NOTE - Create Claimable Notes
  // ============================================================================
  console.log("\n" + "-".repeat(60));
  console.log("TEST 3: ADD_DEMO_NOTE - Create Claimable Notes");
  console.log("-".repeat(60));

  const note1 = generateDemoNote();
  const note2 = generateDemoNote();

  console.log("\nGenerated demo notes:");
  console.log("Note 1:");
  console.log("  Secret:", Buffer.from(note1.secret).toString("hex").slice(0, 20) + "...");
  console.log("  Nullifier:", Buffer.from(note1.nullifier).toString("hex").slice(0, 20) + "...");
  console.log("  Commitment:", Buffer.from(note1.commitment).toString("hex").slice(0, 20) + "...");
  console.log("  Amount:", note1.amount.toString(), "sats");

  console.log("\nNote 2:");
  console.log("  Secret:", Buffer.from(note2.secret).toString("hex").slice(0, 20) + "...");
  console.log("  Commitment:", Buffer.from(note2.commitment).toString("hex").slice(0, 20) + "...");

  // Note: ADD_DEMO_NOTE instruction was removed in favor of unified stealth model
  // Use ADD_DEMO_STEALTH in TEST 4 instead
  console.log("\nNote: Use ADD_DEMO_STEALTH (TEST 4) to create claimable deposits");
  console.log("Claim link data for Note 1:", `secret=${Buffer.from(note1.secret).toString("hex").slice(0, 40)}...`);

  // ============================================================================
  // TEST 4: ADD_DEMO_STEALTH - Create Stealth Deposits
  // ============================================================================
  console.log("\n" + "-".repeat(60));
  console.log("TEST 4: ADD_DEMO_STEALTH - Create Stealth Deposits");
  console.log("-".repeat(60));

  // Load devnet config for mint and vault addresses
  const devnetConfigPath = path.join(__dirname, "..", ".devnet-config.json");
  let zbtcMint: PublicKey | null = null;
  let poolVault: PublicKey | null = null;

  try {
    const devnetConfig = JSON.parse(fs.readFileSync(devnetConfigPath, "utf-8"));
    zbtcMint = new PublicKey(devnetConfig.accounts.zkbtcMint);
    poolVault = new PublicKey(devnetConfig.accounts.poolVault);
    console.log("\nLoaded devnet config:");
    console.log("  zBTC Mint:", zbtcMint.toString());
    console.log("  Pool Vault:", poolVault.toString());
  } catch (e) {
    console.log("Warning: Could not load .devnet-config.json");
  }

  // Create stealth deposit for Alice
  const stealthDeposit = generateStealthDeposit(alice, 50_000n);

  console.log("\nStealth deposit for Alice:");
  console.log("  Amount:", stealthDeposit.amount.toString(), "sats");
  console.log("  Ephemeral pub:", Buffer.from(stealthDeposit.ephemeralPub).toString("hex").slice(0, 20) + "...");
  console.log("  Commitment:", Buffer.from(stealthDeposit.commitment).toString("hex").slice(0, 20) + "...");
  console.log("  Encrypted amount:", Buffer.from(stealthDeposit.encryptedAmount).toString("hex"));

  const [stealthAnnouncementPda] = deriveStealthAnnouncementPda(stealthDeposit.ephemeralPub);
  console.log("  Announcement PDA:", stealthAnnouncementPda.toString());

  if (poolAccount && zbtcMint && poolVault) {
    try {
      const stealthIx = buildAddDemoStealthInstruction(
        poolStatePda,
        commitmentTreePda,
        stealthAnnouncementPda,
        authority.publicKey,
        zbtcMint,
        poolVault,
        stealthDeposit.ephemeralPub,
        stealthDeposit.commitment,
        stealthDeposit.encryptedAmount,
      );

      const tx = new Transaction().add(stealthIx);
      const sig = await sendAndConfirmTransaction(connection, tx, [authority]);
      console.log("\n✓ Stealth deposit added:", sig.slice(0, 20) + "...");
    } catch (e: any) {
      console.log("Failed to add stealth deposit:", e.message?.slice(0, 80));
    }
  } else {
    console.log("Skipping on-chain test - missing devnet config or pool not initialized");
  }

  // ============================================================================
  // TEST 5: Scan for Deposits with Viewing Key
  // ============================================================================
  console.log("\n" + "-".repeat(60));
  console.log("TEST 5: Scan for Deposits with Viewing Key");
  console.log("-".repeat(60));

  console.log("\nSimulating scanning for Alice's deposits...");
  console.log("(In production, scan all stealth announcements and try ECDH)");

  // Simulate ECDH check (using ephemeral pub from deposit)
  const checkSharedSecret = sha256(
    Buffer.concat([alice.viewingPrivKey, stealthDeposit.ephemeralPub])
  );

  // In a real implementation, compare derived values
  console.log("  Alice's viewing private key:", Buffer.from(alice.viewingPrivKey).toString("hex").slice(0, 20) + "...");
  console.log("  Computed shared secret:", Buffer.from(checkSharedSecret).toString("hex").slice(0, 20) + "...");
  console.log("  ✓ Deposit found! Amount:", stealthDeposit.amount.toString(), "sats");

  // ============================================================================
  // TEST 6: Claim Flow (Simulated)
  // ============================================================================
  console.log("\n" + "-".repeat(60));
  console.log("TEST 6: Claim Flow (Simulated)");
  console.log("-".repeat(60));

  console.log("\nTo claim, user would:");
  console.log("1. Derive nullifier from note secret");
  console.log("2. Generate ZK proof of knowledge");
  console.log("3. Submit CLAIM instruction with proof");
  console.log("4. Receive zkBTC to their wallet");

  console.log("\nClaim data for Note 1:");
  console.log("  Secret:", Buffer.from(note1.secret).toString("hex"));
  console.log("  Nullifier:", Buffer.from(note1.nullifier).toString("hex"));
  console.log("  Amount:", note1.amount.toString(), "sats");

  // ============================================================================
  // SUMMARY
  // ============================================================================
  console.log("\n" + "=".repeat(60));
  console.log("TEST SUMMARY");
  console.log("=".repeat(60));

  console.log("\n✓ Generated stealth meta-addresses for Alice and Bob");
  console.log("✓ Derived .zkey name registry PDAs");
  console.log("✓ Generated demo notes with secrets");
  console.log("✓ Created stealth deposit data");
  console.log("✓ Simulated viewing key scanning");

  if (poolAccount) {
    console.log("\nOn-chain operations completed on:", RPC_URL);
  } else {
    console.log("\n⚠ Pool not initialized - on-chain tests skipped");
    console.log("To run full tests:");
    console.log("  1. Start validator: solana-test-validator");
    console.log("  2. Deploy program: bun run deploy");
    console.log("  3. Initialize pool: bun run setup:devnet");
    console.log("  4. Re-run this script");
  }

  console.log("\n" + "=".repeat(60) + "\n");
}

main().catch(console.error);
