# zVault — How to Run

Complete guide for running all zVault services locally and on devnet.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Quick Start (Local Development)](#2-quick-start-local-development)
3. [Service-by-Service Guide](#3-service-by-service-guide)
4. [Environment Variables Reference](#4-environment-variables-reference)
5. [E2E Test Scripts](#5-e2e-test-scripts)
6. [Production Checklist](#6-production-checklist)
7. [Architecture Overview](#7-architecture-overview)
8. [Component Status](#8-component-status)

---

## 1. Prerequisites

### Required Tools

| Tool | Version | Install |
|------|---------|---------|
| Rust + Cargo | 1.75+ | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Solana CLI | 1.18+ | `sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"` |
| Bun | 1.0+ | `curl -fsSL https://bun.sh/install \| bash` |
| Node.js | 18+ | Required for snarkjs (proof generation) |
| circom | 2.1+ | `cargo install circom` |

### Solana Wallet Setup

```bash
# Generate a new keypair (or use existing)
solana-keygen new -o ~/.config/solana/id.json

# For devnet: airdrop SOL
solana config set --url devnet
solana airdrop 5

# For localnet testing, also create an authority keypair:
solana-keygen new -o ~/.config/solana/johnny.json
```

---

## 2. Quick Start (Local Development)

### Step 1: Build Everything

```bash
# Build Solana programs
cd contracts
cargo build-sbf --features devnet

# Install SDK dependencies
cd ../sdk
bun install

# Build circuits (first time only — takes ~5 min)
cd ../circuits
bun install
bash scripts/compile.sh
bash scripts/setup.sh

# Build backend
cd ../backend
cargo build

# Build FROST server
cd ../frost_server
cargo build
```

### Step 2: Start Local Validator

```bash
# IMPORTANT: Must clone devnet feature set for BN254 pairing syscalls
solana-test-validator \
  --clone-feature-set \
  --url devnet \
  --reset
```

### Step 3: Deploy Programs

```bash
cd contracts

# Deploy both zvault and btc-light-client programs
bun run scripts/deploy-localnet.ts

# Or deploy to devnet:
bun run scripts/deploy-devnet.ts
```

### Step 4: Start Backend Services

Open separate terminals for each service:

```bash
# Terminal 1: API Server (port 3001)
cd backend
cargo run -- api

# Terminal 2: Deposit Tracker
cd backend
cargo run -- tracker

# Terminal 3: Header Relayer
cd backend/header-relayer
bun run start

# Terminal 4 (optional): Redemption Processor
cd backend
POOL_SIGNING_KEY=<hex_private_key> cargo run -- redemption
```

### Step 5: Start Frontend

```bash
cd zvault-app
bun install
bun run dev
# Open http://localhost:3000
```

---

## 3. Service-by-Service Guide

### 3.1 Solana Programs

Two on-chain programs:

| Program | ID (devnet) | Purpose |
|---------|-------------|---------|
| zVault | `2dBmKyfLibkqdxgyEWUhHos3g56oU2wXLVrucY2dCpGV` | Main bridge logic (12 instructions) |
| BTC Light Client | `DeDut4fkjbWBPY4FRUU3q9BUcvwTisHczj1EQmqX5avS` | Bitcoin header verification |

```bash
cd contracts

# Build with devnet features (enables demo instructions)
cargo build-sbf --features devnet

# Deploy to localnet
bun run scripts/deploy-localnet.ts

# Deploy to devnet
bun run scripts/deploy-devnet.ts

# Verify deployment
bun run scripts/verify-deployment.ts
```

**Troubleshooting:**
- If `cargo build-sbf` fails on `edition2024`: `cargo update -p blake3 --precise 1.5.5`
- Programs use Pinocchio framework (not Anchor)

---

### 3.2 Backend API Server

REST API for the frontend.

```bash
cd backend
cargo run -- api [--port <port>]
```

**Default port**: 3001

**Key endpoints**:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/deposit/address` | POST | Generate Taproot deposit address |
| `/api/deposit/status/:txid` | GET | Check deposit status |
| `/api/redemption/request` | POST | Request BTC withdrawal |
| `/api/redemption/status/:id` | GET | Check redemption status |
| `/api/pool/status` | GET | Pool state (total shielded, etc.) |
| `/api/stealth` | GET | List stealth deposits |
| `/health` | GET | Health check |

---

### 3.3 Deposit Tracker

Background service that monitors Bitcoin deposits.

```bash
cd backend
cargo run -- tracker [options]
```

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--interval <secs>` | 30 | Poll interval |
| `--confirmations <n>` | 3 | Required BTC confirmations |
| `--db-path <path>` | `data/deposits.db` | SQLite database path |
| `--max-retries <n>` | 5 | Max retry attempts |

**Deposit lifecycle**: `Pending → Detected → Confirming → Confirmed → Sweeping → Verifying → Ready → Claimed`

**Environment variables:**
```bash
POOL_SIGNING_KEY=<hex>          # Required for sweeping deposits
POOL_RECEIVE_ADDRESS=<btc_addr> # Pool wallet address
SOLANA_RPC_URL=<url>            # Solana endpoint
VERIFIER_KEYPAIR=<path>         # Solana keypair for SPV verification
```

---

### 3.4 Header Relayer

TypeScript service that syncs Bitcoin block headers to the on-chain light client.

```bash
cd backend/header-relayer

# First time: initialize the light client with a starting block
bun run init

# Then start the relayer
bun run start
```

**Environment variables:**
```bash
SOLANA_RPC_URL=https://api.devnet.solana.com
PROGRAM_ID=DeDut4fkjbWBPY4FRUU3q9BUcvwTisHczj1EQmqX5avS
RELAYER_KEYPAIR='[1,2,3,...]'   # JSON array of keypair bytes
POLL_INTERVAL_MS=30000           # 30 seconds
BITCOIN_NETWORK=testnet          # mainnet, testnet, or signet
START_BLOCK_HEIGHT=2900000       # Starting block height
```

---

### 3.5 FROST Threshold Signing Server

2-of-3 threshold signing for BTC withdrawals. Each signer runs as a separate process.

#### Initial Setup: DKG Ceremony

```bash
cd frost_server

# Option A: Trusted dealer (development only)
cargo run -- generate-test-keys --output-dir config

# Option B: Real DKG ceremony (production)
# 1. Start all signer nodes first
# 2. Run coordinator:
cargo run -- dkg-coordinator \
  --signers "http://localhost:9001,http://localhost:9002,http://localhost:9003" \
  --threshold 2 \
  --password "secure_password"
```

#### Running Signer Nodes

```bash
# Terminal 1: Signer 1
cargo run -- run --bind 0.0.0.0:9001 --id 1 --password "pw1" --key-file config/signer-1.key

# Terminal 2: Signer 2
cargo run -- run --bind 0.0.0.0:9002 --id 2 --password "pw2" --key-file config/signer-2.key

# Terminal 3: Signer 3
cargo run -- run --bind 0.0.0.0:9003 --id 3 --password "pw3" --key-file config/signer-3.key
```

**Endpoints (per signer):**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Health check |
| `/signing/round1` | POST | Start signing round 1 |
| `/signing/round2` | POST | Complete signing round 2 |
| `/dkg/round1` | POST | DKG round 1 |
| `/dkg/round2` | POST | DKG round 2 |

---

### 3.6 Redemption Processor

Background service that processes BTC withdrawal requests.

```bash
cd backend
POOL_SIGNING_KEY=<hex_private_key> cargo run -- redemption [--interval <secs>] [--min-amount <sats>]
```

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--interval` | 30 | Check interval (seconds) |
| `--min-amount` | 10,000 | Minimum withdrawal amount (sats) |

**Flow**: Watches for `RedemptionRequest` PDAs on Solana → Signs BTC transaction (single key or FROST) → Broadcasts → Confirms → Marks complete.

**For FROST signing mode:**
```bash
ZVAULT_SIGNING_MODE=frost \
ZVAULT_FROST_THRESHOLD=2 \
ZVAULT_FROST_PARTICIPANTS=3 \
ZVAULT_FROST_KEY_SHARE=<encrypted_share> \
ZVAULT_FROST_SIGNER_URLS=http://localhost:9001,http://localhost:9002,http://localhost:9003 \
cargo run -- redemption
```

---

### 3.6b Demo Mode

Validate configuration and see a flow overview without starting any services.

```bash
cd backend
cargo run -- demo
```

This prints:
- Pool public key and sample deposit address
- Step-by-step flow overview (deposit → claim → withdraw)
- No real transactions or network calls

---

### 3.7 Circuits (circom)

Parameterized JoinSplit(N,M) Groth16 circuits for all private operations.

```bash
cd circuits
bun install

# Compile JoinSplit circuits (tier-1: 1x1, 1x2, 2x1, 2x2)
bash scripts/compile.sh

# Compile more variants
bash scripts/compile.sh --tier2   # 10 total variants
bash scripts/compile.sh --all     # All 91 JoinSplit(N,M) variants

# Groth16 trusted setup (generates .zkey files)
bash scripts/setup.sh

# Run circuit tests
bun run test

# Export verification keys for Solana programs
node scripts/export-vk-rust.js joinsplit_1x2
node scripts/export-vk-rust.js joinsplit_2x2
```

**Circuit variants:**
| Variant | Purpose |
|---------|---------|
| `joinsplit_1x2` | Deposit claim (1 input → 2 outputs) |
| `joinsplit_2x2` | Standard private transfer |
| `joinsplit_NxM` | General case (N+M ≤ 14) |

---

### 3.8 SDK

TypeScript SDK used by frontend and E2E tests.

```bash
cd sdk
bun install
bun run build

# Run unit tests
bun test

# Run E2E tests (requires local validator + deployed programs)
bun run e2e
```

---

### 3.9 Frontend (Next.js)

```bash
cd zvault-app
bun install
bun run dev       # Development (port 3000)
bun run build     # Production build
bun run lint      # ESLint
bun run test      # Vitest tests
```

---

## 4. Environment Variables Reference

### Backend (`backend/`)

| Variable | Default | Description |
|----------|---------|-------------|
| `ZVAULT_NETWORK` | `devnet` | Network: mainnet, testnet, devnet |
| `ZVAULT_SOLANA_RPC` | (per network) | Solana RPC endpoint |
| `ZVAULT_BITCOIN_RPC` | (per network) | Esplora API endpoint |
| `ZVAULT_PROGRAM_ID` | (devnet default) | zVault program ID |
| `ZVAULT_POOL_STATE` | (devnet default) | Pool state PDA |
| `ZVAULT_COMMITMENT_TREE` | (devnet default) | Commitment tree PDA |
| `ZVAULT_ZBTC_MINT` | (devnet default) | zBTC mint address |
| `ZVAULT_SIGNING_MODE` | `single` (devnet) | `single` or `frost` |
| `ZVAULT_BTC_SIGNER_KEY` | — | Hex BTC private key (single mode) |
| `ZVAULT_FROST_THRESHOLD` | — | FROST threshold (e.g., 2) |
| `ZVAULT_FROST_PARTICIPANTS` | — | FROST total signers (e.g., 3) |
| `ZVAULT_FROST_KEY_SHARE` | — | Encrypted key share |
| `ZVAULT_FROST_SIGNER_URLS` | — | Comma-separated signer URLs |
| `ZVAULT_FROST_API_KEY` | — | Optional API key for FROST servers |
| `ZVAULT_DEPOSIT_LIMIT_SATS` | (per network) | Max deposit amount |
| `ZVAULT_DEMO_MODE` | `0` | Enable demo instructions (devnet only) |
| `ZVAULT_LOG_LEVEL` | `info` | Log level |
| `API_PORT` | `3001` | API server port |
| `POOL_SIGNING_KEY` | — | Hex BTC key for sweeper/redemption |
| `POOL_RECEIVE_ADDRESS` | — | Pool BTC address |
| `SOLANA_RPC_URL` | — | Solana RPC (tracker/verifier) |
| `VERIFIER_KEYPAIR` | — | Path to Solana keypair file |

### Header Relayer (`backend/header-relayer/`)

| Variable | Default | Description |
|----------|---------|-------------|
| `SOLANA_RPC_URL` | devnet | Solana RPC |
| `PROGRAM_ID` | (hardcoded) | BTC Light Client program ID |
| `RELAYER_KEYPAIR` | — | JSON array keypair bytes |
| `POLL_INTERVAL_MS` | `30000` | Poll interval (ms) |
| `POLL_AT_TIP_MS` | `300000` | Poll interval at chain tip (ms) |
| `BITCOIN_NETWORK` | `testnet` | mainnet, testnet, signet |
| `START_BLOCK_HEIGHT` | — | Starting block height |

### FROST Server (`frost_server/`)

| Variable | Default | Description |
|----------|---------|-------------|
| `FROST_KEY_PASSWORD` | — | Password for encrypted key files |

---

## 5. E2E Test Scripts

Located in `sdk/scripts/`. All use shared helpers from `sdk/scripts/lib.ts`.

### Mock SPV (Self-Contained, No Bitcoin Needed)

```bash
cd sdk
bun run scripts/e2e-mock-spv.ts
```

Builds a fake BTC transaction and block headers, tests the full SPV verification flow locally.

### Full SPV (Real Bitcoin Testnet)

```bash
cd sdk
TXID=<bitcoin_testnet_txid> bun run scripts/e2e-full-spv-flow.ts
```

Fetches a real Bitcoin testnet transaction from Esplora and verifies it on-chain.

### Deposit-Claim (ZK Proof)

```bash
cd sdk
bun run scripts/e2e-deposit-claim.ts
```

Full deposit → claim flow with real Groth16 proof generation. Requires compiled circuits.

### Prerequisites for All E2E Tests

1. Local validator running: `solana-test-validator --clone-feature-set --url devnet --reset`
2. Programs deployed: `cd contracts && bun run scripts/deploy-localnet.ts`
3. For deposit-claim: circuits compiled (`cd circuits && bash scripts/compile.sh && bash scripts/setup.sh`)

---

## 6. Production Checklist

### Security

- [ ] Switch to `ZVAULT_SIGNING_MODE=frost` (single-key is POC only)
- [ ] Run DKG ceremony with real distributed signers (not test keys)
- [ ] Store FROST key shares in HSM or encrypted at rest
- [ ] Set `ZVAULT_DEMO_MODE=0` (demo instructions disabled on mainnet)
- [ ] Set `ZVAULT_NETWORK=mainnet`
- [ ] Deploy without `--features devnet` flag
- [ ] Use private RPC endpoints (not public devnet/mainnet RPCs)
- [ ] Set appropriate `ZVAULT_DEPOSIT_LIMIT_SATS`

### Infrastructure

- [ ] Run 3+ FROST signer nodes on separate machines/regions
- [ ] Set up monitoring for header relayer lag
- [ ] Set up monitoring for deposit tracker queue depth
- [ ] Configure proper BTC confirmation requirements (6+ for mainnet)
- [ ] Set up database backups for deposit tracker SQLite
- [ ] Use mainnet Esplora/Bitcoin RPC (not testnet)

### Programs

- [ ] Build programs without devnet features: `cargo build-sbf` (no `--features devnet`)
- [ ] Run production validation: `config.validate_for_production()` (enforces FROST, mainnet, no demo)
- [ ] Verify all program IDs match deployed addresses
- [ ] Set mainnet config in SDK (`sdk/src/config.ts` — currently disabled)

### Missing for Production

- Mainnet SDK config has placeholder addresses (needs real deployed addresses)

---

## 7. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        USER (Browser/Mobile)                      │
│                                                                   │
│  SDK: Generate notes, compute commitments, build ZK proofs,      │
│       create stealth addresses, scan announcements                │
└──────────┬────────────────────────┬────────────────────┬─────────┘
           │                        │                    │
           ▼                        ▼                    ▼
┌──────────────────┐  ┌─────────────────────┐  ┌────────────────┐
│  Backend API     │  │  Solana Programs     │  │  Bitcoin       │
│  (:3001)         │  │                      │  │  Network       │
│                  │  │  zVault (12 ix)      │  │                │
│  - Deposit addr  │  │  BTC Light Client    │  │  - Taproot     │
│  - Status check  │  │                      │  │    deposits    │
│  - Redemption    │  │  State:              │  │  - FROST-signed│
│  - Pool info     │  │  - PoolState PDA     │  │    withdrawals │
│  - Deposit scan  │  │  - CommitmentTree    │  │                │
└──────────────────┘  │  - Nullifiers        │  └───────┬────────┘
                      │  - StealthAnnounce-  │          │
                      │    ments (npk+type)  │          │
                      │  - BlockHeaders      │          │
                      └──────────────────────┘          │
                               ▲                        │
                               │                        │
           ┌───────────────────┼────────────────────────┘
           │                   │
           ▼                   ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│  Header Relayer  │  │  Deposit Tracker │  │  FROST Servers   │
│  (TypeScript)    │  │  (Rust)          │  │  (Rust x3)       │
│                  │  │                  │  │                  │
│  Polls mempool.  │  │  Monitors BTC    │  │  :9001 Signer 1  │
│  space, submits  │  │  deposits, runs  │  │  :9002 Signer 2  │
│  headers to      │  │  sweeper + SPV   │  │  :9003 Signer 3  │
│  light client    │  │  verifier        │  │                  │
└──────────────────┘  └──────────────────┘  │  2-of-3 Taproot  │
                                            │  threshold sigs  │
                                            └──────────────────┘
```

### Flow: Deposit BTC → Get zkBTC

1. **SDK** generates 3-key set (spending BJJ + nullifying BN254 + viewing Ed25519)
2. **SDK** derives Taproot deposit address from commitment + pool keys
3. **User** sends BTC to the Taproot address
4. **Header Relayer** syncs the block header to Solana light client
5. **Deposit Tracker** detects the deposit, waits for confirmations
6. **Deposit Tracker** sweeps funds to pool wallet and submits SPV proof to Solana
7. **On-chain**: `verify_stealth_deposit` validates SPV proof, computes commitment on-chain (`Poseidon(npk, ZBTC_TOKEN_ID, amount)`), creates StealthAnnouncement PDA (90 bytes, type=deposit), adds commitment to Merkle tree
8. **SDK** generates JoinSplit(1,2) Groth16 claim proof (client-side, in browser)
9. **On-chain**: `transact` verifies JoinSplit proof, inserts output commitments

### Flow: Redeem zkBTC → Get BTC

1. **SDK** burns zkBTC and creates `RedemptionRequest` PDA
2. **Redemption Processor** detects the request
3. **Redemption Processor** orchestrates FROST signing (round1 → round2 → aggregate)
4. **FROST Servers** contribute partial signatures (2-of-3)
5. **Redemption Processor** broadcasts signed BTC transaction
6. After confirmation, marks redemption complete on-chain

---

## 8. Component Status

| Component | Status | Notes |
|-----------|--------|-------|
| zVault Program (12 ix) | Fully implemented | Pinocchio, all instructions working |
| BTC Light Client | Fully implemented | Header storage + validation |
| FROST Server | Fully implemented | DKG, signing, keystore with AES-256-GCM |
| Backend API | Fully implemented | 14+ endpoints, CORS, combined server |
| Deposit Tracker | Fully implemented | Full lifecycle, sweeper, SPV verifier |
| Redemption Processor | Fully implemented | Single-key + FROST MPC modes |
| Header Relayer | Fully implemented | Polls mempool.space, auto-sync |
| SDK | Fully implemented | 400+ functions, all crypto primitives |
| Circuits (JoinSplit) | Fully implemented | Parameterized JoinSplit(N,M), 91 possible variants |
| Frontend (Next.js) | Working scaffold | Wallet connect, basic UI |
| Mainnet Config | Not ready | SDK has placeholder addresses |
