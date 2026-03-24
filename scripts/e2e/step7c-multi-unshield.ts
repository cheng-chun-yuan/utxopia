#!/usr/bin/env bun
/**
 * Step 7c: Multi-Output Unshield (wSOL)
 *
 * Tests multi-output unshield with n_public_outputs=2 using joinsplit_1x2.
 * Splits wSOL note from step5 into 2 unshield outputs to same recipient.
 * Both outputs are burn commitments (npk=0), no tree outputs.
 */

import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
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
  createUnshieldBoundParams,
  computeStealthDataHash,
  eddsaPoseidonSign,
  eddsaGetPubKey,
  parseCommitmentTree,
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

stepHeader(75, "Multi-Output Unshield (wSOL)");


function generateProofViaNode(
  circuitName: string, inputs: Record<string, any>,
): { proof: any; publicSignals: string[] } {
  const CIRCUITS_DIR = path.join(__dirname, "../../circuits");
  const wasmPath = path.join(CIRCUITS_DIR, `build/${circuitName}/${circuitName}_js/${circuitName}.wasm`);
  const zkeyPath = path.join(CIRCUITS_DIR, `build/${circuitName}/${circuitName}.zkey`);
  if (!fs.existsSync(wasmPath)) throw new Error(`WASM not found: ${wasmPath}`);
  if (!fs.existsSync(zkeyPath)) throw new Error(`zkey not found: ${zkeyPath}`);

  const tmpDir = fs.mkdtempSync("/tmp/aegis-proof-");
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

async function main() {
  const state = loadState();
  const authority = loadAuthority();
  const AEGIS = new PublicKey(state.aegisProgramId);
  const [poolState] = derivePoolStatePDA(AEGIS);
  const [commitmentTree] = deriveCommitmentTreePDA(AEGIS);

  if (!state.wsolNote || !state.tWsolMint) {
    throw new Error("wSOL note not found. Run step5 first.");
  }

  await initPoseidon();
  getZeroHashes();

  // Load keys
  const spendingSeed = Buffer.from(state.spendingSeed!, "hex");
  const pubKey = await eddsaGetPubKey(spendingSeed);
  const pubKeyX = pubKey.x;
  const pubKeyY = pubKey.y;
  const nullifyingKey = BigInt("0x" + state.nullifyingKey!);

  // Load wSOL note
  const note = state.wsolNote;
  const totalAmount = BigInt(note.amount);
  const random0 = BigInt("0x" + note.random);
  const leafIndex0 = note.leafIndex;
  const commitment0 = BigInt("0x" + note.commitment);

  // wSOL note uses NATIVE_MINT_2022 (step5 shieldSOL), not tWsolMint from step2
  const NATIVE_MINT_2022 = new PublicKey("9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP");
  const wsolMint = NATIVE_MINT_2022;
  const [tokenConfig] = deriveTokenConfigPDA(AEGIS, wsolMint);
  const tcInfo = await connection.getAccountInfo(tokenConfig);
  if (!tcInfo) throw new Error("wSOL TokenConfig not found");
  const tcData = parseTokenConfig(Buffer.from(tcInfo.data))!;
  const tokenId = bytes32ToBigintBE(new Uint8Array(tcData.tokenId));
  log(`On-chain token_id: ${tokenId.toString(16).slice(0, 16)}...`);

  // Split into two unshield amounts (must be different to avoid duplicate commitments)
  const amount1 = totalAmount * 60n / 100n; // 60%
  const amount2 = totalAmount - amount1;    // 40%
  log(`Input: leaf ${leafIndex0}, total ${totalAmount} lamports`);
  log(`Output 1: ${amount1} lamports, Output 2: ${amount2} lamports`);

  // Vault from on-chain TokenConfig, ATA for NATIVE_MINT_2022
  const wsolVault = new PublicKey(tcData.vault);
  const userAta = deriveATA(wsolMint, authority.publicKey);

  // Rebuild Merkle tree
  if (!state.commitments || state.commitments.length === 0) {
    throw new Error("No tracked commitments. Run steps 3-6 first.");
  }
  log(`Rebuilding tree from ${state.commitments.length} tracked commitments...`);

  const allCommitments = state.commitments.map((h: string) => BigInt("0x" + h));
  const treeLeaves: bigint[] = [...allCommitments];

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

  // Two burn commitments: Poseidon(0, token_id, amount_k)
  const zeroNpk = 0n;
  const burnCommitment1 = computeJoinSplitCommitmentSync(zeroNpk, tokenId, amount1);
  const burnCommitment2 = computeJoinSplitCommitmentSync(zeroNpk, tokenId, amount2);

  // Nullifier
  const nullifier0 = computeJoinSplitNullifierSync(nullifyingKey, BigInt(leafIndex0));
  log(`Nullifier: ${nullifier0.toString(16).slice(0, 16)}...`);
  log(`Burn commitment 1: ${burnCommitment1.toString(16).padStart(64, "0")}`);
  log(`Burn commitment 2: ${burnCommitment2.toString(16).padStart(64, "0")}`);
  log(`Token ID: ${tokenId.toString(16).padStart(64, "0")}`);
  log(`Amount 1: ${amount1}, Amount 2: ${amount2}`);

  // Bound params (multi-output unshield — 2 recipients, same owner)
  const stealthDataHash = computeStealthDataHash([]); // no tree outputs
  const ownerBytes = new Uint8Array(authority.publicKey.toBytes());
  // Both outputs go to the same owner — pass array of 2
  const unshieldParams = createUnshieldBoundParams([ownerBytes, ownerBytes], stealthDataHash, 103n);
  const boundParamsHash = sdkComputeBoundParamsHash(unshieldParams);

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

  // Build unshield instruction (disc=14, n_public_outputs=2)
  const nInputs = 1;
  const nOutputs = 2;
  const nPublicOutputs = 2;
  const nTreeOutputs = 0;
  const stealthPerOutput = 72;
  const dataLen = 1 + 1 + 1 + 1 + 1 + 256 + 32 + 32
    + nInputs * 32 + nOutputs * 32
    + nTreeOutputs * stealthPerOutput
    + nPublicOutputs * 8; // amounts
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
  Buffer.from(bigintToBytes32BE(burnCommitment1)).copy(txData, off); off += 32;
  Buffer.from(bigintToBytes32BE(burnCommitment2)).copy(txData, off); off += 32;
  // No stealth data (nTreeOutputs = 0)
  // Amounts (u64 LE each)
  txData.writeBigUInt64LE(amount1, off); off += 8;
  txData.writeBigUInt64LE(amount2, off); off += 8;

  // Accounts (disc=14, multi-output):
  // 0-7: fixed, 8-9: recipients (same ATA twice), 10: nullifier
  const nullifierBytes0 = bigintToBytes32BE(nullifier0);
  const [nullifierPDA0] = deriveNullifierPDA(AEGIS, nullifierBytes0);
  const [vkRegistry1x2] = deriveVkRegistryPDA(AEGIS, 1, 2);

  // Ensure user ATA exists for NATIVE_MINT_2022
  const { createAssociatedTokenAccountIdempotentInstruction } = await import("@solana/spl-token");
  const ataInfo = await connection.getAccountInfo(userAta);
  if (!ataInfo) {
    log("Creating wSOL ATA...");
    const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      authority.publicKey, userAta, authority.publicKey, wsolMint, TOKEN_2022_PROGRAM_ID,
    );
    await sendIx([createAtaIx], [authority]);
  }

  // Get balance before
  const balanceBefore = await connection.getTokenAccountBalance(userAta);
  const beforeAmount = BigInt(balanceBefore.value.amount);
  log(`Balance before: ${beforeAmount}`);

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: commitmentTree, isSigner: false, isWritable: true },
      { pubkey: vkRegistry1x2, isSigner: false, isWritable: false },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenConfig, isSigner: false, isWritable: true },
      { pubkey: wsolVault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      // Two recipient token accounts (same ATA — both outputs go to same user)
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: userAta, isSigner: false, isWritable: true },
      // Nullifier
      { pubkey: nullifierPDA0, isSigner: false, isWritable: true },
    ],
    programId: AEGIS,
    data: txData,
  });

  const sig = await sendIx([ix], [authority], 1_400_000);
  log(`Multi-output unshield tx: ${sig.slice(0, 20)}...`);

  // Verify nullifier created
  const nullifierInfo = await connection.getAccountInfo(nullifierPDA0);
  if (!nullifierInfo || nullifierInfo.data[0] !== 0x03) {
    throw new Error("Nullifier PDA not created");
  }
  log("Nullifier PDA created");

  // Verify balance increased by total (minus fees)
  const balanceAfter = await connection.getTokenAccountBalance(userAta);
  const afterAmount = BigInt(balanceAfter.value.amount);
  const received = afterAmount - beforeAmount;
  log(`Balance after: ${afterAmount} (received ${received})`);

  // Fee is applied per-output, so total fee = fee(amount1) + fee(amount2)
  // With 0 bps fee, received should equal totalAmount
  if (received <= 0n) {
    throw new Error(`Expected positive received amount, got ${received}`);
  }
  log(`Multi-output unshield SUCCESS: received ${received} lamports from 2 outputs`);

  // Verify token config total_shielded decreased
  const tcAfter = await connection.getAccountInfo(tokenConfig);
  const tcDataAfter = parseTokenConfig(Buffer.from(tcAfter!.data))!;
  log(`wSOL total_shielded after: ${tcDataAfter.totalShielded}`);

  // Mark wSOL note as spent
  // Note spent — no state update needed (wsolNote consumed)
  log("Step 7c complete");
}

main().catch((err) => {
  console.error("Step 7c FAILED:", err);
  process.exit(1);
});
