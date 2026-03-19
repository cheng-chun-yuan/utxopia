#!/usr/bin/env bun
/**
 * Step 6: JoinSplit Transfer
 *
 * JoinSplit 1x2 using the demo note (Step 4): split 30,000 → 15,000 + 15,000 sats.
 * Uses SDK for crypto/instruction building, Node.js subprocess for snarkjs proof gen.
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

import {
  connection,
  loadAuthority,
  loadState,
  updateState,
  trackCommitments,
  stepHeader,
  log,
  sendIx,
  parseCommitmentTree,
  derivePoolStatePDA,
  deriveCommitmentTreePDA,
  deriveVkRegistryPDA,
  deriveNullifierPDA,
  NoteState,
  // SDK re-exports
  initPoseidon,
  poseidonHashSync,
  computeNPKSync,
  computeJoinSplitCommitmentSync,
  computeJoinSplitNullifierSync,
  computeBoundParamsHash,
  bigintToBytes32BE,
  bytes32ToBigintBE,
  randomFieldElement,
  eddsaPoseidonSign,
  eddsaGetPubKey,
  buildTransactInstructionData,
  TREE_DEPTH,
} from "./shared.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

stepHeader(6, "JoinSplit Transfer");

// =============================================================================
// Merkle tree helpers (uses SDK Poseidon)
// =============================================================================

const ZERO_HASHES: bigint[] = [0n];

function computeZeroHashes() {
  for (let i = 1; i <= TREE_DEPTH; i++) {
    ZERO_HASHES[i] = poseidonHashSync([ZERO_HASHES[i - 1], ZERO_HASHES[i - 1]]);
  }
}

function verifyMerkleProof(
  leaf: bigint, proof: { siblings: bigint[]; indices: number[] }, expectedRoot: bigint,
): boolean {
  let hash = leaf;
  for (let level = 0; level < TREE_DEPTH; level++) {
    hash = proof.indices[level] === 0
      ? poseidonHashSync([hash, proof.siblings[level]])
      : poseidonHashSync([proof.siblings[level], hash]);
  }
  return hash === expectedRoot;
}

// =============================================================================
// Proof generation via Node subprocess (snarkjs + bun = hang, must use Node)
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

  // Init SDK Poseidon (replaces circomlibjs buildPoseidon)
  await initPoseidon();
  computeZeroHashes();

  // Load keys using SDK
  const spendingSeed = Buffer.from(state.spendingSeed!, "hex");
  const pubKey = await eddsaGetPubKey(spendingSeed);
  const pubKeyX = pubKey.x;
  const pubKeyY = pubKey.y;
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
  const merkleRoot = bytes32ToBigintBE(new Uint8Array(treeData.currentRoot));

  // Build Merkle proof by reconstructing the full tree
  log(`Building Merkle proof for leaf ${leafIndex0}...`);

  const nextIndex = Number(treeData.nextIndex);
  const leaves: bigint[] = new Array(nextIndex).fill(0n);
  if (state.commitments) {
    for (let i = 0; i < Math.min(state.commitments.length, nextIndex); i++) {
      leaves[i] = BigInt("0x" + state.commitments[i]);
    }
  }

  // Build the full tree bottom-up
  const treeNodes: bigint[][] = [];
  const levelSize = 1 << TREE_DEPTH;
  const level0 = new Array<bigint>(levelSize).fill(ZERO_HASHES[0]);
  for (let i = 0; i < nextIndex; i++) {
    level0[i] = leaves[i];
  }
  treeNodes.push(level0);

  for (let level = 1; level <= TREE_DEPTH; level++) {
    const prevLevel = treeNodes[level - 1];
    const size = 1 << (TREE_DEPTH - level);
    const currentLevel = new Array<bigint>(size);
    for (let i = 0; i < size; i++) {
      currentLevel[i] = poseidonHashSync([prevLevel[2 * i], prevLevel[2 * i + 1]]);
    }
    treeNodes.push(currentLevel);
  }

  const computedRoot = treeNodes[TREE_DEPTH][0];
  log(`Computed root: ${computedRoot.toString(16).slice(0, 16)}...`);
  log(`On-chain root: ${merkleRoot.toString(16).slice(0, 16)}...`);

  if (computedRoot !== merkleRoot) {
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

  // Create 2 output notes using SDK
  const random1 = randomFieldElement();
  const amount1 = 15_000n;
  const npk1 = computeNPKSync(mpk, random1);
  const commitment1 = computeJoinSplitCommitmentSync(npk1, tokenId, amount1);

  const random2 = randomFieldElement();
  const amount2 = 15_000n;
  const npk2 = computeNPKSync(mpk, random2);
  const commitment2 = computeJoinSplitCommitmentSync(npk2, tokenId, amount2);

  // Nullifier using SDK
  const nullifier0 = computeJoinSplitNullifierSync(nullifyingKey, BigInt(leafIndex0));
  log(`Nullifier: ${nullifier0.toString(16).slice(0, 16)}...`);

  // Bound params hash using SDK
  const boundParamsHash = computeBoundParamsHash({ treeNumber: 0, unshieldAddress: null, chainId: 103n });
  const msgHash = poseidonHashSync([merkleRoot, boundParamsHash, nullifier0, commitment1, commitment2]);

  // EdDSA sign using SDK (circuit-compatible — wraps circomlibjs internally)
  const signature = await eddsaPoseidonSign(spendingSeed, msgHash);
  const sigR8x = signature[0];
  const sigR8y = signature[1];
  const sigS = signature[2];

  // Generate Groth16 proof (Node.js subprocess — snarkjs hangs in bun)
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

  // Build transact instruction using SDK
  const ephPub1 = crypto.randomBytes(32);
  const ephPub2 = crypto.randomBytes(32);
  const stealth1 = new Uint8Array(72);
  stealth1.set(ephPub1, 0);
  stealth1.set(new Uint8Array(new BigUint64Array([BigInt(amount1)]).buffer), 32);
  stealth1.set(crypto.randomBytes(32), 40); // encrypted_token_id
  const stealth2 = new Uint8Array(72);
  stealth2.set(ephPub2, 0);
  stealth2.set(new Uint8Array(new BigUint64Array([BigInt(amount2)]).buffer), 32);
  stealth2.set(crypto.randomBytes(32), 40); // encrypted_token_id

  const txData = buildTransactInstructionData({
    nInputs: 1,
    nOutputs: 2,
    proofBytes,
    merkleRoot: bigintToBytes32BE(merkleRoot),
    boundParamsHash: bigintToBytes32BE(boundParamsHash),
    nullifiers: [bigintToBytes32BE(nullifier0)],
    commitmentsOut: [bigintToBytes32BE(commitment1), bigintToBytes32BE(commitment2)],
    stealthData: [stealth1, stealth2],
  });

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
    data: Buffer.from(txData),
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
