# Privacy Coin - Private Bitcoin on Solana

**Trustless BTC bridge with full transaction privacy using Zero-Knowledge Proofs**

Privacy Coin lets Bitcoin holders access Solana DeFi without sacrificing privacy. Deposit BTC, receive shielded commitments, and transact — amounts and identities stay hidden.

```
BTC Deposit → Taproot Address → SPV Verify → On-Chain Commitment → ZK Transfers → Withdraw BTC
        │          │                              │
        │   OP_RETURN (64B):              Poseidon(npk, token, amount)
        │   ephemeralPub + npk            computed on-chain from npk
        │                                         │
        └─── Send any BTC amount ──►  Shielded Pool (Merkle Tree)
                                                  │
                              ┌───────────────────┴────────────────────┐
                              │                                        │
                    Amounts hidden in commitments        Unlinkable stealth addresses
                    Nullifier-based double-spend         .btcpro.sol human-readable names
```

---

## The Problem

Bitcoin's transparent blockchain makes privacy challenging:
- Every transaction is publicly visible and linkable
- Cross-chain bridges expose user activity on both chains
- DeFi participation requires revealing transaction history

**Privacy Coin solves this** by creating a privacy layer between Bitcoin and Solana using zero-knowledge proofs.

---

## Tech Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| **ZK Circuits** | circom + Groth16 (BN254) | Parameterized JoinSplit(N,M) circuits, client-side proving |
| **On-Chain Verifier** | BN254 alt_bn128 pairing syscalls | Inline Groth16 proof verification (~95k CU) |
| **Smart Contracts** | Pinocchio (Solana) | Zero-copy state, CU-optimized with LTO |
| **Bitcoin Integration** | Taproot + SPV light client | Permissionless deposit verification |
| **Stealth Addresses** | Baby Jubjub + Ed25519 ECDH | Unlinkable one-time addresses (EIP-5564/DKSAP) |
| **Name Service** | .btcpro.sol (SNS subdomains) | Human-readable stealth addresses |
| **Data Publishing** | ChadBuffer | Large data upload on-chain |
| **Client SDK** | TypeScript | Full privacy toolkit |
| **Frontend** | Next.js | Web interface |
| **Backend** | Rust (Axum) + FROST | API server + threshold BTC signing |

---

## Key Innovations

### 1. JoinSplit(N,M) ZK Circuits

Single parameterized circuit for all private operations — no trusted backend:

| Variant | Purpose |
|---------|---------|
| `joinsplit_1x2` | Deposit claim (1 input → 2 outputs) |
| `joinsplit_2x2` | Standard private transfer |
| `joinsplit_NxM` | General case (N+M ≤ 14, 91 total variants) |

**Commitment Model:**
```
MPK        = Poseidon(spendingPub.x, spendingPub.y, nullifyingKey)
NPK        = Poseidon(MPK, random)
Commitment = Poseidon(NPK, token, amount)
Nullifier  = Poseidon(nullifyingKey, leafIndex)
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
- **Spending Key** (Baby Jubjub): Sign JoinSplit transactions (EdDSA-Poseidon)

### 3. Three-Key Model

```
Spending Key (Baby Jubjub) ─► Signs JoinSplit transactions (EdDSA-Poseidon)
       │
       ├─► Nullifying Key (BN254 scalar) ─► Generates nullifiers, prevents double-spend
       │
       └─► Viewing Key (Ed25519) ─► Scans stealth announcements, decrypts amounts
```

Share viewing key with accountants or compliance without risk of fund loss.

### 4. .btcpro.sol Name Registry

Human-readable stealth addresses via SNS subdomains:

```typescript
// Send privately to alice.btcpro.sol
const meta = await resolveStealthName(connection, 'alice');
await sendPrivate(config, myNote, meta.stealthMetaAddress);
```

---

## Project Structure

```
privacy-coin/
├── contracts/                  # Solana programs (Pinocchio)
│   ├── programs/aegis/        # Main program (14 instructions)
│   └── programs/btc-light-client/ # Bitcoin header tracking (standalone)
├── circuits/                   # Zero-knowledge circuits (circom)
│   ├── circom/joinsplit.circom # Parameterized JoinSplit(N,M,16) template
│   └── circom/lib/             # Shared (commitment, nullifier, merkle, mpk)
├── sdk/                        # TypeScript client SDK
├── aegis-app/                 # Next.js web interface
├── backend/                    # Rust API + deposit tracker + redemption
├── frost_server/               # FROST threshold signing (BTC redemption)
└── docs/                       # Technical docs + operational guide
```

---

## Getting Started

### Prerequisites

- Bun (package manager)
- Rust + Solana CLI (for contracts)
- circom (for circuits)

### Quick Start (Localnet)

```bash
# 1. Deploy everything to local validator
bun run scripts/e2e/run-all.ts

# 2. Sync env files
./scripts/sync-env.sh

# 3. Start backend API (terminal 1)
cd backend && cargo run --bin zkbtc-api -- api

# 4. Start backend tracker (terminal 2)
cd backend && cargo run --bin zkbtc-api -- tracker

# 5. Start frontend (terminal 3)
cd aegis-app && bun run dev
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

## Privacy Guarantees

| Operation | Amount Visible | Linkable |
|-----------|---------------|----------|
| Deposit BTC | On Bitcoin chain | No (to claim) |
| Claim (JoinSplit 1→2) | No | No |
| Transfer (JoinSplit N→M) | No | No |
| Stealth Send | No | Recipient only |
| Withdraw BTC | On Bitcoin chain | No (to deposit) |

---

## Cryptography

| Component | Technology |
|-----------|------------|
| Proof System | Groth16 (BN254 curve) |
| Hash Function | Poseidon (ZK-friendly) |
| Commitment | `Poseidon(NPK, token, amount)` |
| Nullifier | `Poseidon(nullifyingKey, leafIndex)` |
| Stealth | Baby Jubjub + Ed25519 ECDH (EIP-5564) |
| BTC Deposits | Taproot (BIP-341) |
| BTC Redemption | FROST 2-of-3 threshold signing (secp256k1-tr) |
| Merkle Tree | Depth 16 (65,536 leaves) |
| Token | zkBTC (Token-2022) |

---

## Security Notice

> **This is hackathon software.** Not audited for production use.

- Testnet/Devnet only
- Full security audit required before production

---

## License

MIT
