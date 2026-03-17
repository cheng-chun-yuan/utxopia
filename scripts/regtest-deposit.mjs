#!/usr/bin/env node
/**
 * Regtest BTC Deposit Flow
 *
 * 1. Parse stealth meta-address
 * 2. Generate deposit (ephemeral keypair + npk)
 * 3. Create BTC tx with OP_RETURN on regtest
 * 4. Mine block
 * 5. Initialize BTC light client + submit headers
 * 6. Verify deposit on Solana
 */

import {
  createStealthDeposit,
  computeTokenId,
  computeNPKSync,
  computeMPKSync,
  ed25519GenerateKeyPair,
  x25519Ecdh,
  ed25519PubToX25519,
  bigintToBytes,
} from "../sdk/dist/index.js";
import { PublicKey, Keypair, Connection, Transaction, TransactionInstruction, SystemProgram, sendAndConfirmTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { execSync } from "child_process";
import fs from "fs";

// ============================================================================
// Config
// ============================================================================

const STEALTH_ADDR = process.argv[2] || "aegis:9d2cb3fea6912aeb783760f47367c53f2fb2ed7240c98a99786172982950fe988f45b56ecd1d6d02f5007accc9fa430bc4dc91f1fabe1d37977cb773468ef3451b592c4e3881b34572c0d83baacfda725f04ac6810dbaf7227e7f69f784c1eb6";
const AMOUNT_BTC = 0.001; // 100,000 sats
const AMOUNT_SATS = BigInt(Math.floor(AMOUNT_BTC * 1e8));

const PROGRAM_ID = new PublicKey("8fqRet9WB5PECvKfWmzTPSusJgQz1onzxTLfHD75XKim");
const MINT = new PublicKey("AYJpCnAPbLbcfiCJLwRSpvNgH2yt9UktMPMYSTRA9fLL");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const BTC_CLI = "docker exec aegis-esplora-regtest /srv/explorer/bitcoin/bin/bitcoin-cli -regtest -datadir=/data/bitcoin";

const authority = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/johnny.json")))
);
const conn = new Connection("http://localhost:8899", "confirmed");

function btcCmd(cmd) {
  return execSync(`${BTC_CLI} ${cmd}`, { encoding: "utf8" }).trim();
}

function ata(mint, owner) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_2022.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM,
  )[0];
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("=== Regtest BTC Deposit Flow ===\n");

  // 1. Parse stealth meta-address
  const hex = STEALTH_ADDR.replace("aegis:", "");
  const metaBytes = Buffer.from(hex, "hex");
  const meta = {
    spendingPubKey: metaBytes.slice(0, 32),
    viewingPubKey: metaBytes.slice(32, 64),
    mpk: metaBytes.slice(64, 96),
  };
  console.log("Stealth address parsed (96 bytes)");

  // 2. Compute token_id
  const tokenId = computeTokenId(MINT.toBytes());
  console.log("Token ID:", tokenId.toString(16).slice(0, 16) + "...");

  // 3. Generate deposit data (ephemeral + npk)
  const deposit = await createStealthDeposit(meta, AMOUNT_SATS, tokenId);
  const ephemeralPub = Buffer.from(deposit.ephemeralPub);
  const commitment = Buffer.from(deposit.commitment);
  console.log("Ephemeral pub:", ephemeralPub.toString("hex").slice(0, 20) + "...");
  console.log("Commitment:", commitment.toString("hex").slice(0, 20) + "...");

  // 4. Build OP_RETURN data: ephemeral_pub(32) + npk(32) = 64 bytes
  // NPK is embedded in the commitment — for the on-chain instruction we need the raw NPK
  // The deposit object encryptedAmount field contains the NPK info
  // For demo, we'll generate a deterministic NPK from the meta
  const { sha256 } = await import("@noble/hashes/sha2.js");
  const sharedSecret = x25519Ecdh(
    deposit.ephemeralPub.slice(0, 32), // use as private key placeholder
    ed25519PubToX25519(meta.viewingPubKey)
  );
  const domain = new TextEncoder().encode("Aegis-stealth-v1");
  const buf = new Uint8Array(sharedSecret.length + domain.length);
  buf.set(sharedSecret);
  buf.set(domain, sharedSecret.length);
  const hash = sha256(buf);
  let stealthScalar = 0n;
  for (const b of hash) stealthScalar = (stealthScalar << 8n) | BigInt(b);
  const BN254_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  stealthScalar = stealthScalar % BN254_FIELD;

  const mpkBigint = (() => {
    let v = 0n;
    for (const b of meta.mpk) v = (v << 8n) | BigInt(b);
    return v;
  })();
  const npk = computeNPKSync(mpkBigint, stealthScalar);
  const npkBytes = bigintToBytes(npk);

  // OP_RETURN = ephemeral_pub(32) + npk(32) = 64 bytes
  const opReturnData = Buffer.concat([ephemeralPub, Buffer.from(npkBytes)]);
  console.log("OP_RETURN (64 bytes):", opReturnData.toString("hex").slice(0, 40) + "...");

  // 5. Create BTC transaction with OP_RETURN
  console.log("\n--- Sending BTC on regtest ---");

  // Get a new regtest address for the deposit output (Taproot P2TR)
  // For real flow, this would be derived from the npk. For regtest demo, use a random address.
  const depositAddr = btcCmd("getnewaddress '' bech32m");
  console.log("Deposit addr:", depositAddr);

  // Create raw tx with OP_RETURN
  const opReturnHex = opReturnData.toString("hex");

  // Fund, create, sign, send
  const txHex = btcCmd(`-named createrawtransaction inputs='[]' outputs='[{"${depositAddr}":${AMOUNT_BTC}},{"data":"${opReturnHex}"}]'`);
  const fundedResult = JSON.parse(btcCmd(`fundrawtransaction ${txHex}`));
  const signedResult = JSON.parse(btcCmd(`signrawtransactionwithwallet ${fundedResult.hex}`));

  if (!signedResult.complete) {
    throw new Error("Failed to sign transaction");
  }

  const txid = btcCmd(`sendrawtransaction ${signedResult.hex}`);
  console.log("Deposit txid:", txid);

  // 6. Mine a block
  const minerAddr = btcCmd("getnewaddress '' bech32m");
  const blockHash = JSON.parse(btcCmd(`generatetoaddress 1 ${minerAddr}`))[0];
  console.log("Mined block:", blockHash.slice(0, 20) + "...");

  // Verify via Esplora API
  await new Promise(r => setTimeout(r, 3000)); // wait for indexing
  const esploraHeight = execSync("curl -s http://localhost:3002/regtest/api/blocks/tip/height", { encoding: "utf8" }).trim();
  console.log("Esplora tip height:", esploraHeight);

  const txInfo = execSync(`curl -s http://localhost:3002/regtest/api/tx/${txid}`, { encoding: "utf8" });
  const txData = JSON.parse(txInfo);
  console.log("TX confirmed:", txData.status?.confirmed ? "yes" : "no");
  console.log("TX block height:", txData.status?.block_height);

  console.log("\n=== BTC Deposit Created ===");
  console.log("TXID:", txid);
  console.log("Amount:", AMOUNT_SATS.toString(), "sats");
  console.log("OP_RETURN ephemeral:", ephemeralPub.toString("hex").slice(0, 32) + "...");
  console.log("OP_RETURN npk:", Buffer.from(npkBytes).toString("hex").slice(0, 32) + "...");
  console.log("\nNext: initialize BTC light client headers, then call verify_stealth_deposit");
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
