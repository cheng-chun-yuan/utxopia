#!/usr/bin/env bun
/**
 * Demo-mode pool key generator (devnet-regtest hybrid).
 *
 * Generates a fresh secp256k1 keypair, derives its BIP-340 x-only public
 * key and the corresponding P2TR (bech32m) address for regtest, and
 * persists both into scripts/devnet-regtest-state.json so the hybrid
 * stack has a real BTC receive address while Ika DKG is unavailable.
 *
 * The private key is saved alongside the address — same machine, same
 * trust boundary as the rest of the demo state. Treat as throwaway.
 *
 * Idempotent: skips generation if state already has demoPool.{privKey,xOnlyPubKey,btcAddress}.
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { bech32m } from "@scure/base";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const STATE_PATH = path.resolve(
  import.meta.dirname ?? ".",
  "../devnet-regtest-state.json",
);

const state = JSON.parse(readFileSync(STATE_PATH, "utf-8"));

if (
  state.demoPool?.privKey &&
  state.demoPool?.xOnlyPubKey &&
  state.demoPool?.btcAddress
) {
  console.log("demoPool already present — leaving in place");
  console.log(`  btcAddress:  ${state.demoPool.btcAddress}`);
  console.log(`  xOnlyPubKey: ${state.demoPool.xOnlyPubKey}`);
  process.exit(0);
}

const priv = secp256k1.utils.randomPrivateKey();
const pub = secp256k1.getPublicKey(priv, true); // 33 bytes, compressed
const xOnly = pub.subarray(1); // drop the 02/03 prefix → 32 bytes

// P2TR encoding: witness version 1 + 32-byte program, bech32m, HRP "bcrt" for regtest.
// @scure/base's bech32m.encode wants the prefix int (0x01) prepended to the
// program bytes converted to 5-bit words.
const words = bech32m.toWords(xOnly);
const btcAddress = bech32m.encode("bcrt", [0x01, ...words]);

state.demoPool = {
  privKey: Buffer.from(priv).toString("hex"),
  xOnlyPubKey: Buffer.from(xOnly).toString("hex"),
  btcAddress,
  generatedAt: new Date().toISOString(),
  note:
    "Demo-mode placeholder while Ika devnet is unavailable. Throwaway key — do not use in prod.",
};
state.btcXOnlyPubKey = state.demoPool.xOnlyPubKey;
state.poolBtcAddress = btcAddress;

writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");

console.log("Wrote demoPool to scripts/devnet-regtest-state.json:");
console.log(`  btcAddress:  ${btcAddress}`);
console.log(`  xOnlyPubKey: ${state.demoPool.xOnlyPubKey}`);
console.log(`  privKey:     ${state.demoPool.privKey.slice(0, 8)}…`);
