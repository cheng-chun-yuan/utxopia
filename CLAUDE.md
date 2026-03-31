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
bun run test         # bun test (was vitest)
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
cargo build-sbf --features devnet    # Build programs for SBF (devnet)
cargo build-sbf --features localnet  # Build for localnet (regtest BTC LC ID)
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

### FROST Localnet (Docker)
```bash
./scripts/frost-localnet-setup.sh    # Start Esplora + 2 FROST signers
docker compose -f docker-compose.regtest.yml up -d   # Start infrastructure
docker compose -f docker-compose.regtest.yml down     # Stop all
```

### E2E Tests (localnet + regtest)
```bash
bun run scripts/e2e/run-all.ts       # Full E2E (14 steps)
bun run scripts/e2e/step3b-frost-sweep.ts  # FROST sweep only
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
BTC Deposit → Taproot → SPV Verify ──┐
SOL/USDC/USDT → Shield (disc=29) ───┤──► Poseidon(npk, token_id, amount) → Shared Merkle Tree
                                      │                                              ↓
                                      │              JoinSplit Transact (N in → M out, ZK proof)
                                      │                                              ↓
                                      ├──► Unshield → SPL token back to wallet (disc=15)
                                      └──► Withdraw → BTC via FROST threshold signing (disc=16)
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

- **Aegis (devnet)**: `AjbX243s2JMFG2uhfTjKkadjPvQEPgcuyV3vfLJv36MT`
- **BTC Light Client**: `859B7kw1xDyY8rzSXY6pAPNxaAsPWrsaAPJk3iivd43g`

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
import { AegisClient } from '@aegis/sdk';

// High-level client (recommended)
const client = await AegisClient.init({ network: "devnet" });
await client.loginWithSeed(seed);
const notes = await client.getNotes(tokens);
```

Lower-level imports are also available:

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

## Environment Management

### Config sync (single source of truth)

State files are the single source of truth per network:
- `scripts/e2e/localnet-state.json` — generated by localnet init
- `scripts/devnet-state.json` — generated by deploy scripts

`sync-env.sh` reads the state file and generates ALL config:
```bash
./scripts/sync-env.sh                           # defaults to localnet
AEGIS_NETWORK=devnet ./scripts/sync-env.sh       # switch to devnet
```

Generated files:
- `backend/.env.{network}` + symlink `backend/.env`
- `aegis-app/.env.{network}` + symlink `aegis-app/.env.local`
- `aegis-app/src/lib/networks.json` (frontend runtime config)

**After deploy or validator reset**: update the state JSON, then run `./scripts/sync-env.sh`.
Never edit `networks.json` or `.env` files directly — they are generated.

### Localnet full reset
```bash
# 1. Run E2E init (starts validator, deploys, creates test state)
bun run scripts/e2e/run-all.ts

# 2. Sync env files
./scripts/sync-env.sh

# 3. Start backend (reads from localnet-state.json on mismatch)
cd backend && cargo run --bin zkbtc-api -- tracker
```

### Top up stealth address (all tokens)
```bash
# From aegis-app/ dir (needs SDK):
bun run scripts/topup-all.ts aegis:<stealth_address>
```

## Development Notes

- **Package Manager**: Always use `bun` instead of `npm`
- **Network**: Solana devnet + Bitcoin testnet
- **Build Contracts**: `cargo build-sbf --features devnet`
- **Poseidon Hashing**: Done inside circom circuits (BN254 curve)
- **Token**: zkBTC uses Token-2022 program
- **Solana SDK**: Uses `@solana/kit` (new framework-kit)
- **Tree Depth**: 16 (65,536 leaves max)
- **snarkjs + bun**: Use Node.js subprocess fallback for proof generation
- **ECDH stealth**: Use `@noble/curves` (SDK) for Ed25519→X25519 conversion, NOT Node.js `crypto.convertKey` (produces different scalars)
- **AEGIS_PROGRAM_ID**: Required env var — backend fails fast if missing (no hardcoded fallback)
- **Reconciler**: Seeds leaves from `localnet-state.json` when on localnet with empty DB (handles validator `--reset`)
