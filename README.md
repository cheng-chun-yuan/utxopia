# zVault - Privacy-Preserving BTC on Solana

**Private Bitcoin on Solana using Zero-Knowledge Proofs**

zVault is a trustless bridge that enables Bitcoin holders to access Solana DeFi with full transaction privacy. Deposit BTC, receive shielded zkBTC, and transact without revealing amounts or linking identities.

```
BTC Deposit → Taproot Address → SPV Verify → Shielded Pool → ZK Transfers → Withdraw BTC
                                                   │
                              ┌────────────────────┴─────────────────────┐
                              │                                          │
                    Amounts hidden in commitments          Unlinkable stealth addresses
                    Nullifier-based double-spend prevention   .zkey.sol human-readable names
```

---

## The Problem

Bitcoin's transparent blockchain makes privacy challenging:
- Every transaction is publicly visible and linkable
- Cross-chain bridges expose user activity on both chains
- DeFi participation requires revealing transaction history

**zVault solves this** by creating a privacy layer between Bitcoin and Solana using zero-knowledge proofs.

---

## Tech Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| **ZK Circuits** | circom + Groth16 (BN254) | 6 specialized privacy circuits, client-side proving |
| **On-Chain Verifier** | BN254 alt_bn128 pairing syscalls | Inline Groth16 proof verification (~95k CU) |
| **Smart Contracts** | Pinocchio (Solana) | Zero-copy state, CU-optimized with LTO |
| **Bitcoin Integration** | Taproot + SPV light client | Permissionless deposit verification |
| **Stealth Addresses** | Baby Jubjub + Ed25519 ECDH | Unlinkable one-time addresses (EIP-5564/DKSAP) |
| **Name Service** | .zkey.sol (SNS-style) | Human-readable stealth addresses |
| **Data Publishing** | ChadBuffer | Large data upload on-chain |
| **Client SDK** | @zvault/sdk (TypeScript) | Full privacy toolkit with React hooks |
| **Frontend** | Next.js | Web interface |
| **Backend** | Rust (Axum) + FROST | API server + threshold BTC signing |

---

## Key Innovations

### 1. Groth16 ZK Circuits (6 Circuits)

Client-side proof generation via circom/snarkjs — no trusted backend:

| Circuit | Purpose |
|---------|---------|
| `claim` | Mint zkBTC from BTC deposit |
| `spend_split` | Split 1 note into 2 notes |
| `spend_partial_public` | Partial public withdrawal + change |
| `pool_deposit` | Enter yield pool |
| `pool_withdraw` | Exit pool with yield |
| `pool_claim_yield` | Compound yield rewards |

**Unified Commitment Model:**
```
Commitment = Poseidon(pub_key_x, amount)
Nullifier  = Poseidon(priv_key, leaf_index)
```

### 2. Stealth Address Protocol (EIP-5564/DKSAP)

Unlinkable one-time addresses using Baby Jubjub spending keys + Ed25519 viewing keys:

```
Sender:                              Recipient:
┌────────────────────┐               ┌────────────────────┐
│ 1. ephemeral_priv  │               │ 1. viewing_priv    │
│ 2. ECDH(eph, view) │───shared───►  │ 2. ECDH(view, eph) │
│ 3. derive stealth  │   secret      │ 3. derive stealth  │
│ 4. encrypt amount  │               │ 4. decrypt amount  │
│ 5. publish announce│               │ 5. spend with priv │
└────────────────────┘               └────────────────────┘
```

- **Viewing Key** (Ed25519): Detect and decrypt incoming transfers (cannot spend)
- **Spending Key** (Baby Jubjub): Generate nullifier and claim funds

### 3. Key Separation

```
Spending Key (private) ─► Can spend funds, must keep secret
       │
       └─► Viewing Key (derived) ─► Can view balances/history, safe to share
```

Share viewing key with accountants, regulators, or compliance without risk of fund loss.

### 4. .zkey Name Registry

Human-readable stealth addresses:

```typescript
// Send to alice.zkey.sol
const entry = await lookupZkeyName(connection, 'alice');
await sendPrivate(config, myNote, entry.stealthMetaAddress);
```

---

## Project Structure

```
zVault/
├── contracts/                  # Solana programs (Pinocchio)
│   ├── programs/zvault/        # Main zVault program
│   └── programs/btc-light-client/  # Bitcoin header tracking
├── circuits/                   # Zero-knowledge circuits (circom)
│   ├── circom/claim.circom
│   ├── circom/spend_split.circom
│   ├── circom/spend_partial_public.circom
│   ├── circom/pool_*.circom
│   └── circom/lib/             # Shared (commitment, nullifier, merkle)
├── sdk/                        # @zvault/sdk TypeScript client
├── zvault-app/                 # Next.js web interface
├── backend/                    # Rust API + redemption service
│   └── header-relayer/         # Bitcoin header sync
└── frost_server/               # FROST threshold signing (BTC redemption)
```

---

## Getting Started

### Prerequisites

- Bun (package manager)
- Rust + Solana CLI (for contracts)
- circom (for circuits)

### Frontend

```bash
cd zvault-app
bun install
bun run dev
```

### SDK

```bash
cd sdk
bun install
bun run build
bun test
```

### Contracts

```bash
cd contracts
cargo build-sbf --features devnet
```

### Circuits

```bash
cd circuits
bun install
bash scripts/compile.sh
bash scripts/setup.sh
```

---

## Program IDs (Devnet)

| Program | Address |
|---------|---------|
| zVault | `GqdjVMBDmFEd6wSV4TzRsvnVWnE4pMMdhVo8U4iXvYUX` |
| BTC Light Client | `S6rgPjCeBhkYBejWyDR1zzU3sYCMob36LAf8tjwj8pn` |
| ChadBuffer | `C5RpjtTMFXKVZCtXSzKXD4CDNTaWBg3dVeMfYvjZYHDF` |

---

## Privacy Guarantees

| Operation | Amount Visible | Linkable |
|-----------|---------------|----------|
| Deposit BTC | On Bitcoin chain | No (to claim) |
| Claim zkBTC | No | No |
| Split | No | No |
| Stealth Send | No | Recipient only |
| Withdraw BTC | On Bitcoin chain | No (to deposit) |

---

## Cryptography

| Component | Technology |
|-----------|------------|
| Proof System | Groth16 (BN254 curve) |
| Hash Function | Poseidon (ZK-friendly) |
| Commitment | `Poseidon(pub_key_x, amount)` |
| Nullifier | `Poseidon(priv_key, leaf_index)` |
| Stealth | Baby Jubjub + Ed25519 ECDH (EIP-5564) |
| BTC Deposits | Taproot (BIP-341) |
| Merkle Tree | Depth 20 (~1M leaves) |
| Token | zkBTC (Token-2022) |

---

## Security Notice

> **This is hackathon software.** Not audited for production use.

- Testnet/Devnet only
- Full security audit required before production

---

## License

MIT
