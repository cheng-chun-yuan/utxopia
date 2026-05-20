#!/usr/bin/env bun
/**
 * Hybrid demo: spend one locally owned shielded zkBTC note and withdraw BTC.
 *
 *   scan notes from .demo-seed.json
 *     → generate joinsplit_1x1 redeem proof
 *       → create RedemptionRequest PDA on Solana (disc=15)
 *         → backend redemption watcher approves Ika signing, broadcasts regtest BTC
 *           → mines 6 confirmations and completes redemption on Solana
 *
 * Usage:
 *   set -a && source .env && set +a
 *   bun run scripts/hybrid/04-withdraw.ts
 *   # optional: BTC_ADDRESS=bcrt1... WITHDRAW_SATS=90000
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

import {
  UTXOpiaClient,
  initConfig,
  initPoseidon,
  poseidonHashSync,
  computeJoinSplitCommitmentSync,
  computeStealthDataHash,
  createRedeemBoundParams,
  computeBoundParamsHash,
  bigintToBytes,
  bytesToBigint,
  eddsaPoseidonSign,
  TREE_DEPTH,
  prepareClaimInputs,
  computeTokenId,
} from "../../sdk/src/index";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3020";
const API_KEY = process.env.BACKEND_API_KEY;
const STATE_PATH =
  process.env.STATE_PATH ||
  path.join(PROJECT_ROOT, "scripts/devnet-regtest-state.json");
const SOLANA_RPC =
  process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const SEED_PATH = path.join(__dirname, ".demo-seed.json");
const OUT_PATH = path.join(__dirname, ".withdraw.json");
const KEYPAIR_PATH = path.join(process.env.HOME!, ".config/solana/id.json");
const CIRCUITS_DIR = path.resolve(PROJECT_ROOT, "circuits/build");

const CONTAINER = "utxopia-esplora-regtest";
const BCLI = "/srv/explorer/bitcoin/bin/bitcoin-cli";
const BCLI_ARGS = "-regtest -datadir=/data/bitcoin -rpcwallet=test";

if (!API_KEY) {
  console.error("ERROR: BACKEND_API_KEY required");
  process.exit(1);
}
if (!fs.existsSync(SEED_PATH)) {
  console.error(`ERROR: ${SEED_PATH} missing — run scripts/hybrid/01-deposit.ts first`);
  process.exit(1);
}

const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
const seed = Uint8Array.from(
  Buffer.from(JSON.parse(fs.readFileSync(SEED_PATH, "utf-8")).seed, "hex"),
);

function btc(cmd: string): string {
  return execSync(`docker exec ${CONTAINER} ${BCLI} ${BCLI_ARGS} ${cmd}`, {
    encoding: "utf-8",
  }).trim();
}

function loadAuthority(): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf-8"))),
  );
}

function bigintTo32(n: bigint): Uint8Array {
  return bigintToBytes(n);
}

function hex(buf: Uint8Array): string {
  return Buffer.from(buf).toString("hex");
}

async function api(pathname: string, init?: RequestInit): Promise<any> {
  const r = await fetch(`${BACKEND_URL}${pathname}`, {
    ...init,
    headers: { "X-API-Key": API_KEY!, ...(init?.headers || {}) },
  });
  if (!r.ok) throw new Error(`${pathname} -> ${r.status}: ${await r.text()}`);
  return r.json();
}

function generateProofViaNode(
  circuitName: string,
  inputs: Record<string, unknown>,
): { proof: any; publicSignals: string[] } {
  const wasmPath = path.join(
    CIRCUITS_DIR,
    circuitName,
    `${circuitName}_js`,
    `${circuitName}.wasm`,
  );
  const zkeyPath = path.join(CIRCUITS_DIR, circuitName, `${circuitName}.zkey`);
  if (!fs.existsSync(wasmPath)) throw new Error(`WASM missing: ${wasmPath}`);
  if (!fs.existsSync(zkeyPath)) throw new Error(`zkey missing: ${zkeyPath}`);

  const tmpDir = path.join(__dirname, ".tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const ts = Date.now();
  const tmpInput = path.join(tmpDir, `withdraw_input_${ts}.json`);
  const tmpProof = path.join(tmpDir, `withdraw_proof_${ts}.json`);
  const tmpPublic = path.join(tmpDir, `withdraw_public_${ts}.json`);
  fs.writeFileSync(tmpInput, JSON.stringify(inputs));

  console.log(`  generating ${circuitName} proof...`);
  execSync(
    `node -e "
      const snarkjs = require('snarkjs');
      const fs = require('fs');
      (async () => {
        const input = JSON.parse(fs.readFileSync('${tmpInput}', 'utf8'));
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
          input, '${wasmPath}', '${zkeyPath}'
        );
        fs.writeFileSync('${tmpProof}', JSON.stringify(proof));
        fs.writeFileSync('${tmpPublic}', JSON.stringify(publicSignals));
        process.exit(0);
      })().catch(e => { console.error(e); process.exit(1); });
    "`,
    { timeout: 540_000, stdio: "pipe" },
  );

  const proof = JSON.parse(fs.readFileSync(tmpProof, "utf-8"));
  const publicSignals: string[] = JSON.parse(fs.readFileSync(tmpPublic, "utf-8"));
  fs.unlinkSync(tmpInput);
  fs.unlinkSync(tmpProof);
  fs.unlinkSync(tmpPublic);
  return { proof, publicSignals };
}

function serializeGroth16Proof(proof: any): Uint8Array {
  const bytes = new Uint8Array(256);
  function writeBE(buf: Uint8Array, offset: number, value: bigint, len: number) {
    for (let i = len - 1; i >= 0; i--) {
      buf[offset + i] = Number(value & 0xffn);
      value >>= 8n;
    }
  }
  writeBE(bytes, 0, BigInt(proof.pi_a[0]), 32);
  writeBE(bytes, 32, BigInt(proof.pi_a[1]), 32);
  writeBE(bytes, 64, BigInt(proof.pi_b[0][1]), 32);
  writeBE(bytes, 96, BigInt(proof.pi_b[0][0]), 32);
  writeBE(bytes, 128, BigInt(proof.pi_b[1][1]), 32);
  writeBE(bytes, 160, BigInt(proof.pi_b[1][0]), 32);
  writeBE(bytes, 192, BigInt(proof.pi_c[0]), 32);
  writeBE(bytes, 224, BigInt(proof.pi_c[1]), 32);
  return bytes;
}

function deriveRedemptionPda(programId: PublicKey, user: PublicKey, nonce: bigint): PublicKey {
  const nonceBytes = Buffer.alloc(8);
  nonceBytes.writeBigUInt64LE(nonce);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("redemption"), user.toBuffer(), nonceBytes],
    programId,
  )[0];
}

function btcAddressToScriptPubKey(address: string): Buffer {
  // bitcoin-core can decode arbitrary valid regtest addresses, not only wallet-owned ones.
  const info = JSON.parse(btc(`getaddressinfo ${address}`));
  if (!info.scriptPubKey) {
    throw new Error(`bitcoin-cli did not return scriptPubKey for ${address}`);
  }
  return Buffer.from(info.scriptPubKey, "hex");
}

async function waitForRedemptionComplete(
  redemptionPda: PublicKey,
  requestNonce: bigint,
  destination: string,
) {
  const start = Date.now();
  const TIMEOUT = 15 * 60_000;
  let mined = false;

  while (Date.now() - start < TIMEOUT) {
    await new Promise((r) => setTimeout(r, 15_000));
    const elapsed = Math.round((Date.now() - start) / 1000);

    const all = await api("/api/redemption/all").catch(() => null);
    const tracking = all?.tracking || all?.redemptions?.tracking || [];
    const rows = Array.isArray(tracking) ? tracking : [];
    const row = rows.find((r: any) =>
      r.pda_address === redemptionPda.toBase58() ||
      BigInt(r.request_id || 0) === requestNonce
    );
    const btcTxid = row?.btc_txid || row?.btcTxid;
    const processingRows = all?.processing || all?.redemptions?.processing || [];
    const processing = Array.isArray(processingRows)
      ? processingRows.find((r: any) => BigInt(r.request_id || 0) === requestNonce)
      : undefined;
    const requestedRows = all?.requested || all?.redemptions?.requested || [];
    const requested = Array.isArray(requestedRows)
      ? requestedRows.find((r: any) => BigInt(r.request_id || 0) === requestNonce)
      : undefined;
    const status = row?.local_status || row?.status ||
      (processing ? "processing" : requested ? "requested" : "pending");
    console.log(`  [${elapsed}s] redemption=${status}${btcTxid ? ` btc=${btcTxid}` : ""}`);

    if (btcTxid && !mined) {
      const miner = btc("getnewaddress");
      btc(`generatetoaddress 6 ${miner}`);
      console.log(`  [${elapsed}s] mined 6 BTC confirmations for withdrawal`);
      mined = true;
    }

    const completed = all?.completed || all?.redemptions?.completed || [];
    const completedRows = Array.isArray(completed) ? completed : [];
    const done = completedRows.find((r: any) =>
      (r.redemption_pda === redemptionPda.toBase58() || r.pda_address === redemptionPda.toBase58()) ||
      BigInt(r.request_id || 0) === requestNonce ||
      (btcTxid && (r.btc_txid === btcTxid || r.btcTxid === btcTxid))
    );
    if (status === "Completed" || status === "completed" || done) {
      return { btcTxid, status: "completed" };
    }

    if (btcTxid) {
      const tx = await fetch(`http://localhost:3002/regtest/api/tx/${btcTxid}`).then((r) =>
        r.ok ? r.json() : null,
      ).catch(() => null);
      const paid = tx?.vout?.some((o: any) => o.scriptpubkey_address === destination);
      if (paid && mined && elapsed > 45) {
        return { btcTxid, status: "btc_broadcast" };
      }
    }
  }

  throw new Error("Timed out waiting for redemption backend");
}

async function main() {
  console.log("\n═══ Hybrid BTC withdraw via Ika redemption ═══\n");

  console.log("─── 1/6 SDK init + scan notes ───");
  await initPoseidon();
  const client = await UTXOpiaClient.init({ backendUrl: BACKEND_URL });
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
  await client.loginWithSeed(seed);
  const keys = client.keys;
  if (!keys) throw new Error("loginWithSeed did not populate keys");

  const notes = await client.getNotes([
    { symbol: "BTC", shieldedSymbol: "zkBTC", mint: state.zkbtcMint },
  ]);
  const spendable = notes
    .filter((n) => n.amount >= 10_000n)
    .sort((a, b) => Number(b.leafIndex - a.leafIndex));
  if (spendable.length === 0) {
    throw new Error("No spendable local zkBTC note found. Run scripts/hybrid/01-deposit.ts first.");
  }
  const note = spendable[0];
  const withdrawAmount = process.env.WITHDRAW_SATS
    ? BigInt(process.env.WITHDRAW_SATS)
    : BigInt(note.amount);
  if (withdrawAmount !== BigInt(note.amount)) {
    throw new Error("Partial withdraw is not implemented in this demo script; use full note amount.");
  }
  console.log(`  note leaf:        ${note.leafIndex}`);
  console.log(`  withdraw gross:   ${withdrawAmount} sats`);

  console.log("\n─── 2/6 BTC destination ───");
  const destination = process.env.BTC_ADDRESS || btc("getnewaddress withdraw bech32");
  const btcScript = btcAddressToScriptPubKey(destination);
  console.log(`  address:          ${destination}`);
  console.log(`  scriptPubKey:     ${btcScript.toString("hex")}`);

  console.log("\n─── 3/6 Fetch merkle proof ───");
  const proofResp = await api(`/api/tree/proof?commitment=${note.commitmentHex}`);
  if (!proofResp.success) throw new Error(`tree/proof failed: ${JSON.stringify(proofResp)}`);
  const merkleRoot = bytesToBigint(Uint8Array.from(Buffer.from(proofResp.root, "hex")));
  const merkleProof = {
    root: merkleRoot,
    pathElements: (proofResp.siblings as string[]).map((s) =>
      bytesToBigint(Uint8Array.from(Buffer.from(s, "hex"))),
    ),
    pathIndices: proofResp.indices as number[],
  };
  if (merkleProof.pathElements.length !== TREE_DEPTH) {
    throw new Error(`merkle proof depth ${merkleProof.pathElements.length} != ${TREE_DEPTH}`);
  }
  const claim = await prepareClaimInputs(keys, note as any, merkleProof);

  console.log("\n─── 4/6 Build redeem proof ───");
  const tokenId = computeTokenId(new PublicKey(state.zkbtcMint).toBuffer());
  const zeroNpk = 0n;
  const burnCommitment = computeJoinSplitCommitmentSync(zeroNpk, tokenId, withdrawAmount);
  const stealthDataHash = computeStealthDataHash([]);
  const redeemParams = createRedeemBoundParams(new Uint8Array(btcScript), stealthDataHash, 103n);
  const boundParamsHash = computeBoundParamsHash(redeemParams);
  const msgHash = poseidonHashSync([
    merkleRoot,
    boundParamsHash,
    claim.nullifier,
    burnCommitment,
  ]);
  const sig = await eddsaPoseidonSign(keys.eddsaSeed, msgHash);

  const circuitInputs = {
    merkleRoot: merkleRoot.toString(),
    boundParamsHash: boundParamsHash.toString(),
    nullifiers: [claim.nullifier.toString()],
    commitmentsOut: [burnCommitment.toString()],
    token: tokenId.toString(),
    publicKey: [keys.spendingPubKey.x.toString(), keys.spendingPubKey.y.toString()],
    signature: [sig[0].toString(), sig[1].toString(), sig[2].toString()],
    nullifyingKey: claim.nullifyingKey.toString(),
    randomIn: [claim.random.toString()],
    valueIn: [claim.amount.toString()],
    leavesIndices: [BigInt(claim.leafIndex).toString()],
    pathElements: [claim.merklePath.map((p) => p.toString())],
    pathIndices: [claim.merkleIndices],
    npkOut: [zeroNpk.toString()],
    valueOut: [withdrawAmount.toString()],
  };
  const { proof: groth16Proof } = generateProofViaNode("joinsplit_1x1", circuitInputs);
  const proofBytes = serializeGroth16Proof(groth16Proof);
  console.log(`  proof:            ${proofBytes.length} bytes`);

  console.log("\n─── 5/6 Submit REDEEM instruction ───");
  const authority = loadAuthority();
  const UTXOPIA = new PublicKey(state.utxopiaProgramId);
  const ZKBTC_MINT = new PublicKey(state.zkbtcMint);
  const [poolStatePda] = PublicKey.findProgramAddressSync([Buffer.from("pool_state")], UTXOPIA);
  const [commitmentTreePda] = PublicKey.findProgramAddressSync([Buffer.from("commitment_tree")], UTXOPIA);
  const [vkRegistryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vk_registry"), Buffer.from([1]), Buffer.from([1])],
    UTXOPIA,
  );
  const [tokenConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_config"), ZKBTC_MINT.toBuffer()],
    UTXOPIA,
  );
  const [nullifierPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier"), Buffer.from(bigintTo32(claim.nullifier))],
    UTXOPIA,
  );
  const requestNonce = BigInt(Date.now());
  const redemptionPda = deriveRedemptionPda(UTXOPIA, authority.publicKey, requestNonce);

  const nIn = 1;
  const nOut = 1;
  const nPubOut = 1;
  const dataLen =
    1 + 1 + 1 + 1 + 1 + 256 + 32 + 32 +
    nIn * 32 + nOut * 32 +
    8 + 1 + btcScript.length + 8;
  const ixData = Buffer.alloc(dataLen);
  let off = 0;
  ixData[off++] = 15;
  ixData[off++] = nIn;
  ixData[off++] = nOut;
  ixData[off++] = nPubOut;
  ixData[off++] = 0;
  Buffer.from(proofBytes).copy(ixData, off); off += 256;
  Buffer.from(bigintTo32(merkleRoot)).copy(ixData, off); off += 32;
  Buffer.from(bigintTo32(boundParamsHash)).copy(ixData, off); off += 32;
  Buffer.from(bigintTo32(claim.nullifier)).copy(ixData, off); off += 32;
  Buffer.from(bigintTo32(burnCommitment)).copy(ixData, off); off += 32;
  ixData.writeBigUInt64LE(withdrawAmount, off); off += 8;
  ixData[off++] = btcScript.length;
  btcScript.copy(ixData, off); off += btcScript.length;
  ixData.writeBigUInt64LE(requestNonce, off); off += 8;

  const redeemIx = new TransactionInstruction({
    programId: UTXOPIA,
    keys: [
      { pubkey: poolStatePda, isSigner: false, isWritable: true },
      { pubkey: commitmentTreePda, isSigner: false, isWritable: true },
      { pubkey: vkRegistryPda, isSigner: false, isWritable: false },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenConfigPda, isSigner: false, isWritable: false },
      { pubkey: nullifierPda, isSigner: false, isWritable: true },
      { pubkey: redemptionPda, isSigner: false, isWritable: true },
    ],
    data: ixData,
  });

  const conn = new Connection(SOLANA_RPC, "confirmed");
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    redeemIx,
  );
  const redeemSig = await sendAndConfirmTransaction(conn, tx, [authority], {
    commitment: "confirmed",
  });
  console.log(`  redeem tx:        ${redeemSig}`);
  console.log(`  redemption PDA:   ${redemptionPda.toBase58()}`);

  console.log("\n─── 6/6 Wait for backend/Ika BTC broadcast ───");
  const result = await waitForRedemptionComplete(redemptionPda, requestNonce, destination);
  console.log(`  result:           ${result.status}`);
  console.log(`  btc txid:         ${result.btcTxid || "(not available yet)"}`);

  fs.writeFileSync(
    OUT_PATH,
    JSON.stringify(
      {
        redeemSig,
        redemptionPda: redemptionPda.toBase58(),
        btcAddress: destination,
        btcScriptPubKey: btcScript.toString("hex"),
        grossSats: withdrawAmount.toString(),
        nullifier: hex(bigintTo32(claim.nullifier)),
        btcTxid: result.btcTxid,
        status: result.status,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  fs.chmodSync(OUT_PATH, 0o600);
  console.log(`  saved:            ${OUT_PATH}`);
}

main().catch((e) => {
  console.error("\nERROR:", e?.message || e);
  if (e?.stack) console.error(e.stack);
  process.exit(1);
});
