#!/usr/bin/env bun
/**
 * Step 6: JoinSplit Transfer
 *
 * JoinSplit 1x2 using the demo note (Step 4): split 10,000 → 6,000 + 4,000 sats.
 * Uses real Groth16 proof (Node.js subprocess for snarkjs).
 */

import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { sha256 } from "@noble/hashes/sha2.js";
import { buildPoseidon } from "circomlibjs";

import {
  connection,
  loadAuthority,
  loadState,
  updateState,
  trackCommitments,
  stepHeader,
  log,
  Disc,
  BN254_FIELD_PRIME,
  TREE_DEPTH,
  SDK_DIR,
  bigintToBytes32BE,
  bytes32ToBigintBE,
  amountToLE8,
  sendIx,
  randomFieldElement,
  parseCommitmentTree,
  extractFrontier,
  derivePoolStatePDA,
  deriveCommitmentTreePDA,
  deriveVkRegistryPDA,
  deriveNullifierPDA,
  NoteState,
} from "./shared.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

stepHeader(6, "JoinSplit Transfer");

// =============================================================================
// Merkle tree helpers
// =============================================================================

let poseidon: any;
let poseidonHash: (inputs: bigint[]) => bigint;
const ZERO_HASHES: bigint[] = [0n];

function computeZeroHashes() {
  for (let i = 1; i <= TREE_DEPTH; i++) {
    ZERO_HASHES[i] = poseidonHash([ZERO_HASHES[i - 1], ZERO_HASHES[i - 1]]);
  }
}

function getMerkleProofFromFrontier(
  leafIndex: number, frontier: bigint[],
): { siblings: bigint[]; indices: number[] } {
  const siblings: bigint[] = [];
  const indices: number[] = [];
  let idx = leafIndex;
  for (let level = 0; level < TREE_DEPTH; level++) {
    const bit = idx & 1;
    indices.push(bit);
    siblings.push(bit === 0 ? ZERO_HASHES[level] : frontier[level]);
    idx >>= 1;
  }
  return { siblings, indices };
}

function verifyMerkleProof(
  leaf: bigint, proof: { siblings: bigint[]; indices: number[] }, expectedRoot: bigint,
): boolean {
  let hash = leaf;
  for (let level = 0; level < TREE_DEPTH; level++) {
    hash = proof.indices[level] === 0
      ? poseidonHash([hash, proof.siblings[level]])
      : poseidonHash([proof.siblings[level], hash]);
  }
  return hash === expectedRoot;
}

// =============================================================================
// Bound params hash
// =============================================================================

function computeBoundParamsHash(): bigint {
  const buf = new Uint8Array(45);
  const view = new DataView(buf.buffer);
  view.setUint32(0, 0, true); // treeNumber = 0
  buf[4] = 0; // hasUnshield = 0
  const chainIdBuf = new Uint8Array(8);
  chainIdBuf[0] = 103; // Solana devnet chain ID
  buf.set(chainIdBuf, 37);
  const hash = sha256(buf);
  return bytes32ToBigintBE(hash) % BN254_FIELD_PRIME;
}

// =============================================================================
// Proof generation via Node subprocess
// =============================================================================

function generateProofViaNode(
  circuitName: string, inputs: Record<string, any>,
): { proof: any; publicSignals: string[] } {
  const circuitsDir = path.resolve(__dirname, "../../circuits/build");
  const wasmPath = path.join(circuitsDir, circuitName, `${circuitName}_js`, `${circuitName}.wasm`);
  const zkeyPath = path.join(circuitsDir, circuitName, `${circuitName}.zkey`);

  if (!fs.existsSync(wasmPath)) throw new Error(`WASM not found: ${wasmPath}`);
  if (!fs.existsSync(zkeyPath)) throw new Error(`zkey not found: ${zkeyPath}`);

  const tmpDir = path.join(__dirname, ".tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const ts = Date.now();
  const tmpInput = path.join(tmpDir, `input_${ts}.json`);
  const tmpProof = path.join(tmpDir, `proof_${ts}.json`);
  const tmpPublic = path.join(tmpDir, `public_${ts}.json`);

  fs.writeFileSync(tmpInput, JSON.stringify(inputs));

  try {
    log(`Generating ${circuitName} Groth16 proof via Node.js...`);
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
      { timeout: 120000, stdio: "pipe" },
    );

    const proof = JSON.parse(fs.readFileSync(tmpProof, "utf8"));
    const publicSignals: string[] = JSON.parse(fs.readFileSync(tmpPublic, "utf8"));
    return { proof, publicSignals };
  } finally {
    try { fs.unlinkSync(tmpInput); } catch {}
    try { fs.unlinkSync(tmpProof); } catch {}
    try { fs.unlinkSync(tmpPublic); } catch {}
  }
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

// =============================================================================
// Main
// =============================================================================

async function main() {
  const state = loadState();
  const authority = loadAuthority();
  const AEGIS = new PublicKey(state.aegisProgramId);
  const [poolState] = derivePoolStatePDA(AEGIS);
  const [commitmentTree] = deriveCommitmentTreePDA(AEGIS);

  // Init crypto
  poseidon = await buildPoseidon();
  poseidonHash = (inputs: bigint[]) => poseidon.F.toObject(poseidon(inputs)) as bigint;
  computeZeroHashes();

  const { buildEddsa } = await import("circomlibjs");
  const eddsa = await buildEddsa();
  const F = eddsa.babyJub.F;

  // Load keys
  const spendingSeed = Buffer.from(state.spendingSeed!, "hex");
  const privKeyBuf = Buffer.from(spendingSeed);
  const pubKey = eddsa.prv2pub(privKeyBuf);
  const pubKeyX = F.toObject(pubKey[0]) as bigint;
  const pubKeyY = F.toObject(pubKey[1]) as bigint;
  const nullifyingKey = BigInt("0x" + state.nullifyingKey!);
  const mpk = BigInt("0x" + state.mpk!);

  // Load demo note from Step 4
  if (!state.demoNote) throw new Error("Demo note not found. Run step4 first.");
  const note = state.demoNote;
  const amount0 = BigInt(note.amount);
  const random0 = BigInt("0x" + note.random);
  const leafIndex0 = note.leafIndex;
  const commitment0 = BigInt("0x" + note.commitment);

  log(`Input: leaf ${leafIndex0}, ${amount0} sats`);

  // Read tree
  const treeInfo = await connection.getAccountInfo(commitmentTree);
  const treeData = parseCommitmentTree(Buffer.from(treeInfo!.data))!;
  const frontier = extractFrontier(treeData);
  const merkleRoot = bytes32ToBigintBE(new Uint8Array(treeData.currentRoot));

  // Build Merkle proof by reconstructing the full tree from all known commitments
  // Frontier-based proofs only work for the last leaf; for earlier leaves we need all siblings
  log(`Building Merkle proof for leaf ${leafIndex0}...`);

  // Collect all commitments from state.commitments (tracked in insertion order)
  const nextIndex = Number(treeData.nextIndex);
  const leaves: bigint[] = new Array(nextIndex).fill(0n);

  // Use the commitments array tracked across all steps (insertion order = leaf order)
  if (state.commitments) {
    for (let i = 0; i < Math.min(state.commitments.length, nextIndex); i++) {
      leaves[i] = BigInt("0x" + state.commitments[i]);
    }
  }

  // Build the full tree bottom-up
  const treeNodes: bigint[][] = [];
  // Level 0: all leaves (pad with zero hashes)
  const levelSize = 1 << TREE_DEPTH; // 65536
  const level0 = new Array<bigint>(levelSize).fill(ZERO_HASHES[0]);
  for (let i = 0; i < nextIndex; i++) {
    level0[i] = leaves[i];
  }
  treeNodes.push(level0);

  // Build up
  for (let level = 1; level <= TREE_DEPTH; level++) {
    const prevLevel = treeNodes[level - 1];
    const size = 1 << (TREE_DEPTH - level);
    const currentLevel = new Array<bigint>(size);
    for (let i = 0; i < size; i++) {
      currentLevel[i] = poseidonHash([prevLevel[2 * i], prevLevel[2 * i + 1]]);
    }
    treeNodes.push(currentLevel);
  }

  const computedRoot = treeNodes[TREE_DEPTH][0];
  log(`Computed root: ${computedRoot.toString(16).slice(0, 16)}...`);
  log(`On-chain root: ${merkleRoot.toString(16).slice(0, 16)}...`);

  if (computedRoot !== merkleRoot) {
    // Some commitments may differ from on-chain. Use frontier to fill gaps.
    log("WARNING: Root mismatch — our local commitments don't match on-chain.");
    log("Falling back to frontier-based proof (works only for last leaf).");

    // Since we can't rebuild the tree without knowing all commitments exactly,
    // let's use the frontier-based approach but for a leaf that IS the frontier.
    // The demo note should match since we computed it locally with the same Poseidon.
    // The problem might be that btcNote commitment is wrong (sweep amount != 25000 sats).
    // Let's check frontier values to understand what the tree looks like.
    log(`Frontier[0]=${frontier[0].toString(16).slice(0,16)}...`);
    log(`Frontier[1]=${frontier[1].toString(16).slice(0,16)}...`);

    throw new Error("Cannot build valid Merkle proof — commitment mismatch with on-chain tree");
  }

  // Extract proof from the full tree
  const siblings: bigint[] = [];
  const indices: number[] = [];
  let idx = leafIndex0;
  for (let level = 0; level < TREE_DEPTH; level++) {
    const bit = idx & 1;
    indices.push(bit);
    const siblingIdx = bit === 0 ? idx + 1 : idx - 1;
    siblings.push(treeNodes[level][siblingIdx]);
    idx >>= 1;
  }
  const proof = { siblings, indices };

  if (!verifyMerkleProof(commitment0, proof, merkleRoot)) {
    throw new Error("Full tree Merkle proof verification failed");
  }
  log("Merkle proof verified locally");

  // Get token_id from the note
  const tokenId = BigInt("0x" + note.tokenId);

  // Create 2 output notes: 6,000 + 4,000
  const random1 = randomFieldElement();
  const amount1 = 15_000n;
  const npk1 = poseidonHash([mpk, random1]);
  const commitment1 = poseidonHash([npk1, tokenId, amount1]);

  const random2 = randomFieldElement();
  const amount2 = 15_000n;
  const npk2 = poseidonHash([mpk, random2]);
  const commitment2 = poseidonHash([npk2, tokenId, amount2]);

  // Nullifier
  const nullifier0 = poseidonHash([nullifyingKey, BigInt(leafIndex0)]);
  log(`Nullifier: ${nullifier0.toString(16).slice(0, 16)}...`);

  // Bound params hash + message hash + sign
  const boundParamsHash = computeBoundParamsHash();
  const msgHash = poseidonHash([merkleRoot, boundParamsHash, nullifier0, commitment1, commitment2]);
  const msgF = F.e(msgHash);
  const signature = eddsa.signPoseidon(privKeyBuf, msgF);
  const sigR8x = F.toObject(signature.R8[0]) as bigint;
  const sigR8y = F.toObject(signature.R8[1]) as bigint;
  const sigS = signature.S as bigint;

  // Generate Groth16 proof (joinsplit_1x2)
  const circuitInputs = {
    merkleRoot: merkleRoot.toString(),
    boundParamsHash: boundParamsHash.toString(),
    nullifiers: [nullifier0.toString()],
    commitmentsOut: [commitment1.toString(), commitment2.toString()],
    token: tokenId.toString(),
    publicKey: [pubKeyX.toString(), pubKeyY.toString()],
    signature: [sigR8x.toString(), sigR8y.toString(), sigS.toString()],
    nullifyingKey: nullifyingKey.toString(),
    randomIn: [random0.toString()],
    valueIn: [amount0.toString()],
    leavesIndices: [leafIndex0.toString()],
    pathElements: [proof.siblings.map(s => s.toString())],
    pathIndices: [proof.indices],
    npkOut: [npk1.toString(), npk2.toString()],
    valueOut: [amount1.toString(), amount2.toString()],
  };

  const { proof: groth16Proof } = generateProofViaNode("joinsplit_1x2", circuitInputs);
  const proofBytes = serializeGroth16Proof(groth16Proof);
  log(`Proof: ${proofBytes.length} bytes`);

  // Build transact instruction (disc=14)
  // Current on-chain format: disc(1) + n_inputs(1) + n_outputs(1) + proof_source(1) + proof(256) +
  //   merkle_root(32) + bound_params_hash(32) + nullifiers(32*N) + commitments(32*M) + stealth_data(72*M)
  const nInputs = 1;
  const nOutputs = 2;
  const stealthPerOutput = 72; // ephemeral(32) + encrypted_amount(8) + encrypted_token_id(32)
  const dataLen = 1 + 1 + 1 + 1 + 256 + 32 + 32 + nInputs * 32 + nOutputs * 32 + nOutputs * stealthPerOutput;
  const txData = Buffer.alloc(dataLen);
  let off = 0;

  txData[off++] = Disc.TRANSACT;
  txData[off++] = nInputs;
  txData[off++] = nOutputs;
  txData[off++] = 0; // proof_source = inline
  Buffer.from(proofBytes).copy(txData, off); off += 256;
  Buffer.from(bigintToBytes32BE(merkleRoot)).copy(txData, off); off += 32;
  Buffer.from(bigintToBytes32BE(boundParamsHash)).copy(txData, off); off += 32;

  // Nullifiers
  Buffer.from(bigintToBytes32BE(nullifier0)).copy(txData, off); off += 32;

  // Commitments
  Buffer.from(bigintToBytes32BE(commitment1)).copy(txData, off); off += 32;
  Buffer.from(bigintToBytes32BE(commitment2)).copy(txData, off); off += 32;

  // Stealth data per output (72 bytes each)
  const ephPub1 = crypto.randomBytes(32);
  ephPub1.copy(txData, off); off += 32;
  Buffer.from(amountToLE8(amount1)).copy(txData, off); off += 8;
  crypto.randomBytes(32).copy(txData, off); off += 32; // encrypted_token_id

  const ephPub2 = crypto.randomBytes(32);
  ephPub2.copy(txData, off); off += 32;
  Buffer.from(amountToLE8(amount2)).copy(txData, off); off += 8;
  crypto.randomBytes(32).copy(txData, off); off += 32; // encrypted_token_id

  // Accounts
  const nullifierBytes0 = bigintToBytes32BE(nullifier0);
  const [nullifierPDA0] = deriveNullifierPDA(AEGIS, nullifierBytes0);
  const [vkRegistry1x2] = deriveVkRegistryPDA(AEGIS, 1, 2);

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: commitmentTree, isSigner: false, isWritable: true },
      { pubkey: vkRegistry1x2, isSigner: false, isWritable: false },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: nullifierPDA0, isSigner: false, isWritable: true },
    ],
    programId: AEGIS,
    data: txData,
  });

  const sig = await sendIx([ix], [authority], 1_400_000);
  log(`Transact tx: ${sig.slice(0, 20)}...`);

  // Verify nullifier
  const nullifierInfo = await connection.getAccountInfo(nullifierPDA0);
  if (!nullifierInfo || nullifierInfo.data[0] !== 0x03) {
    throw new Error("Nullifier PDA not created");
  }
  log("Nullifier PDA created");

  // Verify tree updated
  const treeAfter = await connection.getAccountInfo(commitmentTree);
  const treeDataAfter = parseCommitmentTree(Buffer.from(treeAfter!.data))!;
  const newLeafIndex = Number(treeDataAfter.nextIndex);
  const leafIndex1 = newLeafIndex - 2;
  const leafIndex2 = newLeafIndex - 1;
  log(`Outputs at leaves ${leafIndex1} (6k) and ${leafIndex2} (4k)`);

  // Save notes
  const sendNote: NoteState = {
    npk: npk1.toString(16),
    random: random1.toString(16),
    amount: Number(amount1),
    leafIndex: leafIndex1,
    commitment: commitment1.toString(16),
    tokenId: tokenId.toString(16),
  };
  const changeNote: NoteState = {
    npk: npk2.toString(16),
    random: random2.toString(16),
    amount: Number(amount2),
    leafIndex: leafIndex2,
    commitment: commitment2.toString(16),
    tokenId: tokenId.toString(16),
  };

  updateState({ transferNotes: { send: sendNote, change: changeNote } });
  trackCommitments(sendNote.commitment, changeNote.commitment);

  console.log("\nStep 6: JoinSplit Transfer ...... PASS");
}

main().catch(err => {
  console.error("FAIL:", err.message);
  if (err.logs) err.logs.forEach((l: string) => console.error("  ", l));
  process.exit(1);
});
