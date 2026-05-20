#!/usr/bin/env bun
/**
 * Hybrid demo: JoinSplit 1x2 transact on the devnet+regtest stack.
 *
 *   SDK init (hybrid overrides)
 *     → loginWithSeed (.demo-seed.json from 01-deposit)
 *       → scan announcements via SDK / backend
 *         → fetch merkle proof from backend /api/tree/proof
 *           → prepareClaimInputs (recovers random + nullifier)
 *             → generate Groth16 1x2 proof via Node subprocess
 *               → submit transact (disc 13) on devnet
 *
 * By default, splits a deposited note into two private notes for ourselves.
 * If RECIPIENT=utxo:<meta-address> is set, output 1 goes to that recipient and
 * output 2 is sender change.
 */

import fs from "node:fs";
import path from "node:path";
import * as crypto from "node:crypto";
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
  UTXOpiaClient,
  initConfig,
  initPoseidon,
  poseidonHashSync,
  computeBoundParamsHash,
  createTransferBoundParams,
  computeStealthDataHash,
  bigintToBytes,
  bytesToBigint,
  eddsaPoseidonSign,
  buildTransactInstructionData,
  TREE_DEPTH,
  prepareClaimInputs,
  computeTokenId,
  decodeStealthMetaAddress,
  createStealthDepositWithKeys,
  createStealthOutputWithKeys,
} from "../../sdk/src/index";

// ── Config ────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3020";
const API_KEY = process.env.BACKEND_API_KEY;
const STATE_PATH =
  process.env.STATE_PATH ||
  path.join(PROJECT_ROOT, "scripts/devnet-regtest-state.json");
const SOLANA_RPC =
  process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const RECIPIENT = process.env.RECIPIENT;
const SEED_PATH = path.join(__dirname, ".demo-seed.json");
const NOTES_OUT = path.join(__dirname, ".notes.json");
const KEYPAIR_PATH = path.join(process.env.HOME!, ".config/solana/id.json");
const CIRCUITS_DIR = path.resolve(PROJECT_ROOT, "circuits/build");

if (!API_KEY) {
  console.error("ERROR: BACKEND_API_KEY required");
  process.exit(1);
}
if (!fs.existsSync(SEED_PATH)) {
  console.error(`ERROR: ${SEED_PATH} not found — run 01-deposit.ts first`);
  process.exit(1);
}

const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
const seed = Uint8Array.from(
  Buffer.from(JSON.parse(fs.readFileSync(SEED_PATH, "utf-8")).seed, "hex"),
);

// ── Helpers ──────────────────────────────────────────────────────
function api(p: string): Promise<any> {
  return fetch(`${BACKEND_URL}${p}`, { headers: { "X-API-Key": API_KEY! } }).then(
    async (r) => {
      if (!r.ok) throw new Error(`${p} -> ${r.status}: ${await r.text()}`);
      return r.json();
    },
  );
}

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
  // BN254 negate-G2 packing per Solana alt-bn128 expectation
  const bytes = new Uint8Array(256);
  function writeBE(buf: Uint8Array, offset: number, value: bigint, len: number) {
    for (let i = len - 1; i >= 0; i--) {
      buf[offset + i] = Number(value & 0xffn);
      value >>= 8n;
    }
  }
  writeBE(bytes, 0, BigInt(proof.pi_a[0]), 32);
  writeBE(bytes, 32, BigInt(proof.pi_a[1]), 32);
  // G2 elements: swap (c1, c0) for the `[1][0]` / `[0][1]` ordering the verifier expects.
  writeBE(bytes, 64, BigInt(proof.pi_b[0][1]), 32);
  writeBE(bytes, 96, BigInt(proof.pi_b[0][0]), 32);
  writeBE(bytes, 128, BigInt(proof.pi_b[1][1]), 32);
  writeBE(bytes, 160, BigInt(proof.pi_b[1][0]), 32);
  writeBE(bytes, 192, BigInt(proof.pi_c[0]), 32);
  writeBE(bytes, 224, BigInt(proof.pi_c[1]), 32);
  return bytes;
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log("\n═══ Hybrid JoinSplit 1x2 transact ═══\n");

  // Phase 1: SDK init
  // CAUTION: UTXOpiaClient.init({network:...}) re-runs initConfig and clobbers
  // overrides. So call client.init WITHOUT network first, then layer overrides.
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
  const setup = await client.loginWithSeed(seed);
  const keys = (client as any)._keys; // UTXOpiaKeys with viewing/spending/null keys
  if (!keys) throw new Error("loginWithSeed did not populate _keys");
  console.log(`  stealthAddress: ${setup.stealthAddressEncoded.slice(0, 50)}…`);

  // Phase 2: scan our note
  console.log("\n─── 2/6 Scan announcements for our note ───");
  const notes = await client.getNotes([{ symbol: "zkBTC", shieldedSymbol: "zkBTC" }]);
  if (notes.length === 0) {
    throw new Error("No notes found — has the deposit landed? Check tree.size > 0");
  }
  // Pick the newest unspent one. Older local demo notes may have been spent
  // by previous manual runs before local scanner state caught up.
  const note = notes
    .filter((n) => !n.isSpent)
    .sort((a, b) => b.leafIndex - a.leafIndex)[0];
  if (!note) throw new Error("No unspent notes");
  console.log(
    `  using note: leafIndex=${note.leafIndex}, amount=${note.amount} sats, commitment=${note.commitmentHex.slice(0, 16)}…`,
  );

  // Phase 3: merkle proof
  console.log("\n─── 3/6 Fetch merkle proof from backend ───");
  const proofResp = await api(`/api/tree/proof?commitment=${note.commitmentHex}`);
  // proofResp shape: { siblings: hex[], indices: number[], root: hex, leaf_index: n }
  const merkleRoot = bytesToBigint(Uint8Array.from(Buffer.from(proofResp.root, "hex")));
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
  console.log(`  root: ${merkleRoot.toString(16).slice(0, 20)}…`);

  // Phase 4: prepareClaimInputs (recovers random/nullifier from ECDH + viewing key)
  console.log("\n─── 4/6 Recover spend material via prepareClaimInputs ───");
  const scanned = {
    amount: note.amount,
    ephemeralPub: note.ephemeralPub!,
    stealthPub: note.stealthPub!,
    leafIndex: note.leafIndex,
    commitment: note.commitment,
  };
  const claim = await prepareClaimInputs(keys, scanned, merkleProof);
  console.log(`  random:    ${claim.random.toString(16).slice(0, 20)}…`);
  console.log(`  npk:       ${claim.npk.toString(16).slice(0, 20)}…`);
  console.log(`  nullifier: ${claim.nullifier.toString(16).slice(0, 20)}…`);

  // Phase 5: build outputs (1x2 split into two notes for ourselves)
  console.log("\n─── 5/6 Build proof + transact ix ───");
  const tokenId = computeTokenId(new PublicKey(state.zkbtcMint).toBuffer());
  const halfAmount = note.amount / 2n;
  const remainder = note.amount - halfAmount;

  let output1;
  let output1Label = "self-send";
  if (RECIPIENT) {
    const recipientMeta = decodeStealthMetaAddress(RECIPIENT);
    output1 = await createStealthDepositWithKeys(recipientMeta, halfAmount, tokenId);
    output1Label = `recipient ${RECIPIENT.slice(0, 48)}…`;
  } else {
    output1 = await createStealthOutputWithKeys(keys, halfAmount, tokenId);
  }

  const output2 = await createStealthOutputWithKeys(keys, remainder, tokenId);

  const npk1 = output1.stealthPubKeyX;
  const npk2 = output2.stealthPubKeyX;
  const commitment1 = bytesToBigint(output1.commitment);
  const commitment2 = bytesToBigint(output2.commitment);

  // Stealth data per output: ephemeralPub(32) + encryptedAmount(8) + encryptedTokenId(32).
  // Current scanners use the first 40 bytes; keep token ciphertext reserved.
  const stealth1 = new Uint8Array(72);
  stealth1.set(output1.ephemeralPub, 0);
  stealth1.set(output1.encryptedAmount, 32);
  stealth1.set(crypto.randomBytes(32), 40);
  const stealth2 = new Uint8Array(72);
  stealth2.set(output2.ephemeralPub, 0);
  stealth2.set(output2.encryptedAmount, 32);
  stealth2.set(crypto.randomBytes(32), 40);
  console.log(`  output 1: ${halfAmount} sats → ${output1Label}`);
  console.log(`  output 2: ${remainder} sats → sender change`);

  const stealthDataHash = computeStealthDataHash([stealth1, stealth2]);
  const transferParams = createTransferBoundParams(stealthDataHash, 103n);
  const boundParamsHash = computeBoundParamsHash(transferParams);

  const msgHash = poseidonHashSync([
    merkleRoot,
    boundParamsHash,
    claim.nullifier,
    commitment1,
    commitment2,
  ]);

  // CRITICAL: use the circuit-derived spending pubkey + the EdDSA seed (not the
  // user seed). UTXOpiaKeys.eddsaSeed = sha256(fakeSig || "spend"), and
  // keys.spendingPubKey was derived from THAT seed via circomlibjs eddsa. The
  // MPK in the circuit is Poseidon(pub.x, pub.y, nullifyingKey) — must match.
  const sig = await eddsaPoseidonSign(keys.eddsaSeed, msgHash);

  const circuitInputs = {
    merkleRoot: merkleRoot.toString(),
    boundParamsHash: boundParamsHash.toString(),
    nullifiers: [claim.nullifier.toString()],
    commitmentsOut: [commitment1.toString(), commitment2.toString()],
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
    npkOut: [npk1.toString(), npk2.toString()],
    valueOut: [halfAmount.toString(), remainder.toString()],
  };

  const { proof: groth16Proof } = generateProofViaNode("joinsplit_1x2", circuitInputs);
  const proofBytes = serializeGroth16Proof(groth16Proof);
  console.log(`  proof: ${proofBytes.length} bytes`);

  const ixData = buildTransactInstructionData({
    nInputs: 1,
    nOutputs: 2,
    proofBytes,
    merkleRoot: bigintTo32(merkleRoot),
    boundParamsHash: bigintTo32(boundParamsHash),
    nullifiers: [bigintTo32(claim.nullifier)],
    commitmentsOut: [bigintTo32(commitment1), bigintTo32(commitment2)],
    stealthData: [stealth1, stealth2],
  });

  // Account derivation
  const UTXOPIA = new PublicKey(state.utxopiaProgramId);
  const [poolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_state")],
    UTXOPIA,
  );
  const [commitmentTreePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("commitment_tree")],
    UTXOPIA,
  );
  const [vkRegistryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vk_registry"), Buffer.from([1]), Buffer.from([2])],
    UTXOPIA,
  );
  const [nullifierPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier"), Buffer.from(bigintTo32(claim.nullifier))],
    UTXOPIA,
  );
  const authority = loadAuthority();

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: poolStatePda, isSigner: false, isWritable: true },
      { pubkey: commitmentTreePda, isSigner: false, isWritable: true },
      { pubkey: vkRegistryPda, isSigner: false, isWritable: false },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: nullifierPda, isSigner: false, isWritable: true },
    ],
    programId: UTXOPIA,
    data: Buffer.from(ixData),
  });

  // Phase 6: submit
  console.log("\n─── 6/6 Submit transact tx ───");
  const conn = new Connection(SOLANA_RPC, "confirmed");
  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
    .add(ix);
  const txid = await sendAndConfirmTransaction(conn, tx, [authority], {
    commitment: "confirmed",
  });
  console.log(`  transact tx: ${txid}`);

  // Persist output notes for 03-unshield
  const out = {
    sendNote: {
      npk: npk1.toString(16),
      random: "derived-from-stealth-ecdh",
      amount: Number(halfAmount),
      commitment: commitment1.toString(16),
      tokenId: tokenId.toString(16),
      recipient: RECIPIENT || setup.stealthAddressEncoded,
    },
    changeNote: {
      npk: npk2.toString(16),
      random: "derived-from-stealth-ecdh",
      amount: Number(remainder),
      commitment: commitment2.toString(16),
      tokenId: tokenId.toString(16),
    },
    spentNullifier: claim.nullifier.toString(16),
    txid,
  };
  fs.writeFileSync(NOTES_OUT, JSON.stringify(out, null, 2));
  console.log(`\n  ✓ TRANSACT LANDED. ${note.amount} sats split → ${halfAmount} + ${remainder}`);
  console.log(`  ✓ Notes persisted to ${NOTES_OUT}`);
}

main().catch((e) => {
  console.error("\nERROR:", e?.message || e);
  if (e?.stack) console.error(e.stack);
  process.exit(1);
});
