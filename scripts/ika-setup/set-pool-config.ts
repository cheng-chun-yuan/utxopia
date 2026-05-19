#!/usr/bin/env node --experimental-strip-types --no-warnings
/**
 * Submit `set_pool_config` (disc 2) on devnet to write the Ika fields
 * into the on-chain PoolConfig PDA.
 *
 * Reads the existing PDA first, then applies state-file overrides. Hybrid
 * deployments can keep the deposit derivation key (`btcXOnlyPubKey`) separate
 * from the pool custody key (`poolReceiveXOnlyPubKey`): deposits are still
 * swept by the legacy/demo key, but the swept pool UTXO is owned by Ika.
 *
 * Usage:
 *   UTXOPIA_PROGRAM_ID=<pid> PAYER_KEYPAIR_PATH=<path> \
 *     node --experimental-strip-types set-pool-config.ts --network devnet
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const NETWORK = process.argv.includes("--network")
  ? process.argv[process.argv.indexOf("--network") + 1]
  : "devnet";

const STATE_FILE =
  NETWORK === "localnet"
    ? path.resolve(import.meta.dirname ?? ".", "../e2e/localnet-state.json")
    : NETWORK === "devnet-regtest"
      ? path.resolve(import.meta.dirname ?? ".", "../devnet-regtest-state.json")
      : path.resolve(import.meta.dirname ?? ".", "../devnet-state.json");

const RPC_URL =
  NETWORK === "localnet"
    ? "http://localhost:8899"
    : "https://api.devnet.solana.com";

const programIdStr = process.env.UTXOPIA_PROGRAM_ID;
if (!programIdStr) throw new Error("UTXOPIA_PROGRAM_ID required");
const PROGRAM_ID = new PublicKey(programIdStr);

const payerPath = process.env.PAYER_KEYPAIR_PATH;
if (!payerPath || !existsSync(payerPath)) {
  throw new Error("PAYER_KEYPAIR_PATH required");
}
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(payerPath, "utf-8"))),
);

const state = JSON.parse(readFileSync(STATE_FILE, "utf-8"));

if (!state.ika?.dwallet || state.ika.dwallet === "11111111111111111111111111111111") {
  throw new Error("State JSON has no Ika dWallet — run dkg.ts first");
}

const conn = new Connection(RPC_URL, "confirmed");

console.log("\n═══ set_pool_config (disc 2) ═══");
console.log(`Network:           ${NETWORK}`);
console.log(`Program:           ${PROGRAM_ID.toBase58()}`);
console.log(`Payer (authority): ${payer.publicKey.toBase58()}`);
console.log();

// Derive PDAs
const [poolStatePda] = PublicKey.findProgramAddressSync(
  [Buffer.from("pool_state")],
  PROGRAM_ID,
);
const [poolConfigPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("pool_config")],
  PROGRAM_ID,
);
console.log(`pool_state PDA:    ${poolStatePda.toBase58()}`);
console.log(`pool_config PDA:   ${poolConfigPda.toBase58()}`);

// Read existing PoolConfig if present
const existing = await conn.getAccountInfo(poolConfigPda);
function xonlyFromState(name: string, value?: string): Buffer | null {
  if (!value) return null;
  const buf = Buffer.from(value, "hex");
  if (buf.length !== 32) {
    throw new Error(`${name} must be 32 bytes`);
  }
  return buf;
}

function p2trScript(xonly: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x51, 0x20]), xonly]);
}

let poolScript: Buffer;
let groupPubKey: Buffer;

if (existing) {
  const data = Buffer.from(existing.data);
  if (data[0] !== 0x0a) {
    throw new Error(
      `pool_config PDA exists but discriminator is 0x${data[0].toString(16)}, not 0x0a`,
    );
  }
  const scriptLen = data[1];
  poolScript = data.subarray(2, 2 + scriptLen);
  groupPubKey = data.subarray(36, 36 + 32);
  console.log(`existing script:   ${poolScript.toString("hex")} (${scriptLen} bytes)`);
  console.log(`existing group_pk: ${groupPubKey.toString("hex")}`);
} else {
  const xonly = xonlyFromState(
    "state.poolReceiveXOnlyPubKey/state.btcXOnlyPubKey/state.ika.dwalletXOnlyPubkey",
    state.poolReceiveXOnlyPubKey ?? state.btcXOnlyPubKey ?? state.ika?.dwalletXOnlyPubkey,
  );
  if (!xonly) {
    throw new Error(
      "Need state.btcXOnlyPubKey or state.ika.dwalletXOnlyPubkey to derive pool_script",
    );
  }
  poolScript = p2trScript(xonly);
  groupPubKey = xonly;
  console.log(`new script:        ${poolScript.toString("hex")}`);
  console.log(`new group_pk:      ${groupPubKey.toString("hex")}`);
}

const poolReceiveXonly = xonlyFromState(
  "state.poolReceiveXOnlyPubKey",
  state.poolReceiveXOnlyPubKey,
);
if (poolReceiveXonly) {
  poolScript = p2trScript(poolReceiveXonly);
  console.log(`override script:   ${poolScript.toString("hex")} (poolReceiveXOnlyPubKey)`);
}

const depositXonly = xonlyFromState("state.btcXOnlyPubKey", state.btcXOnlyPubKey);
if (depositXonly) {
  groupPubKey = depositXonly;
  console.log(`override group_pk: ${groupPubKey.toString("hex")} (btcXOnlyPubKey)`);
}

const ikaDwallet = new PublicKey(state.ika.dwallet).toBuffer();
const ikaXonly = Buffer.from(state.ika.dwalletXOnlyPubkey, "hex");
const cpiBump = state.ika.cpiAuthorityBump as number;

if (ikaXonly.length !== 32) throw new Error("ika.dwalletXOnlyPubkey must be 32 bytes hex");
if (typeof cpiBump !== "number") throw new Error("ika.cpiAuthorityBump must be a number");

console.log(`new ika_dwallet:   ${state.ika.dwallet}`);
console.log(`new ika_xonly:     ${state.ika.dwalletXOnlyPubkey}`);
console.log(`new cpi bump:      ${cpiBump}`);

// Build instruction data:
//   [0]   disc = 2 (SET_POOL_CONFIG)
//   [1]   script_len
//   [..]  script (script_len bytes)
//   [..]  group_pub_key (32 bytes)
//   [..]  ika_dwallet (32)
//   [..]  ika_dwallet_xonly (32)
//   [..]  cpi_authority_bump (1)
const ixData = Buffer.concat([
  Buffer.from([2]),
  Buffer.from([poolScript.length]),
  poolScript,
  groupPubKey,
  ikaDwallet,
  ikaXonly,
  Buffer.from([cpiBump]),
]);

console.log(`\nix data:           ${ixData.length} bytes`);

const ix = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: poolStatePda, isSigner: false, isWritable: false },
    { pubkey: poolConfigPda, isSigner: false, isWritable: true },
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data: ixData,
});

const tx = new Transaction().add(ix);
tx.feePayer = payer.publicKey;
tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
tx.sign(payer);

const sig = await conn.sendRawTransaction(tx.serialize());
console.log(`\nsignature:         ${sig}`);
console.log("waiting for confirmation...");
await conn.confirmTransaction(sig, "confirmed");
console.log("✓ confirmed");

// Read back to verify
const after = await conn.getAccountInfo(poolConfigPda);
if (!after) throw new Error("pool_config PDA missing after tx");
const d = Buffer.from(after.data);
console.log("\n── PoolConfig after ──");
console.log(`  discriminator:   0x${d[0].toString(16)}`);
console.log(`  pool_script_len: ${d[1]}`);
console.log(`  pool_script:     ${d.subarray(2, 2 + d[1]).toString("hex")}`);
console.log(`  group_pub_key:   ${d.subarray(36, 36 + 32).toString("hex")}`);
console.log(`  ika_dwallet:     ${new PublicKey(d.subarray(68, 68 + 32)).toBase58()}`);
console.log(`  ika_xonly:       ${d.subarray(100, 100 + 32).toString("hex")}`);
console.log(`  cpi_auth_bump:   ${d[132]}`);
