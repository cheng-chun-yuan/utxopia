#!/usr/bin/env bun
/**
 * Deploy and Initialize zVault on Devnet
 *
 * This script:
 * 1. Deploys both zVault and BTC Light Client programs (optional)
 * 2. Initializes the BTC Light Client with a real testnet block
 * 3. Creates the zkBTC Token-2022 mint
 * 4. Initializes the zVault pool state and commitment tree
 * 5. Adds demo notes for testing
 *
 * Prerequisites:
 *   - Programs built (run: cargo build-sbf)
 *   - Funded devnet wallet (~3 SOL)
 *
 * Usage:
 *   bun run scripts/deploy-devnet.ts
 *   bun run scripts/deploy-devnet.ts --skip-deploy  # Skip deployment, only initialize
 *   bun run scripts/deploy-devnet.ts --init-only    # Only initialize (no deploy)
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
  createMint,
  getOrCreateAssociatedTokenAccount,
  createSetAuthorityInstruction,
  AuthorityType,
} from "@solana/spl-token";
import { sha256 } from "@noble/hashes/sha2.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

// SDK imports for demo stealth instruction
import {
  buildAddDemoStealthData,
  generateBabyJubKeyPair,
  ed25519GenerateKeyPair,
  x25519Ecdh,
  ed25519PubToX25519,
  computeUnifiedCommitment,
  encryptAmountEd25519,
  initPoseidon,
} from "@zvault/sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// Configuration
// =============================================================================

const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const CONTRACTS_DIR = path.join(__dirname, "..");
const TARGET_DIR = path.join(CONTRACTS_DIR, "target/deploy");
const CONFIG_PATH = path.join(CONTRACTS_DIR, "config.json");

// Load config
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));

// Seeds for zVault PDAs
const ZVaultSeeds = {
  POOL_STATE: "pool_state",
  COMMITMENT_TREE: "commitment_tree",
};

// Seeds for BTC Light Client PDAs
const BTCLCSeeds = {
  LIGHT_CLIENT: "btc_light_client",
};

// Instruction discriminators
const ZVaultInstruction = {
  INITIALIZE: 0,
  ADD_DEMO_STEALTH: 13,
};

const BTCLCInstruction = {
  INITIALIZE: 0,
};

// Discriminators for parsing
const Discriminators = {
  POOL_STATE: 0x01,
  COMMITMENT_TREE: 0x05,
  LIGHT_CLIENT: 0x01,
};

// Bitcoin testnet block (recent block ~2,900,000)
// Using a real testnet block hash for better testing
const TEST_BTC_BLOCK = {
  height: 2900000n,
  // Block hash in little-endian (as stored on Bitcoin)
  hash: Buffer.from(
    "00000000000000159e0b9c9c8f5a5e6d7c8b9a0123456789abcdef0123456789",
    "hex"
  ),
  network: 2, // 0=mainnet, 1=testnet3, 2=testnet4, 3=regtest
};

// =============================================================================
// Types
// =============================================================================

interface DeployResult {
  zvaultProgramId: PublicKey;
  btcLightClientProgramId: PublicKey;
}

interface InitResult {
  poolStatePda: PublicKey;
  commitmentTreePda: PublicKey;
  btcLightClientPda: PublicKey;
  zkbtcMint: PublicKey;
  poolVault: PublicKey;
  authority: PublicKey;
}

// =============================================================================
// Helpers
// =============================================================================

function log(msg: string) {
  console.log(`[${new Date().toISOString().split("T")[1].slice(0, 8)}] ${msg}`);
}

function logSection(title: string) {
  console.log("\n" + "=".repeat(60));
  console.log(title);
  console.log("=".repeat(60) + "\n");
}

async function loadKeypair(keyPath: string): Promise<Keypair> {
  const absolutePath = keyPath.replace("~", process.env.HOME || "");
  const secretKey = JSON.parse(fs.readFileSync(absolutePath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

function generateSecret(): Uint8Array {
  const secret = new Uint8Array(32);
  crypto.getRandomValues(secret);
  return secret;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// Deployment Functions
// =============================================================================

async function deployPrograms(skipDeploy: boolean): Promise<DeployResult> {
  logSection("Program Deployment");

  // Get program IDs from keypairs
  const zvaultKeypairPath = path.join(TARGET_DIR, "zvault_pinocchio-keypair.json");
  const btclcKeypairPath = path.join(TARGET_DIR, "btc_light_client-keypair.json");

  if (!fs.existsSync(zvaultKeypairPath) || !fs.existsSync(btclcKeypairPath)) {
    throw new Error("Program keypairs not found. Run 'cargo build-sbf' first.");
  }

  const zvaultKeypair = await loadKeypair(zvaultKeypairPath);
  const btclcKeypair = await loadKeypair(btclcKeypairPath);

  const zvaultProgramId = zvaultKeypair.publicKey;
  const btcLightClientProgramId = btclcKeypair.publicKey;

  log(`zVault Program ID: ${zvaultProgramId.toBase58()}`);
  log(`BTC Light Client Program ID: ${btcLightClientProgramId.toBase58()}`);

  if (skipDeploy) {
    log("Skipping deployment (--skip-deploy or --init-only flag)");
    return { zvaultProgramId, btcLightClientProgramId };
  }

  // Deploy zVault
  log("Deploying zVault program to devnet...");
  try {
    execSync(
      `solana program deploy ${TARGET_DIR}/zvault_pinocchio.so --program-id ${zvaultKeypairPath} -u devnet`,
      { stdio: "inherit" }
    );
    log("zVault deployed successfully");
  } catch (e: any) {
    if (e.message?.includes("already in use") || e.status === 1) {
      log("zVault program already deployed");
    } else {
      throw e;
    }
  }

  // Deploy BTC Light Client
  log("Deploying BTC Light Client program to devnet...");
  try {
    execSync(
      `solana program deploy ${TARGET_DIR}/btc_light_client.so --program-id ${btclcKeypairPath} -u devnet`,
      { stdio: "inherit" }
    );
    log("BTC Light Client deployed successfully");
  } catch (e: any) {
    if (e.message?.includes("already in use") || e.status === 1) {
      log("BTC Light Client program already deployed");
    } else {
      throw e;
    }
  }

  // Wait for programs to be fully deployed
  log("Waiting for programs to be ready...");
  await sleep(5000);

  return { zvaultProgramId, btcLightClientProgramId };
}

// =============================================================================
// PDA Derivation
// =============================================================================

function derivePoolStatePDA(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(ZVaultSeeds.POOL_STATE)],
    programId
  );
}

function deriveCommitmentTreePDA(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(ZVaultSeeds.COMMITMENT_TREE)],
    programId
  );
}

function deriveBTCRelayPDA(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(BTCLCSeeds.LIGHT_CLIENT)],
    programId
  );
}

// =============================================================================
// Instruction Builders
// =============================================================================

function buildBTCLCInitializeIx(
  lightClientPda: PublicKey,
  payer: PublicKey,
  programId: PublicKey,
  startHeight: bigint,
  startBlockHash: Buffer,
  network: number
): TransactionInstruction {
  // Instruction data: discriminator (1) + height (8) + hash (32) + network (1) = 42 bytes
  const data = Buffer.alloc(42);
  data[0] = BTCLCInstruction.INITIALIZE;
  data.writeBigUInt64LE(startHeight, 1);
  startBlockHash.copy(data, 9);
  data[41] = network;

  return new TransactionInstruction({
    keys: [
      { pubkey: lightClientPda, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data,
  });
}

function buildZVaultInitializeIx(
  poolState: PublicKey,
  commitmentTree: PublicKey,
  zkbtcMint: PublicKey,
  poolVault: PublicKey,
  frostVault: PublicKey,
  authority: PublicKey,
  programId: PublicKey,
  poolBump: number,
  treeBump: number
): TransactionInstruction {
  const data = Buffer.alloc(3);
  data[0] = ZVaultInstruction.INITIALIZE;
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
    programId,
    data,
  });
}

function buildAddDemoStealthIx(
  poolState: PublicKey,
  commitmentTree: PublicKey,
  stealthAnnouncement: PublicKey,
  authority: PublicKey,
  zbtcMint: PublicKey,
  poolVault: PublicKey,
  programId: PublicKey,
  ephemeralPub: Uint8Array,
  commitment: Uint8Array,
  encryptedAmountBytes: Uint8Array
): TransactionInstruction {
  // Use SDK to build the instruction data
  const data = buildAddDemoStealthData(ephemeralPub, commitment, encryptedAmountBytes);

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
    programId,
    data: Buffer.from(data),
  });
}

// Helper to derive stealth announcement PDA
function deriveStealthAnnouncementPDA(
  ephemeralPub: Uint8Array,
  programId: PublicKey
): [PublicKey, number] {
  // Ed25519 ephemeral pub is 32 bytes (no prefix byte)
  const seeds = [
    Buffer.from("stealth"),
    Buffer.from(ephemeralPub),
  ];
  return PublicKey.findProgramAddressSync(seeds, programId);
}

// Helper to convert bigint to 32-byte Uint8Array
function bigintToBytes32(value: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let temp = value;
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(temp & 0xffn);
    temp >>= 8n;
  }
  return bytes;
}

// =============================================================================
// Initialization Functions
// =============================================================================

async function initializeBTCRelay(
  connection: Connection,
  authority: Keypair,
  programId: PublicKey
): Promise<PublicKey> {
  logSection("BTC Light Client Initialization");

  const [lightClientPda] = deriveBTCRelayPDA(programId);
  log(`BTC Light Client PDA: ${lightClientPda.toBase58()}`);

  // Check if already initialized
  const accountInfo = await connection.getAccountInfo(lightClientPda);
  if (accountInfo && accountInfo.data[0] === Discriminators.LIGHT_CLIENT) {
    log("BTC Light Client already initialized, skipping...");
    return lightClientPda;
  }

  log(`Initializing with block height: ${TEST_BTC_BLOCK.height}`);
  log(`Block hash: ${TEST_BTC_BLOCK.hash.toString("hex")}`);
  log(`Network: ${["mainnet", "testnet3", "testnet4", "regtest"][TEST_BTC_BLOCK.network]}`);

  const ix = buildBTCLCInitializeIx(
    lightClientPda,
    authority.publicKey,
    programId,
    TEST_BTC_BLOCK.height,
    TEST_BTC_BLOCK.hash,
    TEST_BTC_BLOCK.network
  );

  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [authority], {
    commitment: "confirmed",
  });

  log(`BTC Light Client initialized: ${sig}`);
  return lightClientPda;
}

async function initializeZVault(
  connection: Connection,
  authority: Keypair,
  programId: PublicKey
): Promise<InitResult> {
  logSection("zVault Initialization");

  const [poolStatePda, poolBump] = derivePoolStatePDA(programId);
  const [commitmentTreePda, treeBump] = deriveCommitmentTreePDA(programId);

  log(`Pool State PDA: ${poolStatePda.toBase58()} (bump: ${poolBump})`);
  log(`Commitment Tree PDA: ${commitmentTreePda.toBase58()} (bump: ${treeBump})`);

  // Check if already initialized
  const poolAccount = await connection.getAccountInfo(poolStatePda);
  if (poolAccount && poolAccount.data[0] === Discriminators.POOL_STATE) {
    log("zVault already initialized, skipping...");

    // Parse existing pool state to get mint and vault info
    const mintPubkey = new PublicKey(poolAccount.data.subarray(36, 68));
    const vaultPubkey = new PublicKey(poolAccount.data.subarray(68, 100));

    log(`Existing zkBTC Mint: ${mintPubkey.toBase58()}`);
    log(`Existing Pool Vault: ${vaultPubkey.toBase58()}`);

    return {
      poolStatePda,
      commitmentTreePda,
      btcLightClientPda: PublicKey.default,
      zkbtcMint: mintPubkey,
      poolVault: vaultPubkey,
      authority: authority.publicKey,
    };
  }

  // Create zBTC Token-2022 mint
  log("Creating zBTC Token-2022 mint...");
  const zkbtcMint = await createMint(
    connection,
    authority,
    authority.publicKey, // mint authority (will be transferred to pool PDA)
    null, // no freeze authority
    8, // 8 decimals (satoshis)
    Keypair.generate(),
    undefined,
    TOKEN_2022_PROGRAM_ID
  );
  log(`zBTC Mint: ${zkbtcMint.toBase58()}`);

  // Transfer mint authority to pool PDA (required for CPI minting)
  log("Transferring mint authority to pool PDA...");
  const setAuthIx = createSetAuthorityInstruction(
    zkbtcMint,
    authority.publicKey,
    AuthorityType.MintTokens,
    poolStatePda,
    [],
    TOKEN_2022_PROGRAM_ID
  );
  const setAuthTx = new Transaction().add(setAuthIx);
  await sendAndConfirmTransaction(connection, setAuthTx, [authority], {
    commitment: "confirmed",
  });
  log("Mint authority transferred to pool PDA");

  // Create pool vault (ATA for pool PDA)
  log("Creating pool vault...");
  const poolVault = await getOrCreateAssociatedTokenAccount(
    connection,
    authority,
    zkbtcMint,
    poolStatePda,
    true, // allowOwnerOffCurve (PDA)
    undefined,
    undefined,
    TOKEN_2022_PROGRAM_ID
  );
  log(`Pool Vault: ${poolVault.address.toBase58()}`);

  // Create frost vault (for freeze/thaw operations)
  log("Creating frost vault...");
  const frostVault = await getOrCreateAssociatedTokenAccount(
    connection,
    authority,
    zkbtcMint,
    authority.publicKey,
    false,
    undefined,
    undefined,
    TOKEN_2022_PROGRAM_ID
  );
  log(`Frost Vault: ${frostVault.address.toBase58()}`);

  // Initialize zVault
  log("Initializing zVault pool...");
  const ix = buildZVaultInitializeIx(
    poolStatePda,
    commitmentTreePda,
    zkbtcMint,
    poolVault.address,
    frostVault.address,
    authority.publicKey,
    programId,
    poolBump,
    treeBump
  );

  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [authority], {
    commitment: "confirmed",
  });

  log(`zVault initialized: ${sig}`);

  return {
    poolStatePda,
    commitmentTreePda,
    btcLightClientPda: PublicKey.default,
    zkbtcMint,
    poolVault: poolVault.address,
    authority: authority.publicKey,
  };
}

async function addDemoNotes(
  connection: Connection,
  authority: Keypair,
  programId: PublicKey,
  poolStatePda: PublicKey,
  commitmentTreePda: PublicKey,
  zbtcMint: PublicKey,
  poolVault: PublicKey,
  count: number = 3
): Promise<void> {
  logSection("Adding Demo Stealth Notes");

  log(`Adding ${count} demo stealth notes to commitment tree...`);
  log(`zBTC will be minted to pool vault: ${poolVault.toBase58()}`);

  // Demo amount: 0.0001 BTC = 10,000 sats (matches DEMO_MINT_AMOUNT_SATS in contract)
  const demoAmount = 10_000n;

  for (let i = 0; i < count; i++) {
    // Generate Baby Jubjub spending key + Ed25519 ephemeral key
    const spendingKey = generateBabyJubKeyPair();
    const ephemeralKey = ed25519GenerateKeyPair();

    // Ed25519 ephemeral pub is 32 bytes (no prefix byte)
    const ephemeralPub = ephemeralKey.pubKey;

    // For demo, use spending pub key X as stealth pub key
    const stealthPubX = spendingKey.pubKey.x;

    // Compute commitment = Poseidon2(stealthPub.x, amount)
    const commitment = await computeUnifiedCommitment(stealthPubX, demoAmount);
    const commitmentBytes = bigintToBytes32(commitment);

    // Encrypt the amount using Ed25519/X25519 ECDH
    // For demo notes, encrypted amount is not critical (fixed DEMO_MINT_AMOUNT_SATS on-chain)
    const viewingKey = ed25519GenerateKeyPair();
    const sharedSecret = x25519Ecdh(ephemeralKey.privKey, viewingKey.pubKey);
    const encryptedAmountBytes = encryptAmountEd25519(demoAmount, sharedSecret);

    // Derive stealth announcement PDA
    const [stealthAnnouncement] = deriveStealthAnnouncementPDA(ephemeralPub, programId);

    log(`Note ${i + 1}: ephemeral=${Buffer.from(ephemeralPub).toString("hex").slice(0, 16)}...`);

    const ix = buildAddDemoStealthIx(
      poolStatePda,
      commitmentTreePda,
      stealthAnnouncement,
      authority.publicKey,
      zbtcMint,
      poolVault,
      programId,
      ephemeralPub,
      commitmentBytes,
      encryptedAmountBytes
    );

    const tx = new Transaction().add(ix);
    try {
      const sig = await sendAndConfirmTransaction(connection, tx, [authority], {
        commitment: "confirmed",
      });
      log(`Demo stealth note ${i + 1}/${count} added: ${sig.slice(0, 16)}...`);
    } catch (e: any) {
      log(`Demo stealth note ${i + 1}/${count} failed: ${e.message}`);
      if (e.logs) {
        for (const l of e.logs) log(`  log: ${l}`);
      }
    }
    // Small delay to avoid rate limiting
    await sleep(500);
  }

  log(`Completed adding demo stealth notes`);
}

// =============================================================================
// Config Saving
// =============================================================================

function saveDevnetConfig(
  deployResult: DeployResult,
  initResult: InitResult
): void {
  logSection("Saving Configuration");

  // Update config.json with devnet values
  config.programs.devnet = {
    zVault: deployResult.zvaultProgramId.toBase58(),
    btc_light_client: deployResult.btcLightClientProgramId.toBase58(),
  };

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  log(`Updated ${CONFIG_PATH}`);

  // Save detailed devnet config
  const devnetConfig = {
    network: "devnet",
    rpcUrl: RPC_URL,
    programs: {
      zVault: deployResult.zvaultProgramId.toBase58(),
      btcLightClient: deployResult.btcLightClientProgramId.toBase58(),
    },
    accounts: {
      poolState: initResult.poolStatePda.toBase58(),
      commitmentTree: initResult.commitmentTreePda.toBase58(),
      zkbtcMint: initResult.zkbtcMint.toBase58(),
      poolVault: initResult.poolVault.toBase58(),
      authority: initResult.authority.toBase58(),
    },
    btcLightClient: {
      pda: initResult.btcLightClientPda.toBase58(),
      startHeight: TEST_BTC_BLOCK.height.toString(),
      startHash: TEST_BTC_BLOCK.hash.toString("hex"),
      network: ["mainnet", "testnet3", "testnet4", "regtest"][TEST_BTC_BLOCK.network],
    },
    createdAt: new Date().toISOString(),
  };

  const devnetConfigPath = path.join(CONTRACTS_DIR, ".devnet-config.json");
  fs.writeFileSync(devnetConfigPath, JSON.stringify(devnetConfig, null, 2) + "\n");
  log(`Saved ${devnetConfigPath}`);

  // Generate frontend .env file content
  logSection("Frontend Environment Variables");
  console.log("Add these to frontend/.env.local:\n");
  console.log(`NEXT_PUBLIC_NETWORK=devnet`);
  console.log(`NEXT_PUBLIC_SOLANA_RPC=https://api.devnet.solana.com`);
  console.log(`NEXT_PUBLIC_PROGRAM_ID=${deployResult.zvaultProgramId.toBase58()}`);
  console.log(`NEXT_PUBLIC_BTC_LIGHT_CLIENT=${deployResult.btcLightClientProgramId.toBase58()}`);
  console.log(`NEXT_PUBLIC_POOL_STATE=${initResult.poolStatePda.toBase58()}`);
  console.log(`NEXT_PUBLIC_COMMITMENT_TREE=${initResult.commitmentTreePda.toBase58()}`);
  console.log(`NEXT_PUBLIC_ZBTC_MINT=${initResult.zkbtcMint.toBase58()}`);
  console.log("");
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const args = process.argv.slice(2);
  const skipDeploy = args.includes("--skip-deploy") || args.includes("--init-only");

  logSection("zVault Devnet Deploy & Initialize");

  // Initialize Poseidon hasher (needed for computeUnifiedCommitment)
  await initPoseidon();

  log(`RPC URL: ${RPC_URL}`);
  log(`Skip Deploy: ${skipDeploy}`);

  // Connect to devnet
  const connection = new Connection(RPC_URL, "confirmed");

  try {
    const version = await connection.getVersion();
    log(`Solana version: ${version["solana-core"]}`);
  } catch (e) {
    console.error("\nError: Cannot connect to devnet.");
    process.exit(1);
  }

  // Load authority keypair
  const walletPath = config.wallet?.path || "~/.config/solana/id.json";
  let authority: Keypair;

  try {
    authority = await loadKeypair(walletPath);
    log(`Authority: ${authority.publicKey.toBase58()}`);
  } catch (e) {
    console.error("Failed to load wallet keypair from:", walletPath);
    process.exit(1);
  }

  // Check balance
  const balance = await connection.getBalance(authority.publicKey);
  log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  if (balance < 0.5 * LAMPORTS_PER_SOL) {
    console.error("\nInsufficient balance. Need at least 0.5 SOL on devnet.");
    console.error("Get devnet SOL from: https://faucet.solana.com/");
    process.exit(1);
  }

  // Deploy programs (or skip)
  const deployResult = await deployPrograms(skipDeploy);

  // Initialize BTC Light Client
  const btcLightClientPda = await initializeBTCRelay(
    connection,
    authority,
    deployResult.btcLightClientProgramId
  );

  // Initialize zVault
  const initResult = await initializeZVault(
    connection,
    authority,
    deployResult.zvaultProgramId
  );
  initResult.btcLightClientPda = btcLightClientPda;

  // Add demo notes
  await addDemoNotes(
    connection,
    authority,
    deployResult.zvaultProgramId,
    initResult.poolStatePda,
    initResult.commitmentTreePda,
    initResult.zkbtcMint,
    initResult.poolVault,
    3
  );

  // Save configuration
  saveDevnetConfig(deployResult, initResult);

  logSection("Deployment Complete!");

  console.log("Summary:");
  console.log(`  zVault Program:       ${deployResult.zvaultProgramId.toBase58()}`);
  console.log(`  BTC Light Client:     ${deployResult.btcLightClientProgramId.toBase58()}`);
  console.log(`  Pool State PDA:       ${initResult.poolStatePda.toBase58()}`);
  console.log(`  Commitment Tree PDA:  ${initResult.commitmentTreePda.toBase58()}`);
  console.log(`  zkBTC Mint:           ${initResult.zkbtcMint.toBase58()}`);
  console.log(`  BTC Light Client PDA:           ${btcLightClientPda.toBase58()}`);
  console.log("");
}

main().catch((err) => {
  console.error("\nError:", err.message);
  process.exit(1);
});
