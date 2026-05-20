#!/usr/bin/env bun
/**
 * Hybrid demo: send a regtest BTC deposit to an arbitrary stealth address.
 *
 *   parse stealth meta-address (utxo:96-bytes-hex)
 *     → SDK createDepositFromConfig(meta, regtest)
 *       → bitcoin-cli broadcast OP_RETURN tx
 *         → mine 6 blocks
 *           → backend SPV-verifies the direct Ika vault deposit
 *             → recipient sees a new commitment in their wallet
 *
 * Usage:
 *   set -a && source .env && set +a
 *   RECIPIENT=utxo:<192-hex-chars> bun run scripts/hybrid/send-to.ts
 *   # optional: AMOUNT_SATS=50000
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  initConfig,
  initPoseidon,
  createDirectVaultDeposit,
  decodeStealthMetaAddress,
} from "../../sdk/src/index";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3020";
const API_KEY = process.env.BACKEND_API_KEY;
const RECIPIENT = process.env.RECIPIENT;
const AMOUNT_SATS = Number(process.env.AMOUNT_SATS || 100_000);
const STATE_PATH =
  process.env.STATE_PATH ||
  path.join(PROJECT_ROOT, "scripts/devnet-regtest-state.json");
const SOLANA_RPC =
  process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

const CONTAINER = "utxopia-esplora-regtest";
const BCLI = "/srv/explorer/bitcoin/bin/bitcoin-cli";
const BCLI_ARGS = "-regtest -datadir=/data/bitcoin -rpcwallet=test";

if (!API_KEY) {
  console.error("ERROR: BACKEND_API_KEY required (set -a; source .env; set +a)");
  process.exit(1);
}
if (!RECIPIENT) {
  console.error("ERROR: RECIPIENT env var required (utxo:<192-hex-chars>)");
  process.exit(1);
}

const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));

function btc(cmd: string): string {
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

async function main() {
  console.log("\n═══ Hybrid send-to-stealth ═══\n");

  // Phase 1: SDK init
  console.log("─── 1/4 SDK init w/ hybrid overrides ───");
  await initPoseidon();
  await initConfig({
    network: "devnet",
    utxopiaProgramId: state.utxopiaProgramId,
    zkbtcMint: state.zkbtcMint,
    solanaRpcUrl: SOLANA_RPC,
    groupPubKey: state.btcXOnlyPubKey || state.demoPool?.xOnlyPubKey,
    ikaDwalletXOnlyPubkey:
      state.ika?.dwalletXOnlyPubkey || state.poolReceiveXOnlyPubKey || state.btcXOnlyPubKey,
    depositMode: "direct",
  });
  console.log(`  vault xonly:      ${(state.ika?.dwalletXOnlyPubkey || state.poolReceiveXOnlyPubKey).slice(0, 16)}…`);
  console.log(`  recipient:        ${RECIPIENT.slice(0, 60)}…\n`);

  // Phase 2: parse recipient + build deposit
  console.log("─── 2/4 Build non-interactive deposit ───");
  const recipientMeta = decodeStealthMetaAddress(
    RECIPIENT.replace(/^utxo:/, ""), // pass raw hex; decodeStealthMetaAddress handles unprefixed
  );
  const vaultXOnly = Uint8Array.from(
    Buffer.from(state.ika?.dwalletXOnlyPubkey || state.poolReceiveXOnlyPubKey, "hex"),
  );
  const deposit = await createDirectVaultDeposit(recipientMeta, vaultXOnly, "regtest");
  console.log(`  deposit BTC addr: ${deposit.btcAddress}`);
  console.log(`  amount:           ${AMOUNT_SATS} sats`);
  console.log(`  npk:              ${hex(deposit.npk).slice(0, 32)}…\n`);

  // Phase 3: broadcast via bitcoin-cli
  console.log("─── 3/4 Broadcast on regtest ───");
  const tipBefore = parseInt(btc("getblockcount"), 10);
  const amountBtc = (AMOUNT_SATS / 1e8).toFixed(8);
  const outputs = JSON.stringify([
    { [deposit.btcAddress]: parseFloat(amountBtc) },
    { data: hex(deposit.opReturnPayload) },
  ]);
  const rawHex = btc(`createrawtransaction '[]' '${outputs}'`);
  const fundedHex = JSON.parse(btc(`fundrawtransaction ${rawHex}`)).hex;
  const signed = JSON.parse(btc(`signrawtransactionwithwallet ${fundedHex}`));
  if (!signed.complete) throw new Error(`sign failed: ${JSON.stringify(signed.errors)}`);
  const txid = btc(`sendrawtransaction ${signed.hex}`);
  const minerAddr = btc("getnewaddress");
  // btc-light-client currently enforces 6 confirmations on-chain.
  btc(`generatetoaddress 6 ${minerAddr}`);
  console.log(`  txid:             ${txid}`);
  console.log(`  tip:              ${tipBefore} → ${tipBefore + 6}\n`);

  // Phase 4: poll backend until commitment lands
  console.log("─── 4/4 Wait for SPV verify + commitment ───");

  const tree0 = await api("/api/tree/status");
  const startSize = tree0.size;
  console.log(`  tree.size start:  ${startSize}`);

  const start = Date.now();
  const TIMEOUT = 8 * 60_000;

  while (Date.now() - start < TIMEOUT) {
    await new Promise((r) => setTimeout(r, 15_000));
    const elapsed = Math.round((Date.now() - start) / 1000);

    try {
      const tree = await api("/api/tree/status");
      console.log(`  [${elapsed}s] tree.size=${tree.size}`);
      if (tree.size > startSize) {
        console.log(`\n  ✓ DEPOSIT LANDED. tree.size: ${startSize} → ${tree.size}`);
        console.log(`  ✓ Recipient (${RECIPIENT.slice(0, 60)}…) can scan to find note`);
        return;
      }
    } catch (e) {
      console.log(`  [${elapsed}s] poll error: ${(e as Error).message.slice(0, 100)}`);
    }
  }

  throw new Error(`Timed out — commitment did not land`);
}

main().catch((e) => {
  console.error("\nERROR:", e?.message || e);
  process.exit(1);
});
