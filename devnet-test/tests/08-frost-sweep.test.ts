/**
 * 08 — FROST Sweep E2E (Regtest)
 *
 * Full lifecycle test of FROST threshold signing with real regtest BTC:
 *   Get group pubkey → derive Taproot deposit address → fund deposit
 *   → build sweep tx → compute BIP-341 sighash → FROST 2-of-3 sign
 *   → broadcast sweep → verify on-chain
 *
 * Requires:
 *   - bitcoind regtest Docker (port 18443)
 *   - 3 FROST signers Docker (ports 9001/9002/9003, keys loaded)
 *
 * Run: TEST_MODE=local bun test tests/08-frost-sweep.test.ts --timeout 300000
 */

import { describe, it, expect, beforeAll } from "bun:test";
import {
  createTestContext,
  fetchJson,
  postJson,
  type TestContext,
  IS_LOCAL,
} from "./setup";
import {
  bitcoinRpc,
  bootstrapRegtest,
  isRegtestAvailable,
  mineBlocks,
} from "./regtest";
import { sha256 } from "@noble/hashes/sha2.js";

// =============================================================================
// Helpers
// =============================================================================

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** BIP-340/341 tagged hash: SHA256(SHA256(tag) || SHA256(tag) || data) */
function taggedHash(tag: string, data: Uint8Array): Uint8Array {
  const tagBytes = new TextEncoder().encode(tag);
  const tagHash = sha256(tagBytes);
  const combined = new Uint8Array(64 + data.length);
  combined.set(tagHash, 0);
  combined.set(tagHash, 32);
  combined.set(data, 64);
  return sha256(combined);
}

/** Concat multiple Uint8Arrays */
function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

/** Write u32 LE into buffer at offset */
function writeU32LE(buf: Uint8Array, value: number, offset: number) {
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setUint32(offset, value, true);
}

/** Write i32 LE into buffer at offset */
function writeI32LE(buf: Uint8Array, value: number, offset: number) {
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setInt32(offset, value, true);
}

/** Write u64 LE into buffer at offset */
function writeU64LE(buf: Uint8Array, value: bigint, offset: number) {
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setBigUint64(offset, value, true);
}

/** Bitcoin compact size (varint) encoding */
function compactSize(n: number): Uint8Array {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) return new Uint8Array([0xfd, n & 0xff, (n >> 8) & 0xff]);
  const buf = new Uint8Array(5);
  buf[0] = 0xfe;
  writeU32LE(buf, n, 1);
  return buf;
}

/**
 * Compute BIP-341 sighash for key-path spend (SIGHASH_DEFAULT = 0x00).
 *
 * Reference: BIP-341, frost_server/src/bin/mock_sweep_e2e.rs:199-206
 */
function computeTapSighash(params: {
  txVersion: number;
  txLocktime: number;
  prevouts: { txid: Uint8Array; vout: number; amount: bigint; scriptPubKey: Uint8Array }[];
  outputs: { value: bigint; scriptPubKey: Uint8Array }[];
  inputIndex: number;
}): Uint8Array {
  const { txVersion, txLocktime, prevouts, outputs, inputIndex } = params;

  // sha_prevouts: SHA256(outpoint0 || outpoint1 || ...)
  const prevoutsData = concat(
    ...prevouts.map((p) => {
      const buf = new Uint8Array(36);
      buf.set(p.txid, 0);
      writeU32LE(buf, p.vout, 32);
      return buf;
    })
  );
  const shaPrevouts = sha256(prevoutsData);

  // sha_amounts: SHA256(amount0_le || amount1_le || ...)
  const amountsData = concat(
    ...prevouts.map((p) => {
      const buf = new Uint8Array(8);
      writeU64LE(buf, p.amount, 0);
      return buf;
    })
  );
  const shaAmounts = sha256(amountsData);

  // sha_scriptpubkeys: SHA256(compact_size(spk.len) || spk || ...)
  const shaScriptPubKeys = sha256(
    concat(...prevouts.map((p) => concat(compactSize(p.scriptPubKey.length), p.scriptPubKey)))
  );

  // sha_sequences: SHA256(sequence0_le || ...)
  // Using 0xFFFFFFFD (ENABLE_RBF_NO_LOCKTIME)
  const shaSequences = sha256(
    concat(
      ...prevouts.map(() => {
        const buf = new Uint8Array(4);
        writeU32LE(buf, SEQUENCE_RBF, 0);
        return buf;
      })
    )
  );

  // sha_outputs: SHA256(value_le || compact_size(spk.len) || spk || ...)
  const shaOutputs = sha256(
    concat(
      ...outputs.map((o) => {
        const valueBuf = new Uint8Array(8);
        writeU64LE(valueBuf, o.value, 0);
        return concat(valueBuf, compactSize(o.scriptPubKey.length), o.scriptPubKey);
      })
    )
  );

  // Assemble sighash message
  const versionBuf = new Uint8Array(4);
  writeI32LE(versionBuf, txVersion, 0);
  const locktimeBuf = new Uint8Array(4);
  writeU32LE(locktimeBuf, txLocktime, 0);
  const inputIndexBuf = new Uint8Array(4);
  writeU32LE(inputIndexBuf, inputIndex, 0);

  const message = concat(
    new Uint8Array([0x00]),   // epoch
    new Uint8Array([0x00]),   // hash_type (SIGHASH_DEFAULT)
    versionBuf,               // tx version
    locktimeBuf,              // tx locktime
    shaPrevouts,
    shaAmounts,
    shaScriptPubKeys,
    shaSequences,
    shaOutputs,
    new Uint8Array([0x00]),   // spend_type (key-path, no annex)
    inputIndexBuf,
  );

  return taggedHash("TapSighash", message);
}

/**
 * Build a signed Bitcoin transaction with Taproot witness.
 *
 * Segwit format: version(4) + marker(0x00) + flag(0x01) + inputs + outputs + witness + locktime(4)
 */
function buildSignedTx(params: {
  version: number;
  locktime: number;
  inputs: { txid: Uint8Array; vout: number; sequence: number }[];
  outputs: { value: bigint; scriptPubKey: Uint8Array }[];
  witnesses: Uint8Array[][]; // witness stack per input
}): Uint8Array {
  const { version, locktime, inputs, outputs, witnesses } = params;
  const parts: Uint8Array[] = [];

  // Version (4 bytes LE)
  const versionBuf = new Uint8Array(4);
  writeI32LE(versionBuf, version, 0);
  parts.push(versionBuf);

  // Segwit marker + flag
  parts.push(new Uint8Array([0x00, 0x01]));

  // Inputs
  parts.push(compactSize(inputs.length));
  for (const inp of inputs) {
    parts.push(inp.txid);
    const voutBuf = new Uint8Array(4);
    writeU32LE(voutBuf, inp.vout, 0);
    parts.push(voutBuf);
    parts.push(new Uint8Array([0x00])); // empty scriptSig
    const seqBuf = new Uint8Array(4);
    writeU32LE(seqBuf, inp.sequence, 0);
    parts.push(seqBuf);
  }

  // Outputs
  parts.push(compactSize(outputs.length));
  for (const out of outputs) {
    const valueBuf = new Uint8Array(8);
    writeU64LE(valueBuf, out.value, 0);
    parts.push(valueBuf);
    parts.push(compactSize(out.scriptPubKey.length));
    parts.push(out.scriptPubKey);
  }

  // Witness data
  for (const witnessStack of witnesses) {
    parts.push(compactSize(witnessStack.length));
    for (const item of witnessStack) {
      parts.push(compactSize(item.length));
      parts.push(item);
    }
  }

  // Locktime (4 bytes LE)
  const locktimeBuf = new Uint8Array(4);
  writeU32LE(locktimeBuf, locktime, 0);
  parts.push(locktimeBuf);

  return concat(...parts);
}

// =============================================================================
// Constants
// =============================================================================

const DEPOSIT_AMOUNT_SATS = 50_000n;
const FEE_SATS = 300n; // conservative for regtest (~150 vbytes × 2 sat/vbyte)
const SEQUENCE_RBF = 0xfffffffd; // ENABLE_RBF_NO_LOCKTIME
const TX_VERSION = 2;

// =============================================================================
// Test Suite
// =============================================================================

let ctx: TestContext;

// Shared state across test steps
let groupPubKeyHex: string;
let groupPubKeyBytes: Uint8Array;
let npk: Uint8Array;
let tweakBytes: Uint8Array;
let depositAddress: string;
let outputKeyBytes: Uint8Array;
let depositScriptPubKey: Uint8Array;
let depositTxid: string;
let depositVout: number;
let poolAddress: string;
let poolScriptPubKey: Uint8Array;
let sighashBytes: Uint8Array;
let signedTxHex: string;

beforeAll(async () => {
  ctx = await createTestContext();
});

describe("FROST Sweep E2E (Regtest)", () => {
  it("0. prerequisites — FROST signers and regtest available", async () => {
    if (!IS_LOCAL) {
      console.log("  Skipping — requires TEST_MODE=local");
      return;
    }

    const regtestReady = await isRegtestAvailable();
    expect(regtestReady).toBe(true);
    await bootstrapRegtest();

    // Check at least 2 FROST signers are reachable (threshold)
    let available = 0;
    for (const url of ctx.frostSignerUrls) {
      try {
        const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) available++;
      } catch {}
    }
    console.log(`  ${available}/3 FROST signers reachable`);
    expect(available).toBeGreaterThanOrEqual(2);
    console.log("  Regtest and FROST signers ready");
  });

  it("1. get FROST group pubkey from signers", async () => {
    if (!IS_LOCAL) return;

    const info = await fetchJson(`${ctx.frostSignerUrls[0]}/info`, 5000);
    groupPubKeyHex = info.group_public_key;
    groupPubKeyBytes = hexToBytes(groupPubKeyHex);

    expect(groupPubKeyBytes.length).toBe(32);
    expect(groupPubKeyHex).not.toBe("0".repeat(64));

    // Verify all reachable signers agree on the group pubkey
    for (let i = 1; i < ctx.frostSignerUrls.length; i++) {
      try {
        const info2 = await fetchJson(`${ctx.frostSignerUrls[i]}/info`, 5000);
        expect(info2.group_public_key).toBe(groupPubKeyHex);
      } catch {}
    }

    console.log(`  Group pubkey: ${groupPubKeyHex}`);
  });

  it("2. generate Taproot deposit address with npk tweak", async () => {
    if (!IS_LOCAL || !groupPubKeyBytes) return;

    // Generate random npk (32 bytes) — serves as the commitment for the tweak
    npk = crypto.getRandomValues(new Uint8Array(32));

    // Use SDK to derive the tweaked Taproot address
    const { deriveTaprootAddress } = await import("@aegis/sdk");
    const result = deriveTaprootAddress(npk, "regtest", groupPubKeyBytes);
    depositAddress = result.address;
    outputKeyBytes = result.outputKey;
    tweakBytes = result.tweak;

    // Build the P2TR scriptPubKey for sighash computation
    depositScriptPubKey = new Uint8Array(34);
    depositScriptPubKey[0] = 0x51; // OP_1
    depositScriptPubKey[1] = 0x20; // PUSH 32
    depositScriptPubKey.set(outputKeyBytes, 2);

    expect(depositAddress).toMatch(/^bcrt1p/);
    expect(outputKeyBytes.length).toBe(32);

    console.log(`  NPK: ${bytesToHex(npk).slice(0, 32)}...`);
    console.log(`  Deposit address: ${depositAddress}`);
    console.log(`  Tweak: ${bytesToHex(tweakBytes).slice(0, 32)}...`);
  });

  it("3. fund deposit address on regtest", async () => {
    if (!IS_LOCAL || !depositAddress) return;

    // Send 50,000 sats to the Taproot deposit address
    await bitcoinRpc<string>("sendtoaddress", [
      depositAddress,
      Number(DEPOSIT_AMOUNT_SATS) / 1e8,
    ]);
    await mineBlocks(1);

    // Find the UTXO via scantxoutset (works for any address, not just wallet)
    const scan = await bitcoinRpc<{ unspents: any[] }>("scantxoutset", [
      "start",
      [`addr(${depositAddress})`],
    ]);
    expect(scan.unspents.length).toBeGreaterThan(0);

    const utxo = scan.unspents[0];
    depositTxid = utxo.txid;
    depositVout = utxo.vout;
    const utxoAmountSats = BigInt(Math.round(utxo.amount * 1e8));
    expect(utxoAmountSats).toBe(DEPOSIT_AMOUNT_SATS);

    console.log(`  Funded: ${depositTxid}:${depositVout} (${utxoAmountSats} sats)`);
  });

  it("4. build sweep tx and compute BIP-341 sighash", async () => {
    if (!IS_LOCAL || !depositTxid) return;

    // Get a fresh pool receive address from bitcoind wallet
    poolAddress = await bitcoinRpc<string>("getnewaddress", ["", "bech32"]);

    // Get the scriptPubKey via getaddressinfo (reliable for wallet addresses)
    const addrInfo = await bitcoinRpc<{ scriptPubKey: string }>("getaddressinfo", [poolAddress]);
    poolScriptPubKey = hexToBytes(addrInfo.scriptPubKey);

    console.log(`  Pool address: ${poolAddress}`);
    console.log(`  Pool scriptPubKey: ${bytesToHex(poolScriptPubKey)}`);

    // OP_RETURN script: OP_RETURN(0x6a) + PUSH32(0x20) + npk(32)
    const opReturnScript = new Uint8Array(34);
    opReturnScript[0] = 0x6a;
    opReturnScript[1] = 0x20;
    opReturnScript.set(npk, 2);

    const sendAmount = DEPOSIT_AMOUNT_SATS - FEE_SATS;

    // Prevout txid in internal byte order (reversed from display order)
    const txidInternal = hexToBytes(depositTxid);
    txidInternal.reverse();

    // Compute BIP-341 sighash for key-path spend
    sighashBytes = computeTapSighash({
      txVersion: TX_VERSION,
      txLocktime: 0,
      prevouts: [
        {
          txid: txidInternal,
          vout: depositVout,
          amount: DEPOSIT_AMOUNT_SATS,
          scriptPubKey: depositScriptPubKey,
        },
      ],
      outputs: [
        { value: sendAmount, scriptPubKey: poolScriptPubKey },
        { value: 0n, scriptPubKey: opReturnScript },
      ],
      inputIndex: 0,
    });

    console.log(`  Sighash: ${bytesToHex(sighashBytes)}`);
    console.log(`  Send: ${sendAmount} sats → pool`);
    console.log(`  Fee: ${FEE_SATS} sats`);
  });

  it("5. FROST 2-of-3 threshold signing", async () => {
    if (!IS_LOCAL || !sighashBytes) return;

    const sessionId = crypto.randomUUID();
    const sighashHex = bytesToHex(sighashBytes);
    const tweakHex = bytesToHex(tweakBytes);
    const npkHex = bytesToHex(npk);

    // Use signers 1 and 2 (threshold = 2)
    const signerUrls = ctx.frostSignerUrls.slice(0, 2);

    // ── Round 1: Collect commitments ──
    console.log("  Round 1: Collecting commitments...");
    const commitments: Record<number, string> = {};
    const identifierMap: Record<number, string> = {};

    for (const url of signerUrls) {
      const response = await postJson(`${url}/round1`, {
        session_id: sessionId,
        sighash: sighashHex,
        tweak: tweakHex,
        merkle_root: npkHex,
      });

      console.log(`    Signer ${response.signer_id} → commitment OK`);
      commitments[response.signer_id] = response.commitment;
      identifierMap[response.signer_id] = response.frost_identifier;
    }

    // ── Verify commitments (broadcast consistency) ──
    console.log("  Verify: Checking broadcast consistency...");
    const digests: string[] = [];

    for (const url of signerUrls) {
      const response = await postJson(`${url}/verify-commitments`, {
        session_id: sessionId,
        commitments,
        identifier_map: identifierMap,
      });
      digests.push(response.digest);
      console.log(`    Signer ${response.signer_id} digest: ${response.digest.slice(0, 16)}...`);
    }
    expect(digests[0]).toBe(digests[1]);
    console.log("    Digests match!");

    // ── Round 2: Collect signature shares ──
    console.log("  Round 2: Collecting signature shares...");
    const signatureShares: Record<number, string> = {};

    for (const url of signerUrls) {
      const response = await postJson(`${url}/round2`, {
        session_id: sessionId,
        sighash: sighashHex,
        tweak: tweakHex,
        commitments,
        identifier_map: identifierMap,
        merkle_root: npkHex,
      });

      console.log(`    Signer ${response.signer_id} → share OK`);
      signatureShares[response.signer_id] = response.signature_share;
    }

    // ── Aggregate: Combine shares into final Schnorr signature ──
    console.log("  Aggregate: Combining signature shares with Taproot tweak...");
    const aggResponse = await postJson(`${ctx.frostSignerUrls[0]}/aggregate`, {
      commitments,
      identifier_map: identifierMap,
      signature_shares: signatureShares,
      sighash: sighashHex,
      merkle_root: npkHex,
    });

    const sigHex: string = aggResponse.signature;
    const sigBytes = hexToBytes(sigHex);
    expect(sigBytes.length).toBe(64);
    console.log(`  Signature (64 bytes): ${sigHex.slice(0, 16)}...${sigHex.slice(-16)}`);

    // ── Build the signed transaction ──
    const txidInternal = hexToBytes(depositTxid);
    txidInternal.reverse();

    const sendAmount = DEPOSIT_AMOUNT_SATS - FEE_SATS;
    const opReturnScript = new Uint8Array(34);
    opReturnScript[0] = 0x6a;
    opReturnScript[1] = 0x20;
    opReturnScript.set(npk, 2);

    const signedTxBytes = buildSignedTx({
      version: TX_VERSION,
      locktime: 0,
      inputs: [
        {
          txid: txidInternal,
          vout: depositVout,
          sequence: SEQUENCE_RBF,
        },
      ],
      outputs: [
        { value: sendAmount, scriptPubKey: poolScriptPubKey },
        { value: 0n, scriptPubKey: opReturnScript },
      ],
      witnesses: [
        [sigBytes], // Taproot key-path spend: single 64-byte Schnorr signature
      ],
    });

    signedTxHex = bytesToHex(signedTxBytes);
    console.log(`  Signed tx: ${signedTxBytes.length} bytes`);
  });

  it("6. broadcast sweep and verify on-chain", async () => {
    if (!IS_LOCAL || !signedTxHex) return;

    // Broadcast the signed sweep transaction
    console.log("  Broadcasting sweep tx...");
    const sweepTxid = await bitcoinRpc<string>("sendrawtransaction", [signedTxHex]);
    console.log(`  Sweep txid: ${sweepTxid}`);

    // Mine a block to confirm
    await mineBlocks(1);

    // Verify tx is confirmed
    const txInfo = await bitcoinRpc<any>("getrawtransaction", [sweepTxid, true]);
    expect(txInfo.confirmations).toBeGreaterThanOrEqual(1);
    console.log(`  Confirmations: ${txInfo.confirmations}`);

    // Verify pool address received funds
    const scan = await bitcoinRpc<{ total_amount: number }>("scantxoutset", [
      "start",
      [`addr(${poolAddress})`],
    ]);
    const receivedSats = BigInt(Math.round(scan.total_amount * 1e8));
    expect(receivedSats).toBe(DEPOSIT_AMOUNT_SATS - FEE_SATS);
    console.log(`  Pool received: ${receivedSats} sats`);

    // Verify OP_RETURN commitment is extractable from the sweep tx
    let commitmentFound = false;
    for (const output of txInfo.vout) {
      if (output.scriptPubKey?.type === "nulldata") {
        const scriptHex: string = output.scriptPubKey.hex;
        // OP_RETURN(6a) + PUSH32(20) + npk(64 hex chars) = 68 hex chars
        if (scriptHex.startsWith("6a20") && scriptHex.length === 68) {
          const extractedNpk = scriptHex.slice(4);
          expect(extractedNpk).toBe(bytesToHex(npk));
          commitmentFound = true;
          console.log(`  OP_RETURN commitment verified: ${extractedNpk.slice(0, 32)}...`);
        }
      }
    }
    expect(commitmentFound).toBe(true);

    // Verify deposit UTXO is now spent
    const depositScan = await bitcoinRpc<{ unspents: any[] }>("scantxoutset", [
      "start",
      [`addr(${depositAddress})`],
    ]);
    expect(depositScan.unspents.length).toBe(0);
    console.log("  Deposit UTXO spent: confirmed");

    console.log(`\n  === FROST SWEEP E2E COMPLETE ===`);
    console.log(`  Deposit address: ${depositAddress}`);
    console.log(`  Sweep txid: ${sweepTxid}`);
    console.log(`  Amount: ${DEPOSIT_AMOUNT_SATS - FEE_SATS} sats → ${poolAddress}`);
    console.log(`  Fee: ${FEE_SATS} sats`);
  });
});
