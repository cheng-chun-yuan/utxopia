# Scripts Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate duplicated script logic into a shared module, delete dead/buggy scripts, and make all scripts network-aware (localnet + devnet).

**Architecture:** Extract shared helpers (keypair loading, state files, RPC URL, PDA derivation, instruction sending) into `scripts/lib/common.ts`. Convert all `.mjs` scripts to `.ts` importing from the shared module. Delete `topup-all.mjs` (buggy ECDH), `start-localnet.sh` (superseded by `setup.sh`), and `upload-circuits-r2.sh` (no aegis-app copy exists, but only used once — keep as standalone). Remove inline token registration from `init-devnet.mjs` — call `register-token.ts` instead.

**Tech Stack:** TypeScript (bun), @solana/web3.js, @solana/spl-token

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `scripts/lib/common.ts` | **Create** | Shared helpers: `loadKeypair()`, `loadState()`, `getConnection()`, `getRpcUrl()`, PDA derivation, `sendIx()`, constants |
| `scripts/topup-all.mjs` | **Delete** | Buggy Node.js ECDH — `.ts` version is correct |
| `scripts/start-localnet.sh` | **Delete** | Superseded by `setup.sh localnet` |
| `scripts/init-devnet.ts` | **Create** (replaces `init-devnet.mjs`) | Pool init + calls `register-token.ts` for each token |
| `scripts/init-devnet.mjs` | **Delete** | Replaced by `.ts` version |
| `scripts/register-vk-hashes.ts` | **Create** (replaces `.mjs`) | VK hash registration using shared module |
| `scripts/register-vk-hashes.mjs` | **Delete** | Replaced by `.ts` version |
| `scripts/propose-pool-update.ts` | **Create** (replaces `.mjs`) | Pool update proposal using shared module |
| `scripts/propose-pool-update.mjs` | **Delete** | Replaced by `.ts` version |
| `scripts/execute-pool-update.ts` | **Create** (replaces `.mjs`) | Pool update execution using shared module |
| `scripts/execute-pool-update.mjs` | **Delete** | Replaced by `.ts` version |
| `scripts/init-btc-light-client.ts` | **Create** (replaces `.mjs`) | BTC Light Client init using shared module |
| `scripts/init-btc-light-client.mjs` | **Delete** | Replaced by `.ts` version |
| `scripts/verify-deposits.ts` | **Modify** | Use shared module for keypair/connection/PDA |
| `scripts/register-token.ts` | **Modify** | Use shared module for keypair/connection |
| `scripts/topup-all.ts` | **Modify** | Use shared module for state loading |

---

### Task 1: Create `scripts/lib/common.ts` — Shared Module

**Files:**
- Create: `scripts/lib/common.ts`

- [ ] **Step 1: Create the shared module**

```typescript
#!/usr/bin/env bun
/**
 * Shared utilities for Aegis admin/deployment scripts.
 *
 * Provides network-aware connection, keypair loading, state file access,
 * PDA derivation, and transaction helpers.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

// =============================================================================
// Paths
// =============================================================================

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_ROOT = path.resolve(SCRIPTS_DIR, "..");

export const DEVNET_STATE_FILE = path.join(SCRIPTS_DIR, "devnet-state.json");
export const LOCALNET_STATE_FILE = path.join(SCRIPTS_DIR, "e2e/localnet-state.json");

// =============================================================================
// Network Detection
// =============================================================================

export type Network = "localnet" | "devnet";

/** Detect network from AEGIS_NETWORK env, or infer from RPC_URL, or default to devnet */
export function detectNetwork(): Network {
  const env = process.env.AEGIS_NETWORK;
  if (env === "localnet" || env === "local") return "localnet";
  if (env === "devnet" || env === "dev") return "devnet";
  // Infer from RPC_URL
  const rpc = process.env.RPC_URL || "";
  if (rpc.includes("localhost") || rpc.includes("127.0.0.1")) return "localnet";
  return "devnet";
}

export function getRpcUrl(network?: Network): string {
  if (process.env.RPC_URL) return process.env.RPC_URL;
  const net = network ?? detectNetwork();
  return net === "localnet"
    ? "http://127.0.0.1:8899"
    : "https://api.devnet.solana.com";
}

export function getConnection(network?: Network): Connection {
  return new Connection(getRpcUrl(network), "confirmed");
}

// =============================================================================
// State File
// =============================================================================

export interface ScriptState {
  aegisProgramId: string;
  btcLightClientId?: string;
  chadbufferId?: string;
  zkbtcMint: string;
  poolState: string;
  commitmentTree?: string;
  poolVault?: string;
  frostVault?: string;
  authority?: string;
  tUsdcMint?: string;
  tUsdcVault?: string;
  tWsolMint?: string;
  tWsolVault?: string;
  poolBtcAddress?: string;
  signingMode?: string;
  [key: string]: unknown;
}

export function getStateFilePath(network?: Network): string {
  const net = network ?? detectNetwork();
  return net === "localnet" ? LOCALNET_STATE_FILE : DEVNET_STATE_FILE;
}

export function loadState(network?: Network): ScriptState {
  const stateFile = getStateFilePath(network);
  if (!fs.existsSync(stateFile)) {
    throw new Error(`State file not found: ${stateFile}. Run deploy or e2e first.`);
  }
  return JSON.parse(fs.readFileSync(stateFile, "utf-8"));
}

export function saveState(state: ScriptState, network?: Network): void {
  const stateFile = getStateFilePath(network);
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
}

// =============================================================================
// Keypair Loading
// =============================================================================

/** Load authority keypair from KEYPAIR_PATH env, or RELAYER_KEYPAIR in .env file, or default */
export function loadKeypair(): Keypair {
  // 1. KEYPAIR_PATH env var
  if (process.env.KEYPAIR_PATH) {
    const kpPath = process.env.KEYPAIR_PATH.replace("~", process.env.HOME!);
    const data = JSON.parse(fs.readFileSync(kpPath, "utf-8"));
    return Keypair.fromSecretKey(Uint8Array.from(data));
  }

  // 2. RELAYER_KEYPAIR from backend .env
  const net = detectNetwork();
  const envPath = path.join(PROJECT_ROOT, `backend/.env.${net}`);
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, "utf-8");
    const match = content.match(/RELAYER_KEYPAIR=(\[[\d,\s]+\])/);
    if (match) {
      return Keypair.fromSecretKey(new Uint8Array(JSON.parse(match[1])));
    }
  }

  // 3. Default keypair
  const defaultPath = path.join(process.env.HOME!, ".config/solana/johnny.json");
  if (fs.existsSync(defaultPath)) {
    const data = JSON.parse(fs.readFileSync(defaultPath, "utf-8"));
    return Keypair.fromSecretKey(Uint8Array.from(data));
  }

  // 4. Solana default
  const solanaDefault = path.join(process.env.HOME!, ".config/solana/id.json");
  const data = JSON.parse(fs.readFileSync(solanaDefault, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(data));
}

// =============================================================================
// Program IDs from state
// =============================================================================

export function getProgramId(state: ScriptState): PublicKey {
  return new PublicKey(state.aegisProgramId);
}

export function getBtcLightClientId(state: ScriptState): PublicKey {
  if (!state.btcLightClientId) throw new Error("btcLightClientId not in state file");
  return new PublicKey(state.btcLightClientId);
}

// =============================================================================
// Constants
// =============================================================================

export const TOKEN_2022 = TOKEN_2022_PROGRAM_ID;
export const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export const Disc = {
  INITIALIZE: 0,
  VERIFY_STEALTH_DEPOSIT: 1,
  REQUEST_REDEMPTION: 5,
  COMPLETE_REDEMPTION: 6,
  INIT_VK_REGISTRY: 11,
  TRANSACT: 14,
  PROPOSE_POOL_UPDATE: 21,
  EXECUTE_POOL_UPDATE: 22,
  CANCEL_POOL_UPDATE: 23,
  REGISTER_TOKEN: 28,
  SHIELD: 29,
  UNSHIELD: 30,
} as const;

export const Seeds = {
  POOL_STATE: "pool_state",
  COMMITMENT_TREE: "commitment_tree",
  VK_REGISTRY: "vk_registry",
  NULLIFIER: "nullifier",
  TOKEN_CONFIG: "token_config",
  BTC_LIGHT_CLIENT: "btc_light_client",
  BLOCK: "block",
  HEIGHT_INDEX: "height_index",
  DEPOSIT: "deposit",
  REDEMPTION: "redemption",
  UTXO: "utxo",
};

// =============================================================================
// PDA Derivation
// =============================================================================

export function derivePoolStatePDA(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from(Seeds.POOL_STATE)], programId);
}

export function deriveCommitmentTreePDA(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from(Seeds.COMMITMENT_TREE)], programId);
}

export function deriveVkRegistryPDA(programId: PublicKey, nIn: number, nOut: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(Seeds.VK_REGISTRY), Buffer.from([nIn]), Buffer.from([nOut])],
    programId,
  );
}

export function deriveTokenConfigPDA(programId: PublicKey, mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(Seeds.TOKEN_CONFIG), mint.toBuffer()],
    programId,
  );
}

export function deriveLightClientPDA(btcLcId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from(Seeds.BTC_LIGHT_CLIENT)], btcLcId);
}

export function deriveHeightIndexPDA(btcLcId: PublicKey, height: bigint): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(height);
  return PublicKey.findProgramAddressSync([Buffer.from(Seeds.HEIGHT_INDEX), buf], btcLcId);
}

export function deriveBlockHeaderPDA(btcLcId: PublicKey, blockHash: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from(Seeds.BLOCK), Buffer.from(blockHash)], btcLcId);
}

export function deriveATA(mint: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_2022.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM,
  )[0];
}

export function deriveDepositRecordPDA(programId: PublicKey, txid: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(Seeds.DEPOSIT), Buffer.from(txid)],
    programId,
  );
}

// =============================================================================
// Transaction Helpers
// =============================================================================

export async function sendIx(
  connection: Connection,
  ixs: TransactionInstruction[],
  signers: Keypair[],
  cu = 400_000,
): Promise<string> {
  const budget = ComputeBudgetProgram.setComputeUnitLimit({ units: cu });
  const tx = new Transaction().add(budget, ...ixs);
  return sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
}

export async function sendSimple(
  connection: Connection,
  payer: Keypair,
  ix: TransactionInstruction,
): Promise<string> {
  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  return sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });
}

// =============================================================================
// ATA Creation Helper
// =============================================================================

export function makeCreateAtaIx(
  payer: PublicKey,
  vault: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    data: Buffer.alloc(0),
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

// =============================================================================
// Logging
// =============================================================================

export function log(msg: string): void {
  console.log(`  ${msg}`);
}

export function stepHeader(title: string): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(title);
  console.log("=".repeat(60));
}
```

- [ ] **Step 2: Verify the module compiles**

Run: `cd /Users/chengchunyuan/project/hackathon/private_bitcoin_bridge && bun build scripts/lib/common.ts --no-bundle 2>&1 | head -20`
Expected: No TypeScript errors

- [ ] **Step 3: Commit**

```bash
git add scripts/lib/common.ts
git commit -m "feat(scripts): add shared common.ts module for script consolidation"
```

---

### Task 2: Delete Dead Scripts

**Files:**
- Delete: `scripts/topup-all.mjs`
- Delete: `scripts/start-localnet.sh`

- [ ] **Step 1: Delete `topup-all.mjs`**

This script uses Node.js `crypto.convertKey` for ECDH which produces wrong X25519 scalars. The `.ts` version uses the SDK and is correct.

```bash
rm scripts/topup-all.mjs
```

- [ ] **Step 2: Delete `start-localnet.sh`**

Fully superseded by `setup.sh localnet` which calls the E2E suite.

```bash
rm scripts/start-localnet.sh
```

- [ ] **Step 3: Commit**

```bash
git add -u scripts/topup-all.mjs scripts/start-localnet.sh
git commit -m "chore: remove topup-all.mjs (buggy ECDH) and start-localnet.sh (superseded by setup.sh)"
```

---

### Task 3: Convert `init-btc-light-client.mjs` → `.ts`

**Files:**
- Create: `scripts/init-btc-light-client.ts`
- Delete: `scripts/init-btc-light-client.mjs`

- [ ] **Step 1: Write `init-btc-light-client.ts`**

**NOTE:** Must accept `BTC_LIGHT_CLIENT_PROGRAM_ID` env var directly (deploy-devnet.sh passes it this way), falling back to state file.

```typescript
#!/usr/bin/env bun
/**
 * Initialize BTC Light Client with genesis block from mempool.space.
 *
 * Usage: bun run scripts/init-btc-light-client.ts
 *
 * Env vars:
 *   BTC_LIGHT_CLIENT_PROGRAM_ID — required (env var or state file)
 *   AEGIS_NETWORK    — localnet | devnet (default: devnet)
 *   BTC_API_URL      — mempool API base (default: per network)
 *   BTC_NETWORK_ID   — 0=mainnet, 1=testnet3, 2=testnet4, 3=regtest (default: 2)
 */

import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  loadKeypair,
  loadState,
  getConnection,
  deriveLightClientPDA,
  deriveHeightIndexPDA,
  deriveBlockHeaderPDA,
  sendSimple,
  stepHeader,
} from "./lib/common.ts";

const BTC_NETWORK_ID = parseInt(process.env.BTC_NETWORK_ID || "2", 10);
const BTC_API_URL = process.env.BTC_API_URL || "https://mempool.space/testnet4/api";

/** Get BTC Light Client program ID from env var first, then state file */
function resolveBtcLcId(): PublicKey {
  if (process.env.BTC_LIGHT_CLIENT_PROGRAM_ID) {
    return new PublicKey(process.env.BTC_LIGHT_CLIENT_PROGRAM_ID);
  }
  const state = loadState();
  if (state.btcLightClientId) return new PublicKey(state.btcLightClientId);
  throw new Error("BTC_LIGHT_CLIENT_PROGRAM_ID required (env var or state file)");
}

function hexToBytesReversed(hex: string): Buffer {
  const buf = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) {
    buf[31 - i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return buf;
}

async function main() {
  const conn = getConnection();
  const authority = loadKeypair();
  const btcLcId = resolveBtcLcId();

  stepHeader("Initialize BTC Light Client");
  console.log("BTC Light Client:", btcLcId.toBase58());
  console.log("Authority:", authority.publicKey.toBase58());
  console.log("BTC API:", BTC_API_URL);

  // Check if already initialized
  const [lightClientPda] = deriveLightClientPDA(btcLcId);
  console.log("Light Client PDA:", lightClientPda.toBase58());

  const existing = await conn.getAccountInfo(lightClientPda);
  if (existing?.data?.length && existing.data[0] === 0x01) {
    console.log("BTC Light Client already initialized — skipping");
    return;
  }

  // Fetch tip
  console.log("\nFetching tip...");
  const tipRes = await fetch(`${BTC_API_URL}/blocks/tip/height`);
  if (!tipRes.ok) throw new Error(`Failed to fetch tip: ${tipRes.statusText}`);
  const tipHeight = parseInt(await tipRes.text(), 10);

  const startHeight = tipHeight - 10;
  console.log(`Tip: ${tipHeight}, Genesis: ${startHeight}`);

  const hashRes = await fetch(`${BTC_API_URL}/block-height/${startHeight}`);
  if (!hashRes.ok) throw new Error(`Failed to fetch block hash: ${hashRes.statusText}`);
  const blockHashHex = await hashRes.text();
  const blockHashBytes = hexToBytesReversed(blockHashHex);

  // Derive PDAs
  const [heightIndexPda] = deriveHeightIndexPDA(btcLcId, BigInt(startHeight));
  const [blockHeaderPda] = deriveBlockHeaderPDA(btcLcId, blockHashBytes);

  // Build initialize instruction (disc=0, 42 bytes)
  const data = Buffer.alloc(42);
  data[0] = 0;
  data.writeBigUInt64LE(BigInt(startHeight), 1);
  blockHashBytes.copy(data, 9);
  data[41] = BTC_NETWORK_ID;

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: lightClientPda, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: heightIndexPda, isSigner: false, isWritable: true },
      { pubkey: blockHeaderPda, isSigner: false, isWritable: true },
    ],
    programId: btcLcId,
    data,
  });

  console.log("\nSending initialize transaction...");
  const sig = await sendSimple(conn, authority, ix);
  console.log(`Initialized! Signature: ${sig}`);
  console.log(`Start height: ${startHeight}`);
}

main().catch(err => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
```

- [ ] **Step 2: Delete old `.mjs` version**

```bash
rm scripts/init-btc-light-client.mjs
```

- [ ] **Step 3: Test it compiles**

```bash
bun build scripts/init-btc-light-client.ts --no-bundle 2>&1 | head -10
```

- [ ] **Step 4: Commit**

```bash
git add scripts/init-btc-light-client.ts
git add -u scripts/init-btc-light-client.mjs
git commit -m "refactor: convert init-btc-light-client to .ts using shared module"
```

---

### Task 4: Convert `register-vk-hashes.mjs` → `.ts`

**Files:**
- Create: `scripts/register-vk-hashes.ts`
- Delete: `scripts/register-vk-hashes.mjs`

- [ ] **Step 1: Write `register-vk-hashes.ts`**

```typescript
#!/usr/bin/env bun
/**
 * Register verification key hashes for all compiled JoinSplit circuits.
 *
 * Usage: bun run scripts/register-vk-hashes.ts
 */

import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  loadKeypair,
  loadState,
  getConnection,
  getProgramId,
  derivePoolStatePDA,
  deriveVkRegistryPDA,
  sendSimple,
  Disc,
  stepHeader,
} from "./lib/common.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function computeVkHash(vkJson: any): Buffer {
  const parts: string[] = [];
  parts.push(vkJson.vk_alpha_1[0], vkJson.vk_alpha_1[1]);
  parts.push(vkJson.vk_beta_2[0][0], vkJson.vk_beta_2[0][1], vkJson.vk_beta_2[1][0], vkJson.vk_beta_2[1][1]);
  parts.push(vkJson.vk_gamma_2[0][0], vkJson.vk_gamma_2[0][1], vkJson.vk_gamma_2[1][0], vkJson.vk_gamma_2[1][1]);
  parts.push(vkJson.vk_delta_2[0][0], vkJson.vk_delta_2[0][1], vkJson.vk_delta_2[1][0], vkJson.vk_delta_2[1][1]);
  for (const ic of vkJson.IC) {
    parts.push(ic[0], ic[1]);
  }
  const serialized = parts.map(x => {
    const hex = BigInt(x).toString(16).padStart(64, "0");
    return Buffer.from(hex, "hex");
  });
  return crypto.createHash("sha256").update(Buffer.concat(serialized)).digest();
}

async function main() {
  const state = loadState();
  const conn = getConnection();
  const authority = loadKeypair();
  const programId = getProgramId(state);
  const [poolState] = derivePoolStatePDA(programId);

  stepHeader("Register VK Hashes");
  console.log("Authority:", authority.publicKey.toBase58());
  console.log("Program:", programId.toBase58());

  const buildDir = path.join(ROOT, "circuits/build");
  const circuitDirs = fs.readdirSync(buildDir).filter(d => d.startsWith("joinsplit_"));
  const circuits = circuitDirs
    .map(d => {
      const m = d.match(/^joinsplit_(\d+)x(\d+)$/);
      return m ? [parseInt(m[1]), parseInt(m[2])] as [number, number] : null;
    })
    .filter((c): c is [number, number] => c !== null)
    .sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]) || a[0] - b[0]);

  for (const [nIn, nOut] of circuits) {
    const name = `joinsplit_${nIn}x${nOut}`;
    const vkPath = path.join(buildDir, name, `${name}.vkey.json`);

    if (!fs.existsSync(vkPath)) {
      console.log(`  ${name}: no vkey.json, skipping`);
      continue;
    }

    const [vkRegistry] = deriveVkRegistryPDA(programId, nIn, nOut);
    const existing = await conn.getAccountInfo(vkRegistry);
    if (existing?.data?.length && existing.data[0] === 0x14) {
      console.log(`  ${name}: already registered`);
      continue;
    }

    const vkJson = JSON.parse(fs.readFileSync(vkPath, "utf-8"));
    const vkHash = computeVkHash(vkJson);
    console.log(`  ${name}: registering VK hash ${vkHash.toString("hex").slice(0, 16)}...`);

    const data = Buffer.alloc(35);
    data[0] = Disc.INIT_VK_REGISTRY;
    data[1] = nIn;
    data[2] = nOut;
    vkHash.copy(data, 3);

    const ix = new TransactionInstruction({
      keys: [
        { pubkey: poolState, isSigner: false, isWritable: false },
        { pubkey: vkRegistry, isSigner: false, isWritable: true },
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId,
      data,
    });

    const sig = await sendSimple(conn, authority, ix);
    console.log(`  ${name}: registered! tx=${sig.slice(0, 20)}...`);
  }

  console.log("Done!");
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Delete old `.mjs`, commit**

```bash
rm scripts/register-vk-hashes.mjs
git add scripts/register-vk-hashes.ts
git add -u scripts/register-vk-hashes.mjs
git commit -m "refactor: convert register-vk-hashes to .ts using shared module"
```

---

### Task 5: Convert `propose-pool-update.mjs` and `execute-pool-update.mjs` → `.ts`

**Files:**
- Create: `scripts/propose-pool-update.ts`
- Create: `scripts/execute-pool-update.ts`
- Delete: `scripts/propose-pool-update.mjs`
- Delete: `scripts/execute-pool-update.mjs`

- [ ] **Step 1: Write `propose-pool-update.ts`**

```typescript
#!/usr/bin/env bun
/**
 * Propose pool parameter update (48h timelock).
 *
 * Usage: bun run scripts/propose-pool-update.ts [--fee-base 2000] [--fee-bps 30]
 */

import { TransactionInstruction } from "@solana/web3.js";
import {
  loadKeypair,
  loadState,
  getConnection,
  getProgramId,
  derivePoolStatePDA,
  sendSimple,
  Disc,
  stepHeader,
} from "./lib/common.ts";

const args = process.argv.slice(2);
function getArg(name: string, def: string): string {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : def;
}

const NEW_FEE_BASE = BigInt(getArg("--fee-base", "2000"));
const NEW_FEE_BPS = parseInt(getArg("--fee-bps", "30"), 10);

async function main() {
  const state = loadState();
  const conn = getConnection();
  const authority = loadKeypair();
  const programId = getProgramId(state);
  const [poolStatePDA] = derivePoolStatePDA(programId);

  stepHeader("Propose Pool Update");
  console.log("Authority:", authority.publicKey.toBase58());
  console.log("Pool State:", poolStatePDA.toBase58());

  const poolAccount = await conn.getAccountInfo(poolStatePDA);
  if (!poolAccount) { console.error("Pool state not found!"); process.exit(1); }

  const data = poolAccount.data;
  const currentMinDeposit = data.readBigUInt64LE(172);
  const currentMaxDeposit = data.readBigUInt64LE(180);
  const currentFeeBase = data.readBigUInt64LE(196);
  const currentFeeBps = data.readUInt16LE(244);

  console.log("\nCurrent:", { feeBase: currentFeeBase.toString(), feeBps: currentFeeBps });
  console.log("Proposed:", { feeBase: NEW_FEE_BASE.toString(), feeBps: NEW_FEE_BPS });

  const ixData = Buffer.alloc(27);
  ixData[0] = Disc.PROPOSE_POOL_UPDATE;
  ixData.writeBigUInt64LE(currentMinDeposit, 1);
  ixData.writeBigUInt64LE(currentMaxDeposit, 9);
  ixData.writeBigUInt64LE(NEW_FEE_BASE, 17);
  ixData.writeUInt16LE(NEW_FEE_BPS, 25);

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: poolStatePDA, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
    ],
    data: ixData,
  });

  const sig = await sendSimple(conn, authority, ix);
  console.log("\nProposal submitted!", sig);
  console.log("Run `bun run scripts/execute-pool-update.ts` after 48h.");
}

main().catch(err => { console.error("Failed:", err.message); process.exit(1); });
```

- [ ] **Step 2: Write `execute-pool-update.ts`**

```typescript
#!/usr/bin/env bun
/**
 * Execute a pending pool parameter update after timelock expires.
 *
 * Usage: bun run scripts/execute-pool-update.ts
 */

import { TransactionInstruction } from "@solana/web3.js";
import {
  loadKeypair,
  loadState,
  getConnection,
  getProgramId,
  derivePoolStatePDA,
  sendSimple,
  Disc,
  stepHeader,
} from "./lib/common.ts";

async function main() {
  const state = loadState();
  const conn = getConnection();
  const payer = loadKeypair();
  const programId = getProgramId(state);
  const [poolStatePDA] = derivePoolStatePDA(programId);

  stepHeader("Execute Pool Update");
  console.log("Payer:", payer.publicKey.toBase58());

  const poolAccount = await conn.getAccountInfo(poolStatePDA);
  if (!poolAccount) { console.error("Pool state not found!"); process.exit(1); }

  const data = poolAccount.data;
  const pendingExecuteAfter = Number(data.readBigInt64LE(236));
  if (pendingExecuteAfter === 0) { console.log("No pending proposal."); return; }

  const now = Math.floor(Date.now() / 1000);
  const remaining = pendingExecuteAfter - now;
  console.log("Execute after:", new Date(pendingExecuteAfter * 1000).toISOString());

  if (remaining > 0) {
    const hours = Math.floor(remaining / 3600);
    const mins = Math.floor((remaining % 3600) / 60);
    console.log(`Timelock not expired. ${hours}h ${mins}m remaining.`);
    process.exit(1);
  }

  const ix = new TransactionInstruction({
    programId,
    keys: [{ pubkey: poolStatePDA, isSigner: false, isWritable: true }],
    data: Buffer.from([Disc.EXECUTE_POOL_UPDATE]),
  });

  const sig = await sendSimple(conn, payer, ix);
  console.log("Executed!", sig);

  const updated = await conn.getAccountInfo(poolStatePDA);
  if (updated) {
    console.log("\nNew config:");
    console.log("  fee_base:", updated.data.readBigUInt64LE(196).toString());
    console.log("  fee_bps:", updated.data.readUInt16LE(244));
  }
}

main().catch(err => { console.error("Failed:", err.message); process.exit(1); });
```

- [ ] **Step 3: Delete old `.mjs` files, commit**

```bash
rm scripts/propose-pool-update.mjs scripts/execute-pool-update.mjs
git add scripts/propose-pool-update.ts scripts/execute-pool-update.ts
git add -u scripts/propose-pool-update.mjs scripts/execute-pool-update.mjs
git commit -m "refactor: convert pool-update scripts to .ts using shared module"
```

---

### Task 6: Rewrite `init-devnet.mjs` → `.ts` (calls `register-token.ts`)

**Files:**
- Create: `scripts/init-devnet.ts`
- Delete: `scripts/init-devnet.mjs`

**CRITICAL:** This script is called by `deploy-devnet.sh` Phase 3 which:
1. Passes `AEGIS_PROGRAM_ID` as env var (state file may not have it yet)
2. Parses stdout for lines like `"Mint created:"`, `"Pool State PDA:"`, `"tUSDC Mint:"`, etc.
3. Uses `bun run` (not `node`) — Task 8 must also update this

So this script MUST: accept `AEGIS_PROGRAM_ID` env var, and print the same stdout format as the old `.mjs`.

- [ ] **Step 1: Write `init-devnet.ts`**

```typescript
#!/usr/bin/env bun
/**
 * Initialize Aegis program (fresh deploy).
 *
 * Creates: Token-2022 mint, pool vault ATA, frost vault ATA,
 *          pool state PDA, commitment tree PDA.
 * Then calls register-token.ts for each token (zkBTC, wSOL, tUSDC, tUSDT).
 *
 * Usage: bun run scripts/init-devnet.ts
 *
 * Env vars:
 *   AEGIS_PROGRAM_ID — required (env var or state file)
 *   RPC_URL / AEGIS_NETWORK — network selection
 *   KEYPAIR_PATH — authority keypair
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
import {
  loadKeypair,
  getConnection,
  getStateFilePath,
  derivePoolStatePDA,
  deriveCommitmentTreePDA,
  deriveATA,
  makeCreateAtaIx,
  sendSimple,
  TOKEN_2022,
  stepHeader,
  type ScriptState,
} from "./lib/common.ts";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Resolve program ID from env var first, then state file */
function resolveProgramId(): PublicKey {
  if (process.env.AEGIS_PROGRAM_ID) return new PublicKey(process.env.AEGIS_PROGRAM_ID);
  const stateFile = getStateFilePath();
  if (fs.existsSync(stateFile)) {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    if (state.aegisProgramId) return new PublicKey(state.aegisProgramId);
  }
  throw new Error("AEGIS_PROGRAM_ID required (env var or state file)");
}

async function main() {
  const conn = getConnection();
  const authority = loadKeypair();
  const programId = resolveProgramId();

  stepHeader("Initialize Aegis Pool");
  console.log("Authority:", authority.publicKey.toBase58());
  console.log("Program:", programId.toBase58());

  const [poolState, poolBump] = derivePoolStatePDA(programId);
  const [commitTree, treeBump] = deriveCommitmentTreePDA(programId);
  console.log("Pool State PDA:", poolState.toBase58());
  console.log("Commitment Tree PDA:", commitTree.toBase58());

  // Check if already initialized — print same format as old .mjs for deploy-devnet.sh parsing
  const existingPool = await conn.getAccountInfo(poolState);
  if (existingPool?.data?.length && existingPool.data[0] === 0x01) {
    const mint = new PublicKey(existingPool.data.slice(36, 68));
    console.log("\nPool already initialized!");
    console.log("zkBTC Mint:", mint.toBase58());
    console.log("Pool Vault:", deriveATA(mint, poolState).toBase58());
    return;
  }

  // 1. Create Token-2022 mint (0 decimals)
  console.log("\n--- Creating Token-2022 Mint ---");
  const mintKp = Keypair.generate();
  const createMint = SystemProgram.createAccount({
    fromPubkey: authority.publicKey,
    newAccountPubkey: mintKp.publicKey,
    lamports: await conn.getMinimumBalanceForRentExemption(82),
    space: 82,
    programId: TOKEN_2022,
  });

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
  await sendAndConfirmTransaction(conn, tx1, [authority, mintKp], { commitment: "confirmed" });
  console.log("Mint created:", mintKp.publicKey.toBase58());

  // 2. Create ATAs
  console.log("\n--- Creating ATAs ---");
  const poolVault = deriveATA(mintKp.publicKey, poolState);
  const frostVault = deriveATA(mintKp.publicKey, authority.publicKey);

  const tx2 = new Transaction().add(
    makeCreateAtaIx(authority.publicKey, poolVault, poolState, mintKp.publicKey),
    makeCreateAtaIx(authority.publicKey, frostVault, authority.publicKey, mintKp.publicKey),
  );
  await sendAndConfirmTransaction(conn, tx2, [authority], { commitment: "confirmed" });
  console.log("Pool Vault:", poolVault.toBase58());
  console.log("Frost Vault:", frostVault.toBase58());

  // 3. Initialize Pool
  console.log("\n--- Initializing Pool ---");
  const initData = Buffer.alloc(3);
  initData[0] = 0; // INITIALIZE
  initData[1] = poolBump;
  initData[2] = treeBump;

  await sendSimple(conn, authority, new TransactionInstruction({
    programId,
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

  // 4. Register tokens via register-token.ts
  const registerScript = path.join(SCRIPTS_DIR, "register-token.ts");

  const tokens = [
    { mint: mintKp.publicKey.toBase58(), args: "--service-fee 1000 --min-deposit 5000 --max-deposit 10000000000 --deposit-cap 2100000000000000", label: "zkBTC" },
    { mint: "9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP", args: "--service-fee 0 --min-deposit 10000000 --max-deposit 1000000000000 --deposit-cap 100000000000000", label: "wSOL" },
  ];

  for (const token of tokens) {
    console.log(`\n--- Registering ${token.label} ---`);
    try {
      execSync(`bun run ${registerScript} ${token.mint} ${token.args}`, {
        stdio: "inherit",
        env: { ...process.env },
      });
    } catch {
      console.log(`${token.label} registration skipped (may already exist or mint not available)`);
    }
  }

  // Create test stablecoins (tUSDC, tUSDT) — these need fresh mints
  // IMPORTANT: Print "tUSDC Mint:" / "tUSDT Mint:" for deploy-devnet.sh stdout parsing
  for (const label of ["tUSDC", "tUSDT"]) {
    console.log(`\n--- Creating + Registering ${label} ---`);
    const stableMintKp = Keypair.generate();
    const createStableMint = SystemProgram.createAccount({
      fromPubkey: authority.publicKey,
      newAccountPubkey: stableMintKp.publicKey,
      lamports: await conn.getMinimumBalanceForRentExemption(82),
      space: 82,
      programId: TOKEN_2022,
    });
    const stableInitData = Buffer.alloc(67);
    stableInitData[0] = 20;
    stableInitData[1] = 6; // 6 decimals
    stableInitData.set(authority.publicKey.toBuffer(), 2);
    stableInitData[34] = 0;

    const stableInitMint = new TransactionInstruction({
      programId: TOKEN_2022,
      keys: [{ pubkey: stableMintKp.publicKey, isSigner: false, isWritable: true }],
      data: stableInitData,
    });

    const txMint = new Transaction().add(createStableMint, stableInitMint);
    await sendAndConfirmTransaction(conn, txMint, [authority, stableMintKp], { commitment: "confirmed" });
    // Print in exact format deploy-devnet.sh expects
    console.log(`${label} Mint:`, stableMintKp.publicKey.toBase58());

    try {
      execSync(`bun run ${registerScript} ${stableMintKp.publicKey.toBase58()} --service-fee 0 --min-deposit 100000 --max-deposit 1000000000000 --deposit-cap 10000000000000`, {
        stdio: "inherit",
        env: { ...process.env },
      });
    } catch {
      console.log(`${label} registration failed`);
    }
  }

  // Summary
  console.log("\n========================================");
  console.log("INITIALIZATION COMPLETE");
  console.log("========================================");
  console.log("Program ID:      ", programId.toBase58());
  console.log("zkBTC Mint:      ", mintKp.publicKey.toBase58());
  console.log("Pool State PDA:  ", poolState.toBase58());
  console.log("Commitment Tree: ", commitTree.toBase58());
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Delete old `.mjs`, commit**

```bash
rm scripts/init-devnet.mjs
git add scripts/init-devnet.ts
git add -u scripts/init-devnet.mjs
git commit -m "refactor: convert init-devnet to .ts, reuse register-token.ts for token registration"
```

---

### Task 7: Update `register-token.ts` and `verify-deposits.ts` to use shared module

**Files:**
- Modify: `scripts/register-token.ts` — replace inline keypair/state/connection setup with imports from `lib/common.ts`
- Modify: `scripts/verify-deposits.ts` — replace inline keypair/connection setup with imports from `lib/common.ts`

- [ ] **Step 1: Update `register-token.ts`**

Replace the "Load state" and keypair loading sections (lines 72-99) with:

```typescript
import {
  loadKeypair,
  loadState,
  getConnection,
  getProgramId,
  derivePoolStatePDA,
  deriveTokenConfigPDA,
  Disc,
} from "./lib/common.ts";

// ... (keep CLI arg parsing as-is)

const state = loadState();
const PROGRAM_ID = getProgramId(state);
const [POOL_STATE] = derivePoolStatePDA(PROGRAM_ID);
const authority = loadKeypair();
const connection = getConnection();
```

- [ ] **Step 2: Update `verify-deposits.ts`**

Replace the Configuration section (lines 33-50) with shared module imports for keypair, connection, and program IDs from state.

- [ ] **Step 3: Update `topup-all.ts`**

Replace inline state loading with `loadState("localnet")` from shared module.

- [ ] **Step 4: Commit**

```bash
git add scripts/register-token.ts scripts/verify-deposits.ts scripts/topup-all.ts
git commit -m "refactor: update remaining scripts to use shared lib/common.ts"
```

---

### Task 8: Update `deploy-devnet.sh` references

**Files:**
- Modify: `scripts/deploy-devnet.sh` — update script calls from `.mjs` to `.ts` AND `node` to `bun run`

**CRITICAL:** Three changes required:
1. `node "$ROOT/scripts/init-devnet.mjs"` → `bun run "$ROOT/scripts/init-devnet.ts"` (line ~231)
2. `bun run "$ROOT/scripts/register-vk-hashes.mjs"` → `bun run "$ROOT/scripts/register-vk-hashes.ts"` (line ~280)
3. `node "$ROOT/scripts/init-btc-light-client.mjs"` → `bun run "$ROOT/scripts/init-btc-light-client.ts"` (line ~299)

- [ ] **Step 1: Update Phase 3 (init-devnet)**

Change line ~231:
```
-    node "$ROOT/scripts/init-devnet.mjs" 2>&1)
+    bun run "$ROOT/scripts/init-devnet.ts" 2>&1)
```

- [ ] **Step 2: Update Phase 4 (register-vk-hashes)**

Change line ~280:
```
-    bun run "$ROOT/scripts/register-vk-hashes.mjs" 2>&1
+    bun run "$ROOT/scripts/register-vk-hashes.ts" 2>&1
```

- [ ] **Step 3: Update Phase 5 (init-btc-light-client)**

Change line ~299:
```
-    node "$ROOT/scripts/init-btc-light-client.mjs" 2>&1
+    bun run "$ROOT/scripts/init-btc-light-client.ts" 2>&1
```

- [ ] **Step 4: Commit**

```bash
git add scripts/deploy-devnet.sh
git commit -m "chore: update deploy-devnet.sh to use .ts scripts with bun run"
```

---

### Task 9: Final Cleanup & Verification

- [ ] **Step 1: Verify no dangling `.mjs` references**

```bash
grep -r "\.mjs" scripts/ --include="*.sh" --include="*.ts" --include="*.json"
```

- [ ] **Step 2: Verify all scripts compile**

```bash
for f in scripts/init-devnet.ts scripts/init-btc-light-client.ts scripts/register-vk-hashes.ts scripts/propose-pool-update.ts scripts/execute-pool-update.ts scripts/register-token.ts scripts/verify-deposits.ts scripts/topup-all.ts; do
  echo "=== $f ===" && bun build "$f" --no-bundle 2>&1 | tail -1
done
```

- [ ] **Step 3: Final commit with cleanup**

```bash
git add -A scripts/
git commit -m "chore: scripts consolidation complete — shared module, .mjs→.ts, dead code removed"
```
