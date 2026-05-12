#!/usr/bin/env bun
/**
 * Step 8c: Multi-Output Redeem (REDEEM disc=15)
 *
 * Tests multi-output redeem with n_public_outputs=2 using joinsplit_1x2.
 * Splits btcNote1 from step3 into 2 BTC redeem outputs with different scripts.
 * Creates 2 RedemptionRequest PDAs.
 */

import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

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
  sendIx,
  initPoseidon,
  poseidonHashSync,
  computeJoinSplitCommitmentSync,
  computeJoinSplitNullifierSync,
  computeBoundParamsHash as sdkComputeBoundParamsHash,
  createRedeemBoundParams,
  computeStealthDataHash,
  eddsaPoseidonSign,
  eddsaGetPubKey,
  parseCommitmentTree,
  derivePoolStatePDA,
  deriveCommitmentTreePDA,
  deriveVkRegistryPDA,
  deriveNullifierPDA,
  deriveTokenConfigPDA,
  parseTokenConfig,
  parsePoolState,
  buildMerkleTree,
  getZeroHashes,
} from "./shared.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

stepHeader(85, "Multi-Output Redeem (BTC)");


function generateProofViaNode(
  circuitName: string, inputs: Record<string, any>,
): { proof: any; publicSignals: string[] } {
  const CIRCUITS_DIR = path.join(__dirname, "../../circuits");
  const wasmPath = path.join(CIRCUITS_DIR, `build/${circuitName}/${circuitName}_js/${circuitName}.wasm`);
  const zkeyPath = path.join(CIRCUITS_DIR, `build/${circuitName}/${circuitName}.zkey`);
  if (!fs.existsSync(wasmPath)) throw new Error(`WASM not found: ${wasmPath}`);
  if (!fs.existsSync(zkeyPath)) throw new Error(`zkey not found: ${zkeyPath}`);

  const tmpDir = fs.mkdtempSync("/tmp/utxopia-proof-");
  const tmpInput = path.join(tmpDir, "input.json");
  const tmpProof = path.join(tmpDir, "proof.json");
  const tmpPublic = path.join(tmpDir, "public.json");

  try {
    fs.writeFileSync(tmpInput, JSON.stringify(inputs));
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
    try { fs.rmdirSync(tmpDir); } catch {}
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

function deriveRedemptionPDA(programId: PublicKey, user: PublicKey, nonce: bigint): [PublicKey, number] {
  const nonceBytes = Buffer.alloc(8);
  nonceBytes.writeBigUInt64LE(nonce);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("redemption"), user.toBuffer(), nonceBytes],
    programId,
  );
}

async function main() {
  const state = loadState();
  const authority = loadAuthority();
  const UTXOPIA = new PublicKey(state.utxopiaProgramId);
  const [poolState] = derivePoolStatePDA(UTXOPIA);
  const [commitmentTree] = deriveCommitmentTreePDA(UTXOPIA);

  if (!state.btcNote) {
    throw new Error("btcNote not found. Run step3 first.");
  }

  await initPoseidon();
  getZeroHashes();

  // Load keys
  const spendingSeed = Buffer.from(state.spendingSeed!, "hex");
  const pubKey = await eddsaGetPubKey(spendingSeed);
  const pubKeyX = pubKey.x;
  const pubKeyY = pubKey.y;
  const nullifyingKey = BigInt("0x" + state.nullifyingKey!);

  // Load btcNote
  const note = state.btcNote;
  const totalAmount = BigInt(note.amount);
  const random0 = BigInt("0x" + note.random);
  const leafIndex0 = note.leafIndex;

  // Read token_id from on-chain TokenConfig (authoritative)
  const zkbtcMint = new PublicKey(state.zkbtcMint!);
  const [tokenConfig] = deriveTokenConfigPDA(UTXOPIA, zkbtcMint);
  const tcInfo = await connection.getAccountInfo(tokenConfig);
  if (!tcInfo) throw new Error("zkBTC TokenConfig not found");
  const tcData = parseTokenConfig(Buffer.from(tcInfo.data))!;
  const tokenId = bytes32ToBigintBE(new Uint8Array(tcData.tokenId));
  log(`On-chain token_id: ${tokenId.toString(16).slice(0, 16)}...`);

  // Split into two redeem amounts
  const amount1 = totalAmount / 2n;
  const amount2 = totalAmount - amount1;
  log(`Input: leaf ${leafIndex0}, total ${totalAmount} sats`);
  log(`Redeem output 1: ${amount1} sats, Redeem output 2: ${amount2} sats`);

  // Two different BTC scripts (P2WPKH-style, 22 bytes each)
  const btcScript1 = Buffer.alloc(22);
  btcScript1[0] = 0x00; // OP_0
  btcScript1[1] = 0x14; // push 20 bytes
  btcScript1.fill(0xAA, 2); // dummy pubkey hash 1

  const btcScript2 = Buffer.alloc(22);
  btcScript2[0] = 0x00; // OP_0
  btcScript2[1] = 0x14; // push 20 bytes
  btcScript2.fill(0xBB, 2); // dummy pubkey hash 2

  const nonce1 = BigInt(Date.now());
  const nonce2 = nonce1 + 1n;

  // zkbtcMint and tokenConfig already derived above

  // Rebuild Merkle tree
  if (!state.commitments || state.commitments.length === 0) {
    throw new Error("No tracked commitments. Run steps 3-6 first.");
  }
  log(`Rebuilding tree from ${state.commitments.length} tracked commitments...`);

  const allCommitments = state.commitments.map((h: string) => BigInt("0x" + h));

  const fullTree = buildMerkleTree([...allCommitments]);
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

  // Two burn commitments: Poseidon(0, token_id, amount_k)
  const zeroNpk = 0n;
  const burnCommitment1 = computeJoinSplitCommitmentSync(zeroNpk, tokenId, amount1);
  const burnCommitment2 = computeJoinSplitCommitmentSync(zeroNpk, tokenId, amount2);

  // Nullifier
  const nullifier0 = computeJoinSplitNullifierSync(nullifyingKey, BigInt(leafIndex0));
  log(`Nullifier: ${nullifier0.toString(16).slice(0, 16)}...`);

  // Bound params (multi-output redeem — 2 BTC scripts concatenated)
  const stealthDataHash = computeStealthDataHash([]); // no tree outputs
  const redeemParams = createRedeemBoundParams(
    [new Uint8Array(btcScript1), new Uint8Array(btcScript2)],
    stealthDataHash, 103n,
  );
  const boundParamsHash = sdkComputeBoundParamsHash(redeemParams);

  const msgHash = poseidonHashSync([merkleRoot, boundParamsHash, nullifier0, burnCommitment1, burnCommitment2]);
  const signature = await eddsaPoseidonSign(spendingSeed, msgHash);

  // Generate Groth16 proof (joinsplit_1x2: 1 input, 2 outputs)
  const circuitInputs = {
    merkleRoot: merkleRoot.toString(),
    boundParamsHash: boundParamsHash.toString(),
    nullifiers: [nullifier0.toString()],
    commitmentsOut: [burnCommitment1.toString(), burnCommitment2.toString()],
    token: tokenId.toString(),
    publicKey: [pubKeyX.toString(), pubKeyY.toString()],
    signature: [signature[0].toString(), signature[1].toString(), signature[2].toString()],
    nullifyingKey: nullifyingKey.toString(),
    randomIn: [random0.toString()],
    valueIn: [totalAmount.toString()],
    leavesIndices: [leafIndex0.toString()],
    pathElements: [proof.siblings.map(s => s.toString())],
    pathIndices: [proof.indices],
    npkOut: [zeroNpk.toString(), zeroNpk.toString()],
    valueOut: [amount1.toString(), amount2.toString()],
  };

  const { proof: groth16Proof } = generateProofViaNode("joinsplit_1x2", circuitInputs);
  const proofBytes = serializeGroth16Proof(groth16Proof);
  log(`Proof: ${proofBytes.length} bytes`);

  // Build REDEEM instruction (disc=15, n_public_outputs=2)
  const nInputs = 1;
  const nOutputs = 2;
  const nPublicOutputs = 2;
  const nTreeOutputs = 0;
  const stealthPerOutput = 40; // redeem uses 40-byte stealth data

  // Per-output: amount(8) + script_len(1) + script(var) + nonce(8)
  const perOutputSize = 8 + 1 + btcScript1.length + 8 + 8 + 1 + btcScript2.length + 8;
  const dataLen = 1 + 1 + 1 + 1 + 1 + 256 + 32 + 32
    + nInputs * 32 + nOutputs * 32
    + nTreeOutputs * stealthPerOutput
    + 8 + 1 + btcScript1.length + 8  // output 1
    + 8 + 1 + btcScript2.length + 8; // output 2

  const txData = Buffer.alloc(dataLen);
  let off = 0;

  txData[off++] = Disc.REDEEM;
  txData[off++] = nInputs;
  txData[off++] = nOutputs;
  txData[off++] = nPublicOutputs;
  txData[off++] = 0; // proof_source=inline
  Buffer.from(proofBytes).copy(txData, off); off += 256;
  Buffer.from(bigintToBytes32BE(merkleRoot)).copy(txData, off); off += 32;
  Buffer.from(bigintToBytes32BE(boundParamsHash)).copy(txData, off); off += 32;
  Buffer.from(bigintToBytes32BE(nullifier0)).copy(txData, off); off += 32;
  Buffer.from(bigintToBytes32BE(burnCommitment1)).copy(txData, off); off += 32;
  Buffer.from(bigintToBytes32BE(burnCommitment2)).copy(txData, off); off += 32;
  // No stealth data (nTreeOutputs = 0)

  // Per-output redeem data: amount(8) + script_len(1) + script(var) + nonce(8)
  // Output 1
  txData.writeBigUInt64LE(amount1, off); off += 8;
  txData[off++] = btcScript1.length;
  btcScript1.copy(txData, off); off += btcScript1.length;
  txData.writeBigUInt64LE(nonce1, off); off += 8;
  // Output 2
  txData.writeBigUInt64LE(amount2, off); off += 8;
  txData[off++] = btcScript2.length;
  btcScript2.copy(txData, off); off += btcScript2.length;
  txData.writeBigUInt64LE(nonce2, off); off += 8;

  // Accounts (disc=15, multi-output):
  // 0-5: fixed, 6..6+N nullifiers, 6+N..6+N+P redemption PDAs
  const nullifierBytes0 = bigintToBytes32BE(nullifier0);
  const [nullifierPDA0] = deriveNullifierPDA(UTXOPIA, nullifierBytes0);
  const [vkRegistry1x2] = deriveVkRegistryPDA(UTXOPIA, 1, 2);
  const [redemptionPDA1] = deriveRedemptionPDA(UTXOPIA, authority.publicKey, nonce1);
  const [redemptionPDA2] = deriveRedemptionPDA(UTXOPIA, authority.publicKey, nonce2);

  // Read pool state before
  const poolBefore = await connection.getAccountInfo(poolState);
  const poolStateBefore = parsePoolState(Buffer.from(poolBefore!.data))!;
  const pendingBefore = poolStateBefore.pendingRedemptions;

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: commitmentTree, isSigner: false, isWritable: true },
      { pubkey: vkRegistry1x2, isSigner: false, isWritable: false },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenConfig, isSigner: false, isWritable: false },
      // Nullifiers
      { pubkey: nullifierPDA0, isSigner: false, isWritable: true },
      // Redemption PDAs
      { pubkey: redemptionPDA1, isSigner: false, isWritable: true },
      { pubkey: redemptionPDA2, isSigner: false, isWritable: true },
    ],
    programId: UTXOPIA,
    data: txData,
  });

  const sig = await sendIx([ix], [authority], 1_400_000);
  log(`Multi-output redeem tx: ${sig.slice(0, 20)}...`);

  // Verify nullifier created
  const nullifierInfo = await connection.getAccountInfo(nullifierPDA0);
  if (!nullifierInfo || nullifierInfo.data[0] !== 0x03) {
    throw new Error("Nullifier PDA not created");
  }
  log("Nullifier PDA created");

  // Verify RedemptionRequest PDA 1
  const redemption1Info = await connection.getAccountInfo(redemptionPDA1);
  if (!redemption1Info || redemption1Info.data[0] !== 0x04) {
    throw new Error("RedemptionRequest PDA 1 not created");
  }
  log(`RedemptionRequest PDA 1 created: ${redemptionPDA1.toBase58().slice(0, 16)}...`);

  // Verify RedemptionRequest PDA 2
  const redemption2Info = await connection.getAccountInfo(redemptionPDA2);
  if (!redemption2Info || redemption2Info.data[0] !== 0x04) {
    throw new Error("RedemptionRequest PDA 2 not created");
  }
  log(`RedemptionRequest PDA 2 created: ${redemptionPDA2.toBase58().slice(0, 16)}...`);

  // Verify pool state updated
  const poolAfter = await connection.getAccountInfo(poolState);
  const poolStateAfter = parsePoolState(Buffer.from(poolAfter!.data))!;
  const pendingAfter = poolStateAfter.pendingRedemptions;
  log(`Pending redemptions: ${pendingBefore} → ${pendingAfter} (expected +2)`);

  if (pendingAfter !== pendingBefore + 2n) {
    throw new Error(`Expected pending_redemptions to increase by 2, got ${pendingAfter - pendingBefore}`);
  }

  // Store nonces for potential future use
  // Note spent — btcNote1 consumed by multi-output redeem

  log("Step 8c complete — 2 RedemptionRequest PDAs created");
}

main().catch((err) => {
  console.error("Step 8c FAILED:", err);
  process.exit(1);
});
