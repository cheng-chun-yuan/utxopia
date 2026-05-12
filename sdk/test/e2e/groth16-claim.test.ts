/**
 * E2E Test: Groth16 Claim Circuit Proof Generation & Verification
 *
 * ⚠️  DEPRECATED: This test uses the legacy 'claim' circuit.
 * The current UTXOpia implementation uses JoinSplit circuits instead.
 *
 * This file is kept for reference only and tests will be skipped.
 *
 * Tests the full flow:
 * 1. Generate Poseidon-based circuit inputs
 * 2. Generate Groth16 proof via snarkjs (Node.js subprocess - bun has issues with snarkjs WASM)
 * 3. Verify proof serialization is correct (256 bytes)
 * 4. Verify proof matches Solidity calldata format
 * 5. Verify on-chain format compatibility
 */

import { describe, test, expect, beforeAll, setDefaultTimeout } from "bun:test";
import { initPoseidon, poseidonHashSync } from "../../src/poseidon";
import { babyJubMul, BABYJUB_BASE8 } from "../../src/crypto";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";

// Proof generation can take ~30s
setDefaultTimeout(120_000);

const CIRCUIT_BUILD_PATH = path.resolve(__dirname, "../../../circuits/build");
const SDK_DIR = path.resolve(__dirname, "../..");

/** Convert big-endian byte array to bigint */
function bytesToBigint(bytes: Uint8Array): bigint {
  let hex = "0x";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return BigInt(hex);
}

/** Write a bigint as big-endian bytes */
function writeBigIntBE(buf: Uint8Array, offset: number, value: bigint, length: number): void {
  for (let i = length - 1; i >= 0; i--) {
    buf[offset + i] = Number(value & 0xFFn);
    value >>= 8n;
  }
}

/** Serialize snarkjs proof to 256 bytes (Ethereum precompile format) */
function serializeProof(proof: any): Uint8Array {
  const bytes = new Uint8Array(256);
  const piA = proof.pi_a;
  const piB = proof.pi_b;
  const piC = proof.pi_c;

  // G1 A: [x_BE(32), y_BE(32)]
  writeBigIntBE(bytes, 0, BigInt(piA[0]), 32);
  writeBigIntBE(bytes, 32, BigInt(piA[1]), 32);

  // G2 B: [x_imag_BE(32), x_real_BE(32), y_imag_BE(32), y_real_BE(32)]
  writeBigIntBE(bytes, 64, BigInt(piB[0][1]), 32);   // x_imag (c1)
  writeBigIntBE(bytes, 96, BigInt(piB[0][0]), 32);    // x_real (c0)
  writeBigIntBE(bytes, 128, BigInt(piB[1][1]), 32);   // y_imag (c1)
  writeBigIntBE(bytes, 160, BigInt(piB[1][0]), 32);   // y_real (c0)

  // G1 C: [x_BE(32), y_BE(32)]
  writeBigIntBE(bytes, 192, BigInt(piC[0]), 32);
  writeBigIntBE(bytes, 224, BigInt(piC[1]), 32);

  return bytes;
}

describe.skip("Groth16 Claim E2E (DEPRECATED - uses legacy claim circuit)", () => {
  let proof: any;
  let publicSignals: string[];
  let merkleRoot: bigint;
  let nullifierHash: bigint;
  const amount = 100_000n;
  const recipient = 123456789012345678901234567890n;

  beforeAll(async () => {
    // Verify circuit artifacts exist
    const wasmPath = path.join(CIRCUIT_BUILD_PATH, "claim/claim_js/claim.wasm");
    const zkeyPath = path.join(CIRCUIT_BUILD_PATH, "claim/claim.zkey");

    if (!fs.existsSync(wasmPath) || !fs.existsSync(zkeyPath)) {
      throw new Error(
        "Circuit artifacts not found. Run: cd circuits && bash scripts/compile.sh && bash scripts/setup.sh"
      );
    }

    // Initialize Poseidon
    await initPoseidon();

    // Generate test values
    const privKey = 12345n;
    // Derive pubKeyX via Baby Jubjub (matches in-circuit BabyPbk derivation)
    const pubKeyX = babyJubMul(privKey, BABYJUB_BASE8).x;
    const leafIndex = 0n;
    const commitment = poseidonHashSync([pubKeyX, amount]);

    // Build single-leaf Merkle tree (20 levels)
    let current = commitment;
    const siblings: bigint[] = [];
    const indices: number[] = [];
    for (let i = 0; i < 20; i++) {
      siblings.push(0n);
      indices.push(0);
      current = poseidonHashSync([current, 0n]);
    }
    merkleRoot = current;

    const nullifier = poseidonHashSync([privKey, leafIndex]);
    nullifierHash = poseidonHashSync([nullifier]);

    // Generate proof via Node.js subprocess (bun has issues with snarkjs WASM)
    const inputJson = JSON.stringify({
      priv_key: privKey.toString(),
      amount: amount.toString(),
      leaf_index: leafIndex.toString(),
      merkle_path: siblings.map(s => s.toString()),
      path_indices: indices,
      merkle_root: merkleRoot.toString(),
      nullifier_hash: nullifierHash.toString(),
      amount_pub: amount.toString(),
      recipient: recipient.toString(),
    });

    // Write input, generate proof via node subprocess
    const tmpInput = path.join(CIRCUIT_BUILD_PATH, "claim/test_input.json");
    const tmpProof = path.join(CIRCUIT_BUILD_PATH, "claim/test_proof.json");
    const tmpPublic = path.join(CIRCUIT_BUILD_PATH, "claim/test_public.json");
    fs.writeFileSync(tmpInput, inputJson);

    console.log("[Test] Generating claim proof via snarkjs...");
    execSync(
      `node -e "
        const snarkjs = require('snarkjs');
        const fs = require('fs');
        (async () => {
          const input = JSON.parse(fs.readFileSync('${tmpInput}', 'utf8'));
          const { proof, publicSignals } = await snarkjs.groth16.fullProve(
            input,
            '${wasmPath}',
            '${zkeyPath}'
          );
          fs.writeFileSync('${tmpProof}', JSON.stringify(proof));
          fs.writeFileSync('${tmpPublic}', JSON.stringify(publicSignals));
          process.exit(0);
        })().catch(e => { console.error(e); process.exit(1); });
      "`,
      { cwd: SDK_DIR, timeout: 60000 }
    );

    proof = JSON.parse(fs.readFileSync(tmpProof, "utf8"));
    publicSignals = JSON.parse(fs.readFileSync(tmpPublic, "utf8"));

    // Cleanup temp files
    fs.unlinkSync(tmpInput);
    fs.unlinkSync(tmpProof);
    fs.unlinkSync(tmpPublic);

    console.log("[Test] Proof generated successfully");
  });

  test("proof generates with 4 public inputs", () => {
    expect(publicSignals.length).toBe(4);
    expect(BigInt(publicSignals[0])).toBe(merkleRoot);
    expect(BigInt(publicSignals[1])).toBe(nullifierHash);
    expect(BigInt(publicSignals[2])).toBe(amount);
    expect(BigInt(publicSignals[3])).toBe(recipient);
    console.log("[Test] Public inputs match expected values");
  });

  test("proof serialization is 256 bytes with valid field elements", () => {
    const serialized = serializeProof(proof);
    expect(serialized.length).toBe(256);

    // Not all zeros
    const allZeros = serialized.every(b => b === 0);
    expect(allZeros).toBe(false);

    // All G1 coordinates within BN254 field
    const BN254_P = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47n;
    expect(bytesToBigint(serialized.slice(0, 32)) < BN254_P).toBe(true);   // A.x
    expect(bytesToBigint(serialized.slice(32, 64)) < BN254_P).toBe(true);  // A.y
    expect(bytesToBigint(serialized.slice(192, 224)) < BN254_P).toBe(true); // C.x
    expect(bytesToBigint(serialized.slice(224, 256)) < BN254_P).toBe(true); // C.y

    console.log("[Test] Proof serialization valid (256 bytes, valid field elements)");
  });

  test("serialization matches snarkjs exportSolidityCallData", () => {
    // Generate calldata via node subprocess
    const tmpProof = path.join(CIRCUIT_BUILD_PATH, "claim/calldata_proof.json");
    const tmpPublic = path.join(CIRCUIT_BUILD_PATH, "claim/calldata_public.json");
    fs.writeFileSync(tmpProof, JSON.stringify(proof));
    fs.writeFileSync(tmpPublic, JSON.stringify(publicSignals));

    const calldataRaw = execSync(
      `node -e "
        const snarkjs = require('snarkjs');
        const fs = require('fs');
        (async () => {
          const proof = JSON.parse(fs.readFileSync('${tmpProof}', 'utf8'));
          const pub = JSON.parse(fs.readFileSync('${tmpPublic}', 'utf8'));
          const cd = await snarkjs.groth16.exportSolidityCallData(proof, pub);
          console.log(cd);
          process.exit(0);
        })().catch(e => { console.error(e); process.exit(1); });
      "`,
      { cwd: SDK_DIR, timeout: 30000, encoding: "utf-8" }
    ).trim();

    // Cleanup
    fs.unlinkSync(tmpProof);
    fs.unlinkSync(tmpPublic);

    // Parse hex values from calldata
    const hexValues = calldataRaw.match(/0x[0-9a-fA-F]+/g);
    expect(hexValues).not.toBeNull();
    expect(hexValues!.length).toBeGreaterThanOrEqual(8);

    // calldataRaw format: ["a0","a1"],[["b00","b01"],["b10","b11"]],["c0","c1"],["pi0","pi1","pi2","pi3"]
    // Solidity calldata B: [[x_imag, x_real], [y_imag, y_real]]
    const calldataA = [hexValues![0], hexValues![1]];
    const calldataB = [[hexValues![2], hexValues![3]], [hexValues![4], hexValues![5]]];
    const calldataC = [hexValues![6], hexValues![7]];

    const serialized = serializeProof(proof);

    // Verify G1 A
    expect(bytesToBigint(serialized.slice(0, 32))).toBe(BigInt(calldataA[0]));
    expect(bytesToBigint(serialized.slice(32, 64))).toBe(BigInt(calldataA[1]));

    // Verify G2 B: [x_imag, x_real, y_imag, y_real]
    expect(bytesToBigint(serialized.slice(64, 96))).toBe(BigInt(calldataB[0][0]));
    expect(bytesToBigint(serialized.slice(96, 128))).toBe(BigInt(calldataB[0][1]));
    expect(bytesToBigint(serialized.slice(128, 160))).toBe(BigInt(calldataB[1][0]));
    expect(bytesToBigint(serialized.slice(160, 192))).toBe(BigInt(calldataB[1][1]));

    // Verify G1 C
    expect(bytesToBigint(serialized.slice(192, 224))).toBe(BigInt(calldataC[0]));
    expect(bytesToBigint(serialized.slice(224, 256))).toBe(BigInt(calldataC[1]));

    console.log("[Test] Serialization matches Solidity calldata format");
  });

  test("snarkjs local verification succeeds", () => {
    const vkeyPath = path.join(CIRCUIT_BUILD_PATH, "claim/claim.vkey.json");
    const tmpProof = path.join(CIRCUIT_BUILD_PATH, "claim/verify_proof.json");
    const tmpPublic = path.join(CIRCUIT_BUILD_PATH, "claim/verify_public.json");
    fs.writeFileSync(tmpProof, JSON.stringify(proof));
    fs.writeFileSync(tmpPublic, JSON.stringify(publicSignals));

    const result = execSync(
      `node -e "
        const snarkjs = require('snarkjs');
        const fs = require('fs');
        (async () => {
          const vkey = JSON.parse(fs.readFileSync('${vkeyPath}', 'utf8'));
          const proof = JSON.parse(fs.readFileSync('${tmpProof}', 'utf8'));
          const pub = JSON.parse(fs.readFileSync('${tmpPublic}', 'utf8'));
          const valid = await snarkjs.groth16.verify(vkey, pub, proof);
          console.log(valid ? 'VALID' : 'INVALID');
          process.exit(0);
        })().catch(e => { console.error(e); process.exit(1); });
      "`,
      { cwd: SDK_DIR, timeout: 30000, encoding: "utf-8" }
    ).trim();

    // Cleanup
    fs.unlinkSync(tmpProof);
    fs.unlinkSync(tmpPublic);

    expect(result).toBe("VALID");
    console.log("[Test] snarkjs local verification: OK");
  });
});
