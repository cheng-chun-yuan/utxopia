#!/usr/bin/env bun
/**
 * Initialize the freshly-deployed devnet-regtest hybrid utxopia program.
 *
 * Pre-reqs: programs already deployed via `solana program deploy`. State file
 * scripts/devnet-regtest-state.json must contain the program IDs.
 *
 * Does:
 *   1. Create zkBTC mint (Token-2022, authority = pool PDA)
 *   2. Create pool vault + frost vault ATAs
 *   3. Call INITIALIZE (disc 0) — creates pool_state + commitment_tree
 *   4. Register all 19 vkey hashes
 *   5. Register zkBTC token config
 *   6. Update state file with mint/vault addresses
 *
 * Run: bun run scripts/init-devnet-regtest.ts
 */

import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, createInitializeMintInstruction, getMintLen,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { sha256 } from "@noble/hashes/sha2.js";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RPC = "https://api.devnet.solana.com";
const STATE_PATH = path.join(__dirname, "devnet-regtest-state.json");
const KEYPAIR_PATH = path.join(process.env.HOME!, ".config/solana/id.json");

const Disc = { INITIALIZE: 0, REGISTER_TOKEN: 8, INIT_VK_REGISTRY: 6, UPDATE_VK_REGISTRY: 7 };
const ZKBTC_TOKEN_ID = 0x7a627463; // "zkbtc" as u32

const log = (m: string) => console.log(`  ${m}`);

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8"))));
}

function computeVkHash(vk: any): Buffer {
  const parts: string[] = [];
  parts.push(vk.vk_alpha_1[0], vk.vk_alpha_1[1]);
  parts.push(vk.vk_beta_2[0][0], vk.vk_beta_2[0][1], vk.vk_beta_2[1][0], vk.vk_beta_2[1][1]);
  parts.push(vk.vk_gamma_2[0][0], vk.vk_gamma_2[0][1], vk.vk_gamma_2[1][0], vk.vk_gamma_2[1][1]);
  parts.push(vk.vk_delta_2[0][0], vk.vk_delta_2[0][1], vk.vk_delta_2[1][0], vk.vk_delta_2[1][1]);
  for (const ic of vk.IC) parts.push(ic[0], ic[1]);
  const ser = Buffer.concat(parts.map(x => Buffer.from(BigInt(x).toString(16).padStart(64, "0"), "hex")));
  return Buffer.from(sha256(ser));
}

async function main() {
  console.log("=== UTXOpia devnet-regtest hybrid init ===\n");
  const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
  const UTXOPIA = new PublicKey(state.utxopiaProgramId);
  const BTC_LC = new PublicKey(state.btcLightClientId);
  console.log(`utxopia program: ${UTXOPIA.toBase58()}`);
  console.log(`BTC LC program:  ${BTC_LC.toBase58()}`);

  const conn = new Connection(RPC, "confirmed");
  const authority = loadKeypair(KEYPAIR_PATH);
  console.log(`authority:       ${authority.publicKey.toBase58()}\n`);

  // Derive PDAs
  const [poolState, poolBump] = PublicKey.findProgramAddressSync([Buffer.from("pool_state")], UTXOPIA);
  const [commitmentTree, treeBump] = PublicKey.findProgramAddressSync([Buffer.from("commitment_tree")], UTXOPIA);
  log(`pool_state PDA:      ${poolState.toBase58()} (bump=${poolBump})`);
  log(`commitment_tree PDA: ${commitmentTree.toBase58()} (bump=${treeBump})`);

  // Idempotency: if pool already initialized, skip mint creation + INITIALIZE
  const existingPoolInfo = await conn.getAccountInfo(poolState);
  const alreadyInit = existingPoolInfo !== null;
  if (alreadyInit) {
    log("\npool_state already exists — skipping mint creation + INITIALIZE");
  }

  // Step 1: create zkBTC mint
  if (!alreadyInit) log("\nCreating zkBTC mint (Token-2022)...");
  const mintKp = Keypair.generate();
  const mintLen = getMintLen([]);
  const mintLamports = await conn.getMinimumBalanceForRentExemption(mintLen);
  const createMintTx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: authority.publicKey, newAccountPubkey: mintKp.publicKey,
      lamports: mintLamports, space: mintLen, programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeMintInstruction(mintKp.publicKey, 8, poolState, null, TOKEN_2022_PROGRAM_ID),
  );
  await sendAndConfirmTransaction(conn, createMintTx, [authority, mintKp]);
  const zkbtcMint = mintKp.publicKey;
  log(`zkBTC Mint: ${zkbtcMint.toBase58()}`);

  // Step 2: vaults
  const poolVault = await getOrCreateAssociatedTokenAccount(
    conn, authority, zkbtcMint, poolState, true, undefined, undefined, TOKEN_2022_PROGRAM_ID,
  );
  const frostVault = await getOrCreateAssociatedTokenAccount(
    conn, authority, zkbtcMint, authority.publicKey, false, undefined, undefined, TOKEN_2022_PROGRAM_ID,
  );
  log(`Pool Vault:  ${poolVault.address.toBase58()}`);
  log(`Frost Vault: ${frostVault.address.toBase58()}`);

  // Step 3: INITIALIZE (disc 0)
  log("\nCalling INITIALIZE (disc 0)...");
  const initData = Buffer.alloc(7);
  initData[0] = Disc.INITIALIZE;
  initData[1] = poolBump;
  initData[2] = treeBump;
  initData.writeUInt16LE(20, 3); // deposit_fee_bps = 0.2%
  initData.writeUInt16LE(20, 5); // withdrawal_fee_bps = 0.2%
  const initIx = new TransactionInstruction({
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: commitmentTree, isSigner: false, isWritable: true },
      { pubkey: zkbtcMint, isSigner: false, isWritable: false },
      { pubkey: poolVault.address, isSigner: false, isWritable: false },
      { pubkey: frostVault.address, isSigner: false, isWritable: false },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: UTXOPIA, data: initData,
  });
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 });
  const initSig = await sendAndConfirmTransaction(conn, new Transaction().add(cu, initIx), [authority]);
  log(`INITIALIZE tx: ${initSig.slice(0, 20)}...`);

  // Verify
  const poolInfo = await conn.getAccountInfo(poolState);
  if (!poolInfo) throw new Error("pool_state PDA not created — CPI failed silently?");
  log(`pool_state exists (${poolInfo.data.length} bytes)`);

  // Step 4: register all 19 vkeys
  log("\nRegistering 19 vkey hashes...");
  const buildDir = path.join(__dirname, "../circuits/build");
  const circuits = fs.readdirSync(buildDir)
    .filter(d => d.startsWith("joinsplit_"))
    .map(d => d.match(/^joinsplit_(\d+)x(\d+)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map(m => [parseInt(m[1]), parseInt(m[2])] as [number, number])
    .sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]) || a[0] - b[0]);

  for (const [nIn, nOut] of circuits) {
    const name = `joinsplit_${nIn}x${nOut}`;
    const vkPath = path.join(buildDir, name, `${name}.vkey.json`);
    if (!fs.existsSync(vkPath)) continue;
    const vk = JSON.parse(fs.readFileSync(vkPath, "utf-8"));
    const vkHash = computeVkHash(vk);
    const [vkRegistry] = PublicKey.findProgramAddressSync(
      [Buffer.from("vk_registry"), Buffer.from([nIn]), Buffer.from([nOut])], UTXOPIA,
    );
    const existing = await conn.getAccountInfo(vkRegistry);
    if (existing?.data[0] === 0x14) { log(`  ${name}: already registered`); continue; }
    const vkData = Buffer.alloc(35);
    vkData[0] = Disc.INIT_VK_REGISTRY; vkData[1] = nIn; vkData[2] = nOut;
    vkHash.copy(vkData, 3);
    const ix = new TransactionInstruction({
      keys: [
        { pubkey: poolState, isSigner: false, isWritable: false },
        { pubkey: vkRegistry, isSigner: false, isWritable: true },
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: UTXOPIA, data: vkData,
    });
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [authority]);
    log(`  ${name}: registered (${sig.slice(0, 12)}...)`);
  }

  // Step 5: register zkBTC token config
  log("\nRegistering zkBTC TokenConfig...");
  const [tokenConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_config"), zkbtcMint.toBuffer()], UTXOPIA,
  );
  const tokenPayload = Buffer.alloc(32);
  tokenPayload.writeBigUInt64LE(500n, 0);                  // service_fee
  tokenPayload.writeBigUInt64LE(1000n, 8);                 // min_deposit (sats)
  tokenPayload.writeBigUInt64LE(1_000_000_000n, 16);       // max_deposit (1 BTC in sats)
  tokenPayload.writeBigUInt64LE(10_000_000_000n, 24);      // deposit_cap (10 BTC)
  const tokenIx = new TransactionInstruction({
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolState, isSigner: false, isWritable: false },
      { pubkey: zkbtcMint, isSigner: false, isWritable: false },
      { pubkey: tokenConfig, isSigner: false, isWritable: true },
      { pubkey: poolVault.address, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: UTXOPIA,
    data: Buffer.concat([Buffer.from([Disc.REGISTER_TOKEN]), tokenPayload]),
  });
  try {
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(tokenIx), [authority]);
    log(`zkBTC TokenConfig registered (${sig.slice(0, 12)}...)`);
  } catch (e: any) {
    log(`zkBTC TokenConfig registration: ${(e.message || String(e)).slice(0, 100)}`);
  }

  // Step 6: update state file
  state.zkbtcMint = zkbtcMint.toBase58();
  state.poolState = poolState.toBase58();
  state.commitmentTree = commitmentTree.toBase58();
  state.poolVault = poolVault.address.toBase58();
  state.frostVault = frostVault.address.toBase58();
  state.tokenConfigZkbtc = tokenConfig.toBase58();
  state.authority = authority.publicKey.toBase58();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
  console.log(`\nState saved to ${STATE_PATH}`);
  console.log("\nDone! Program is initialized and ready for deposits/transfers.");
  console.log("BTC LC will be initialized lazily on first deposit (with regtest header).");
}

main().catch(e => { console.error(e); process.exit(1); });
