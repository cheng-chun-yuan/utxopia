# JoinSplit ZK Circuits

Parameterized Groth16 circuits for private N-to-M asset transfers using circom.

---

## Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                    JoinSplit(N, M, 16) Template                       │
│                                                                       │
│  N Inputs (spent notes)              M Outputs (new notes)           │
│  ┌─────────────────────┐            ┌──────────────────────┐        │
│  │ Input 0             │            │ Output 0              │        │
│  │ ├ NPK = P(MPK,rand) │   MPK = Master Public Key, NPK = Note Public Key            │ ├ Commitment =        │        │
│  │ ├ Commitment ∈ Tree │            │ │   P(npk,token,val)  │        │
│  │ ├ Nullifier = P(nk,i)│           │ ├ Range: val < 2^120  │        │
│  │ └ Merkle proof ✓    │            │ └ npk is fresh        │        │
│  ├─────────────────────┤            ├──────────────────────┤        │
│  │ Input 1             │            │ Output 1              │        │
│  │ └ ...               │            │ └ ...                 │        │
│  └─────────────────────┘            └──────────────────────┘        │
│                                                                       │
│  Constraints:                                                         │
│  ✓ sum(valueIn) == sum(valueOut)       (amount conservation)         │
│  ✓ EdDSA-Poseidon signature            (spending authorization)      │
│  ✓ MPK = P(pkX, pkY, nullifyingKey)   (key binding)                 │
│  ✓ All inputs in Merkle tree           (existence proof)             │
│  ✓ Nullifiers correctly computed       (double-spend prevention)     │
│                                                                       │
│  Public Signals: merkleRoot, boundParamsHash, nullifiers[], commits[] │
│  Proof Size: 256 bytes (2 G1 + 1 G2 on BN254)                       │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Circuit Template

### `JoinSplit(nInputs, nOutputs, treeDepth)`

Single parameterized template generating all circuit variants.

| Parameter | Value | Description |
|-----------|-------|-------------|
| `nInputs` | 1-13 | Number of input notes to spend |
| `nOutputs` | 1-13 | Number of output notes to create |
| `treeDepth` | 16 | Merkle tree depth (65,536 leaves max) |
| **Constraint** | `N + M <= 14` | Due to Poseidon arity limit (message hash = 2 + N + M <= 16) |

### Public Signals

| Signal | Type | Description |
|--------|------|-------------|
| `merkleRoot` | Field | Current commitment tree root |
| `boundParamsHash` | Field | Replay-protection binding (tree number, chain ID, unshield address) |
| `nullifiers[N]` | Field[] | One nullifier per input (published on-chain, prevents double-spend) |
| `commitmentsOut[M]` | Field[] | One commitment per output (inserted into Merkle tree) |

### Private Signals

| Signal | Type | Description |
|--------|------|-------------|
| `token` | Field | Token identifier (`ZKBTC_TOKEN_ID = 0x7a627463`) |
| `publicKey[2]` | [x, y] | Baby Jubjub spending public key |
| `signature[3]` | [R8x, R8y, S] | EdDSA-Poseidon signature |
| `nullifyingKey` | Field | BN254 scalar for nullifier generation |
| `randomIn[N]` | Field[] | Blinding factor per input |
| `valueIn[N]` | Field[] | Amount per input (satoshis) |
| `pathElements[N][16]` | Field[][] | Merkle proof siblings per input |
| `pathIndices[N][16]` | int[][] | Merkle proof directions (0=left, 1=right) |
| `leavesIndices[N]` | Field[] | Leaf position per input (0 to 65,535) |
| `npkOut[M]` | Field[] | Note public key per output |
| `valueOut[M]` | Field[] | Amount per output |

---

## Verification Logic (6 Stages)

```
┌──────────────────────────────────────────────────────────────────┐
│  Stage 1: Compute Master Public Key                               │
│  MPK = Poseidon(publicKey.x, publicKey.y, nullifyingKey)         │
│  → Binds spending key to nullifying key (prevents key separation) │
└──────────────────────────────────┬───────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  Stage 2: Process Each Input (i = 0..N-1)                         │
│                                                                    │
│  NPK[i] = Poseidon(MPK, randomIn[i])                             │
│  commitment[i] = Poseidon(NPK[i], token, valueIn[i])             │
│  ✓ Merkle proof: commitment[i] in tree at leavesIndices[i]       │
│  ✓ Computed root matches public merkleRoot                        │
│  nullifier[i] = Poseidon(nullifyingKey, leavesIndices[i])        │
│  ✓ Computed nullifier matches public nullifiers[i]                │
│  sumIn += valueIn[i]                                              │
└──────────────────────────────────┬───────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  Stage 3: Process Each Output (j = 0..M-1)                        │
│                                                                    │
│  expected = Poseidon(npkOut[j], token, valueOut[j])               │
│  ✓ expected matches public commitmentsOut[j]                      │
│  ✓ Range check: valueOut[j] fits in 120 bits                     │
│  sumOut += valueOut[j]                                            │
└──────────────────────────────────┬───────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  Stage 4: Amount Conservation                                     │
│  ✓ sumIn === sumOut                                               │
└──────────────────────────────────┬───────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  Stage 5: Message Hash                                            │
│  msgHash = Poseidon(merkleRoot, boundParamsHash,                 │
│                     nullifiers[0..N-1], commitmentsOut[0..M-1])  │
│  (arity = 2 + N + M, must be <= 16)                              │
└──────────────────────────────────┬───────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  Stage 6: Signature Verification                                  │
│  ✓ EdDSA-Poseidon(publicKey, signature, msgHash)                 │
│  → Proves prover holds the Baby Jubjub spending key              │
└──────────────────────────────────────────────────────────────────┘
```

---

## Circuit Libraries

### `lib/joinsplit_commitment.circom`

Computes commitment hash:

```
Commitment = Poseidon(npk, token, amount)
```

| Input | Description |
|-------|-------------|
| `npk` | Note public key (Poseidon(MPK, random)) |
| `token` | Token identifier (0x7a627463 for zkBTC) |
| `amount` | Amount in satoshis |
| **Output** | `commitment` (BN254 field element) |

### `lib/joinsplit_nullifier.circom`

Computes nullifier for double-spend prevention:

```
Nullifier = Poseidon(nullifyingKey, leafIndex)
```

| Input | Description |
|-------|-------------|
| `nullifyingKey` | BN254 scalar from 3-key model |
| `leafIndex` | Position in Merkle tree (0 to 65,535) |
| **Output** | `nullifier` (published on-chain) |

### `lib/mpk.circom`

Computes Master Public Key binding spending and nullifying keys:

```
MPK = Poseidon(pkX, pkY, nullifyingKey)
```

Prevents key separation attacks — ensures the prover can't use a different nullifying key with the same spending key.

### `lib/merkle.circom`

Merkle proof verification (depth 16):

```
For each level i (0 to 15):
  ✓ path_indices[i] is binary (0 or 1)
  if path_indices[i] == 0: hash = Poseidon(current, sibling)
  if path_indices[i] == 1: hash = Poseidon(sibling, current)

Output: computed root (compared against public merkleRoot)
```

---

## Variant System

### Tier Structure

| Tier | Variants | Count | Use Case |
|------|----------|-------|----------|
| **Tier 1** | 1x1, 1x2, 2x1, 2x2 | 4 | Core operations (deposit claim, transfer) |
| **Tier 2** | + 1x3, 3x1, 2x3, 3x2, 1x4, 4x1 | 10 | Extended fan-in/fan-out |
| **All** | All N+M <= 14 | 91 | Full coverage |

### Common Use Cases

```
joinsplit_1x2  ─── Deposit claim (1 commitment → 2 output notes)
                   User proves ownership of deposit, creates primary + change notes

joinsplit_2x2  ─── Standard transfer (2 inputs → 2 outputs)
                   Private send to recipient with change back to sender

joinsplit_2x1  ─── Consolidation / withdrawal (2 inputs → 1 output)
                   Merge notes or prepare for BTC redemption

joinsplit_1x1  ─── Simple re-randomize (1 input → 1 output)
                   Refresh commitment without changing amount
```

### Poseidon Arity Constraint

The message hash arity = `2 + N + M` must fit within Poseidon's 16-input limit:

| Config | Arity | Feasible |
|--------|-------|----------|
| 1x1 | 4 | Yes |
| 2x2 | 6 | Yes |
| 7x7 | 16 | Yes (maximum balanced) |
| 13x1 | 16 | Yes (maximum asymmetric) |
| 8x7 | 17 | **No** (exceeds limit) |

### Generating Variants

```bash
# Generate variant circom files
node scripts/generate-variants.js --tier1   # 4 variants
node scripts/generate-variants.js --tier2   # 10 variants
node scripts/generate-variants.js --all     # 91 variants

# Each generates: circuits/circom/generated/joinsplit_NxM.circom
```

Generated file content (example `joinsplit_2x2.circom`):
```circom
pragma circom 2.1.0;
include "../joinsplit.circom";
component main {public [merkleRoot, boundParamsHash, nullifiers, commitmentsOut]}
  = JoinSplit(2, 2, 16);
```

---

## Build Pipeline

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ generate-    │────▶│ compile.sh   │────▶│ setup.sh     │────▶│ export-vk-   │
│ variants.js  │     │              │     │              │     │ rust.js      │
│              │     │ circom →     │     │ Powers of Tau │     │              │
│ Creates      │     │ R1CS + WASM  │     │ + Phase 2    │     │ VK → Rust    │
│ .circom files│     │ + SYM        │     │ → .zkey      │     │ constants    │
└──────────────┘     └──────────────┘     │ → .vkey.json │     └──────────────┘
                                           └──────────────┘
```

### Step 1: Compile Circuits

```bash
cd circuits
bun install

# Compile tier-1 variants (default)
bash scripts/compile.sh

# Compile with more variants
bash scripts/compile.sh --tier2   # 10 variants
bash scripts/compile.sh --all     # All 91 variants
```

**Output per circuit:**
```
build/joinsplit_2x2/
  ├── joinsplit_2x2.r1cs          # Constraint system (binary)
  ├── joinsplit_2x2.sym           # Symbol table (debug)
  └── joinsplit_2x2_js/
      ├── joinsplit_2x2.wasm      # Witness generator (WebAssembly)
      ├── generate_witness.js     # Witness generation driver
      └── witness_calculator.js   # WASM FFI
```

### Step 2: Trusted Setup (Groth16)

```bash
bash scripts/setup.sh
```

**Phase 1** (shared): Powers of Tau ceremony (`2^18` max constraints, BN128 curve)

**Phase 2** (per circuit): Circuit-specific zkey generation + entropy contribution

**Output per circuit:**
```
build/joinsplit_2x2/
  ├── joinsplit_2x2.zkey          # Proving key (~1-2 MB)
  └── joinsplit_2x2.vkey.json     # Verification key (public)
```

### Step 3: Export VK for Solana

```bash
# Export verification key as Rust constants for Pinocchio program
node scripts/export-vk-rust.js joinsplit_2x2
```

Generates Rust code with `ALPHA_G1`, `BETA_G2`, `GAMMA_G2`, `DELTA_G2`, and `IC` points for on-chain Groth16 verification.

---

## Proof Generation (Client-Side)

Proofs are generated in the browser/app via snarkjs WASM:

```typescript
import { generateJoinSplitProof } from '@privacy-coin/sdk';

const proof = await generateJoinSplitProof({
  nInputs: 2, nOutputs: 2,
  merkleRoot, boundParamsHash, token,
  publicKey: [spendPubX, spendPubY],
  signature: [r8x, r8y, s],
  nullifyingKey,
  inputs: [
    { random, value, leafIndex, merkleProof: { siblings, indices } },
    { random, value, leafIndex, merkleProof: { siblings, indices } },
  ],
  outputs: [
    { npk: recipientNPK, value: 50_000n },
    { npk: changeNPK, value: 50_000n },
  ],
});
// proof.proof = 256 bytes (2 G1 + 1 G2 on BN254)
```

> **Note**: snarkjs hangs in bun's WASM runtime. The SDK uses a Node.js subprocess fallback for proof generation.

---

## On-Chain Verification

Proofs are verified inline on Solana using `alt_bn128` pairing syscalls:

| Operation | Compute Units |
|-----------|---------------|
| Groth16 Proof Verification | ~85,000 CU |
| Merkle Tree Update | ~5,000 CU |
| State Updates | ~5,000 CU |
| **Total** | **~95,000 CU** |

---

## On-Chain Groth16 Verification

### Verification Equation

The Privacy Coin program verifies Groth16 proofs on-chain using Solana's native BN254 syscalls:

```
e(-A, B) × e(α, β) × e(vk_x, γ) × e(C, δ) == 1
```

Where `vk_x = IC[0] + Σ(public_input[i] × IC[i+1])`.

### Verification Steps

```
1. Parse proof → A (G1, 64B), B (G2, 128B), C (G1, 64B)    = 256 bytes total
2. Negate A → -A = (x, p - y) using BN254 field modulus
3. Compute vk_x = IC[0] + Σ(input[i] × IC[i+1])
   └─ Uses alt_bn128_multiplication + alt_bn128_addition syscalls
4. Build pairing input: 4 pairs × 192 bytes = 768 bytes
   └─ (-A,B), (α,β), (vk_x,γ), (C,δ)
5. Call alt_bn128_pairing → 32-byte result (0x...01 = valid)
```

### Shared VK Components

All JoinSplit circuits share the same trusted setup ceremony. Only `DELTA_G2` and `IC` differ per variant.

| Component | Type | Size | Shared? |
|-----------|------|------|---------|
| `ALPHA_G1` | G1 point | 64 bytes | Yes (all circuits) |
| `BETA_G2` | G2 point | 128 bytes | Yes (all circuits) |
| `GAMMA_G2` | G2 point | 128 bytes | Yes (all circuits) |
| `DELTA_G2` | G2 point | 128 bytes | **Per-circuit** |
| `IC[]` | G1 points | 64 × (2+N+M) bytes | **Per-circuit** |

### VK Hash Registry

Each JoinSplit(N,M) variant has a `VkRegistry` PDA storing the SHA-256 hash of its full verification key. The `transact` instruction verifies the proof against the registered VK hash.

```
VK Registry PDA seed: ["vk_registry", n_inputs, n_outputs]
VK hash: SHA-256(alpha || beta || gamma || delta || IC[0] || ... || IC[k])
```

> Source: `contracts/programs/aegis/src/utils/groth16.rs`

---

## Source Files

| File | Purpose |
|------|---------|
| `circuits/circom/joinsplit.circom` | Main parameterized template |
| `circuits/circom/lib/joinsplit_commitment.circom` | Commitment hash |
| `circuits/circom/lib/joinsplit_nullifier.circom` | Nullifier hash |
| `circuits/circom/lib/merkle.circom` | Merkle proof verification |
| `circuits/circom/lib/mpk.circom` | Master public key computation |
| `circuits/scripts/generate-variants.js` | Variant file generation (91 total) |
| `circuits/scripts/compile.sh` | circom compilation to R1CS/WASM |
| `circuits/scripts/setup.sh` | Groth16 trusted setup |
| `circuits/scripts/export-vk-rust.js` | VK export for Solana program |

---

## Related Documentation

- [Technical Overview](./TECHNICAL.md) - Cryptography stack and commitment model
- [SDK Reference](../sdk/docs/SDK.md) - Client-side proof generation API
- [Documentation Index](./INDEX.md) - All docs hub
