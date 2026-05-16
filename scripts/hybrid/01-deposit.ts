#!/usr/bin/env bun
/**
 * Hybrid demo: end-to-end BTC deposit on devnet+regtest stack.
 *
 *   SDK (hybrid program ID overrides)
 *     → createNonInteractiveDeposit(regtest)
 *       → bitcoin-cli createOpReturnTx + broadcast
 *         → mine 1 conf for detection, then 6 for sweep
 *           → backend sweeps to demo pool address
 *             → backend SPV-verifies, calls complete_deposit
 *               → on-chain Poseidon → leaf in commitment tree
 *
 * Persists the deposit seed at scripts/hybrid/.demo-seed.json so 02-transact
 * can find the resulting note.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   bun run scripts/hybrid/01-deposit.ts
 *
 * Env (with sane defaults):
 *   BACKEND_URL          http://localhost:3020
 *   BACKEND_API_KEY      required
 *   AMOUNT_SATS          100_000  (0.001 BTC)
 *   STATE_PATH           scripts/devnet-regtest-state.json
 *   SOLANA_RPC_URL       https://api.devnet.solana.com
 */

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  UTXOpiaClient,
  createNonInteractiveDeposit,
  initConfig,
} from "../../sdk/src/index";

// ── Config ────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3020";
const API_KEY = process.env.BACKEND_API_KEY;
const AMOUNT_SATS = Number(process.env.AMOUNT_SATS || 100_000);
const STATE_PATH =
  process.env.STATE_PATH ||
  path.join(PROJECT_ROOT, "scripts/devnet-regtest-state.json");
const SOLANA_RPC =
  process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const SEED_PATH = path.join(__dirname, ".demo-seed.json");

const CONTAINER = "utxopia-esplora-regtest";
const BCLI = "/srv/explorer/bitcoin/bin/bitcoin-cli";
const BCLI_ARGS = "-regtest -datadir=/data/bitcoin -rpcwallet=test";

if (!API_KEY) {
  console.error("ERROR: BACKEND_API_KEY required (set -a; source .env; set +a)");
  process.exit(1);
}
if (!fs.existsSync(STATE_PATH)) {
  console.error(`ERROR: state file not found: ${STATE_PATH}`);
  process.exit(1);
}

const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
if (!state.demoPool?.xOnlyPubKey) {
  console.error("ERROR: state file missing demoPool.xOnlyPubKey — run scripts/ika-setup/gen-demo-pool-key.ts");
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────
function btc(cmd: string): string {
  return execSync(`docker exec ${CONTAINER} ${BCLI} ${BCLI_ARGS} ${cmd}`, {
    encoding: "utf-8",
  }).trim();
}

function btcRaw(cmd: string): string {
  return execSync(`docker exec ${CONTAINER} ${BCLI} ${BCLI_ARGS} ${cmd}`, {
    encoding: "utf-8",
  }).trim();
}

function hex(buf: Uint8Array): string {
  return Buffer.from(buf).toString("hex");
}

async function api(p: string): Promise<any> {
  const r = await fetch(`${BACKEND_URL}${p}`, {
    headers: { "X-API-Key": API_KEY! },
  });
  if (!r.ok) throw new Error(`${p} -> ${r.status}: ${await r.text()}`);
  return r.json();
}

function loadOrCreateSeed(): Uint8Array {
  if (fs.existsSync(SEED_PATH)) {
    const seedHex = JSON.parse(fs.readFileSync(SEED_PATH, "utf8")).seed;
    console.log(`Loaded existing demo seed from ${SEED_PATH}`);
    return Uint8Array.from(Buffer.from(seedHex, "hex"));
  }
  const seed = randomBytes(32);
  fs.writeFileSync(
    SEED_PATH,
    JSON.stringify(
      { seed: Buffer.from(seed).toString("hex"), createdAt: new Date().toISOString() },
      null,
      2,
    ),
  );
  fs.chmodSync(SEED_PATH, 0o600);
  console.log(`Generated new demo seed → ${SEED_PATH}`);
  return new Uint8Array(seed);
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log("\n═══ Hybrid demo deposit (devnet + regtest) ═══\n");

  // Phase 1: SDK init w/ hybrid overrides
  console.log("─── 1/5 SDK init w/ hybrid overrides ───");
  await initConfig({
    network: "devnet",
    utxopiaProgramId: state.utxopiaProgramId,
    zkbtcMint: state.zkbtcMint,
    solanaRpcUrl: SOLANA_RPC,
    groupPubKey: state.demoPool.xOnlyPubKey,
  });
  console.log(`  utxopiaProgramId: ${state.utxopiaProgramId}`);
  console.log(`  zkbtcMint:        ${state.zkbtcMint}`);
  console.log(`  groupPubKey:      ${state.demoPool.xOnlyPubKey}`);
  console.log(`  poolBtcAddress:   ${state.demoPool.btcAddress}\n`);

  const seed = loadOrCreateSeed();
  const client = await UTXOpiaClient.init({
    network: "devnet",
    backendUrl: BACKEND_URL,
  });
  const setup = await client.loginWithSeed(seed);
  console.log(`  stealthAddress:   ${setup.stealthAddressEncoded.slice(0, 50)}…\n`);

  // Phase 2: backend reachability
  console.log("─── 2/5 Backend reachability ───");
  const tree0 = await api("/api/tree/status");
  console.log(`  backend at:       ${BACKEND_URL}`);
  console.log(`  tree.size start:  ${tree0.size}\n`);

  // Phase 3: build deposit
  console.log("─── 3/5 Build non-interactive deposit ───");
  const groupPubKey = Uint8Array.from(
    Buffer.from(state.demoPool.xOnlyPubKey, "hex"),
  );
  const deposit = await createNonInteractiveDeposit(
    setup.stealthAddress,
    groupPubKey,
    "regtest",
  );
  console.log(`  deposit BTC addr: ${deposit.btcAddress}`);
  console.log(`  OP_RETURN (64B):  ${hex(deposit.opReturnPayload).slice(0, 32)}…`);
  console.log(`  npk:              ${hex(deposit.npk)}\n`);

  // Phase 4: broadcast via bitcoin-cli
  console.log("─── 4/5 Broadcast via bitcoin-cli ───");
  const tipBefore = parseInt(btc("getblockcount"), 10);
  console.log(`  regtest tip:      ${tipBefore}`);

  // Build deposit tx with OP_RETURN
  const amountBtc = (AMOUNT_SATS / 1e8).toFixed(8);
  const outputs = JSON.stringify([
    { [deposit.btcAddress]: parseFloat(amountBtc) },
    { data: hex(deposit.opReturnPayload) },
  ]);
  // Use single-quoted JSON for bitcoin-cli arg parsing
  const rawHex = btcRaw(`createrawtransaction '[]' '${outputs}'`);
  const fundedJson = btcRaw(`fundrawtransaction ${rawHex}`);
  const fundedHex = JSON.parse(fundedJson).hex;
  const signedJson = btcRaw(`signrawtransactionwithwallet ${fundedHex}`);
  const signed = JSON.parse(signedJson);
  if (!signed.complete) {
    throw new Error(`sign failed: ${JSON.stringify(signed.errors)}`);
  }
  const txid = btc(`sendrawtransaction ${signed.hex}`);
  console.log(`  deposit txid:     ${txid}`);

  // Mine 1 conf (so backend deposit_tracker detects per --confirmations 1)
  const minerAddr = btc(`getnewaddress`);
  btc(`generatetoaddress 1 ${minerAddr}`);
  console.log(`  mined 1 block (deposit confirmed)\n`);

  // Phase 5: poll backend
  console.log("─── 5/5 Poll backend until commitment lands ───");
  console.log("  Backend cycle: detect → sweep → SPV verify → on-chain claim");
  console.log("  Will mine 6 more blocks ~30s in to clear sweep confirmations\n");

  let minedExtra = false;
  const start = Date.now();
  const TIMEOUT_MS = 8 * 60_000;

  while (Date.now() - start < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 15_000));
    const elapsed = Math.round((Date.now() - start) / 1000);

    // Mine the sweep-confirmation blocks once (~30s in, after backend likely
    // queued the sweep tx).
    if (!minedExtra && elapsed > 25) {
      btc(`generatetoaddress 6 ${minerAddr}`);
      console.log(`  [${elapsed}s] mined 6 more blocks (sweep confirmations)`);
      minedExtra = true;
    }

    try {
      const tree = await api("/api/tree/status");
      const stats = await api("/api/tracker/stats").catch(() => ({}));
      console.log(
        `  [${elapsed}s] tree.size=${tree.size}  tracker:${JSON.stringify(stats)}`,
      );
      if (tree.size > tree0.size) {
        console.log(`\n  ✓ DEPOSIT LANDED. tree.size: ${tree0.size} → ${tree.size}`);
        console.log(`  ✓ Seed persisted at ${SEED_PATH} for 02-transact.ts`);
        return;
      }
    } catch (e) {
      console.log(`  [${elapsed}s] poll error: ${(e as Error).message.slice(0, 100)}`);
    }
  }

  throw new Error(`Timed out after ${TIMEOUT_MS}ms — commitment did not land`);
}

main().catch((e) => {
  console.error("\nERROR:", e?.message || e);
  process.exit(1);
});
