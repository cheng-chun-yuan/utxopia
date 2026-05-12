/**
 * Shared utilities for UTXOpia admin/deployment scripts.
 *
 * Goal-oriented: provides setupScript() to boot any script with
 * connection + authority + program IDs, plus state file access.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

// =============================================================================
// Paths & Network
// =============================================================================

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_ROOT = path.resolve(SCRIPTS_DIR, "..");

export type Network = "localnet" | "devnet";

export function detectNetwork(): Network {
  const env = process.env.UTXOPIA_NETWORK;
  if (env === "localnet" || env === "local") return "localnet";
  if (env === "devnet" || env === "dev") return "devnet";
  const rpc = process.env.RPC_URL || "";
  if (rpc.includes("localhost") || rpc.includes("127.0.0.1")) return "localnet";
  return "devnet";
}

function getRpcUrl(network?: Network): string {
  if (process.env.RPC_URL) return process.env.RPC_URL;
  return (network ?? detectNetwork()) === "localnet"
    ? "http://127.0.0.1:8899"
    : "https://api.devnet.solana.com";
}

// =============================================================================
// State File
// =============================================================================

export interface ScriptState {
  utxopiaProgramId: string;
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
  return net === "localnet"
    ? path.join(SCRIPTS_DIR, "e2e/localnet-state.json")
    : path.join(SCRIPTS_DIR, "devnet-state.json");
}

export function loadState(network?: Network): ScriptState {
  const f = getStateFilePath(network);
  if (!fs.existsSync(f)) throw new Error(`State file not found: ${f}. Run deploy or e2e first.`);
  return JSON.parse(fs.readFileSync(f, "utf-8"));
}

export function saveState(state: ScriptState, network?: Network): void {
  fs.writeFileSync(getStateFilePath(network), JSON.stringify(state, null, 2) + "\n");
}

// =============================================================================
// Keypair Loading
// =============================================================================

export function loadKeypair(): Keypair {
  // 1. KEYPAIR_PATH env var
  if (process.env.KEYPAIR_PATH) {
    const p = process.env.KEYPAIR_PATH.replace("~", process.env.HOME!);
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8"))));
  }
  // 2. RELAYER_KEYPAIR from backend .env
  const envPath = path.join(PROJECT_ROOT, `backend/.env.${detectNetwork()}`);
  if (fs.existsSync(envPath)) {
    const match = fs.readFileSync(envPath, "utf-8").match(/RELAYER_KEYPAIR=(\[[\d,\s]+\])/);
    if (match) return Keypair.fromSecretKey(new Uint8Array(JSON.parse(match[1])));
  }
  // 3. Default keypairs
  for (const name of ["johnny.json", "id.json"]) {
    const p = path.join(process.env.HOME!, ".config/solana", name);
    if (fs.existsSync(p)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8"))));
  }
  throw new Error("No keypair found. Set KEYPAIR_PATH or create ~/.config/solana/id.json");
}

// =============================================================================
// setupScript() — the main entry point for all scripts
// =============================================================================

export interface ScriptContext {
  conn: Connection;
  authority: Keypair;
  programId: PublicKey;
  poolState: PublicKey;
  poolBump: number;
  state: ScriptState;
}

/**
 * Boot a script: load state, connect, load keypair, derive pool PDA.
 * Accepts UTXOPIA_PROGRAM_ID env var override (for deploy-devnet.sh).
 */
export function setupScript(network?: Network): ScriptContext {
  const state = loadState(network);
  const conn = new Connection(getRpcUrl(network), "confirmed");
  const authority = loadKeypair();
  const pid = process.env.UTXOPIA_PROGRAM_ID
    ? new PublicKey(process.env.UTXOPIA_PROGRAM_ID)
    : new PublicKey(state.utxopiaProgramId);
  const [poolState, poolBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_state")], pid,
  );
  return { conn, authority, programId: pid, poolState, poolBump, state };
}

// =============================================================================
// Constants
// =============================================================================

export const TOKEN_2022 = TOKEN_2022_PROGRAM_ID;
export const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// =============================================================================
// Transaction helper
// =============================================================================

export async function sendTx(
  conn: Connection,
  payer: Keypair,
  ix: TransactionInstruction,
): Promise<string> {
  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  return sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
}
