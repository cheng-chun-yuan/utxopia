// scripts/demo-deposit.ts
// End-to-end deposit demo using the real npk-based flow (per CLAUDE.md).
//
// 1. Generates a stealth wallet (seed persisted at scripts/.demo-seed.json, gitignored)
// 2. Builds a non-interactive deposit via SDK → BTC Taproot address + 64-byte OP_RETURN
// 3. Prints copy-pasteable Sparrow Wallet instructions to send the tx
// 4. Polls /api/tree/status until the commitment lands on Solana devnet
//
// Run: set -a; source .env; set +a && bun run scripts/demo-deposit.ts
//
// Env: BACKEND_URL (default http://localhost:3010), BACKEND_API_KEY (required),
//      AMOUNT_SATS (default 10000), POOL_GROUP_PUBKEY (default reads from backend env)

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { PrivacyCoinClient, createNonInteractiveDeposit } from "../sdk/src/index";

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3010";
const API_KEY = process.env.BACKEND_API_KEY;
const AMOUNT_SATS = Number(process.env.AMOUNT_SATS || 10_000);
const POOL_GROUP_PUBKEY_HEX =
  process.env.POOL_GROUP_PUBKEY ||
  "87a1014ea16e42c825026889874902875aec7650b39c2b334a4d04d49b904c76";
const SEED_PATH = path.join(__dirname, ".demo-seed.json");

if (!API_KEY) {
  console.error("ERROR: BACKEND_API_KEY env var is required.");
  console.error("Hint:  set -a; source .env; set +a");
  process.exit(1);
}

function loadOrCreateSeed(): Uint8Array {
  if (fs.existsSync(SEED_PATH)) {
    const seedHex = JSON.parse(fs.readFileSync(SEED_PATH, "utf8")).seed;
    console.log(`Loaded existing demo seed from ${SEED_PATH}`);
    return Uint8Array.from(Buffer.from(seedHex, "hex"));
  }
  const seed = randomBytes(32);
  fs.writeFileSync(SEED_PATH, JSON.stringify({ seed: Buffer.from(seed).toString("hex") }, null, 2));
  fs.chmodSync(SEED_PATH, 0o600);
  console.log(`Generated new demo seed → ${SEED_PATH} (chmod 600, gitignored)`);
  return new Uint8Array(seed);
}

async function api(path: string): Promise<any> {
  const r = await fetch(`${BACKEND_URL}${path}`, { headers: { "X-API-Key": API_KEY! } });
  if (!r.ok) throw new Error(`${path} -> ${r.status}: ${await r.text()}`);
  return r.json();
}

function hex(buf: Uint8Array): string {
  return Buffer.from(buf).toString("hex");
}

async function main() {
  console.log("─── 1/4  Init SDK + login ────────────────────────────────");
  const seed = loadOrCreateSeed();
  const client = await PrivacyCoinClient.init({ network: "devnet" });
  const setup = await client.loginWithSeed(seed);
  console.log(`Stealth meta-address: ${setup.stealthAddressEncoded}`);
  console.log(`(viewing key will let this wallet recognize the deposit later)\n`);

  console.log("─── 2/4  Backend reachability ────────────────────────────");
  console.log(`GET  /api/health         -> ${(await fetch(`${BACKEND_URL}/api/health`)).status}`);
  const tree0 = await api("/api/tree/status");
  console.log(`Tree start state:  next_index=${tree0.next_index}  size=${tree0.size}\n`);

  console.log("─── 3/4  Build non-interactive deposit ───────────────────");
  const groupPubKey = Uint8Array.from(Buffer.from(POOL_GROUP_PUBKEY_HEX, "hex"));
  if (groupPubKey.length !== 32) {
    console.error(`POOL_GROUP_PUBKEY must be 32 bytes (got ${groupPubKey.length})`);
    process.exit(1);
  }
  const deposit = await createNonInteractiveDeposit(setup.stealthAddress, groupPubKey, "testnet");
  console.log(`✓ Deposit built client-side (no /api/stealth/prepare needed)`);
  console.log(`   BTC Taproot address:  ${deposit.btcAddress}`);
  console.log(`   OP_RETURN payload:    ${hex(deposit.opReturnPayload)}`);
  console.log(`                          (64 bytes = ephemeralPub(32) || npk(32))`);
  console.log(`   npk:                  ${hex(deposit.npk)}`);
  console.log(`   ephemeralPub:         ${hex(deposit.ephemeralPub)}\n`);

  console.log("─── 4/4  SEND REAL TESTNET BTC (with custom OP_RETURN) ───");
  console.log(`You need a testnet4 BTC wallet that supports OP_RETURN outputs.`);
  console.log(`Easiest = Sparrow Wallet (free, GUI, multi-platform):\n`);
  console.log(`  Setup (one-time, ~5min):`);
  console.log(`    1. Download Sparrow:  https://sparrowwallet.com/download/`);
  console.log(`    2. Settings → Server → Public Electrum, pick a testnet4 server`);
  console.log(`    3. File → New Wallet → Single Signature → Native SegWit → Generate`);
  console.log(`    4. Take note of a receive address (tb1... — testnet4 prefix)`);
  console.log(`    5. Fund from faucet:  https://mempool.space/testnet4/faucet`);
  console.log(`       (faucets typically give 0.001 BTC = 100k sats — enough for many demos)`);
  console.log(`\n  Send the deposit (after faucet has 1 confirmation):`);
  console.log(`    1. Send tab → Pay to:  ${deposit.btcAddress}`);
  console.log(`    2. Amount:             ${AMOUNT_SATS} sats`);
  console.log(`    3. Advanced → Add Output → Type: OP_RETURN`);
  console.log(`       Paste this hex (64 bytes, NO leading 0x):`);
  console.log(`       ${hex(deposit.opReturnPayload)}`);
  console.log(`    4. Create Transaction → Sign → Broadcast`);
  console.log(`\n  Explorer for the deposit address:`);
  console.log(`    https://mempool.space/testnet4/address/${deposit.btcAddress}`);
  console.log(`\nBackend polls every 60s. After 1 confirmation it will:`);
  console.log(`  → SPV-verify the tx + on-demand sync the BTC header`);
  console.log(`  → call privacy-coin's verify_stealth_deposit (disc=1)`);
  console.log(`  → on-chain Poseidon(npk, ZKBTC, amount) commitment lands in the tree`);
  console.log(`\nPolling for tree.size > ${tree0.size}. Ctrl+C to stop (deposit still processes).\n`);

  const start = Date.now();
  while (true) {
    await new Promise((r) => setTimeout(r, 30_000));
    const elapsed = Math.round((Date.now() - start) / 1000);
    try {
      const tree = await api("/api/tree/status");
      const stats = await api("/api/tracker/stats");
      console.log(
        `[${elapsed}s]  tree.size=${tree.size}  tracker: pending=${stats.pending} confirming=${stats.confirming} ready=${stats.ready} claimed=${stats.claimed} failed=${stats.failed}`,
      );
      if (tree.size > tree0.size) {
        console.log(`\n🎉 DEPOSIT LANDED. tree.size: ${tree0.size} → ${tree.size}`);
        console.log(`Your wallet (seed: ${SEED_PATH}) can scan the announcement events`);
        console.log(`and reconstruct the note via the viewing key.`);
        break;
      }
    } catch (e) {
      console.log(`[${elapsed}s]  poll error: ${(e as Error).message}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
