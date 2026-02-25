# zVault Technical Documentation

**Privacy-Preserving BTC on Solana with Zero-Knowledge Proofs**

---

## Overview

zVault is a trustless bridge enabling Bitcoin holders to access Solana with full transaction privacy.

```
BTC Deposit ─► Taproot Address ─► SPV Verify ─► Shielded Pool ─► ZK Transfers ─► Withdraw BTC
                                                      │
                   ┌──────────────────────────────────┴──────────────────────────────────┐
                   │                                                                      │
         Amounts hidden in commitments                            Unlinkable stealth addresses
         Nullifier-based double-spend prevention                  .zkey.sol human-readable names
```

### Key Innovations

| Innovation | What It Does | Why It Matters |
|------------|--------------|----------------|
| **JoinSplit(N,M) Proofs** | Unified N-input M-output transfers (Groth16) | One circuit for all operations |
| **3-Key Model** | Spending (BJJ) + Nullifying + Viewing (Ed25519) | Railgun-aligned key hierarchy |
| **EdDSA-Poseidon Signatures** | In-circuit signature verification | Authorization without revealing keys |
| **Full SPV Bridge** | Bitcoin light client on Solana | Trustless BTC verification |
| **Stealth Addresses** | EIP-5564/DKSAP protocol | Unlinkable one-time addresses |
| **ChadBuffer** | On-chain large data storage | BTC SPV data exceeding Solana limits |
| **.zkey Names** | SNS-style name registry | Human-readable stealth addresses |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                            BITCOIN LAYER                                         │
│   User Wallet ──► Taproot Address ──► Bitcoin Network ──► Block Confirmation    │
│        │              │                                         │               │
│        │     (OP_RETURN: ephemeralPub                      (1+ confirms)        │
│        │      + npk, 64 bytes)                                  │               │
│        │              │                                         ▼               │
│        │              └──────────────────────────► Header Relayer Service       │
└────────│────────────────────────────────────────────────────────│───────────────┘
         │                                                        │
         │ claim link                                     headers │
         │                                                        │
┌────────▼────────────────────────────────────────────────────────▼───────────────┐
│                            SOLANA LAYER                                          │
│   ┌────────────────────────────────────────────────────────────────────────┐    │
│   │                    BTC Light Client Program                             │    │
│   │         Header Chain │ Difficulty Adjustment │ Block Validation        │    │
│   └────────────────────────────────────────────────────────────────────────┘    │
│                                        │                                        │
│                               SPV proof │                                       │
│                                        ▼                                        │
│   ┌────────────────────────────────────────────────────────────────────────┐    │
│   │                    zVault Program (Pinocchio)                          │    │
│   │   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌───────────┐│    │
│   │   │ Commitment   │  │  Nullifier   │  │   Deposit    │  │   Name    ││    │
│   │   │    Tree      │  │  Registry    │  │   Records    │  │ Registry  ││    │
│   │   │ (depth 16)   │  │(double-spend)│  │(npk+stealth) │  │ (.zkey)   ││    │
│   │   └──────────────┘  └──────────────┘  └──────────────┘  └───────────┘│    │
│   └────────────────────────────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────────────────────────-┘
                                         │
                               ZK proofs │
                                         │
┌────────────────────────────────────────▼────────────────────────────────────────┐
│                            CLIENT LAYER                                          │
│   ┌──────────────────────────────────────────────────────────────────────────┐  │
│   │                         @zvault/sdk                                       │  │
│   │   Note Management │ Proof Generation │ Stealth ECDH │ Taproot Derivation │  │
│   └──────────────────────────────────────────────────────────────────────────┘  │
│              ┌─────────────────────────┼─────────────────────────┐              │
│        ┌─────▼─────┐            ┌──────▼──────┐           ┌──────▼──────┐       │
│        │  Frontend │            │   Backend   │           │   FROST     │       │
│        │ (Next.js) │            │   (Rust)    │           │   Server    │       │
│        └───────────┘            └─────────────┘           └─────────────┘       │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility |
|-----------|---------------|
| **BTC Light Client** | Maintains Bitcoin header chain, validates SPV proofs |
| **zVault Program** | Manages commitments, nullifiers, deposit records (npk-based), names |
| **Header Relayer** | Syncs Bitcoin headers to Solana (permissionless) |
| **SDK** | Client-side proof generation, key derivation, transaction building |
| **FROST Server** | BTC redemption signing (2-of-3 threshold) |

---

## Bitcoin Integration

### SPV Light Client

Bitcoin light client on Solana for trustless deposit verification:

```
Header Chain State:
├── latest_height: u32
├── latest_hash: [u8; 32]
├── chain_work: [u8; 32]
└── retarget_epoch: u32

SPV Verification:
1. Transaction in block at height H
2. Merkle proof: tx_hash → merkle_root
3. Block header with merkle_root at height H
4. Header chain connects to verified tip (6+ confirmations)
```

### Taproot Deposit Addresses (BIP-341)

Each deposit gets a unique Taproot address derived from the commitment:

```typescript
const commitment = computeCommitment(pubKeyX, amount);
const tweak = taggedHash('TapTweak', internalPubKey, commitment);
const outputPubKey = tweakPublicKey(internalPubKey, tweak);
const address = bech32m.encode('tb', [1, ...outputPubKey]);
```

### FROST Threshold Signing

For BTC withdrawals, 2-of-3 multi-party signing:
- Decentralized custody (no single point of failure)
- Backend coordinates signing rounds
- secp256k1-tr (Taproot-compatible)

---

## Groth16 ZK Circuits

### Design

- **Client-side proving**: User generates proofs in browser via snarkjs WASM
- **No trusted backend**: Zero centralized components for proof generation
- **Groth16**: ~256 byte proofs (2 G1 + 1 G2 on BN254), fits inline in Solana transactions

### JoinSplit Circuit (Railgun-Aligned)

Single parameterized `JoinSplit(N, M, 16)` template. N inputs + M outputs, Merkle depth 16.

| Variant | Purpose |
|---------|---------|
| `joinsplit_1x2` | Deposit claim (1 input → 2 outputs) |
| `joinsplit_2x2` | Standard private transfer |
| `joinsplit_NxM` | General case (N+M <= 14, 91 total variants) |

**Public signals**: `merkleRoot`, `boundParamsHash`, `nullifiers[N]`, `commitmentsOut[M]`

### Commitment & Nullifier Model

```
MPK = Poseidon(spendingPub.x, spendingPub.y, nullifyingKey)
NPK = Poseidon(MPK, random)
Commitment = Poseidon(NPK, token, amount)
Nullifier = Poseidon(nullifyingKey, leafIndex)

Message hash = Poseidon(merkleRoot, boundParamsHash, nullifiers..., commitmentsOut...)
Signature = EdDSA-Poseidon(spendingKey, messageHash)
```

**In-circuit logic**:
1. Verify MPK matches spending public key + nullifying key
2. For each input: verify commitment in Merkle tree, verify nullifier
3. For each output: verify commitment = Poseidon(npk, token, amount) + range check (120-bit)
4. Verify sum(valueIn) == sum(valueOut)
5. Verify EdDSA-Poseidon signature over message hash

### On-Chain Verification

Proofs verified inline using Solana's `alt_bn128` pairing syscalls:

| Operation | Compute Units |
|-----------|---------------|
| Groth16 Proof Verification | ~85,000 CU |
| Merkle Update | ~5,000 CU |
| State Updates | ~5,000 CU |
| **Total (Claim)** | **~95,000 CU** |

CU optimizations applied:
- LTO (`lto = "fat"`) + single codegen unit
- Shared VK constants (ALPHA_G1, BETA_G2, GAMMA_G2) across circuits
- Const pubkey comparisons (no runtime `Pubkey::from()`)
- Merged account borrows (single mutable borrow per pool_state)

---

## Stealth Addresses (EIP-5564/DKSAP)

### Key Model

```
User Keys:
├── spending_priv (Baby Jubjub) ──► spending_pub (can spend funds)
└── viewing_priv  (Ed25519)     ──► viewing_pub  (can detect incoming)

Stealth Meta-Address (public, shareable):
[spending_pub(32) || viewing_pub(32) || mpk(32)] = 96 bytes
```

### Protocol Flow

```
SENDER                                          RECIPIENT

eph_priv (Ed25519) ─┐                          viewing_priv ─┐
                     │                                        │
                     ▼                                        │
               eph_pub ──────── On-Chain ──────► eph_pub     │
                     │          Announcement          │       │
                     ▼                                ▼       │
              X25519 ECDH ──► shared_secret ◄── X25519 ECDH ◄┘
                     │                                │
                     ▼                                ▼
           stealth_pub (BJJ) ──────────────► stealth_pub (BJJ)
                     │                                │
                     ▼                                ▼
            commitment ──── Merkle Tree ────► commitment
                                                      │ + spending_priv
                                                      ▼
                                                  ZK PROOF ──► CLAIM
```

### Non-Interactive Deposit Flow (npk-based)

Users deposit BTC with an OP_RETURN containing stealth data. The commitment is computed **on-chain** from the npk and the actual BTC amount received, so users can send any amount.

```
SENDER (Wallet)                                      SOLANA (On-Chain)

1. Generate ephemeral Ed25519 keypair
2. ECDH: shared_secret = X25519(eph_priv, recipient_viewing_pub)
3. Derive random = SHA256(shared_secret || "random")
4. Compute NPK = Poseidon(recipient_MPK, random)
5. Build 64-byte OP_RETURN:
   ┌──────────────────┬──────────────────┐
   │ ephemeral_pub    │ npk              │
   │ (32 bytes)       │ (32 bytes)       │
   └──────────────────┴──────────────────┘
6. Send BTC to Taproot address ─────────────────────►  Bitcoin Network
                                                              │
                                                    (confirmations)
                                                              │
                                                              ▼
                                                    Backend sweeps UTXO
                                                    with OP_RETURN intact
                                                              │
                                                              ▼
                                            ┌─────────────────────────────────┐
                                            │ verify_stealth_deposit (ix 1)   │
                                            │                                 │
                                            │ 1. Validate SPV proof           │
                                            │ 2. Extract amount from UTXO     │
                                            │ 3. Compute commitment ON-CHAIN: │
                                            │    Poseidon(npk, 0x7a627463,    │
                                            │            amount_sats)         │
                                            │ 4. Insert into Merkle tree      │
                                            │ 5. Create DepositRecord PDA     │
                                            └─────────────────────────────────┘

RECIPIENT (Viewing Key)

1. Scan DepositRecord PDAs
2. ECDH: shared_secret = X25519(viewing_priv, ephemeral_pub)
3. Derive random = SHA256(shared_secret || "random")
4. Compute expected_NPK = Poseidon(own_MPK, random)
5. If expected_NPK == record.npk → this deposit is mine
6. Amount is plaintext in record (no decryption needed)
```

**Key constant**: `ZBTC_TOKEN_ID = 0x7a627463` ("zbtc" as u32, used in commitment computation)

### On-Chain DepositRecord (200 bytes)

Each verified deposit creates a `DepositRecord` PDA on Solana:

```
Offset   Field              Size    Description
──────   ──────             ────    ────────────
0        discriminator       1      Account type (0x02)
1        minted              1      Whether deposit has been claimed
2-7      _padding            6      Reserved
8-39     commitment         32      Poseidon(npk, token, amount) — computed on-chain
40-47    amount_sats         8      BTC amount (u64 LE)
48-79    btc_txid           32      Bitcoin transaction hash
80-87    block_height        8      Bitcoin block height (u64 LE)
88-95    leaf_index          8      Position in commitment Merkle tree (u64 LE)
96-127   depositor          32      Solana pubkey of verifier
128-135  timestamp           8      Unix timestamp (i64 LE)
136-167  ephemeral_pub      32      Ed25519 ephemeral public key (for scanning)
168-199  npk                32      Note public key (for commitment verification)
```

### Key Properties

| Role | What They Know | What They Can Do |
|------|----------------|------------------|
| **Sender** | Shared secret, recipient pubkeys | Send unlinkable funds |
| **Recipient (Viewing Key)** | Incoming transfers, amounts | Detect payments, cannot spend |
| **Recipient (Spending Key)** | Everything + nullifier secret | Claim funds |
| **Observer** | Encrypted data, unlinkable points | Nothing useful |

---

## Program Instructions

| Disc | Name | Purpose |
|------|------|---------|
| 0 | `INITIALIZE` | Initialize pool state and commitment tree |
| 1 | `VERIFY_STEALTH_DEPOSIT` | Verify BTC via SPV, compute commitment on-chain, create DepositRecord |
| 5 | `REQUEST_REDEMPTION` | Burn zkBTC, request BTC withdrawal |
| 6 | `COMPLETE_REDEMPTION` | Relayer marks redemption complete |
| 7 | `SET_PAUSED` | Admin pause/unpause |
| 8 | `REGISTER_NAME` | Register .zkey name |
| 9 | `UPDATE_NAME` | Update .zkey name data |
| 10 | `TRANSFER_NAME` | Transfer .zkey name ownership |
| 11 | `INIT_VK_REGISTRY` | Initialize VK hash registry for JoinSplit(N,M) |
| 12 | `UPDATE_VK_REGISTRY` | Update VK hash (circuit upgrades) |
| 13 | `ADD_DEMO_STEALTH` | Demo deposit (devnet only, disabled on mainnet) |
| 14 | `TRANSACT` | JoinSplit N-to-M private transfer (Groth16) |

---

## Cryptography Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| **Proof System** | Groth16 (BN254) via circom/snarkjs | ZK proof generation/verification |
| **Hash Function** | Poseidon | ZK-friendly hashing |
| **Commitment** | `Poseidon(npk, token, amount)` | Binding amounts to keys |
| **Nullifier** | `Poseidon(nullifyingKey, leafIndex)` | Double-spend prevention |
| **Signature** | EdDSA-Poseidon | In-circuit authorization |
| **Spending Keys** | Baby Jubjub (BN254 embedded curve) | In-circuit key derivation |
| **Viewing Keys** | Ed25519 / X25519 | ECDH for stealth scanning |
| **Amount Encryption** | XOR with SHA-256 derived key | Lightweight, deterministic |
| **BTC Deposits** | Taproot (BIP-341) | Commitment-bound addresses |
| **BTC Redemption** | FROST (secp256k1-tr) | 2-of-3 threshold signing |
| **Merkle Tree** | Depth 16 (65,536 leaves) | Commitment storage |
| **Token** | zkBTC (Token-2022) | Shielded token standard |
| **Viewing Key Encryption** | AES-GCM + PBKDF2 (150k iterations) | Delegated viewing keys |

---

## Security Model

### Threat Mitigations

| Threat | Mitigation |
|--------|------------|
| Double-spend | Nullifier registry (on-chain PDA per nullifier) |
| Fake deposits | SPV proof with 6+ confirmations |
| Link deposit to claim | ZK proof hides commitment preimage |
| Link sender to receiver | Stealth addresses (ECDH) |
| Front-running claims | Bearer instrument model |
| Malicious relayer | Permissionless header submission |
| Account spoofing | Owner validation before all deserialization |
| System program spoofing | System program key validated on every instruction |

### Trust Assumptions

| Component | Trust Level |
|-----------|-------------|
| BTC Network | 51% honest hashpower |
| Solana Network | 67% honest validators |
| ZK Circuits | Sound proof system (Groth16) |
| Baby Jubjub ECDH | ECDLP hardness |
| Poseidon | Collision resistance |

---

## Program IDs (Devnet)

| Program | Address |
|---------|---------|
| zVault | `2dBmKyfLibkqdxgyEWUhHos3g56oU2wXLVrucY2dCpGV` |
| BTC Light Client | `DeDut4fkjbWBPY4FRUU3q9BUcvwTisHczj1EQmqX5avS` |
| ChadBuffer | `6VrJmWbhN9WbEkg87JizunVMpL6CHKGVmzWCf3o3LRgy` |

> **Note**: Program IDs change on each deployment. The canonical source is `contracts/config.json` (deploy scripts) and `sdk/src/config.ts` (SDK).

---

## On-Chain Error Codes

Custom error codes start at 6000 to avoid conflicts with Solana system errors.

### Core Errors (6000–6020)

| Code | Name | Description |
|------|------|-------------|
| 6000 | `PoolPaused` | Pool is paused by admin |
| 6001 | `AmountTooSmall` | Deposit amount below minimum |
| 6002 | `AmountTooLarge` | Deposit amount above maximum |
| 6003 | `InvalidMerkleProof` | Merkle proof verification failed |
| 6004 | `NullifierAlreadyUsed` | Double-spend attempt detected |
| 6005 | `CommitmentNotFound` | Commitment not in Merkle tree |
| 6006 | `InvalidCommitment` | Commitment hash is malformed |
| 6007 | `InvalidBtcAddress` | Bitcoin address format invalid |
| 6008 | `RedemptionNotFound` | Redemption request PDA not found |
| 6009 | `RedemptionAlreadyCompleted` | Redemption already processed |
| 6010 | `InvalidRedemptionState` | Redemption in wrong state for operation |
| 6011 | `Unauthorized` | Signer not authorized |
| 6012 | `InsufficientBalance` | Not enough balance |
| 6013 | `Overflow` | Arithmetic overflow |
| 6014 | `InvalidProofLength` | ZK proof bytes wrong length |
| 6015 | `AlreadyMinted` | Deposit already claimed |
| 6016 | `ZeroAmount` | Amount must be > 0 |
| 6017 | `InvalidBlockHeader` | BTC block header invalid |
| 6018 | `InsufficientConfirmations` | Not enough BTC confirmations |
| 6019 | `InvalidSpvProof` | SPV proof verification failed |
| 6020 | `TreeFull` | Commitment tree at capacity (65,536) |

### ZK & Account Errors (6021–6030)

| Code | Name | Description |
|------|------|-------------|
| 6021 | `InvalidRoot` | Merkle root not in history |
| 6022 | `InvalidZkProof` | Groth16 proof malformed |
| 6023 | `ZkVerificationFailed` | Groth16 pairing check failed |
| 6024 | `NotInitialized` | Account not initialized |
| 6025 | `AlreadyInitialized` | Account already initialized |
| 6026 | `InvalidAccountOwner` | Wrong account owner |
| 6027 | `InvalidAccountData` | Account data parse failure |
| 6028 | `InvalidStealthOpReturn` | OP_RETURN stealth data invalid |
| 6029 | `StealthDataNotFound` | No stealth data in transaction |
| 6030 | `InsufficientFunds` | Shielded pool underfunded |

### Security Errors (6060–6066)

| Code | Name | Description |
|------|------|-------------|
| 6060 | `AccountNotWritable` | Required writable account is read-only |
| 6061 | `InvalidMint` | Wrong token mint |
| 6062 | `DemoDisabledOnMainnet` | Demo instructions rejected on mainnet |
| 6063 | `NotRentExempt` | Account not rent-exempt |
| 6064 | `DuplicateAccounts` | Same account passed twice |
| 6065 | `AccountClosed` | Account has been closed |
| 6066 | `InvalidVkRegistry` | VK registry doesn't match circuit variant |

> Source: `contracts/programs/zvault/src/error.rs`

---

## On-Chain Account Layouts

### CommitmentTree (3824 bytes)

Incremental Merkle tree using Poseidon hashing. Discriminator: `0x05`. PDA seed: `"commitment_tree"`.

```
Offset  Size   Field
──────  ─────  ─────────────────────────────────────
0       1      discriminator (0x05)
1       1      bump
2       6      padding (alignment)
8       32     current_root
40      8      next_index (u64 LE, leaf count)
48      512    frontier (16 × 32 bytes, rightmost filled nodes)
560     3200   root_history (100 × 32 bytes, circular buffer)
3760    4      root_history_index (u32 LE)
3764    60     reserved
──────  ─────  ─────────────────────────────────────
Total: 3824 bytes
```

| Property | Value |
|----------|-------|
| Depth | 16 (65,536 max leaves) |
| Hash function | Poseidon2 (BN254 scalar field) |
| Root history | 100 entries (front-running protection) |
| Zero hash | Pre-computed per level, matching circomlib |

### VkRegistry (256 bytes)

Stores Groth16 VK hashes for JoinSplit(N,M) variants. Discriminator: `0x14`. PDA seed: `"vk_registry"`.

```
Offset  Size   Field
──────  ─────  ─────────────────────────────
0       1      discriminator (0x14)
1       1      padding
2       1      n_inputs (JoinSplit N)
3       1      n_outputs (JoinSplit M)
4       32     authority (update key)
36      32     vk_hash (Groth16 VK hash)
68      188    reserved
──────  ─────  ─────────────────────────────
Total: 256 bytes
```

Public inputs per variant: `2 + N + M` (merkleRoot + boundParamsHash + N nullifiers + M commitments).

> Source: `contracts/programs/zvault/src/state/commitment_tree.rs`, `vk_registry.rs`

---

## Related Documentation

- [Documentation Index](./INDEX.md) - All docs hub
- [SDK Reference](../sdk/docs/SDK.md) - TypeScript SDK guide
- [FROST Server](./FROST.md) - Threshold signing documentation
- [Circuits](./CIRCUITS.md) - JoinSplit ZK circuit design
- [How to Run](./RUNNING.md) - Operational guide for all services
- [Main README](../README.md) - Project overview
