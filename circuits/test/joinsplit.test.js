/**
 * JoinSplit Circuit Tests — Tier 1 Variants
 *
 * Tests the 4 core circuit configurations:
 *   joinsplit_1x1, joinsplit_1x2, joinsplit_2x1, joinsplit_2x2
 *
 * Validates:
 *   - Valid proof generation (well-formed inputs)
 *   - Amount conservation (sum(in) !== sum(out) → fails)
 *   - Merkle root mismatch → fails
 *   - Nullifier mismatch → fails
 */

const { wasm: wasmTester } = require("circom_tester");
const { buildPoseidon, buildEddsa } = require("circomlibjs");
const path = require("path");
const { expect } = require("chai");

const TREE_DEPTH = 16;
const ZKBTC_TOKEN_ID = 0x7a627463; // "zkbtc" as u32

let poseidon;
let eddsa;
let F; // finite field

// Helper: convert Poseidon output to field element
function poseidonHash(inputs) {
  return F.toObject(poseidon(inputs));
}

// Helper: build a simple Merkle tree from leaves and return { root, pathElements, pathIndices }
function buildMerkleTree(leaves, treeDepth) {
  const tree = new Array(treeDepth + 1);
  const paddedSize = 1 << treeDepth;

  // Initialize leaf layer
  tree[0] = new Array(paddedSize);
  for (let i = 0; i < paddedSize; i++) {
    tree[0][i] = i < leaves.length ? leaves[i] : 0n;
  }

  // Build tree bottom-up
  for (let d = 1; d <= treeDepth; d++) {
    const prevLen = tree[d - 1].length;
    tree[d] = new Array(prevLen / 2);
    for (let i = 0; i < prevLen / 2; i++) {
      tree[d][i] = poseidonHash([tree[d - 1][2 * i], tree[d - 1][2 * i + 1]]);
    }
  }

  return tree;
}

function getMerkleProof(tree, index, treeDepth) {
  const pathElements = [];
  const pathIndices = [];

  let currentIndex = index;
  for (let d = 0; d < treeDepth; d++) {
    const siblingIndex = currentIndex % 2 === 0 ? currentIndex + 1 : currentIndex - 1;
    pathElements.push(tree[d][siblingIndex]);
    pathIndices.push(currentIndex % 2);
    currentIndex = Math.floor(currentIndex / 2);
  }

  return { pathElements, pathIndices };
}

// Helper: generate a valid note (commitment, npk, random)
function createNote(spendingPub, nullifyingKey, token, amount, random) {
  const mpk = poseidonHash([spendingPub[0], spendingPub[1], nullifyingKey]);
  const npk = poseidonHash([mpk, random]);
  const commitment = poseidonHash([npk, token, amount]);
  return { commitment, npk, random, amount };
}

// Helper: compute nullifier
function computeNullifier(nullifyingKey, leafIndex) {
  return poseidonHash([nullifyingKey, leafIndex]);
}

// Helper: sign a message with EdDSA-Poseidon
function signMessage(privateKey, msg) {
  const signature = eddsa.signPoseidon(privateKey, F.e(msg));
  return {
    R8x: F.toObject(signature.R8[0]),
    R8y: F.toObject(signature.R8[1]),
    S: signature.S,
  };
}

// Helper: generate test inputs for a JoinSplit(N,M) circuit
function generateValidInputs(nInputs, nOutputs, privateKey) {
  const pubKey = eddsa.prv2pub(privateKey);
  const spendingPub = [F.toObject(pubKey[0]), F.toObject(pubKey[1])];
  const nullifyingKey = poseidonHash([BigInt("0xdeadbeef")]);
  const token = BigInt(ZKBTC_TOKEN_ID);

  // Create input notes
  const totalAmount = BigInt(nInputs * 10000);
  const amountPerInput = 10000n;
  const inputNotes = [];

  for (let i = 0; i < nInputs; i++) {
    const random = poseidonHash([BigInt(i + 1), BigInt(42)]);
    inputNotes.push(createNote(spendingPub, nullifyingKey, token, amountPerInput, random));
  }

  // Build Merkle tree with input commitments
  const leaves = inputNotes.map((n) => n.commitment);
  const tree = buildMerkleTree(leaves, TREE_DEPTH);
  const merkleRoot = tree[TREE_DEPTH][0];

  // Create output notes (split evenly)
  const amountPerOutput = totalAmount / BigInt(nOutputs);
  const remainder = totalAmount - amountPerOutput * BigInt(nOutputs);
  const outputNotes = [];
  for (let i = 0; i < nOutputs; i++) {
    const outRandom = poseidonHash([BigInt(100 + i)]);
    const mpk = poseidonHash([spendingPub[0], spendingPub[1], nullifyingKey]);
    const outNpk = poseidonHash([mpk, outRandom]);
    const outAmount = i === 0 ? amountPerOutput + remainder : amountPerOutput;
    outputNotes.push({
      npk: outNpk,
      amount: outAmount,
      commitment: poseidonHash([outNpk, token, outAmount]),
    });
  }

  // Compute nullifiers
  const nullifiers = inputNotes.map((_, i) => computeNullifier(nullifyingKey, BigInt(i)));

  // Build message hash
  const boundParamsHash = poseidonHash([1n, 2n, 3n]); // dummy
  const msgInputs = [merkleRoot, boundParamsHash, ...nullifiers, ...outputNotes.map((n) => n.commitment)];
  const msgHash = poseidonHash(msgInputs);

  // Sign
  const sig = signMessage(privateKey, msgHash);

  // Get Merkle proofs for each input
  const pathElements = [];
  const pathIndices = [];
  for (let i = 0; i < nInputs; i++) {
    const proof = getMerkleProof(tree, i, TREE_DEPTH);
    pathElements.push(proof.pathElements.map(String));
    pathIndices.push(proof.pathIndices);
  }

  return {
    merkleRoot: String(merkleRoot),
    boundParamsHash: String(boundParamsHash),
    nullifiers: nullifiers.map(String),
    commitmentsOut: outputNotes.map((n) => String(n.commitment)),
    token: String(token),
    publicKey: spendingPub.map(String),
    signature: [String(sig.R8x), String(sig.R8y), String(sig.S)],
    nullifyingKey: String(nullifyingKey),
    randomIn: inputNotes.map((n) => String(n.random)),
    valueIn: inputNotes.map((n) => String(n.amount)),
    pathElements,
    pathIndices,
    leavesIndices: inputNotes.map((_, i) => String(i)),
    npkOut: outputNotes.map((n) => String(n.npk)),
    valueOut: outputNotes.map((n) => String(n.amount)),
  };
}

describe("JoinSplit Circuits — Tier 1", function () {
  this.timeout(120000);

  const privateKey = Buffer.alloc(32);
  privateKey[0] = 1; // deterministic test key

  before(async function () {
    poseidon = await buildPoseidon();
    eddsa = await buildEddsa();
    F = poseidon.F;
  });

  const tier1Variants = [
    { name: "joinsplit_1x1", nInputs: 1, nOutputs: 1 },
    { name: "joinsplit_1x2", nInputs: 1, nOutputs: 2 },
    { name: "joinsplit_2x1", nInputs: 2, nOutputs: 1 },
    { name: "joinsplit_2x2", nInputs: 2, nOutputs: 2 },
  ];

  for (const { name, nInputs, nOutputs } of tier1Variants) {
    describe(name, function () {
      let circuit;

      before(async function () {
        const circuitPath = path.join(__dirname, "..", "circom", "generated", `${name}.circom`);
        circuit = await wasmTester(circuitPath, {
          include: [path.join(__dirname, "..", "node_modules")],
        });
      });

      it("should generate a valid witness with correct inputs", async function () {
        const inputs = generateValidInputs(nInputs, nOutputs, privateKey);
        const witness = await circuit.calculateWitness(inputs);
        await circuit.checkConstraints(witness);
      });

      it("should reject when amount conservation is violated", async function () {
        const inputs = generateValidInputs(nInputs, nOutputs, privateKey);
        // Corrupt the first output value to break conservation
        const firstOutputAmount = BigInt(inputs.valueOut[0]);
        inputs.valueOut[0] = String(firstOutputAmount + 1n);
        // Also recompute the output commitment for the corrupted amount
        // (otherwise commitment check fails first)
        // We leave the commitment unchanged so the circuit catches the amount mismatch
        try {
          await circuit.calculateWitness(inputs);
          expect.fail("should have thrown");
        } catch (err) {
          expect(err.message).to.include("Error");
        }
      });

      it("should reject when nullifier is incorrect", async function () {
        const inputs = generateValidInputs(nInputs, nOutputs, privateKey);
        // Corrupt the first nullifier
        inputs.nullifiers[0] = "12345678";
        try {
          await circuit.calculateWitness(inputs);
          expect.fail("should have thrown");
        } catch (err) {
          expect(err.message).to.include("Error");
        }
      });

      it("should reject when merkle root is wrong", async function () {
        const inputs = generateValidInputs(nInputs, nOutputs, privateKey);
        // Corrupt the merkle root
        inputs.merkleRoot = "99999999";
        try {
          await circuit.calculateWitness(inputs);
          expect.fail("should have thrown");
        } catch (err) {
          expect(err.message).to.include("Error");
        }
      });
    });
  }
});
