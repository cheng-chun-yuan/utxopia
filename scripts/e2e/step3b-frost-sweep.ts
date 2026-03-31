#!/usr/bin/env bun
/**
 * Step 3b: FROST Sweep Test
 *
 * Tests the full FROST threshold signing flow for deposit sweeps:
 * 1. Start 2 FROST signers with test keys
 * 2. Generate deposit address from FROST group key + npk tweak
 * 3. Fund deposit address via regtest
 * 4. Build unsigned sweep TX
 * 5. Sign via FROST (round1 -> verify-commitments -> round2 -> aggregate)
 * 6. Broadcast sweep TX to regtest
 * 7. Verify it gets mined
 */

import { execSync, spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { fileURLToPath } from "url";

import {
  bitcoinCli,
  getNewAddress,
  mineBlocks,
  waitForTxIndexed,
} from "../../contracts/scripts/regtest-helpers.js";

import {
  deriveTaprootAddress,
  hexToBytes,
  bytesToHex,
} from "../../sdk/dist/index.js";

// Inline shared helpers to avoid pulling in shared.ts (which has heavy SDK imports)
const ESPLORA_URL = "http://localhost:3002/regtest/api";

function log(msg: string): void {
  console.log(`  ${msg}`);
}

function stepHeader(step: string | number, title: string): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Step ${step}: ${title}`);
  console.log("=".repeat(60));
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../..");

// FROST signer config
const SIGNER1_PORT = 19101;
const SIGNER2_PORT = 19102;
const SIGNER1_URL = `http://localhost:${SIGNER1_PORT}`;
const SIGNER2_URL = `http://localhost:${SIGNER2_PORT}`;
const KEY_PASSWORD = "e2e_test_password";
const FROST_API_KEY = "e2e_test_api_key_12345";

stepHeader("3b", "FROST Sweep (threshold signing)");

// =============================================================================
// Helpers
// =============================================================================

function findFrostBinary(): string {
  // Workspace builds to root target/, standalone to frost_server/target/
  const paths = [
    path.join(PROJECT_ROOT, "target/release/frost-server"),
    path.join(PROJECT_ROOT, "target/debug/frost-server"),
    path.join(PROJECT_ROOT, "frost_server/target/release/frost-server"),
    path.join(PROJECT_ROOT, "frost_server/target/debug/frost-server"),
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    "frost-server binary not found. Build it first: cd frost_server && cargo build --release"
  );
}

function btc(cmd: string): string {
  return bitcoinCli(cmd);
}

/** Wait for an HTTP endpoint to respond with status 200 */
async function waitForHealth(url: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`${url}/health`);
      if (resp.ok) {
        const body = (await resp.json()) as { status: string; key_loaded: boolean };
        if (body.key_loaded) return;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Signer at ${url} did not become ready within ${timeoutMs}ms`);
}

/**
 * Build an unsigned BTC transaction spending a single P2TR input to a pool address,
 * with an OP_RETURN embedding the npk commitment.
 *
 * Returns { rawTxHex, sighash, prevoutScriptPubkeyHex, sweepAmount }
 */
function buildUnsignedSweepTx(
  depositTxid: string,
  depositVout: number,
  depositAmountSats: number,
  depositOutputKeyHex: string,
  poolAddress: string,
  npkBytes: Uint8Array,
): {
  rawTxHex: string;
  sighashHex: string;
  prevoutScriptPubkeyHex: string;
  sweepAmountSats: number;
} {
  // Manually construct a BTC transaction in raw hex.
  // We need to compute the BIP-341 sighash for key-path spending.
  //
  // Strategy: use bitcoin-cli to create the transaction structure,
  // then compute sighash ourselves.

  const FEE_SATS = 300; // conservative fee for regtest
  const sweepAmountSats = depositAmountSats - FEE_SATS;
  const sweepAmountBtc = (sweepAmountSats / 1e8).toFixed(8);

  // Create raw transaction via bitcoin-cli (no signing, just structure)
  const npkHex = bytesToHex(npkBytes);
  const outputsJson = JSON.stringify([
    { [poolAddress]: parseFloat(sweepAmountBtc) },
    { data: npkHex },
  ]);
  const inputsJson = JSON.stringify([
    { txid: depositTxid, vout: depositVout },
  ]);
  const rawTxHex = btc(
    `-named createrawtransaction inputs='${inputsJson}' outputs='${outputsJson}'`
  );

  // Build the prevout script pubkey (P2TR): OP_1 PUSH32 <outputKey>
  const prevoutScriptPubkeyHex =
    "5120" + depositOutputKeyHex;

  // Compute BIP-341 sighash using bitcoin-cli's signrawtransactionwithwallet
  // with SIGHASH_DEFAULT. We won't actually use the signature — just extracting
  // the raw transaction structure.
  //
  // Actually, we compute sighash manually with a known algorithm.
  // BIP-341 key-path sighash = tagged_hash("TapSighash", <sighash_data>)
  //
  // But it's complex. Instead, let the FROST signers' policy engine verify it.
  // We use the signing_context approach: send raw_tx + prevouts, signers compute sighash.
  //
  // For the sighash that we send, we compute it here using the same BIP-341 algorithm.
  const sighashHex = computeTapSighash(
    rawTxHex,
    depositTxid,
    depositVout,
    depositAmountSats,
    prevoutScriptPubkeyHex,
  );

  return { rawTxHex, sighashHex, prevoutScriptPubkeyHex, sweepAmountSats };
}

/**
 * Compute BIP-341 key-path sighash (SIGHASH_DEFAULT = 0x00).
 *
 * Reference: BIP-341 signature validation rules
 * SigMsg = epoch(1) || hash_type(1) || version(4) || locktime(4) ||
 *          sha256(prevouts) || sha256(amounts) || sha256(scriptpubkeys) ||
 *          sha256(sequences) || sha256(outputs) ||
 *          spend_type(1) || input_index(4)
 *
 * sighash = tagged_hash("TapSighash", SigMsg)
 */
function computeTapSighash(
  rawTxHex: string,
  prevTxid: string,
  prevVout: number,
  prevAmountSats: number,
  prevScriptPubkeyHex: string,
): string {
  const rawTx = Buffer.from(rawTxHex, "hex");

  // Parse version (first 4 bytes LE)
  const version = rawTx.subarray(0, 4);

  // Parse locktime (last 4 bytes LE)
  const locktime = rawTx.subarray(rawTx.length - 4);

  // Build prevout: txid (internal order = reversed display) + vout (4 bytes LE)
  const prevTxidInternal = Buffer.from(prevTxid, "hex");
  prevTxidInternal.reverse();
  const prevoutBuf = Buffer.alloc(36);
  prevTxidInternal.copy(prevoutBuf, 0);
  prevoutBuf.writeUInt32LE(prevVout, 32);

  // sha256(prevouts)
  const sha256Prevouts = sha256(prevoutBuf);

  // sha256(amounts) - single input: amount as 8-byte LE
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(BigInt(prevAmountSats));
  const sha256Amounts = sha256(amountBuf);

  // sha256(scriptpubkeys) - compact_size(script.len) + script
  const scriptBytes = Buffer.from(prevScriptPubkeyHex, "hex");
  const scriptWithLen = Buffer.alloc(1 + scriptBytes.length);
  scriptWithLen[0] = scriptBytes.length;
  scriptBytes.copy(scriptWithLen, 1);
  const sha256ScriptPubkeys = sha256(scriptWithLen);

  // sha256(sequences) - single input sequence (from raw tx)
  // Parse: version(4) + varint(1) + txid(32) + vout(4) + scriptSig_len(1) + scriptSig(0) + sequence(4)
  // For P2TR input with empty scriptSig: offset = 4 + 1 + 32 + 4 + 1 + 0 + 0 = 42, sequence at 42..46
  const sequenceBuf = rawTx.subarray(42, 46);
  const sha256Sequences = sha256(sequenceBuf);

  // sha256(outputs) - all outputs from the raw tx
  // Parse outputs: after input section
  const numOutputs = rawTx[46]; // varint for output count
  // Everything from output count to before locktime is the outputs section
  const outputsSection = rawTx.subarray(46, rawTx.length - 4);
  const sha256Outputs = sha256(outputsSection);

  // Build SigMsg
  const sigMsg = Buffer.alloc(
    1 + 1 + 4 + 4 + 32 + 32 + 32 + 32 + 32 + 1 + 4
  );
  let off = 0;
  sigMsg[off++] = 0x00; // epoch
  sigMsg[off++] = 0x00; // hash_type (SIGHASH_DEFAULT)
  version.copy(sigMsg, off); off += 4;
  locktime.copy(sigMsg, off); off += 4;
  sha256Prevouts.copy(sigMsg, off); off += 32;
  sha256Amounts.copy(sigMsg, off); off += 32;
  sha256ScriptPubkeys.copy(sigMsg, off); off += 32;
  sha256Sequences.copy(sigMsg, off); off += 32;
  sha256Outputs.copy(sigMsg, off); off += 32;
  sigMsg[off++] = 0x00; // spend_type (no annex, key path)
  sigMsg.writeUInt32LE(0, off); // input_index = 0

  // sighash = tagged_hash("TapSighash", sigMsg)
  return bytesToHex(taggedHash("TapSighash", sigMsg));
}

function sha256(data: Buffer | Uint8Array): Buffer {
  return crypto.createHash("sha256").update(data).digest();
}

function taggedHash(tag: string, data: Buffer | Uint8Array): Uint8Array {
  const tagBytes = Buffer.from(tag, "utf-8");
  const tagHash = sha256(tagBytes);
  const preimage = Buffer.concat([tagHash, tagHash, Buffer.from(data)]);
  return new Uint8Array(sha256(preimage));
}

/**
 * Attach a 64-byte Schnorr witness to a raw unsigned P2TR transaction.
 * Witness: [1 item] [64 bytes signature]
 */
function attachWitness(rawTxHex: string, signatureHex: string): string {
  const rawTx = Buffer.from(rawTxHex, "hex");
  const sigBytes = Buffer.from(signatureHex, "hex");

  // Build segwit transaction:
  // version(4) + marker(0x00) + flag(0x01) + inputs + outputs + witness + locktime(4)
  const parts: Buffer[] = [];

  // version
  parts.push(rawTx.subarray(0, 4));

  // segwit marker + flag
  parts.push(Buffer.from([0x00, 0x01]));

  // inputs + outputs (everything between version and locktime)
  parts.push(rawTx.subarray(4, rawTx.length - 4));

  // witness for input 0: 1 stack item, 64 bytes
  parts.push(Buffer.from([0x01])); // 1 witness item
  parts.push(Buffer.from([sigBytes.length])); // length of signature
  parts.push(sigBytes);

  // locktime
  parts.push(rawTx.subarray(rawTx.length - 4));

  return Buffer.concat(parts).toString("hex");
}

// =============================================================================
// FROST HTTP protocol helpers
// =============================================================================

interface Round1Response {
  commitment: string;
  signer_id: number;
  frost_identifier: string;
}

interface VerifyCommitmentsResponse {
  signer_id: number;
  digest: string;
}

interface Round2Response {
  signature_share: string;
  signer_id: number;
}

interface AggregateResponse {
  signature: string;
  group_public_key: string;
}

async function frostRound1(
  url: string,
  sessionId: string,
  sighashHex: string,
  tweakHex: string,
  signingContext: any,
  merkleRootHex: string,
): Promise<Round1Response> {
  const resp = await fetch(`${url}/round1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": FROST_API_KEY },
    body: JSON.stringify({
      session_id: sessionId,
      sighash: sighashHex,
      tweak: tweakHex,
      signing_context: signingContext,
      merkle_root: merkleRootHex,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Round1 failed at ${url}: ${resp.status} ${body}`);
  }
  return (await resp.json()) as Round1Response;
}

async function frostVerifyCommitments(
  url: string,
  sessionId: string,
  commitments: Record<string, string>,
  identifierMap: Record<string, string>,
): Promise<VerifyCommitmentsResponse> {
  const resp = await fetch(`${url}/verify-commitments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": FROST_API_KEY },
    body: JSON.stringify({
      session_id: sessionId,
      commitments,
      identifier_map: identifierMap,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`VerifyCommitments failed at ${url}: ${resp.status} ${body}`);
  }
  return (await resp.json()) as VerifyCommitmentsResponse;
}

async function frostRound2(
  url: string,
  sessionId: string,
  sighashHex: string,
  tweakHex: string,
  commitments: Record<string, string>,
  identifierMap: Record<string, string>,
  merkleRootHex: string,
): Promise<Round2Response> {
  const resp = await fetch(`${url}/round2`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": FROST_API_KEY },
    body: JSON.stringify({
      session_id: sessionId,
      sighash: sighashHex,
      tweak: tweakHex,
      commitments,
      identifier_map: identifierMap,
      merkle_root: merkleRootHex,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Round2 failed at ${url}: ${resp.status} ${body}`);
  }
  return (await resp.json()) as Round2Response;
}

async function frostAggregate(
  url: string,
  commitments: Record<string, string>,
  identifierMap: Record<string, string>,
  signatureShares: Record<string, string>,
  sighashHex: string,
  merkleRootHex: string,
): Promise<AggregateResponse> {
  const resp = await fetch(`${url}/aggregate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": FROST_API_KEY },
    body: JSON.stringify({
      commitments,
      identifier_map: identifierMap,
      signature_shares: signatureShares,
      sighash: sighashHex,
      merkle_root: merkleRootHex,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Aggregate failed at ${url}: ${resp.status} ${body}`);
  }
  return (await resp.json()) as AggregateResponse;
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const frostBin = findFrostBinary();
  log(`Using frost-server binary: ${frostBin}`);

  // Create temp directory for test keys and audit log
  const tmpDir = path.join(PROJECT_ROOT, "scripts/e2e/.frost-test-keys");
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true });
  }
  fs.mkdirSync(tmpDir, { recursive: true });

  const signerProcesses: ChildProcess[] = [];

  try {
    // =========================================================================
    // Step 1: Generate test keys (2-of-3 threshold)
    // =========================================================================
    log("Generating 2-of-3 FROST test keys...");
    execSync(
      `${frostBin} generate-test-keys ` +
        `--password ${KEY_PASSWORD} ` +
        `--threshold 2 --total 3 ` +
        `--output-dir ${tmpDir}`,
      { stdio: "pipe", timeout: 30_000 }
    );

    const groupPubkeyHex = fs
      .readFileSync(path.join(tmpDir, "group_pubkey.txt"), "utf-8")
      .trim();
    log(`Group pubkey: ${groupPubkeyHex}`);

    // =========================================================================
    // Step 2: Generate deposit address using SDK's deriveTaprootAddress
    // =========================================================================
    log("Generating deposit address from FROST group key + npk tweak...");

    // Use a mock npk (32 bytes) as the commitment/tweak data
    const npkBytes = crypto.randomBytes(32);
    const npkHex = npkBytes.toString("hex");
    log(`NPK (commitment): ${npkHex.slice(0, 16)}...`);

    const groupKeyBytes = hexToBytes(groupPubkeyHex) as Uint8Array;
    const { address: depositAddress, outputKey, tweak } = deriveTaprootAddress(
      npkBytes,
      "regtest",
      groupKeyBytes,
    );
    const outputKeyHex = bytesToHex(outputKey);
    const tweakHex = bytesToHex(tweak);
    log(`Deposit address: ${depositAddress}`);
    log(`Output key: ${outputKeyHex.slice(0, 16)}...`);
    log(`Tweak: ${tweakHex.slice(0, 16)}...`);

    // =========================================================================
    // Step 3: Fund the deposit address via regtest
    // =========================================================================
    log("Funding deposit address via regtest...");

    const DEPOSIT_SATS = 50_000;
    const depositBtc = (DEPOSIT_SATS / 1e8).toFixed(8);

    // Send BTC to the FROST-derived deposit address
    const fundTxid = btc(`sendtoaddress ${depositAddress} ${depositBtc}`);
    log(`Fund txid: ${fundTxid}`);

    // Mine a block to confirm the deposit
    const minerAddr = getNewAddress("bech32m");
    mineBlocks(1, minerAddr);
    log("Deposit mined (1 confirmation)");

    // Find the deposit output
    const fundTxInfo = JSON.parse(btc(`gettransaction ${fundTxid} true true`));
    const fundTxDecoded =
      fundTxInfo.decoded ||
      JSON.parse(btc(`decoderawtransaction ${fundTxInfo.hex}`));

    let depositVout = -1;
    let depositAmountSats = 0;
    for (const out of fundTxDecoded.vout) {
      if (
        out.scriptPubKey?.type === "witness_v1_taproot" &&
        out.scriptPubKey?.address === depositAddress
      ) {
        depositVout = out.n;
        depositAmountSats = Math.round(out.value * 1e8);
        break;
      }
    }
    if (depositVout === -1) {
      throw new Error("Could not find deposit output in funding transaction");
    }
    log(`Deposit output: txid=${fundTxid.slice(0, 16)}... vout=${depositVout} amount=${depositAmountSats} sats`);

    // =========================================================================
    // Step 4: Start 2 FROST signers
    // =========================================================================
    log("Starting 2 FROST signers...");

    // Get a pool address (where swept funds go)
    const poolAddr = getNewAddress("bech32m");
    log(`Pool receive address: ${poolAddr}`);

    const auditFile = path.join(tmpDir, "audit.jsonl");

    for (const [id, port] of [
      [1, SIGNER1_PORT],
      [2, SIGNER2_PORT],
    ] as const) {
      const keyFile = path.join(tmpDir, `signer${id}.key.enc`);
      const proc = spawn(
        frostBin,
        [
          "run",
          "--id", String(id),
          "--password", KEY_PASSWORD,
          "--key-file", keyFile,
          "--bind", `0.0.0.0:${port}`,
          "--pool-address", poolAddr,
          "--max-fee", "50000",
          "--max-amount", "1000000000",
          "--audit-log", auditFile,
          "--network", "regtest",
          // Note: --require-context omitted for E2E — sighash verified by regtest broadcast instead
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, RUST_LOG: "warn", FROST_API_KEY },
        }
      );
      signerProcesses.push(proc);
      log(`  Signer ${id} started (pid=${proc.pid}, port=${port})`);
    }

    // Wait for both signers to be healthy
    await waitForHealth(SIGNER1_URL);
    await waitForHealth(SIGNER2_URL);
    log("Both signers are healthy and keys loaded");

    // =========================================================================
    // Step 5: Build unsigned sweep TX
    // =========================================================================
    log("Building unsigned sweep TX...");

    const { rawTxHex, sighashHex, prevoutScriptPubkeyHex, sweepAmountSats } =
      buildUnsignedSweepTx(
        fundTxid,
        depositVout,
        depositAmountSats,
        outputKeyHex,
        poolAddr,
        npkBytes,
      );

    log(`  Raw TX: ${rawTxHex.slice(0, 40)}...`);
    log(`  Sighash: ${sighashHex}`);
    log(`  Sweep amount: ${sweepAmountSats} sats`);

    // Build signing context (sent to signers for policy verification)
    const signingContext = {
      raw_tx_hex: rawTxHex,
      prevouts: [
        {
          txid: fundTxid,
          vout: depositVout,
          amount_sats: depositAmountSats,
          script_pubkey_hex: prevoutScriptPubkeyHex,
        },
      ],
      input_index: 0,
    };

    // =========================================================================
    // Step 6: FROST signing protocol (round1 -> verify -> round2 -> aggregate)
    // =========================================================================
    log("Starting FROST signing protocol...");

    const sessionId = crypto.randomUUID();

    // -- Round 1: Collect commitments --
    log("  Round 1: Collecting commitments...");
    const commitments: Record<string, string> = {};
    const identifierMap: Record<string, string> = {};

    for (const [name, url] of [
      ["Signer 1", SIGNER1_URL],
      ["Signer 2", SIGNER2_URL],
    ] as const) {
      const resp = await frostRound1(
        url,
        sessionId,
        sighashHex,
        tweakHex,
        signingContext,
        npkHex,
      );
      commitments[String(resp.signer_id)] = resp.commitment;
      identifierMap[String(resp.signer_id)] = resp.frost_identifier;
      log(`    ${name} (id=${resp.signer_id}) -> commitment OK`);
    }

    // -- Verify commitments (broadcast consistency check) --
    log("  Verify: Checking broadcast consistency...");
    const digests: string[] = [];

    for (const [name, url] of [
      ["Signer 1", SIGNER1_URL],
      ["Signer 2", SIGNER2_URL],
    ] as const) {
      const resp = await frostVerifyCommitments(
        url,
        sessionId,
        commitments,
        identifierMap,
      );
      digests.push(resp.digest);
      log(`    ${name} digest: ${resp.digest.slice(0, 16)}...`);
    }

    if (digests[0] !== digests[1]) {
      throw new Error("Commitment digests do not match between signers!");
    }
    log("    Digests match!");

    // -- Round 2: Collect signature shares --
    log("  Round 2: Collecting signature shares...");
    const signatureShares: Record<string, string> = {};

    for (const [name, url] of [
      ["Signer 1", SIGNER1_URL],
      ["Signer 2", SIGNER2_URL],
    ] as const) {
      const resp = await frostRound2(
        url,
        sessionId,
        sighashHex,
        tweakHex,
        commitments,
        identifierMap,
        npkHex,
      );
      signatureShares[String(resp.signer_id)] = resp.signature_share;
      log(`    ${name} -> share OK`);
    }

    // -- Aggregate --
    log("  Aggregate: Combining signature shares with Taproot tweak...");
    const aggResp = await frostAggregate(
      SIGNER1_URL,
      commitments,
      identifierMap,
      signatureShares,
      sighashHex,
      npkHex,
    );

    const sigHex = aggResp.signature;
    if (sigHex.length !== 128) {
      throw new Error(`Expected 64-byte signature (128 hex chars), got ${sigHex.length}`);
    }
    log(`  Signature: ${sigHex.slice(0, 16)}...${sigHex.slice(112)}`);

    // =========================================================================
    // Step 7: Build signed TX and broadcast
    // =========================================================================
    log("Building signed transaction...");

    const signedTxHex = attachWitness(rawTxHex, sigHex);
    log(`  Signed TX: ${signedTxHex.slice(0, 40)}... (${signedTxHex.length / 2} bytes)`);

    // Broadcast to regtest
    log("Broadcasting signed sweep TX...");
    const sweepTxid = btc(`sendrawtransaction ${signedTxHex}`);
    log(`  Sweep txid: ${sweepTxid}`);

    // =========================================================================
    // Step 8: Mine and verify
    // =========================================================================
    log("Mining block to confirm sweep...");
    mineBlocks(1, minerAddr);

    // Verify the sweep TX is confirmed
    await waitForTxIndexed(sweepTxid, ESPLORA_URL);
    log("Sweep TX confirmed!");

    // Verify the pool address received the funds
    const sweepTxInfo = JSON.parse(btc(`gettransaction ${sweepTxid} true true`));
    const sweepDecoded =
      sweepTxInfo.decoded ||
      JSON.parse(btc(`decoderawtransaction ${sweepTxInfo.hex}`));

    let poolReceived = false;
    for (const out of sweepDecoded.vout) {
      if (out.scriptPubKey?.address === poolAddr && out.value > 0) {
        const receivedSats = Math.round(out.value * 1e8);
        log(`  Pool received: ${receivedSats} sats at ${poolAddr.slice(0, 20)}...`);
        poolReceived = true;
        break;
      }
    }
    if (!poolReceived) {
      throw new Error("Pool address did not receive funds in sweep TX");
    }

    // Check audit log was written
    if (fs.existsSync(auditFile)) {
      const auditLines = fs.readFileSync(auditFile, "utf-8").trim().split("\n");
      log(`  Audit log: ${auditLines.length} entries written`);
    }

    console.log("\nStep 3b: FROST Sweep (threshold signing) ...... PASS");
  } finally {
    // =========================================================================
    // Cleanup: Kill signer processes
    // =========================================================================
    log("Cleaning up signer processes...");
    for (const proc of signerProcesses) {
      if (proc.pid) {
        try {
          process.kill(proc.pid, "SIGTERM");
        } catch {
          // already exited
        }
      }
    }

    // Clean up temp directory
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }
  }
}

main().catch((err) => {
  console.error("FAIL:", err.message || err);
  if (err.logs) err.logs.forEach((l: string) => console.error("  ", l));
  process.exit(1);
});
