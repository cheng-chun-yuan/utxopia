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
| **6 circom ZK Circuits** | Client-side proof generation (Groth16) | No trusted backend, compact proofs |
| **Baby Jubjub + Ed25519** | Spending keys + viewing keys | Efficient in-circuit + fast ECDH |
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
│        │         (commitment                              (6+ confirms)         │
│        │          in script)                                    │               │
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
│   │   │ Commitment   │  │  Nullifier   │  │   Stealth    │  │   Name    ││    │
│   │   │    Tree      │  │  Registry    │  │ Announcements│  │ Registry  ││    │
│   │   │ (depth 20)   │  │(double-spend)│  │ (BJJ+Ed25519)│  │ (.zkey)   ││    │
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
| **zVault Program** | Manages commitments, nullifiers, stealth announcements, names |
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

### 6 Circuits

| Circuit | Purpose | Key Constraints |
|---------|---------|-----------------|
| `claim` | Mint zkBTC from deposit | Merkle proof, nullifier, amount match |
| `spend_split` | Split 1 note into 2 notes | Amount conservation, unique recipients |
| `spend_partial_public` | Partial withdrawal + change | Public + change outputs |
| `pool_deposit` | Enter yield pool | Unified → Pool commitment |
| `pool_withdraw` | Exit with yield | Yield calculation in-circuit |
| `pool_claim_yield` | Compound yields | Re-stake with epoch reset |

### Unified Commitment Model

```circom
// Commitment = Poseidon(pub_key_x, amount)
template Commitment() {
    signal input pub_key_x;
    signal input amount;
    signal output commitment;
    component hasher = Poseidon(2);
    hasher.inputs[0] <== pub_key_x;
    hasher.inputs[1] <== amount;
    commitment <== hasher.out;
}

// Nullifier = Poseidon(Poseidon(priv_key, leaf_index))
template Nullifier() {
    signal input priv_key;
    signal input leaf_index;
    signal output nullifier_hash;
    component h1 = Poseidon(2);
    h1.inputs[0] <== priv_key;
    h1.inputs[1] <== leaf_index;
    component h2 = Poseidon(1);
    h2.inputs[0] <== h1.out;
    nullifier_hash <== h2.out;
}
```

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
[spending_pub_x(32) || viewing_pub(32)] = 64 bytes
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

### On-Chain Announcement (90 bytes)

```
├── discriminator:     1 byte
├── type:              1 byte
├── ephemeral_pub:    32 bytes (Ed25519 public key)
├── encrypted_amount:  8 bytes (XOR-encrypted with derived key)
├── commitment:       32 bytes (Poseidon hash)
├── leaf_index:        8 bytes (u64 LE)
└── created_at:        8 bytes (i64 LE timestamp)
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
| 0 | `INITIALIZE` | Initialize pool state |
| 4 | `SPLIT_COMMITMENT` | Split 1 note into 2 notes (Groth16) |
| 5 | `REQUEST_REDEMPTION` | Burn zkBTC, request BTC withdrawal |
| 8 | `VERIFY_DEPOSIT` | Record BTC deposit (SPV verified) |
| 9 | `CLAIM` | Mint zkBTC with Groth16 proof |
| 10 | `SPEND_PARTIAL_PUBLIC` | Partial public spend + change (Groth16) |
| 12 | `ANNOUNCE_STEALTH` | Stealth transfer announcement |
| 17 | `REGISTER_NAME` | Register .zkey name |

---

## Cryptography Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| **Proof System** | Groth16 (BN254) via circom/snarkjs | ZK proof generation/verification |
| **Hash Function** | Poseidon | ZK-friendly hashing |
| **Commitment** | `Poseidon(pub_key_x, amount)` | Binding amounts to keys |
| **Nullifier** | `Poseidon(Poseidon(priv_key, leaf_index))` | Double-spend prevention |
| **Spending Keys** | Baby Jubjub (BN254 embedded curve) | In-circuit key derivation |
| **Viewing Keys** | Ed25519 / X25519 | ECDH for stealth scanning |
| **Amount Encryption** | XOR with SHA-256 derived key | Lightweight, deterministic |
| **BTC Deposits** | Taproot (BIP-341) | Commitment-bound addresses |
| **BTC Redemption** | FROST (secp256k1-tr) | 2-of-3 threshold signing |
| **Merkle Tree** | Depth 20 (~1M leaves) | Commitment storage |
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
| zVault | `GqdjVMBDmFEd6wSV4TzRsvnVWnE4pMMdhVo8U4iXvYUX` |
| BTC Light Client | `S6rgPjCeBhkYBejWyDR1zzU3sYCMob36LAf8tjwj8pn` |
| ChadBuffer | `C5RpjtTMFXKVZCtXSzKXD4CDNTaWBg3dVeMfYvjZYHDF` |

---

## Related Documentation

- [SDK Reference](./SDK.md) - TypeScript SDK guide
- [Main README](../README.md) - Project overview
