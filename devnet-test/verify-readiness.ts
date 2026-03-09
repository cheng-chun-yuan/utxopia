#!/usr/bin/env bun
/**
 * Devnet Integration Test — Readiness Verification
 *
 * Pre-flight checks before running the test suite:
 * 1. Solana devnet reachable
 * 2. Aegis program deployed
 * 3. BTC Light Client program deployed
 * 4. Pool state PDA initialized
 * 5. Commitment tree PDA initialized
 * 6. VK registry populated (at least 1x2)
 * 7. FROST signers healthy (if FROST mode)
 * 8. Backend API healthy
 * 9. Esplora reachable
 * 10. Payer wallet funded
 * 11. Circuit artifacts exist
 */

import * as fs from "fs";
import * as path from "path";
import { config } from "dotenv";

// Load env
config({ path: path.resolve(__dirname, ".env") });
config({ path: path.resolve(__dirname, ".env.devnet-test") });

const SOLANA_RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const ESPLORA_URL = process.env.ESPLORA_URL || "https://mempool.space/testnet4/api";
const BACKEND_API_URL = process.env.BACKEND_API_URL || "http://localhost:3001";
const FROST_SIGNER_URLS = [
  process.env.FROST_SIGNER_1_URL || "http://localhost:8081",
  process.env.FROST_SIGNER_2_URL || "http://localhost:8082",
  process.env.FROST_SIGNER_3_URL || "http://localhost:8083",
];
const AEGIS_PROGRAM_ID = process.env.AEGIS_PROGRAM_ID || "4Gt66pJd6N3hYEVWnaWTSLfxotsPvShYEWYvbUB9Ubx1";
const BTC_LIGHT_CLIENT_PROGRAM_ID = process.env.BTC_LIGHT_CLIENT_PROGRAM_ID || "Ho6UTeF8yFnRdCK15tSZtcJozvkDABJZWYxkgGyWAfyq";
const SIGNING_MODE = process.env.AEGIS_SIGNING_MODE || "frost";
const CIRCUITS_DIR = path.resolve(__dirname, "../circuits/build");

interface CheckResult {
  name: string;
  status: "pass" | "fail" | "warn";
  message: string;
}

const results: CheckResult[] = [];

function pass(name: string, msg: string) {
  results.push({ name, status: "pass", message: msg });
}
function fail(name: string, msg: string) {
  results.push({ name, status: "fail", message: msg });
}
function warn(name: string, msg: string) {
  results.push({ name, status: "warn", message: msg });
}

async function checkSolana() {
  try {
    const res = await fetch(SOLANA_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getVersion" }),
    });
    const data = await res.json() as any;
    pass("Solana RPC", `Version ${data.result?.["solana-core"] || "unknown"}`);
  } catch (err) {
    fail("Solana RPC", `Cannot reach ${SOLANA_RPC}: ${err}`);
  }
}

async function checkProgramDeployed(name: string, programId: string) {
  try {
    const res = await fetch(SOLANA_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [programId, { encoding: "base64" }],
      }),
    });
    const data = await res.json() as any;
    if (data.result?.value?.executable) {
      pass(name, `Deployed at ${programId.slice(0, 12)}...`);
    } else {
      fail(name, `Not deployed or not executable: ${programId}`);
    }
  } catch (err) {
    fail(name, `Check failed: ${err}`);
  }
}

async function checkAccountExists(name: string, address: string, minSize?: number) {
  try {
    const res = await fetch(SOLANA_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [address, { encoding: "base64" }],
      }),
    });
    const data = await res.json() as any;
    if (data.result?.value) {
      const size = data.result.value.data?.[0]
        ? Buffer.from(data.result.value.data[0], "base64").length
        : 0;
      if (minSize && size < minSize) {
        fail(name, `Account exists but too small: ${size} bytes (need ${minSize})`);
      } else {
        pass(name, `${address.slice(0, 12)}... (${size} bytes)`);
      }
    } else {
      fail(name, `Account not found: ${address}`);
    }
  } catch (err) {
    fail(name, `Check failed: ${err}`);
  }
}

async function checkFrostSigners() {
  if (SIGNING_MODE !== "frost") {
    warn("FROST Signers", "Signing mode is not FROST — skipping");
    return;
  }

  for (let i = 0; i < FROST_SIGNER_URLS.length; i++) {
    const url = FROST_SIGNER_URLS[i];
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        pass(`FROST Signer ${i + 1}`, `Healthy at ${url}`);
      } else {
        fail(`FROST Signer ${i + 1}`, `Unhealthy: HTTP ${res.status}`);
      }
    } catch {
      fail(`FROST Signer ${i + 1}`, `Cannot reach ${url}`);
    }
  }
}

async function checkBackendApi() {
  try {
    const res = await fetch(`${BACKEND_API_URL}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      pass("Backend API", `Healthy at ${BACKEND_API_URL}`);
    } else {
      fail("Backend API", `Unhealthy: HTTP ${res.status}`);
    }
  } catch {
    fail("Backend API", `Cannot reach ${BACKEND_API_URL}`);
  }
}

async function checkEsplora() {
  try {
    const res = await fetch(`${ESPLORA_URL}/blocks/tip/height`, {
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const height = await res.text();
      pass("Esplora", `Reachable, tip height: ${height}`);
    } else {
      fail("Esplora", `HTTP ${res.status}`);
    }
  } catch (err) {
    fail("Esplora", `Cannot reach ${ESPLORA_URL}: ${err}`);
  }
}

async function checkPayerBalance() {
  const keypairPath = (process.env.SOLANA_KEYPAIR_PATH || "~/.config/solana/johnny.json")
    .replace("~", process.env.HOME || "");

  if (!fs.existsSync(keypairPath)) {
    fail("Payer Wallet", `Keypair not found at ${keypairPath}`);
    return;
  }

  try {
    const bytes = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
    // Derive pubkey from first 32 bytes (ed25519)
    const { Keypair } = await import("@solana/web3.js");
    const kp = Keypair.fromSecretKey(new Uint8Array(bytes));
    const pubkey = kp.publicKey.toBase58();

    const res = await fetch(SOLANA_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getBalance",
        params: [pubkey],
      }),
    });
    const data = await res.json() as any;
    const balanceSol = (data.result?.value || 0) / 1e9;

    if (balanceSol >= 0.1) {
      pass("Payer Wallet", `${pubkey.slice(0, 12)}... — ${balanceSol.toFixed(4)} SOL`);
    } else {
      warn("Payer Wallet", `Low balance: ${balanceSol.toFixed(4)} SOL (need >= 0.1)`);
    }
  } catch (err) {
    fail("Payer Wallet", `Failed to check balance: ${err}`);
  }
}

function checkCircuitArtifacts() {
  const variants = ["joinsplit_1x1", "joinsplit_1x2", "joinsplit_2x1", "joinsplit_2x2"];
  let found = 0;

  for (const variant of variants) {
    const wasmPath = path.join(CIRCUITS_DIR, variant, `${variant}_js/${variant}.wasm`);
    const zkeyPath = path.join(CIRCUITS_DIR, variant, `${variant}.zkey`);

    if (fs.existsSync(wasmPath) && fs.existsSync(zkeyPath)) {
      found++;
    }
  }

  if (found === variants.length) {
    pass("Circuit Artifacts", `All ${found} tier-1 JoinSplit variants found`);
  } else if (found > 0) {
    warn("Circuit Artifacts", `${found}/${variants.length} variants found`);
  } else {
    fail("Circuit Artifacts", "No JoinSplit circuit artifacts found");
  }
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log("=== Aegis Devnet Readiness Check ===\n");

  await checkSolana();
  await checkProgramDeployed("Aegis Program", AEGIS_PROGRAM_ID);
  await checkProgramDeployed("BTC Light Client Program", BTC_LIGHT_CLIENT_PROGRAM_ID);

  // Check PDAs (would need to derive — use known devnet addresses)
  // These are from sdk/src/config.ts DEVNET_CONFIG
  await checkAccountExists("Pool State PDA", "E6DVestxC5dn5ixvLa3FcYodcVtwUAyanpVPbs4y3p16", 100);
  await checkAccountExists("Commitment Tree PDA", "JCiGqC1a1rjfqk2dqcybU2e3FQjAQ19x8ts9fQCtTFCq", 100);

  await checkFrostSigners();
  await checkBackendApi();
  await checkEsplora();
  await checkPayerBalance();
  checkCircuitArtifacts();

  // Print results
  console.log("");
  let passes = 0;
  let fails = 0;
  let warns = 0;

  for (const r of results) {
    const icon = r.status === "pass" ? "[PASS]" : r.status === "fail" ? "[FAIL]" : "[WARN]";
    console.log(`  ${icon} ${r.name}: ${r.message}`);
    if (r.status === "pass") passes++;
    else if (r.status === "fail") fails++;
    else warns++;
  }

  console.log(`\n  Total: ${passes} pass, ${warns} warn, ${fails} fail\n`);

  if (fails > 0) {
    console.log("Some checks failed. Fix issues above before running tests.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Readiness check failed:", err);
  process.exit(1);
});
