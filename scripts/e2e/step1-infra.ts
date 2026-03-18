#!/usr/bin/env bun
/**
 * Step 1: Infrastructure
 *
 * Start Solana validator + Esplora Docker + deploy programs + init pool + register VKs.
 */

import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createInitializeMintInstruction,
  getMintLen,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { buildPoseidon } from "circomlibjs";

import {
  connection,
  loadAuthority,
  saveState,
  stepHeader,
  log,
  Disc,
  CONTRACTS_DIR,
  CIRCUITS_DIR,
  derivePoolStatePDA,
  deriveCommitmentTreePDA,
  deriveVkRegistryPDA,
  deriveTokenConfigPDA,
  deriveATA,
  sendIx,
  ensureFunded,
  ESPLORA_URL,
  BN254_FIELD_PRIME,
  bigintToBytes32BE,
  bytes32ToBigintBE,
  LocalnetState,
  TOKEN_2022,
} from "./shared.js";

// Import regtest helpers
import {
  setupRegtest,
} from "../../contracts/scripts/regtest-helpers.js";

stepHeader(1, "Infrastructure");

// =============================================================================
// VK Hash Computation
// =============================================================================

function serializeG1(point: string[]): Buffer {
  const x = BigInt(point[0]);
  const y = BigInt(point[1]);
  const buf = Buffer.alloc(64);
  Buffer.from(x.toString(16).padStart(64, "0"), "hex").copy(buf, 0);
  Buffer.from(y.toString(16).padStart(64, "0"), "hex").copy(buf, 32);
  return buf;
}

function serializeG2(point: string[][]): Buffer {
  const buf = Buffer.alloc(128);
  Buffer.from(BigInt(point[0][0]).toString(16).padStart(64, "0"), "hex").copy(buf, 0);
  Buffer.from(BigInt(point[0][1]).toString(16).padStart(64, "0"), "hex").copy(buf, 32);
  Buffer.from(BigInt(point[1][0]).toString(16).padStart(64, "0"), "hex").copy(buf, 64);
  Buffer.from(BigInt(point[1][1]).toString(16).padStart(64, "0"), "hex").copy(buf, 96);
  return buf;
}

function computeVkHash(vkJson: any): Buffer {
  const parts: Buffer[] = [];
  parts.push(serializeG1(vkJson.vk_alpha_1));
  parts.push(serializeG2(vkJson.vk_beta_2));
  parts.push(serializeG2(vkJson.vk_gamma_2));
  parts.push(serializeG2(vkJson.vk_delta_2));
  for (const ic of vkJson.IC) parts.push(serializeG1(ic));
  return Buffer.from(crypto.createHash("sha256").update(Buffer.concat(parts)).digest());
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const authority = loadAuthority();
  log(`Authority: ${authority.publicKey.toBase58()}`);

  // 1. Kill existing validator
  log("Killing existing solana-test-validator...");
  try { execSync("pkill -f solana-test-validator", { stdio: "ignore" }); } catch {}
  await new Promise(r => setTimeout(r, 2000));

  // 2. Get program keypairs for IDs
  const targetDir = path.join(CONTRACTS_DIR, "target/deploy");
  const aegisKpPath = path.join(targetDir, "aegis_pinocchio-keypair.json");
  const btclcKpPath = path.join(targetDir, "btc_light_client-keypair.json");
  const chadbufferKpPath = path.join(CONTRACTS_DIR, "programs/chadbuffer/chadbuffer-keypair.json");
  const chadbufferSoPath = path.join(CONTRACTS_DIR, "programs/chadbuffer/chadbuffer.so");

  if (!fs.existsSync(aegisKpPath) || !fs.existsSync(btclcKpPath)) {
    throw new Error("Program keypairs not found. Run 'cargo build-sbf --features devnet' first.");
  }

  const aegisKp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(aegisKpPath, "utf-8"))));
  const btclcKp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(btclcKpPath, "utf-8"))));
  const AEGIS = aegisKp.publicKey;
  const BTC_LC = btclcKp.publicKey;

  let chadbufferId: PublicKey;
  if (fs.existsSync(chadbufferKpPath)) {
    const cbKp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(chadbufferKpPath, "utf-8"))));
    chadbufferId = cbKp.publicKey;
  } else {
    chadbufferId = new PublicKey("C5RpjtTMFXKVZCtXSzKXD4CDNTaWBg3dVeMfYvjZYHDF");
  }

  log(`Aegis: ${AEGIS.toBase58()}`);
  log(`BTC LC: ${BTC_LC.toBase58()}`);
  log(`ChadBuffer: ${chadbufferId.toBase58()}`);

  // 3. Start test validator
  log("Starting solana-test-validator...");
  const aegisSo = path.join(targetDir, "aegis_pinocchio.so");
  const btclcSo = path.join(targetDir, "btc_light_client.so");

  // BTC LC: prefer cloning from devnet to match the hardcoded program ID constant in Aegis
  // (cargo clean may regenerate the keypair with a different address)
  const BTC_LC_DEVNET = "Ho6UTeF8yFnRdCK15tSZtcJozvkDABJZWYxkgGyWAfyq";
  const useBtcLcFromDevnet = BTC_LC.toBase58() !== BTC_LC_DEVNET;
  let bpfArgs = `--bpf-program ${AEGIS.toBase58()} ${aegisSo}`;
  if (useBtcLcFromDevnet) {
    bpfArgs += ` --clone-upgradeable-program ${BTC_LC_DEVNET}`;
    log(`BTC LC keypair mismatch — cloning from devnet: ${BTC_LC_DEVNET}`);
  } else {
    bpfArgs += ` --bpf-program ${BTC_LC.toBase58()} ${btclcSo}`;
  }
  // Override BTC_LC reference for the rest of the script
  const BTC_LC_EFFECTIVE = new PublicKey(useBtcLcFromDevnet ? BTC_LC_DEVNET : BTC_LC.toBase58());
  if (fs.existsSync(chadbufferSoPath)) {
    bpfArgs += ` --bpf-program ${chadbufferId.toBase58()} ${chadbufferSoPath}`;
  }

  // Clone ChadBuffer from devnet if .so not available locally
  const CHADBUFFER_DEVNET = "C5RpjtTMFXKVZCtXSzKXD4CDNTaWBg3dVeMfYvjZYHDF";
  let cloneArgs = "";
  if (!fs.existsSync(chadbufferSoPath)) {
    cloneArgs = `--clone-upgradeable-program ${CHADBUFFER_DEVNET}`;
    chadbufferId = new PublicKey(CHADBUFFER_DEVNET);
    log(`ChadBuffer not found locally, cloning from devnet: ${CHADBUFFER_DEVNET}`);
  }

  // Clone NATIVE_MINT_2022 from devnet for wSOL support
  const NATIVE_MINT_2022 = "9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP";

  const validatorCmd = [
    "solana-test-validator",
    "--clone-feature-set",
    "--url devnet",
    bpfArgs,
    cloneArgs,
    `--clone ${NATIVE_MINT_2022}`,
    "--reset",
    "--quiet",
  ].filter(Boolean).join(" ");

  execSync(`nohup ${validatorCmd} > /tmp/solana-validator.log 2>&1 &`, { shell: "/bin/bash" });
  log("Waiting for validator...");
  for (let i = 0; i < 30; i++) {
    try {
      await connection.getSlot();
      break;
    } catch {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  log("Validator ready");

  // 4. Start regtest Docker + Esplora + mine 101 blocks
  log("Starting Bitcoin regtest Docker...");
  await setupRegtest();
  log("Regtest ready");

  // 5. Fund authority
  await ensureFunded(authority);
  log("Authority funded");

  // 6. Create zkBTC mint (mint authority = pool state PDA so program can mint)
  const [poolState, poolBump] = derivePoolStatePDA(AEGIS);
  const [commitmentTree, treeBump] = deriveCommitmentTreePDA(AEGIS);

  log("Creating zkBTC mint...");
  const mintKp = Keypair.generate();
  const mintLen = getMintLen([]);
  const mintLamports = await connection.getMinimumBalanceForRentExemption(mintLen);

  const createMintTx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: authority.publicKey,
      newAccountPubkey: mintKp.publicKey,
      lamports: mintLamports,
      space: mintLen,
      programId: TOKEN_2022,
    }),
    createInitializeMintInstruction(mintKp.publicKey, 8, poolState, null, TOKEN_2022),
  );
  await sendAndConfirmTransaction(connection, createMintTx, [authority, mintKp]);
  const zkbtcMint = mintKp.publicKey;
  log(`zkBTC Mint: ${zkbtcMint.toBase58()}`);

  // 7. Create pool vault + frost vault ATAs
  const poolVaultAccount = await getOrCreateAssociatedTokenAccount(
    connection, authority, zkbtcMint, poolState, true, undefined, undefined, TOKEN_2022,
  );
  const frostVaultAccount = await getOrCreateAssociatedTokenAccount(
    connection, authority, zkbtcMint, authority.publicKey, false, undefined, undefined, TOKEN_2022,
  );
  log(`Pool Vault: ${poolVaultAccount.address.toBase58()}`);
  log(`Frost Vault: ${frostVaultAccount.address.toBase58()}`);

  // 8. Initialize pool (disc=0)
  log("Initializing Aegis pool...");
  const initData = Buffer.alloc(3);
  initData[0] = Disc.INITIALIZE;
  initData[1] = poolBump;
  initData[2] = treeBump;

  const initIx = new TransactionInstruction({
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: commitmentTree, isSigner: false, isWritable: true },
      { pubkey: zkbtcMint, isSigner: false, isWritable: false },
      { pubkey: poolVaultAccount.address, isSigner: false, isWritable: false },
      { pubkey: frostVaultAccount.address, isSigner: false, isWritable: false },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: AEGIS,
    data: initData,
  });
  await sendIx([initIx], [authority]);
  log("Pool initialized");

  // 9. Register zkBTC TokenConfig (disc=28)
  log("Registering zkBTC TokenConfig...");
  const [zkbtcTokenConfig] = deriveTokenConfigPDA(AEGIS, zkbtcMint);
  const regData = Buffer.alloc(1 + 32); // disc + service_fee(8) + min(8) + max(8) + cap(8)
  regData[0] = Disc.REGISTER_TOKEN;
  // service_fee = 0, min_deposit = 1000, max_deposit = 100 BTC, deposit_cap = 1000 BTC
  const regPayload = Buffer.alloc(32);
  regPayload.writeBigUInt64LE(0n, 0);           // service_fee
  regPayload.writeBigUInt64LE(1000n, 8);         // min_deposit
  regPayload.writeBigUInt64LE(10_000_000_000n, 16); // max_deposit
  regPayload.writeBigUInt64LE(100_000_000_000n, 24); // deposit_cap

  const regIx = new TransactionInstruction({
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolState, isSigner: false, isWritable: false },
      { pubkey: zkbtcMint, isSigner: false, isWritable: false },
      { pubkey: zkbtcTokenConfig, isSigner: false, isWritable: true },
      { pubkey: poolVaultAccount.address, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: AEGIS,
    data: Buffer.concat([Buffer.from([Disc.REGISTER_TOKEN]), regPayload]),
  });
  await sendIx([regIx], [authority]);
  log("zkBTC TokenConfig registered");

  // 9b. Register wSOL (NATIVE_MINT_2022) if available
  try {
    const NATIVE_MINT_2022 = new PublicKey("9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP");
    const nativeMintInfo = await connection.getAccountInfo(NATIVE_MINT_2022);
    if (nativeMintInfo) {
      log("Registering wSOL (NATIVE_MINT_2022)...");
      const wsolVault = await getOrCreateAssociatedTokenAccount(
        connection, authority, NATIVE_MINT_2022, poolState, true, undefined, undefined, TOKEN_2022,
      );
      const [wsolTokenConfig] = deriveTokenConfigPDA(AEGIS, NATIVE_MINT_2022);
      const wsolRegPayload = Buffer.alloc(32);
      wsolRegPayload.writeBigUInt64LE(0n, 0);              // service_fee
      wsolRegPayload.writeBigUInt64LE(10_000_000n, 8);      // min_deposit (0.01 SOL)
      wsolRegPayload.writeBigUInt64LE(1_000_000_000_000n, 16); // max_deposit (1000 SOL)
      wsolRegPayload.writeBigUInt64LE(100_000_000_000_000n, 24); // deposit_cap
      const wsolRegIx = new TransactionInstruction({
        keys: [
          { pubkey: authority.publicKey, isSigner: true, isWritable: true },
          { pubkey: poolState, isSigner: false, isWritable: false },
          { pubkey: NATIVE_MINT_2022, isSigner: false, isWritable: false },
          { pubkey: wsolTokenConfig, isSigner: false, isWritable: true },
          { pubkey: wsolVault.address, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        programId: AEGIS,
        data: Buffer.concat([Buffer.from([Disc.REGISTER_TOKEN]), wsolRegPayload]),
      });
      await sendIx([wsolRegIx], [authority]);
      log("wSOL TokenConfig registered");
    }
  } catch (err: any) {
    log(`wSOL registration skipped: ${err.message?.slice(0, 60)}`);
  }

  // 10. Register VK hashes for joinsplit_1x1 and joinsplit_1x2
  log("Registering VK hashes...");
  for (const [nIn, nOut] of [[1, 1], [1, 2]] as [number, number][]) {
    const circuitName = `joinsplit_${nIn}x${nOut}`;
    const vkPath = path.join(CIRCUITS_DIR, `build/${circuitName}/${circuitName}.vkey.json`);
    if (!fs.existsSync(vkPath)) {
      log(`WARNING: VK not found at ${vkPath} — skip ${circuitName}`);
      continue;
    }
    const vkJson = JSON.parse(fs.readFileSync(vkPath, "utf-8"));
    const vkHash = computeVkHash(vkJson);
    const [vkRegistry] = deriveVkRegistryPDA(AEGIS, nIn, nOut);

    const existing = await connection.getAccountInfo(vkRegistry);
    if (existing && existing.data[0] === 0x14) {
      log(`${circuitName} VK already registered`);
      continue;
    }

    const vkData = Buffer.alloc(35);
    vkData[0] = Disc.INIT_VK_REGISTRY;
    vkData[1] = nIn;
    vkData[2] = nOut;
    vkHash.copy(vkData, 3);

    const vkIx = new TransactionInstruction({
      keys: [
        { pubkey: poolState, isSigner: false, isWritable: false },
        { pubkey: vkRegistry, isSigner: false, isWritable: true },
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: AEGIS,
      data: vkData,
    });
    await sendIx([vkIx], [authority]);
    log(`${circuitName} VK registered`);
  }

  // 11. Generate crypto keys for all steps
  log("Generating crypto keys...");
  const spendingSeed = new Uint8Array(32);
  crypto.getRandomValues(spendingSeed);

  const { buildEddsa } = await import("circomlibjs");
  const eddsa = await buildEddsa();
  const poseidon = await buildPoseidon();
  const F = eddsa.babyJub.F;
  const privKeyBuf = Buffer.from(spendingSeed);
  const pubKey = eddsa.prv2pub(privKeyBuf);
  const pubKeyX = F.toObject(pubKey[0]) as bigint;
  const pubKeyY = F.toObject(pubKey[1]) as bigint;

  // Nullifying key
  const nkInput = new Uint8Array(39);
  nkInput.set(new TextEncoder().encode("nullify"), 0);
  nkInput.set(spendingSeed, 7);
  const nullifyingKey = bytes32ToBigintBE(sha256(nkInput)) % BN254_FIELD_PRIME;

  // MPK = Poseidon(pkX, pkY, nullifyingKey)
  const mpk = poseidon.F.toObject(poseidon([pubKeyX, pubKeyY, nullifyingKey])) as bigint;
  log(`MPK: ${mpk.toString(16).slice(0, 16)}...`);

  // 12. Generate BTC pool address (single-key mode for localnet)
  // The regtest wallet controls the key — signing is done via signrawtransactionwithwallet
  log("Generating BTC pool address (single-key mode)...");

  const btcCliPath = "/srv/explorer/bitcoin-27.2/bin/bitcoin-cli";
  const btcCmd = (cmd: string) =>
    execSync(`docker exec aegis-esplora-regtest ${btcCliPath} -regtest -datadir=/data/bitcoin -rpcwallet=test ${cmd}`, { encoding: "utf8" }).trim();

  const poolBtcAddress = btcCmd("getnewaddress pool_receive bech32m");
  const poolAddrInfo = JSON.parse(btcCmd(`getaddressinfo ${poolBtcAddress}`));
  const btcXOnlyPubKey = poolAddrInfo.pubkey || "";
  // No need for raw private key — regtest wallet signs via RPC (signrawtransactionwithwallet)
  const btcSigningKey = "wallet-managed"; // placeholder
  log(`Pool BTC address: ${poolBtcAddress}`);
  log(`Pool pubkey: ${btcXOnlyPubKey.slice(0, 32)}...`);

  // 13. Write state
  const state: LocalnetState = {
    aegisProgramId: AEGIS.toBase58(),
    btcLightClientId: BTC_LC_EFFECTIVE.toBase58(),
    chadbufferId: chadbufferId.toBase58(),
    zkbtcMint: zkbtcMint.toBase58(),
    poolState: poolState.toBase58(),
    commitmentTree: commitmentTree.toBase58(),
    poolVault: poolVaultAccount.address.toBase58(),
    frostVault: frostVaultAccount.address.toBase58(),
    authority: authority.publicKey.toBase58(),
    spendingSeed: Buffer.from(spendingSeed).toString("hex"),
    pubKeyX: pubKeyX.toString(16),
    pubKeyY: pubKeyY.toString(16),
    nullifyingKey: nullifyingKey.toString(16),
    mpk: mpk.toString(16),
    // BTC signing config (single-key mode for localnet)
    btcSigningKey,
    btcXOnlyPubKey,
    poolBtcAddress,
    signingMode: "single",
  };
  saveState(state);
  log("State saved to localnet-state.json");

  console.log("\nStep 1: Infrastructure .......... PASS");
}

main().catch(err => {
  console.error("FAIL:", err.message);
  if (err.logs) err.logs.forEach((l: string) => console.error("  ", l));
  process.exit(1);
});
