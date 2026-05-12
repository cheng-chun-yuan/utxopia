#!/usr/bin/env bun
/**
 * Step 7b: Unshield zkBTC
 *
 * Unshield the change note from Step 6 JoinSplit (13500 sats zkBTC at leaf 5)
 * back to SPL zkBTC tokens using JoinSplit 1x1 proof with burn commitment.
 * Burn commitment = Poseidon([0;32], token_id, amount)
 */

import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
// circomlibjs removed — SDK's eddsaPoseidonSign wraps it internally

import {
  connection,
  loadAuthority,
  loadState,
  updateState,
  stepHeader,
  log,
  Disc,
  TREE_DEPTH,
  bigintToBytes32BE,
  bytes32ToBigintBE,
  amountToLE8,
  sendIx,
  initPoseidon,
  poseidonHashSync,
  computeJoinSplitCommitmentSync,
  computeJoinSplitNullifierSync,
  computeBoundParamsHash as sdkComputeBoundParamsHash,
  createUnshieldBoundParams,
  computeStealthDataHash,
  eddsaPoseidonSign,
  eddsaGetPubKey,
  parseCommitmentTree,
  extractFrontier,
  derivePoolStatePDA,
  deriveCommitmentTreePDA,
  deriveVkRegistryPDA,
  deriveNullifierPDA,
  deriveTokenConfigPDA,
  deriveATA,
  parseTokenConfig,
  TOKEN_2022,
  buildMerkleTree,
  getZeroHashes,
} from "./shared.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log("\n" + "=".repeat(60));
console.log("Step 7b: Unshield zkBTC");
console.log("=".repeat(60));


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

async function main() {
  const state = loadState();
  const authority = loadAuthority();
  const UTXOPIA = new PublicKey(state.privacyCoinProgramId);
  const [poolState] = derivePoolStatePDA(UTXOPIA);
  const [commitmentTree] = deriveCommitmentTreePDA(UTXOPIA);

  if (!state.transferNotes?.change) {
    throw new Error("Transfer change note not found. Run step6 first.");
  }

  // Init SDK Poseidon
  await initPoseidon();
  getZeroHashes();

  // Load keys using SDK
  const spendingSeed = Buffer.from(state.spendingSeed!, "hex");
  const pubKey = await eddsaGetPubKey(spendingSeed);
  const pubKeyX = pubKey.x;
  const pubKeyY = pubKey.y;
  const nullifyingKey = BigInt("0x" + state.nullifyingKey!);

  // Load zkBTC change note from step 6
  const note = state.transferNotes.change;
  const amount0 = BigInt(note.amount);
  const random0 = BigInt("0x" + note.random);
  const leafIndex0 = note.leafIndex;
  const commitment0 = BigInt("0x" + note.commitment);
  const tokenId = BigInt("0x" + note.tokenId);

  log(`Input: leaf ${leafIndex0}, ${amount0} sats zkBTC`);

  // Get token config for zkBTC
  const zkbtcMint = new PublicKey(state.zkbtcMint);
  const [tokenConfig] = deriveTokenConfigPDA(UTXOPIA, zkbtcMint);
  const poolVault = deriveATA(zkbtcMint, poolState);
  const userAta = deriveATA(zkbtcMint, authority.publicKey);

  // Rebuild full tree from tracked commitments
  if (!state.commitments || state.commitments.length === 0) {
    throw new Error("No tracked commitments. Run steps 3-6 first.");
  }
  log(`Rebuilding tree from ${state.commitments.length} tracked commitments...`);

  // Build tree from all commitments
  const allCommitments = state.commitments.map((h: string) => BigInt("0x" + h));
  const treeLeaves: bigint[] = [];
  for (const c of allCommitments) {
    treeLeaves.push(c);
  }

  const fullTree = buildMerkleTree(treeLeaves);
  const merkleRoot = fullTree.root;
  const proof = fullTree.getProof(leafIndex0);

  // Verify root matches on-chain
  const treeInfo = await connection.getAccountInfo(commitmentTree);
  const treeData = parseCommitmentTree(Buffer.from(treeInfo!.data))!;
  const onChainRoot = bytes32ToBigintBE(new Uint8Array(treeData.currentRoot));
  if (merkleRoot !== onChainRoot) {
    throw new Error(`Root mismatch: local ${merkleRoot.toString(16).slice(0, 16)} vs on-chain ${onChainRoot.toString(16).slice(0, 16)}`);
  }
  log(`Merkle root verified: ${merkleRoot.toString(16).slice(0, 16)}...`);

  // Unshield: 1 input → 1 output (burn commitment)
  // Burn commitment = Poseidon([0;32], token_id, amount)
  // The [0;32] is treated as a bigint (0)
  const zeroNpk = 0n;
  const burnCommitment = computeJoinSplitCommitmentSync(zeroNpk, tokenId, amount0);

  // Nullifier using SDK
  const nullifier0 = computeJoinSplitNullifierSync(nullifyingKey, BigInt(leafIndex0));
  log(`Nullifier: ${nullifier0.toString(16).slice(0, 16)}...`);
  log(`Burn commitment: ${burnCommitment.toString(16).slice(0, 16)}...`);

  // Bound params using SDK (unshield mode)
  // Bound params (unshield mode — multi-output format)
  const stealthDataHash = computeStealthDataHash([]); // no tree outputs
  const ownerBytes = new Uint8Array(authority.publicKey.toBytes());
  const unshieldParams = createUnshieldBoundParams(ownerBytes, stealthDataHash, 103n);
  const boundParamsHash = sdkComputeBoundParamsHash(unshieldParams);
  const msgHash = poseidonHashSync([merkleRoot, boundParamsHash, nullifier0, burnCommitment]);
  // EdDSA sign using SDK (circuit-compatible — wraps circomlibjs internally)
  const signature = await eddsaPoseidonSign(spendingSeed, msgHash);
  const sigR8x = signature[0];
  const sigR8y = signature[1];
  const sigS = signature[2];

  // Generate Groth16 proof (joinsplit_1x1)
  const circuitInputs = {
    merkleRoot: merkleRoot.toString(),
    boundParamsHash: boundParamsHash.toString(),
    nullifiers: [nullifier0.toString()],
    commitmentsOut: [burnCommitment.toString()],
    token: tokenId.toString(),
    publicKey: [pubKeyX.toString(), pubKeyY.toString()],
    signature: [sigR8x.toString(), sigR8y.toString(), sigS.toString()],
    nullifyingKey: nullifyingKey.toString(),
    randomIn: [random0.toString()],
    valueIn: [amount0.toString()],
    leavesIndices: [leafIndex0.toString()],
    pathElements: [proof.siblings.map(s => s.toString())],
    pathIndices: [proof.indices],
    npkOut: [zeroNpk.toString()],
    valueOut: [amount0.toString()],
  };

  const { proof: groth16Proof } = generateProofViaNode("joinsplit_1x1", circuitInputs);
  const proofBytes = serializeGroth16Proof(groth16Proof);
  log(`Proof: ${proofBytes.length} bytes`);

  // Build unshield instruction (disc=14)
  // Data: n_inputs(1) + n_outputs(1) + n_public_outputs(1) + proof_source(1) + proof(256) +
  //       merkle_root(32) + bound_params_hash(32) + nullifiers(32*N) + commitments(32*M) +
  //       stealth_data(72*n_tree_outputs) + amounts(8*n_public_outputs)
  const nInputs = 1;
  const nOutputs = 1; // just the burn output
  const nPublicOutputs = 1;
  const nTreeOutputs = nOutputs - nPublicOutputs; // 0 tree outputs for pure unshield
  const stealthPerOutput = 72;
  const dataLen = 1 + 1 + 1 + 1 + 1 + 256 + 32 + 32 + nInputs * 32 + nOutputs * 32 + nTreeOutputs * stealthPerOutput + nPublicOutputs * 8;
  const txData = Buffer.alloc(dataLen);
  let off = 0;

  txData[off++] = Disc.UNSHIELD;
  txData[off++] = nInputs;
  txData[off++] = nOutputs;
  txData[off++] = nPublicOutputs;
  txData[off++] = 0; // proof_source=inline
  Buffer.from(proofBytes).copy(txData, off); off += 256;
  Buffer.from(bigintToBytes32BE(merkleRoot)).copy(txData, off); off += 32;
  Buffer.from(bigintToBytes32BE(boundParamsHash)).copy(txData, off); off += 32;
  Buffer.from(bigintToBytes32BE(nullifier0)).copy(txData, off); off += 32;
  Buffer.from(bigintToBytes32BE(burnCommitment)).copy(txData, off); off += 32;
  // No stealth data (nTreeOutputs = 0)
  // Unshield amount
  txData.writeBigUInt64LE(amount0, off); off += 8;

  // Accounts for unshield (disc=14, multi-output):
  // 0. pool_state, 1. commitment_tree, 2. vk_registry, 3. user, 4. system_program,
  // 5. token_config, 6. vault, 7. token_program, 8..8+P recipients, 8+P+ nullifiers
  const nullifierBytes0 = bigintToBytes32BE(nullifier0);
  const [nullifierPDA0] = deriveNullifierPDA(UTXOPIA, nullifierBytes0);
  const [vkRegistry1x1] = deriveVkRegistryPDA(UTXOPIA, 1, 1);

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: commitmentTree, isSigner: false, isWritable: true },
      { pubkey: vkRegistry1x1, isSigner: false, isWritable: false },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenConfig, isSigner: false, isWritable: true },
      { pubkey: poolVault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: userAta, isSigner: false, isWritable: true }, // recipient
      { pubkey: nullifierPDA0, isSigner: false, isWritable: true },
    ],
    programId: UTXOPIA,
    data: txData,
  });

  const sig = await sendIx([ix], [authority], 1_400_000);
  log(`Unshield tx: ${sig.slice(0, 20)}...`);

  // Verify nullifier created
  const nullifierInfo = await connection.getAccountInfo(nullifierPDA0);
  if (!nullifierInfo || nullifierInfo.data[0] !== 0x03) {
    throw new Error("Nullifier PDA not created");
  }
  log("Nullifier PDA created");

  // Verify user received zkBTC tokens
  const userAtaInfo = await connection.getAccountInfo(userAta);
  if (userAtaInfo) {
    const tokenAmount = Buffer.from(userAtaInfo.data).readBigUInt64LE(64);
    log(`User zkBTC balance: ${tokenAmount} sats`);
  }

  console.log("\nStep 7b: Unshield zkBTC ......... PASS");
}

main().catch(err => {
  console.error("FAIL:", err.message);
  if (err.logs) err.logs.forEach((l: string) => console.error("  ", l));
  process.exit(1);
});
