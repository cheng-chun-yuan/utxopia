# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Aegis is a privacy-preserving Bitcoin-to-Solana bridge using Zero-Knowledge Proofs. Users deposit BTC, which becomes shielded commitments in a Merkle tree. All transfers use JoinSplit(N,M) proofs — no public tokens ever exist. Amount is revealed only at BTC withdrawal.

**Key Technologies**: Pinocchio (Solana), circom circuits (Groth16 JoinSplit proofs), Taproot (BTC deposits), Baby Jubjub + Ed25519 (stealth addresses), FROST (threshold signing)

## Commands

### Frontend (Next.js) - `/aegis-app`
```bash
bun run dev          # Start dev server (port 3000)
bun run build        # Production build (builds SDK first)
bun run lint         # ESLint
bun run test         # Vitest tests
```

### SDK - `/sdk`
```bash
bun run build        # Compile TypeScript
bun test             # Run tests
bun run e2e          # End-to-end tests (localnet)
bun run e2e:devnet   # E2E tests on devnet
```

### Contracts (Pinocchio) - `/contracts`
```bash
cargo build-sbf --features devnet   # Build programs for SBF
cargo test                           # Run tests
bun run test                         # TypeScript tests
```

### FROST Server - `/frost_server`
```bash
cargo run --bin frost-server       # Start FROST signing server
cargo run --bin generate_deposit_address  # Generate Taproot address
cargo run --bin spend_utxo         # Spend UTXO with threshold sig
cargo run --bin mock_sweep_e2e     # Mock sweep E2E test
cargo test                         # Run tests
```

### Backend (Rust) - `/backend`
```bash
cargo run                # Start API server
cargo test               # Run tests
```

### circom Circuits - `/circuits`
```bash
bun install                          # Install dependencies
bash scripts/compile.sh              # Compile tier-1 JoinSplit circuits (1x1, 1x2, 2x1, 2x2)
bash scripts/compile.sh --tier2      # + tier-2 variants (10 total)
bash scripts/compile.sh --all        # All 91 JoinSplit(N,M) variants
bash scripts/setup.sh                # Groth16 trusted setup
bun run test                         # Run circuit tests
node scripts/export-vk-rust.js <circuit>  # Export VK for Solana program
```

### Header Relayer - `/backend/header-relayer`
```bash
bun run init         # Initialize light client (first time)
bun run start        # Start header relay service
```

## Architecture

```
BTC Deposit → Taproot Address (npk-tweaked) → Backend Sweep → SPV Verification
       ↓                                                            ↓
  OP_RETURN: ephemeralPub(32) + npk(32) = 64 bytes     On-chain: Poseidon(npk, token, amount) → Merkle Tree
                                                                                    ↓
                                        JoinSplit Transact (N inputs → M outputs, ZK proof)
                                                                                    ↓
                                    Withdraw → ZK Proof → Burn from Pool → BTC via FROST
```

### Main Components

| Directory | Purpose | Language |
|-----------|---------|----------|
| `contracts/programs/aegis` | Main Solana program (14 instructions) | Rust (Pinocchio) |
| `contracts/programs/btc-light-client` | Bitcoin header tracking (standalone program) | Rust (Pinocchio) |
| `circuits` | JoinSplit Groth16 ZK circuits | circom |
| `sdk` | TypeScript SDK (@aegis/sdk) | TypeScript |
| `frost_server` | FROST threshold signing + policy engine + audit log | Rust |
| `backend` | API server + deposit tracker + redemption + header relayer | Rust + TypeScript |
| `aegis-app` | Web interface | Next.js + React |

### JoinSplit Circuit Architecture

Single parameterized `JoinSplit(N, M, 16)` template producing circuit variants:
- `joinsplit_1x2` — deposit claim (1 input → 2 outputs)
- `joinsplit_2x2` — standard transfer
- `joinsplit_NxM` — general case, N+M <= 14

**Commitment** = `Poseidon(npk, token, amount)` where `npk = Poseidon(MPK, random)`
**Nullifier** = `Poseidon(nullifyingKey, leafIndex)`
**Signature** = EdDSA-Poseidon over `(merkleRoot, boundParamsHash, nullifiers..., commitmentsOut...)`

### Key Privacy Features

| Feature | Description |
|---------|-------------|
| **Shielded-Only** | zkBTC exists only as commitments — no public tokens |
| **JoinSplit Proofs** | Groth16 (~256 byte proofs) for all transfers |
| **3-Key Model** | Spending (BJJ) + Nullifying (BN254) + Viewing (Ed25519) |
| **Stealth Addresses** | Unlinkable one-time addresses via DKSAP (EIP-5564) |
| **.btcpro.sol Names** | Human-readable stealth addresses (SNS subdomains) |
| **Merkle Tree depth 16** | 65,536 leaf capacity with Poseidon hashing |

### Key Model

```
Spending Key (Baby Jubjub) ─► Signs JoinSplit transactions (EdDSA-Poseidon)
       │
       ├─► Nullifying Key (BN254 scalar) ─► Generates nullifiers, prevents double-spend
       │
       └─► Viewing Key (Ed25519) ─► Scans stealth announcements via npk matching
```

- **MPK** = `Poseidon(spendingPub.x, spendingPub.y, nullifyingKey)`
- **NPK** = `Poseidon(MPK, random)` — per-note public key
- Use case: Share viewing key with accountants/compliance without spending risk

### FROST Server Modules

| Module | Purpose |
|--------|---------|
| `policy.rs` | Signing policy engine: sighash verification, UTXO checks, destination whitelist, amount/fee limits |
| `audit.rs` | Append-only JSONL audit log for all signing operations |
| `crypto.rs` | X25519/AES-256-GCM encryption for DKG round 2, commitment digest verification |

### Backend Modules

| Module | Purpose |
|--------|---------|
| `frost_client.rs` | Shared `FrostClient` with broadcast verification, session retry, round coordination |
| `deposit_tracker/` | Full deposit lifecycle: detection → confirmation → sweep → SPV verify → claim |
| `redemption/` | BTC withdrawal processor (single-key or FROST mode) |

### Cryptography

1. **Commitment**: `Poseidon(npk, token, amount)` — 3-field Poseidon hash
2. **ZK Proof**: Groth16 via circom/snarkjs (client-side, 256 byte proofs)
3. **Stealth**: Baby Jubjub ECDH + Ed25519 viewing keys
4. **Redemption**: FROST threshold signatures (secp256k1-tr)
5. **DKG Security**: X25519 ECDH + AES-256-GCM for encrypted key shares

## Key Program IDs

- **Aegis (devnet)**: `25eTdotdeY9EqfJy5tfXSAD5Dg8XTL29sQYVgz1tJkTM`
- **BTC Light Client**: `Ho6UTeF8yFnRdCK15tSZtcJozvkDABJZWYxkgGyWAfyq`

## On-Chain Instructions

| Discriminator | Instruction | Purpose |
|---------------|-------------|---------|
| 0 | `initialize` | Setup pool state and commitment tree |
| 1 | `verify_stealth_deposit` | Verify BTC via SPV, compute commitment on-chain (npk-based, 11 accounts) |
| 5 | `request_redemption` | Burn zkBTC, queue BTC withdrawal |
| 6 | `complete_redemption` | Relayer marks redemption complete |
| 7 | `set_paused` | Admin pause/unpause |
| 11-12 | VK registry | Init/update verification key hashes |
| 14 | `transact` | JoinSplit N-to-M private transfer (Groth16) |
| 21 | `propose_pool_update` | Authority proposes new pool params (48h timelock) |
| 22 | `execute_pool_update` | Permissionless execute after timelock expires |
| 23 | `cancel_pool_update` | Authority cancels pending proposal |

## SDK Usage (@aegis/sdk)

```typescript
import {
  createNonInteractiveDeposit,
  generateJoinSplitProof,
  buildTransactInstruction,
  scanUnifiedNotes,
} from '@aegis/sdk';

// 1. DEPOSIT: Generate npk-based deposit (user sends any amount)
const deposit = await createNonInteractiveDeposit(recipientMeta, groupPubKey);
console.log('Send BTC to:', deposit.btcAddress);

// 2. TRANSACT: JoinSplit proof for private transfer
const proof = await generateJoinSplitProof(inputs);

// 3. BUILD: Create Solana instruction
const ix = buildTransactInstruction(options);
```

## Documentation

- `docs/TECHNICAL.md` - Full technical documentation
- `docs/RUNNING.md` - Operational guide (how to run all services)
- `sdk/docs/SDK.md` - SDK API reference

## Non-Interactive Deposit (OP_RETURN)

npk-based deposits: user sends BTC with OP_RETURN containing `ephemeralPub(32) + npk(32)` = 64 bytes.
Commitment is computed ON-CHAIN: `Poseidon(npk, ZKBTC_TOKEN_ID, amount)`.
Stealth announcements are emitted as `sol_log_data` events (disc=0x03), not stored as PDAs:
- `type = 0` (deposit): `amount_bytes` is plaintext u64 LE
- `type = 1` (transfer): `amount_bytes` is XOR-encrypted

Sweep transactions have no OP_RETURN — Solana verifies everything via the VerifiedTransaction PDA.

Key constants:
- `ZKBTC_TOKEN_ID = 0x7a627463` ("zkbtc" as u32)
- `DEPOSIT_OP_RETURN_SIZE = 64`

## Development Notes

- **Package Manager**: Always use `bun` instead of `npm`
- **Network**: Solana devnet + Bitcoin testnet
- **Build Contracts**: `cargo build-sbf --features devnet`
- **Poseidon Hashing**: Done inside circom circuits (BN254 curve)
- **Token**: zkBTC uses Token-2022 program
- **Solana SDK**: Uses `@solana/kit` (new framework-kit)
- **Tree Depth**: 16 (65,536 leaves max)
- **snarkjs + bun**: Use Node.js subprocess fallback for proof generation
