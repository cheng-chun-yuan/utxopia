#!/usr/bin/env bun
/**
 * E2E Test: Mock BTC → SPV Verify on localnet
 *
 * Self-contained — no Bitcoin testnet needed.
 * Builds fake BTC tx + headers, submits to on-chain SPV, verifies deposit.
 *
 * Prerequisites:
 *   solana-test-validator --clone-feature-set --url devnet --reset
 *   Deploy: utxopia, btc-light-client, chadbuffer
 *
 * Usage:
 *   bun run scripts/e2e-mock-spv.ts
 */

import {
  Connection, Keypair, PublicKey, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
  LAMPORTS_PER_SOL, SystemProgram,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { bytesToHex, doubleSha256 } from "../src/crypto";

// =============================================================================
// Program IDs (override via env)
// =============================================================================

const UTXOPIA = new PublicKey(process.env.UTXOPIA_PROGRAM_ID || "zKeyrLmpT8W9o8iRvhizuSihLAFLhfAGBvfM638Pbw8");
const BTC_LIGHT_CLIENT = new PublicKey(process.env.BTC_LIGHT_CLIENT_PROGRAM_ID || "Ho6UTeF8yFnRdCK15tSZtcJozvkDABJZWYxkgGyWAfyq");
const CHADBUFFER = new PublicKey(process.env.CHADBUFFER_PROGRAM_ID || "EgWyMVFZewHmjJ9GGvVBTyaC376Xp7qu7CAFjWYPYYDv");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8899";

const AMOUNT_SATS = 10_000n;

// =============================================================================
// Helpers
// =============================================================================

function loadAuthority(): Keypair {
  for (const name of ["johnny.json", "id.json"]) {
    const p = path.join(process.env.HOME || "~", ".config/solana", name);
    if (fs.existsSync(p)) return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(p, "utf-8"))));
  }
  return Keypair.generate();
}

async function send(conn: Connection, payer: Keypair, ix: TransactionInstruction, extra: Keypair[] = []) {
  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  return sendAndConfirmTransaction(conn, tx, [payer, ...extra], { commitment: "confirmed" });
}

function pda(seeds: (string | Uint8Array | Buffer)[], programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    seeds.map(s => typeof s === "string" ? Buffer.from(s) : s),
    programId,
  );
}

function ata(mint: PublicKey, owner: PublicKey): PublicKey {
  return pda([owner.toBuffer(), TOKEN_2022.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
}

function heightBuf(h: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(h);
  return b;
}

// =============================================================================
// Mock BTC Builders
// =============================================================================

function buildMockTx(amountSats: bigint): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(new Uint8Array([0x02, 0x00, 0x00, 0x00])); // version

  parts.push(new Uint8Array([0x01])); // 1 input
  const input = new Uint8Array(32 + 4 + 1 + 4 + 4);
  input.fill(0xff, 32, 36); input[36] = 0x04;
  input[37] = 0xde; input[38] = 0xad; input[39] = 0xbe; input[40] = 0xef;
  input.fill(0xff, 41, 45);
  parts.push(input);

  parts.push(new Uint8Array([0x02])); // 2 outputs
  // P2TR output
  const out0 = new Uint8Array(8 + 1 + 34);
  new DataView(out0.buffer).setBigUint64(0, amountSats, true);
  out0[8] = 34; out0[9] = 0x51; out0[10] = 0x20;
  for (let i = 0; i < 32; i++) out0[11 + i] = (i * 7 + 0x42) & 0xff;
  parts.push(out0);
  // OP_RETURN output
  const out1 = new Uint8Array(8 + 1 + 34);
  out1[8] = 34; out1[9] = 0x6a; out1[10] = 0x20;
  for (let i = 0; i < 32; i++) out1[11 + i] = (i * 3 + 0xAB) & 0xff;
  parts.push(out1);

  parts.push(new Uint8Array([0x00, 0x00, 0x00, 0x00])); // locktime

  const total = parts.reduce((s, p) => s + p.length, 0);
  const raw = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { raw.set(p, off); off += p.length; }
  return raw;
}

function buildMockHeader(prevHash: Uint8Array, merkleRoot: Uint8Array): Uint8Array {
  const h = new Uint8Array(80);
  h[0] = 0x02;
  h.set(prevHash, 4);
  h.set(merkleRoot, 36);
  new DataView(h.buffer, 68, 4).setUint32(0, Math.floor(Date.now() / 1000), true);
  h[72] = 0xff; h[73] = 0xff; h[74] = 0x00; h[75] = 0x1d;
  return h;
}

// =============================================================================
// Pool Init
// =============================================================================

async function initPoolIfNeeded(conn: Connection, auth: Keypair) {
  const [poolState, poolBump] = pda(["pool_state"], UTXOPIA);
  const [commitTree, treeBump] = pda(["commitment_tree"], UTXOPIA);
  const info = await conn.getAccountInfo(poolState);

  if (info && info.data.length > 0 && info.data[0] === 0x01) {
    const mint = new PublicKey(info.data.slice(36, 68));
    return { mint, poolVault: ata(mint, poolState), poolState, commitTree };
  }

  // Create Token-2022 mint
  const mintKp = Keypair.generate();
  const createMint = SystemProgram.createAccount({
    fromPubkey: auth.publicKey, newAccountPubkey: mintKp.publicKey,
    lamports: await conn.getMinimumBalanceForRentExemption(82), space: 82, programId: TOKEN_2022,
  });
  const initMintData = Buffer.alloc(67);
  initMintData[0] = 20; initMintData[1] = 0;
  initMintData.set(poolState.toBuffer(), 2); initMintData[34] = 0;
  const initMint = new TransactionInstruction({
    programId: TOKEN_2022, keys: [{ pubkey: mintKp.publicKey, isSigner: false, isWritable: true }], data: initMintData,
  });
  const tx1 = new Transaction().add(createMint, initMint);
  tx1.feePayer = auth.publicKey;
  tx1.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  await sendAndConfirmTransaction(conn, tx1, [auth, mintKp], { commitment: "confirmed" });

  const poolVault = ata(mintKp.publicKey, poolState);
  const frostVault = ata(mintKp.publicKey, auth.publicKey);
  const makeAta = (vault: PublicKey, owner: PublicKey) => new TransactionInstruction({
    programId: ATA_PROGRAM, data: Buffer.alloc(0),
    keys: [
      { pubkey: auth.publicKey, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mintKp.publicKey, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
    ],
  });
  const tx2 = new Transaction().add(makeAta(poolVault, poolState), makeAta(frostVault, auth.publicKey));
  tx2.feePayer = auth.publicKey;
  tx2.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  await sendAndConfirmTransaction(conn, tx2, [auth], { commitment: "confirmed" });

  const initData = Buffer.alloc(3);
  initData[0] = 0; initData[1] = poolBump; initData[2] = treeBump;
  await send(conn, auth, new TransactionInstruction({
    programId: UTXOPIA, data: initData,
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: commitTree, isSigner: false, isWritable: true },
      { pubkey: mintKp.publicKey, isSigner: false, isWritable: false },
      { pubkey: poolVault, isSigner: false, isWritable: false },
      { pubkey: frostVault, isSigner: false, isWritable: false },
      { pubkey: auth.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  }));
  console.log("   Pool initialized");
  return { mint: mintKp.publicKey, poolVault, poolState, commitTree };
}

// =============================================================================
// ChadBuffer
// =============================================================================

async function uploadToChadBuffer(conn: Connection, payer: Keypair, data: Uint8Array): Promise<PublicKey> {
  const buf = Keypair.generate();
  const space = 32 + data.length;
  const createIx = SystemProgram.createAccount({
    fromPubkey: payer.publicKey, newAccountPubkey: buf.publicKey,
    lamports: await conn.getMinimumBalanceForRentExemption(space), space, programId: CHADBUFFER,
  });
  const tx = new Transaction().add(createIx);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  await sendAndConfirmTransaction(conn, tx, [payer, buf], { commitment: "confirmed" });

  const MAX_CHUNK = 1232 - 176;
  const initChunk = data.slice(0, MAX_CHUNK);
  const initData = Buffer.alloc(1 + initChunk.length);
  initData[0] = 0;
  initData.set(initChunk, 1);
  await send(conn, payer, new TransactionInstruction({
    programId: CHADBUFFER, data: initData,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: buf.publicKey, isSigner: false, isWritable: true },
    ],
  }));

  let off = initChunk.length;
  while (off < data.length) {
    const chunk = data.slice(off, off + MAX_CHUNK);
    const wd = Buffer.alloc(4 + chunk.length);
    wd[0] = 2; wd[1] = off & 0xff; wd[2] = (off >> 8) & 0xff; wd[3] = (off >> 16) & 0xff;
    wd.set(chunk, 4);
    await send(conn, payer, new TransactionInstruction({
      programId: CHADBUFFER, data: wd,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: buf.publicKey, isSigner: false, isWritable: true },
      ],
    }));
    off += chunk.length;
  }
  return buf.publicKey;
}

async function closeChadBuffer(conn: Connection, payer: Keypair, buf: PublicKey) {
  await send(conn, payer, new TransactionInstruction({
    programId: CHADBUFFER, data: Buffer.from([3]),
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: buf, isSigner: false, isWritable: true },
    ],
  }));
}

// =============================================================================
// Commitment (Poseidon via Node subprocess — snarkjs hangs in bun)
// =============================================================================

async function computeCommitment(npk: bigint, amount: bigint): Promise<Uint8Array> {
  const script = `
    const c = require("circomlibjs");
    (async () => {
      const p = await c.buildPoseidon();
      const h = p.F.toString(p([BigInt("${npk}"), BigInt("${amount}")]));
      process.stdout.write(BigInt(h).toString(16).padStart(64, "0"));
    })();
  `;
  const proc = Bun.spawn(["node", "-e", script], { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  if (await proc.exited !== 0) {
    // Fallback to SHA256
    const hash = createHash("sha256");
    const b = new Uint8Array(32);
    let t = npk;
    for (let i = 31; i >= 0; i--) { b[i] = Number(t & 0xffn); t >>= 8n; }
    const ab = Buffer.alloc(8); ab.writeBigUInt64LE(amount);
    hash.update(b); hash.update(ab);
    return new Uint8Array(hash.digest());
  }
  const hex = out.trim();
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log("E2E: Mock BTC → SPV Verify\n");

  // 1. Connect
  const conn = new Connection(RPC_URL, "confirmed");
  const auth = loadAuthority();
  const bal = await conn.getBalance(auth.publicKey);
  console.log(`Authority: ${auth.publicKey.toBase58()} (${(bal / LAMPORTS_PER_SOL).toFixed(0)} SOL)`);
  if (bal < 2 * LAMPORTS_PER_SOL) {
    await conn.confirmTransaction(await conn.requestAirdrop(auth.publicKey, 5 * LAMPORTS_PER_SOL));
  }

  // 2. Build mock BTC tx
  const rawTx = buildMockTx(AMOUNT_SATS);
  const txHash = doubleSha256(rawTx);
  const txid = new Uint8Array(txHash); txid.reverse();
  console.log(`Mock tx: ${rawTx.length} bytes, txid: ${bytesToHex(txid).slice(0, 16)}...`);

  // 3. Init pool
  const { mint, poolVault, poolState, commitTree } = await initPoolIfNeeded(conn, auth);

  // 4. Init BTC relay light client (genesis at height 99)
  const genesisRawHeader = new Uint8Array(80); // minimal genesis header
  genesisRawHeader[0] = 0x01; // version = 1
  const genesisHash = doubleSha256(genesisRawHeader);
  const [lcPDA] = pda(["btc_light_client"], BTC_LIGHT_CLIENT);
  const [genesisBlockPDA] = pda(["block", genesisHash], BTC_LIGHT_CLIENT);
  const [genesisHeightPDA] = pda(["height_index", heightBuf(99n)], BTC_LIGHT_CLIENT);
  if (!(await conn.getAccountInfo(lcPDA))) {
    // Initialize: disc(1) + genesis_height(8 LE) + genesis_block_hash(32) + network(1)
    const d = Buffer.alloc(1 + 8 + 32 + 1);
    d[0] = 0; // disc = INITIALIZE
    d.writeBigUInt64LE(99n, 1);
    d.set(genesisHash, 9);
    d[41] = 1; // network = testnet
    await send(conn, auth, new TransactionInstruction({
      programId: BTC_LIGHT_CLIENT, data: d,
      keys: [
        { pubkey: lcPDA, isSigner: false, isWritable: true },
        { pubkey: auth.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: genesisHeightPDA, isSigner: false, isWritable: true },
        { pubkey: genesisBlockPDA, isSigner: false, isWritable: true },
      ],
    }));
    console.log("Light client initialized");
  }

  // 5. Submit block headers via extend_blockchain (batch of 2: height 100 + 101)
  const header100 = buildMockHeader(genesisHash, txid);
  const hash100 = doubleSha256(header100);
  const header101 = buildMockHeader(hash100, new Uint8Array(32));
  const hash101 = doubleSha256(header101);

  const [blockPDA100] = pda(["block", hash100], BTC_LIGHT_CLIENT);
  const [blockPDA101] = pda(["block", hash101], BTC_LIGHT_CLIENT);
  const [hiPDA100] = pda(["height_index", heightBuf(100n)], BTC_LIGHT_CLIENT);
  const [hiPDA101] = pda(["height_index", heightBuf(101n)], BTC_LIGHT_CLIENT);

  const headerPDA = blockPDA100;

  if (!(await conn.getAccountInfo(blockPDA100))) {
    // extend_blockchain: disc(1) + num_headers(1) + N*80 raw headers
    const d = Buffer.alloc(1 + 1 + 2 * 80);
    d[0] = 1; // disc = EXTEND_BLOCKCHAIN
    d[1] = 2; // num_headers
    d.set(header100, 2);
    d.set(header101, 82);
    await send(conn, auth, new TransactionInstruction({
      programId: BTC_LIGHT_CLIENT, data: d,
      keys: [
        { pubkey: lcPDA, isSigner: false, isWritable: true },
        { pubkey: auth.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: genesisBlockPDA, isSigner: false, isWritable: false }, // parent anchor
        { pubkey: blockPDA100, isSigner: false, isWritable: true },
        { pubkey: blockPDA101, isSigner: false, isWritable: true },
        { pubkey: hiPDA100, isSigner: false, isWritable: true },
        { pubkey: hiPDA101, isSigner: false, isWritable: true },
      ],
    }));
  }
  console.log("Block headers submitted (100, 101)");

  // 6. Upload tx to ChadBuffer
  const bufPub = await uploadToChadBuffer(conn, auth, rawTx);
  console.log(`ChadBuffer: ${bufPub.toBase58()}`);

  // 7. Compute commitment
  const npkBytes = new Uint8Array(32); crypto.getRandomValues(npkBytes);
  let npk = 0n;
  for (let i = 0; i < 32; i++) npk = (npk << 8n) | BigInt(npkBytes[i]);
  npk = npk % (2n ** 254n - 1n);
  const ephemeralPub = new Uint8Array(32); crypto.getRandomValues(ephemeralPub);
  const commitment = await computeCommitment(npk, AMOUNT_SATS);

  // 8. Call complete_deposit
  const [depositRec] = pda(["deposit", txid], UTXOPIA);
  const [stealthAnn] = pda(["stealth", ephemeralPub], UTXOPIA);

  // Merkle proof for single-tx block: txid + 41 zero bytes (path_bits=0, path_len=0, tx_index=0)
  const merkleProof = new Uint8Array(41);
  merkleProof.set(txid, 0);

  const ixData = Buffer.alloc(1 + 32 + 8 + 8 + 4 + 32 + 32 + merkleProof.length);
  let off = 0;
  ixData[off++] = 1; // discriminator
  ixData.set(txid, off); off += 32;
  ixData.writeBigUInt64LE(100n, off); off += 8;
  ixData.writeBigUInt64LE(AMOUNT_SATS, off); off += 8;
  ixData.writeUInt32LE(rawTx.length, off); off += 4;
  ixData.set(ephemeralPub, off); off += 32;
  ixData.set(commitment, off); off += 32;
  ixData.set(merkleProof, off);

  const sig = await send(conn, auth, new TransactionInstruction({
    programId: UTXOPIA, data: ixData,
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: lcPDA, isSigner: false, isWritable: false },
      { pubkey: headerPDA, isSigner: false, isWritable: false },
      { pubkey: commitTree, isSigner: false, isWritable: true },
      { pubkey: depositRec, isSigner: false, isWritable: true },
      { pubkey: stealthAnn, isSigner: false, isWritable: true },
      { pubkey: bufPub, isSigner: false, isWritable: false },
      { pubkey: auth.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: poolVault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
    ],
  }));
  console.log(`complete_deposit: ${sig.slice(0, 20)}...`);

  // 9. Verify on-chain state
  const dr = await conn.getAccountInfo(depositRec);
  const sa = await conn.getAccountInfo(stealthAnn);
  console.log(`Deposit record: ${dr ? `${dr.data.length} bytes` : "MISSING"}`);
  console.log(`Stealth announcement: ${sa ? `${sa.data.length} bytes` : "MISSING"}`);

  const vault = await conn.getAccountInfo(poolVault);
  if (vault && vault.data.length >= 72)
    console.log(`Pool vault: ${vault.data.readBigUInt64LE(64)} sats`);

  if (!dr || !sa) { console.error("FAIL: missing on-chain accounts"); process.exit(1); }
  console.log("\nALL CHECKS PASSED");

  // 10. Cleanup
  try { await closeChadBuffer(conn, auth, bufPub); } catch {}
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
