#!/usr/bin/env bun
/**
 * Hybrid demo: unshield one of the JoinSplit output notes (from 02-transact)
 * back to a public zkBTC SPL balance on devnet.
 *
 * 1x1 JoinSplit with the single output as a "burn" commitment
 *   Poseidon(0, tokenId, amount) → no spendable note created
 *   amount minted to user's zkBTC ATA via the on-chain unshield handler.
 *
 *   SDK init (hybrid overrides)
 *     → loginWithSeed (.demo-seed.json)
 *       → scan announcements; pick a note matching .notes.json sendNote
 *         → fetch merkle proof
 *           → generate Groth16 1x1 proof
 *             → submit unshield (disc 14) on devnet
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";

import {
  UTXOpiaClient,
  initConfig,
  initPoseidon,
  poseidonHashSync,
  computeJoinSplitCommitmentSync,
  computeStealthDataHash,
  createUnshieldBoundParams,
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
const NOTES_PATH = path.join(__dirname, ".notes.json");
const KEYPAIR_PATH = path.join(process.env.HOME!, ".config/solana/id.json");
const CIRCUITS_DIR = path.resolve(PROJECT_ROOT, "circuits/build");

if (!API_KEY) {
  console.error("ERROR: BACKEND_API_KEY required");
  process.exit(1);
}
for (const p of [SEED_PATH, NOTES_PATH]) {
  if (!fs.existsSync(p)) {
    console.error(`ERROR: ${p} missing — run 01-deposit.ts then 02-transact.ts first`);
    process.exit(1);
  }
}

const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
const seed = Uint8Array.from(
  Buffer.from(JSON.parse(fs.readFileSync(SEED_PATH, "utf-8")).seed, "hex"),
);
const transactNotes = JSON.parse(fs.readFileSync(NOTES_PATH, "utf-8"));

function bigintTo32(n: bigint): Uint8Array {
  return bigintToBytes(n);
}

function loadAuthority(): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf-8"))),
  );
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
  const tmpInput = path.join(tmpDir, `input_${ts}.json`);
  const tmpProof = path.join(tmpDir, `proof_${ts}.json`);
  const tmpPublic = path.join(tmpDir, `public_${ts}.json`);
  fs.writeFileSync(tmpInput, JSON.stringify(inputs));

  console.log(`  Generating ${circuitName} Groth16 proof via Node.js...`);
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

async function main() {
  console.log("\n═══ Hybrid JoinSplit 1x1 unshield → public zkBTC ═══\n");

  // Phase 1: SDK init (override AFTER client.init so values stick)
  console.log("─── 1/6 SDK init w/ hybrid overrides ───");
  await initPoseidon();
  const client = await UTXOpiaClient.init({ backendUrl: BACKEND_URL });
  await initConfig({
    network: "devnet",
    utxopiaProgramId: state.utxopiaProgramId,
    zkbtcMint: state.zkbtcMint,
    solanaRpcUrl: SOLANA_RPC,
    groupPubKey: state.demoPool.xOnlyPubKey,
  });
  await client.loginWithSeed(seed);
  const keys = (client as any)._keys;
  if (!keys) throw new Error("loginWithSeed did not populate _keys");

  // Phase 2: locate our note from the persisted notes file (transact outputs
  // use plaintext amounts in stealth data so the SDK scanner doesn't decrypt
  // them — read directly from .notes.json instead).
  console.log("\n─── 2/6 Locate JoinSplit output via .notes.json ───");
  const targetCommit = transactNotes.sendNote.commitment.padStart(64, "0");
  console.log(`  target commitment: ${targetCommit.slice(0, 20)}…`);

  // Phase 3: merkle proof + leaf index
  console.log("\n─── 3/6 Fetch merkle proof from backend ───");
  const proofResp = await fetch(
    `${BACKEND_URL}/api/tree/proof?commitment=${targetCommit}`,
    { headers: { "X-API-Key": API_KEY! } },
  ).then((r) => r.json());
  if (!proofResp.success) {
    throw new Error(`tree/proof failed: ${JSON.stringify(proofResp)}`);
  }
  const merkleRoot = bytesToBigint(
    Uint8Array.from(Buffer.from(proofResp.root, "hex")),
  );
  const merkleProof = {
    root: merkleRoot,
    pathElements: (proofResp.siblings as string[]).map((s) =>
      bytesToBigint(Uint8Array.from(Buffer.from(s, "hex"))),
    ),
    pathIndices: proofResp.indices as number[],
  };
  if (merkleProof.pathElements.length !== TREE_DEPTH) {
    throw new Error(
      `merkle proof depth ${merkleProof.pathElements.length} != ${TREE_DEPTH}`,
    );
  }

  // Phase 4: build claim from persisted note material (no scan needed)
  console.log("\n─── 4/6 Build claim from persisted note ───");
  const noteRandom = BigInt("0x" + transactNotes.sendNote.random);
  const noteNpk = BigInt("0x" + transactNotes.sendNote.npk);
  const noteAmount = BigInt(transactNotes.sendNote.amount);
  const noteLeafIndex = proofResp.leaf_index as number;
  const noteCommitment = Uint8Array.from(Buffer.from(targetCommit, "hex"));
  const nullifier = poseidonHashSync([keys.nullifyingKey, BigInt(noteLeafIndex)]);

  const claim = {
    amount: noteAmount,
    leafIndex: noteLeafIndex,
    random: noteRandom,
    npk: noteNpk,
    nullifier,
    nullifyingKey: keys.nullifyingKey,
  };
  console.log(`  leafIndex: ${claim.leafIndex}, amount: ${claim.amount}`);
  console.log(`  nullifier: ${claim.nullifier.toString(16).slice(0, 20)}…`);

  // Phase 5: build burn commitment + 1x1 proof
  console.log("\n─── 5/6 Build burn commitment + Groth16 1x1 proof ───");
  const tokenId = computeTokenId(new PublicKey(state.zkbtcMint).toBuffer());
  const zeroNpk = 0n;
  const burnCommitment = computeJoinSplitCommitmentSync(
    zeroNpk,
    tokenId,
    claim.amount,
  );

  const authority = loadAuthority();
  const ownerBytes = new Uint8Array(authority.publicKey.toBytes());
  const stealthDataHash = computeStealthDataHash([]); // no tree outputs
  const unshieldParams = createUnshieldBoundParams(ownerBytes, stealthDataHash, 103n);
  const boundParamsHash = computeBoundParamsHash(unshieldParams);
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
    publicKey: [
      keys.spendingPubKey.x.toString(),
      keys.spendingPubKey.y.toString(),
    ],
    signature: [sig[0].toString(), sig[1].toString(), sig[2].toString()],
    nullifyingKey: claim.nullifyingKey.toString(),
    randomIn: [claim.random.toString()],
    valueIn: [claim.amount.toString()],
    leavesIndices: [BigInt(claim.leafIndex).toString()],
    pathElements: [merkleProof.pathElements.map((p) => p.toString())],
    pathIndices: [merkleProof.pathIndices],
    npkOut: [zeroNpk.toString()],
    valueOut: [claim.amount.toString()],
  };

  const { proof: groth16Proof } = generateProofViaNode("joinsplit_1x1", circuitInputs);
  const proofBytes = serializeGroth16Proof(groth16Proof);
  console.log(`  proof: ${proofBytes.length} bytes`);

  // Phase 6: build + submit unshield ix
  console.log("\n─── 6/6 Build + submit unshield ix (disc 14) ───");
  const UTXOPIA = new PublicKey(state.utxopiaProgramId);
  const ZKBTC_MINT = new PublicKey(state.zkbtcMint);
  const POOL_VAULT = new PublicKey(state.poolVault);

  const [poolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_state")], UTXOPIA,
  );
  const [commitmentTreePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("commitment_tree")], UTXOPIA,
  );
  const [vkRegistryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vk_registry"), Buffer.from([1]), Buffer.from([1])], UTXOPIA,
  );
  const [tokenConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_config"), ZKBTC_MINT.toBuffer()], UTXOPIA,
  );
  const [nullifierPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier"), Buffer.from(bigintTo32(claim.nullifier))], UTXOPIA,
  );

  const userAta = getAssociatedTokenAddressSync(
    ZKBTC_MINT, authority.publicKey, false, TOKEN_2022_PROGRAM_ID,
  );

  // Pre-create the user's ATA if missing — unshield expects it to exist.
  const conn = new Connection(SOLANA_RPC, "confirmed");
  const ataInfo = await conn.getAccountInfo(userAta);
  const setupIxs: TransactionInstruction[] = [];
  if (!ataInfo) {
    console.log(`  creating user ATA: ${userAta.toBase58()}`);
    setupIxs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        authority.publicKey,
        userAta,
        authority.publicKey,
        ZKBTC_MINT,
        TOKEN_2022_PROGRAM_ID,
      ),
    );
  }

  // Build unshield ix data — multi-output format.
  // Layout: disc + n_in + n_out + n_pub_out + proof_source + proof + root +
  //         bound_hash + nullifiers + commitments + stealth_data + amounts
  const nIn = 1;
  const nOut = 1;
  const nPubOut = 1;
  const nTreeOut = nOut - nPubOut; // 0 here
  const stealthPerOutput = 72;
  const dataLen =
    1 + 1 + 1 + 1 + 1 + 256 + 32 + 32 +
    nIn * 32 + nOut * 32 +
    nTreeOut * stealthPerOutput +
    nPubOut * 8;
  const ixData = Buffer.alloc(dataLen);
  let off = 0;
  ixData[off++] = 14; // UNSHIELD discriminator
  ixData[off++] = nIn;
  ixData[off++] = nOut;
  ixData[off++] = nPubOut;
  ixData[off++] = 0; // proof_source = inline
  Buffer.from(proofBytes).copy(ixData, off); off += 256;
  Buffer.from(bigintTo32(merkleRoot)).copy(ixData, off); off += 32;
  Buffer.from(bigintTo32(boundParamsHash)).copy(ixData, off); off += 32;
  Buffer.from(bigintTo32(claim.nullifier)).copy(ixData, off); off += 32;
  Buffer.from(bigintTo32(burnCommitment)).copy(ixData, off); off += 32;
  // (no tree-output stealth data)
  ixData.writeBigUInt64LE(claim.amount, off); off += 8;

  const unshieldIx = new TransactionInstruction({
    programId: UTXOPIA,
    keys: [
      { pubkey: poolStatePda, isSigner: false, isWritable: true },
      { pubkey: commitmentTreePda, isSigner: false, isWritable: true },
      { pubkey: vkRegistryPda, isSigner: false, isWritable: false },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenConfigPda, isSigner: false, isWritable: true },
      { pubkey: POOL_VAULT, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: userAta, isSigner: false, isWritable: true }, // recipient
      { pubkey: nullifierPda, isSigner: false, isWritable: true },
    ],
    data: ixData,
  });

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
  );
  for (const ix of setupIxs) tx.add(ix);
  tx.add(unshieldIx);

  const txid = await sendAndConfirmTransaction(conn, tx, [authority], {
    commitment: "confirmed",
  });
  console.log(`  unshield tx: ${txid}`);

  const ataAfter = await conn.getAccountInfo(userAta);
  if (ataAfter) {
    const bal = Buffer.from(ataAfter.data).readBigUInt64LE(64);
    console.log(`  ✓ user zkBTC balance: ${bal} (received ${claim.amount} sats)`);
  }
}

main().catch((e) => {
  console.error("\nERROR:", e?.message || e);
  if (e?.stack) console.error(e.stack);
  process.exit(1);
});
