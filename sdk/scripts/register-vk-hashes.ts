#!/usr/bin/env bun
/**
 * Register JoinSplit VK Hashes On-Chain
 *
 * Reads compiled VK JSON files from circuits/build/joinsplit_*,
 * computes SHA-256 hashes, and calls init_vk_registry for each variant.
 *
 * Usage:
 *   bun run scripts/register-vk-hashes.ts
 *   NETWORK=devnet bun run scripts/register-vk-hashes.ts
 *   DRY_RUN=true bun run scripts/register-vk-hashes.ts  # Just print hashes
 *
 * Environment:
 *   KEYPAIR_PATH - Path to authority keypair (default: ~/.config/solana/johnny.json)
 *   NETWORK - localnet | devnet (default: devnet)
 *   DRY_RUN - If "true", only compute and print hashes without submitting
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import {
  address,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createKeyPairSignerFromBytes,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  signTransactionMessageWithSigners,
  sendAndConfirmTransactionFactory,
  getSignatureFromTransaction,
  getProgramDerivedAddress,
  AccountRole,
  type Address,
  type KeyPairSigner,
  type IInstruction,
} from "@solana/kit";

import { setConfig, getConfig, type NetworkConfig } from "../src/config";
import { derivePoolStatePDA, deriveVkRegistryPDA } from "../src/pda";

// =============================================================================
// Configuration
// =============================================================================

const NETWORK = (process.env.NETWORK || "devnet") as "localnet" | "devnet";
const DRY_RUN = process.env.DRY_RUN === "true";
const KEYPAIR_PATH =
  process.env.KEYPAIR_PATH ||
  path.join(process.env.HOME || "~", ".config/solana/johnny.json");

const CIRCUITS_BUILD_DIR = path.resolve(__dirname, "../../circuits/build");

const RPC_URL =
  NETWORK === "devnet"
    ? "https://api.devnet.solana.com"
    : "http://127.0.0.1:8899";
const WS_URL =
  NETWORK === "devnet"
    ? "wss://api.devnet.solana.com"
    : "ws://127.0.0.1:8900";

// Auto-discover all variants from circuits/build directory
function discoverVariants(): [number, number][] {
  const variants: [number, number][] = [];
  if (!fs.existsSync(CIRCUITS_BUILD_DIR)) return variants;
  for (const entry of fs.readdirSync(CIRCUITS_BUILD_DIR)) {
    const match = entry.match(/^joinsplit_(\d+)x(\d+)$/);
    if (!match) continue;
    const vkPath = path.join(CIRCUITS_BUILD_DIR, entry, `${entry}.vkey.json`);
    if (fs.existsSync(vkPath)) {
      variants.push([parseInt(match[1]), parseInt(match[2])]);
    }
  }
  // Sort by N then M for consistent ordering
  return variants.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

const ALL_VARIANTS = discoverVariants();

// =============================================================================
// VK Serialization (matches on-chain verification format)
// =============================================================================

/**
 * Serialize a G1 point from snarkjs VK format to 64 bytes (big-endian x, y)
 */
function serializeG1(point: string[]): Buffer {
  const x = BigInt(point[0]);
  const y = BigInt(point[1]);
  const buf = Buffer.alloc(64);
  const xBytes = x.toString(16).padStart(64, "0");
  const yBytes = y.toString(16).padStart(64, "0");
  Buffer.from(xBytes, "hex").copy(buf, 0);
  Buffer.from(yBytes, "hex").copy(buf, 32);
  return buf;
}

/**
 * Serialize a G2 point from snarkjs VK format to 128 bytes
 * snarkjs format: [[x_imag, x_real], [y_imag, y_real]]
 */
function serializeG2(point: string[][]): Buffer {
  const buf = Buffer.alloc(128);
  const xImag = BigInt(point[0][0]).toString(16).padStart(64, "0");
  const xReal = BigInt(point[0][1]).toString(16).padStart(64, "0");
  const yImag = BigInt(point[1][0]).toString(16).padStart(64, "0");
  const yReal = BigInt(point[1][1]).toString(16).padStart(64, "0");
  Buffer.from(xImag, "hex").copy(buf, 0);
  Buffer.from(xReal, "hex").copy(buf, 32);
  Buffer.from(yImag, "hex").copy(buf, 64);
  Buffer.from(yReal, "hex").copy(buf, 96);
  return buf;
}

/**
 * Compute SHA-256 hash of a serialized VK
 */
function computeVkHash(vkJson: any): string {
  const parts: Buffer[] = [];

  // Alpha G1 (64 bytes)
  parts.push(serializeG1(vkJson.vk_alpha_1));
  // Beta G2 (128 bytes)
  parts.push(serializeG2(vkJson.vk_beta_2));
  // Gamma G2 (128 bytes)
  parts.push(serializeG2(vkJson.vk_gamma_2));
  // Delta G2 (128 bytes)
  parts.push(serializeG2(vkJson.vk_delta_2));
  // IC points (64 bytes each)
  for (const ic of vkJson.IC) {
    parts.push(serializeG1(ic));
  }

  const serialized = Buffer.concat(parts);
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

// =============================================================================
// Instruction Builder
// =============================================================================

/**
 * Build init_vk_registry instruction
 *
 * Discriminator: 11 (INIT_VK_REGISTRY)
 * Data: [disc(1), n_inputs(1), n_outputs(1), vk_hash(32)]
 */
function buildInitVkRegistryInstruction(
  programId: Address,
  poolStatePda: Address,
  vkRegistryPda: Address,
  authority: KeyPairSigner,
  nInputs: number,
  nOutputs: number,
  vkHash: string
): IInstruction {
  const data = new Uint8Array(35);
  data[0] = 11; // INIT_VK_REGISTRY discriminator
  data[1] = nInputs;
  data[2] = nOutputs;
  const hashBytes = Buffer.from(vkHash, "hex");
  data.set(hashBytes, 3);

  return {
    programAddress: programId,
    accounts: [
      { address: poolStatePda, role: AccountRole.READONLY },
      { address: vkRegistryPda, role: AccountRole.WRITABLE },
      { address: authority.address, role: AccountRole.WRITABLE_SIGNER, signer: authority },
      {
        address: address("11111111111111111111111111111111"),
        role: AccountRole.READONLY,
      },
    ],
    data,
  };
}

/**
 * Build update_vk_registry instruction
 *
 * Discriminator: 12 (UPDATE_VK_REGISTRY)
 * Data: [disc(1), n_inputs(1), n_outputs(1), vk_hash(32)]
 */
function buildUpdateVkRegistryInstruction(
  programId: Address,
  vkRegistryPda: Address,
  authority: KeyPairSigner,
  nInputs: number,
  nOutputs: number,
  vkHash: string
): IInstruction {
  const data = new Uint8Array(35);
  data[0] = 12; // UPDATE_VK_REGISTRY discriminator
  data[1] = nInputs;
  data[2] = nOutputs;
  const hashBytes = Buffer.from(vkHash, "hex");
  data.set(hashBytes, 3);

  return {
    programAddress: programId,
    accounts: [
      { address: vkRegistryPda, role: AccountRole.WRITABLE },
      { address: authority.address, role: AccountRole.WRITABLE_SIGNER, signer: authority },
    ],
    data,
  };
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log("=== Register JoinSplit VK Hashes ===\n");
  console.log(`Network: ${NETWORK}`);
  console.log(`Circuits dir: ${CIRCUITS_BUILD_DIR}`);
  console.log(`Dry run: ${DRY_RUN}\n`);

  // Set SDK config
  setConfig(NETWORK);
  const config = getConfig();

  // Discover JoinSplit VK files
  const vkHashes: Record<string, string> = {};
  const variants: [number, number][] = [];

  for (const [n, m] of ALL_VARIANTS) {
    const circuitName = `joinsplit_${n}x${m}`;
    const vkPath = path.join(
      CIRCUITS_BUILD_DIR,
      circuitName,
      `${circuitName}.vkey.json`
    );

    if (!fs.existsSync(vkPath)) {
      console.warn(`  SKIP ${circuitName} — VK not found at ${vkPath}`);
      continue;
    }

    const vkJson = JSON.parse(fs.readFileSync(vkPath, "utf-8"));
    const hash = computeVkHash(vkJson);
    vkHashes[`${n}x${m}`] = hash;
    variants.push([n, m]);

    console.log(`  ${circuitName}: ${hash}`);
  }

  if (variants.length === 0) {
    console.error(
      "\nNo JoinSplit VK files found. Run circuits compile + setup first."
    );
    process.exit(1);
  }

  console.log(`\nFound ${variants.length} JoinSplit variants.`);

  // Print config update snippet
  console.log("\n--- SDK config.ts update (joinSplitVkHashes) ---");
  console.log("joinSplitVkHashes: {");
  for (const [key, hash] of Object.entries(vkHashes)) {
    console.log(`  "${key}": "${hash}",`);
  }
  console.log("},");
  console.log("--- end ---\n");

  if (DRY_RUN) {
    console.log("Dry run complete. No transactions submitted.");
    return;
  }

  // Load authority keypair
  if (!fs.existsSync(KEYPAIR_PATH)) {
    console.error(`Keypair not found: ${KEYPAIR_PATH}`);
    process.exit(1);
  }

  const keypairBytes = new Uint8Array(
    JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf-8"))
  );
  const authority = await createKeyPairSignerFromBytes(keypairBytes);

  console.log(`Authority: ${authority.address}`);

  // Setup RPC
  const rpc = createSolanaRpc(RPC_URL);
  const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);
  const sendAndConfirm = sendAndConfirmTransactionFactory({
    rpc,
    rpcSubscriptions,
  });

  // Derive pool state PDA
  const [poolStatePda] = await derivePoolStatePDA(config.utxopiaProgramId);

  // Register each variant
  for (const [n, m] of variants) {
    const key = `${n}x${m}`;
    const hash = vkHashes[key];
    const circuitName = `joinsplit_${n}x${m}`;

    console.log(`\nRegistering ${circuitName} (hash: ${hash.slice(0, 16)}...)`);

    // Derive VK registry PDA
    const [vkRegistryPda] = await deriveVkRegistryPDA(
      n,
      m,
      config.utxopiaProgramId
    );
    console.log(`  VK Registry PDA: ${vkRegistryPda}`);

    // Check if already registered
    let alreadyExists = false;
    try {
      const account = await rpc
        .getAccountInfo(vkRegistryPda, { encoding: "base64" })
        .send();
      if (account.value) {
        alreadyExists = true;
      }
    } catch {
      // Account doesn't exist, proceed with init
    }

    // Build instruction (init or update)
    let ix: IInstruction;
    if (alreadyExists) {
      console.log(`  Exists — updating VK hash...`);
      ix = buildUpdateVkRegistryInstruction(
        config.utxopiaProgramId,
        vkRegistryPda,
        authority,
        n,
        m,
        hash
      );
    } else {
      ix = buildInitVkRegistryInstruction(
        config.utxopiaProgramId,
        poolStatePda,
        vkRegistryPda,
        authority,
        n,
        m,
        hash
      );
    }

    // Build and send transaction
    const { value: latestBlockhash } = await rpc
      .getLatestBlockhash()
      .send();

    const txMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (msg) => setTransactionMessageFeePayer(authority.address, msg),
      (msg) =>
        setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, msg),
      (msg) => appendTransactionMessageInstruction(ix, msg)
    );

    const signedTx = await signTransactionMessageWithSigners(txMessage);
    const sig = getSignatureFromTransaction(signedTx);

    try {
      await sendAndConfirm(signedTx, { commitment: "confirmed" });
      console.log(`  Registered! Tx: ${sig}`);
    } catch (err) {
      console.error(`  Failed to register ${circuitName}:`, err);
    }
  }

  console.log("\n=== Done ===");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
