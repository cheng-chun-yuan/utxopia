## Testing Overview

This project has tests at four main layers:

- **Contracts** (Rust + TypeScript helpers)
- **SDK** (TypeScript, Bun test)
- **Devnet / Backend** (integration against running services)
- **Privacy Coin App** (frontend, Vitest)

The goal is to keep each test file focused, small, and clearly scoped (unit, integration, or E2E).

### Contracts (`contracts`)

- **Rust unit / integration tests** live next to program code and are run with `cargo test`.
- **TypeScript contract helpers and integration tests** live under:
  - `contracts/tests/helpers/` — shared program IDs, PDA helpers, Poseidon Merkle tree, Groth16 helpers.
  - `contracts/tests/integration/` — Bun tests for:
    - `instruction-encoding.test.ts`
    - `zk-merkle.test.ts`
    - `e2e-flow.test.ts`
    - `claim-groth16-demo.test.ts`
- **How to run**:
  - `cd contracts && bun test tests/integration`
  - `cd contracts && cargo test` for Rust-side logic.
- **When to add tests**:
  - Changing instruction layouts or PDAs → add/extend `instruction-encoding.test.ts`.
  - Touching ZK/Merkle helpers used by contracts → add/extend `zk-merkle.test.ts` or `e2e-flow.test.ts`.

### Devnet / Backend (`devnet-test`)

- Devnet E2E tests live in `devnet-test/tests/*.test.ts`.
- Files are already split by flow (health, FROST DKG, deposit, joinsplit, redemption, full-flow, real-deposit-verify).
- **How to run**:
  - `cd devnet-test && bun test` (after services are up as described in `docs/RUNNING.md`).
- **When to add tests**:
  - New end-to-end flow spanning Bitcoin + Solana + backend → add a new `NN-description.test.ts`.
  - Keep each file focused on a single flow and reuse shared setup from `setup.ts` (or a future `helpers/` folder if you add shared utilities).

### SDK (`sdk`)

- Uses Bun test with Vitest-style assertions.
- Test layout:
  - `sdk/test/unit/` — fast, pure unit tests:
    - `commitment.test.ts`
    - `priority-fee.test.ts`
    - `mempool.test.ts`
    - `connection.test.ts`
  - `sdk/test/integration/` — higher-level, SDK focused tests:
    - `commitment-onchain.test.ts`
    - `deposit-flow.test.ts`
    - `chadbuffer-e2e.test.ts` (legacy, mostly skipped)
  - `sdk/test/e2e/` — full E2E tests against localnet/devnet:
    - `full-flow.test.ts`
    - `nullifier.test.ts`
    - `tree-consistency.test.ts`
    - `groth16-claim.test.ts`
    - plus shared helpers in `sdk/test/e2e/helpers.ts`, `sdk/test/e2e/setup.ts`, etc.
- **How to run**:
  - `cd sdk && bun test` (all tests).
  - `cd sdk && bun test test/unit` (unit only).
  - `cd sdk && bun test test/integration` (integration only).
  - `cd sdk && bun test test/e2e` (E2E only; requires environment and circuits, see SDK docs).
- **When to add tests**:
  - Pure helper or utility logic (Poseidon, PDAs, fees, mempool, connection) → `test/unit`.
  - New SDK flows that stay within the SDK (no external services) → `test/integration`.
  - New flows that require a running validator / circuits / backend → `test/e2e`.

### Web App (`web`)

- Frontend tests are co-located with code using Bun test:
  - Stores: `src/stores/__tests__/privacy-coin-store.test.ts`, `src/stores/__tests__/notes-store.test.ts`.
  - Hooks: `src/hooks/__tests__/use-pool-stats.test.tsx`, `src/hooks/__tests__/use-copy-to-clipboard.test.ts`.
  - Utils: `src/lib/utils/__tests__/formatting.test.ts`, `src/lib/utils/__tests__/validation.test.ts`.
  - API: `src/lib/api/__tests__/client.test.ts`, `src/lib/api/__tests__/errors.test.ts`.
  - Components: `src/components/btc-widget/__tests__/widget.test.tsx`.
- **How to run**:
  - `cd web && bun test`.
- **Conventions**:
  - Keep tests close to the code they cover in `__tests__` folders.
  - Use descriptive file names, e.g. `use-pool-stats.test.tsx`, `widget.test.tsx`.
  - Small, focused tests per concern (one hook or one component per file).

### General Guidelines

- Prefer **unit tests** for pure logic; reserve E2E tests for a small, high-value set of flows.
- Keep each test file under ~500 lines; if a test file grows large, split by concern (e.g. multiple `*.test.ts` files).
- Use existing helpers where possible instead of inlining setup:
  - Contracts: `contracts/tests/helpers/*`.
  - SDK: `sdk/test/e2e/helpers.ts`, `sdk/test/e2e/setup.ts`, and new `test/unit`/`test/integration` helpers if you add them.
- When adding a new feature, try to:
  - Add/extend a **unit test** close to the logic.
  - Add/extend an **integration/E2E test** only if the behavior crosses boundaries (Solana, backend, Bitcoin).

---

## Environment Testing Guide

How to run the full Privacy Coin stack on **localnet** (regtest) and **devnet** (testnet4), including FROST threshold signing.

### Localnet (Regtest) — One-Command Setup

Localnet uses a local Solana validator + Bitcoin regtest in Docker. All transactions are instant — no waiting for real block times.

**Prerequisites:** Docker running, Surfpool 1.1+ (`curl -sL https://run.surfpool.run/ | bash`), Bun 1.0+, Node.js 18+, contracts built (`cargo build-sbf --features localnet`), circuits compiled (`cd circuits && bash scripts/compile.sh && bash scripts/setup.sh`).

```bash
# 1. Start Bitcoin regtest (Docker must be running)
docker compose -f docker-compose.regtest.yml up -d

# 2. Wait for Esplora API (~10 seconds)
curl -s http://localhost:3002/regtest/api/blocks/tip/height

# 3. Run full setup: validator + deploy + E2E tests + env sync + frontend
./scripts/setup.sh localnet

# 4. Start backend (separate terminal)
cd backend && cargo run --bin zkbtc-api -- tracker --interval 30 --confirmations 1
```

**E2E steps run automatically (14 steps by default, 15 if `frost-server` is built; total ~2.5 minutes):**

| Step | What | Time |
|------|------|------|
| 1 | Start Surfpool (offline + auto-deploy), init pool | ~33s |
| 2 | Create tUSDC, tWSOL test tokens | ~5s |
| 3 | Real BTC deposit: OP_RETURN → sweep → SPV verify → mint | ~10s |
| 3b | Optional: FROST sweep with local threshold signers (`frost-server` binary required) | ~4s |
| 4 | BTC deposit 2 (for JoinSplit testing) | ~11s |
| 5 | Shield SPL tokens (tUSDC + wSOL) into commitments | ~2s |
| 6 | JoinSplit transfer: Groth16 proof splits notes | ~15s |
| 7 | Unshield tUSDC | ~15s |
| 7b | Unshield zkBTC | ~15s |
| 7c | Multi-output unshield (wSOL) | ~16s |
| 8 | BTC withdrawal request (redemption PDA) | ~1s |
| 8b | Complete BTC redemption: SPV verify → close PDA | ~7s |
| 8c | Multi-output redeem (BTC) | ~15s |
| 9 | Summary: pool state, tree, token configs | ~0.2s |
| 10 | Security negative tests | ~0.3s |

**Services after setup:**

| Service | URL | Port |
|---------|-----|------|
| Solana Validator | http://localhost:8899 | 8899 |
| Bitcoin Esplora | http://localhost:3002 | 3002 |
| Backend API | http://localhost:3001 | 3001 |
| Frontend | http://localhost:3000 | 3000 |

**FROST on localnet: Not required.** The backend auto-detects localnet and falls back to **single-key signing** for BTC withdrawals. No FROST signers needed.

**Stop everything:**

```bash
./scripts/setup.sh localnet --stop
docker compose -f docker-compose.regtest.yml down
```

### Localnet — Manual Step-by-Step

For debugging or running services individually:

```bash
# Terminal 1: Surfpool (BN254 enabled by default via mainnet feature set)
surfpool start --no-tui --network devnet

# Terminal 2: Bitcoin regtest
docker compose -f docker-compose.regtest.yml up -d

# Terminal 3: Deploy & init
cd contracts && cargo build-sbf --features devnet
bun run scripts/e2e/run-all.ts

# Terminal 4: Sync env + backend
./scripts/sync-env.sh
cd backend && cargo run --bin zkbtc-api -- tracker --interval 30 --confirmations 1

# Terminal 5: Frontend
cd privacy-coin-app && bun run dev
```

### Devnet (Testnet4)

Devnet uses Solana devnet + Bitcoin testnet4. Real BTC deposits take ~10 min per block (6 confirmations ≈ 1 hour).

| Aspect | Localnet | Devnet |
|--------|----------|--------|
| Bitcoin network | regtest (instant blocks) | testnet4 (~10 min/block) |
| Solana network | local validator | devnet RPC |
| BTC deposit time | ~10 seconds | ~60 minutes |
| FROST signing | Single-key (auto) | Single-key or FROST |
| Demo deposit | Available (admin) | Available (admin) |
| Programs | Fresh deploy each run | Persistent program IDs |

**Setup:**

```bash
# 1. Ensure you have a funded devnet keypair at ~/.config/solana/id.json
# Get devnet SOL: https://faucet.solana.com/

# 2. Build with devnet features
cd contracts && cargo build-sbf --features devnet

# 3. Deploy (first time) or use existing program IDs
bun run scripts/init-devnet.mjs

# 4. Sync env files for devnet
PRIVACY_COIN_NETWORK=devnet ./scripts/sync-env.sh

# 5. Start backend
cd backend && cargo run --bin zkbtc-api -- tracker

# 6. Start frontend
cd privacy-coin-app && bun run dev
```

**Quick testing on devnet (without waiting for real BTC blocks):**

1. **Demo deposit** — admin instruction, instant, creates shielded notes:
   ```bash
   bun run scripts/topup-all.ts pcoin:<stealth_meta_address>
   ```

2. **Shield SPL tokens** — disc=29, instant, creates commitments from tUSDC/wSOL/etc.

3. **Full BTC deposit** — send testnet4 BTC to pool's Taproot address with OP_RETURN. Wait ~1 hour for 6 confirmations. Backend auto-detects, sweeps, and verifies via SPV.

### FROST Threshold Signing

FROST provides 2-of-3 threshold Schnorr signing for BTC withdrawals. Each signer runs as a separate process.

**When to use FROST:**

| Environment | FROST? | Reason |
|-------------|--------|--------|
| Localnet | **No** | Single-key fallback is faster |
| Devnet | Optional | Test threshold signing flow |
| Production | **Required** | Single-key = single point of failure |

**Architecture:**

```
Backend (coordinator)
    │
    ├── round1 ──► Signer 1 (:9001) ──► nonce commitment
    ├── round1 ──► Signer 2 (:9002) ──► nonce commitment
    └── round1 ──► Signer 3 (:9003) ──► nonce commitment
    │
    │   (collect 2-of-3 commitments)
    │
    ├── round2 ──► Signer 1 ──► partial signature
    └── round2 ──► Signer 2 ──► partial signature
    │
    │   (aggregate → valid Schnorr signature)
    └── Broadcast BTC transaction
```

**Start local FROST signers:**

```bash
# Start 3 signers via Docker
docker compose -f docker-compose.local.yml up --build -d

# Verify health
curl -s http://localhost:9001/health
curl -s http://localhost:9002/health
curl -s http://localhost:9003/health
```

**Configure backend for FROST** (in `backend/.env`):

```bash
PRIVACY_COIN_SIGNING_MODE=frost
PRIVACY_COIN_FROST_THRESHOLD=2
PRIVACY_COIN_FROST_PARTICIPANTS=3
PRIVACY_COIN_FROST_SIGNER_URLS=http://localhost:9001,http://localhost:9002,http://localhost:9003
```

**Test FROST keys:** Password `test`, threshold 2-of-3, stored in `frost_server/config/`.

**Railway deployment (devnet):** FROST signers run as separate Railway services with internal networking (`frost-signer-N.railway.internal:900N`). Key shares injected via `FROST_KEY_BASE64` env var.

**Stop FROST signers:**

```bash
docker compose -f docker-compose.local.yml down
```

### Environment Sync

All services read from `.env` files generated by `sync-env.sh`:

```bash
# Localnet (default) — reads scripts/e2e/localnet-state.json
./scripts/sync-env.sh

# Devnet
PRIVACY_COIN_NETWORK=devnet ./scripts/sync-env.sh
```

Generated files:

| File | Symlink |
|------|---------|
| `backend/.env.localnet` | `backend/.env` |
| `privacy-coin-app/.env.localnet` | `privacy-coin-app/.env.local` |

### Troubleshooting

| Problem | Fix |
|---------|-----|
| `cargo build-sbf` fails on `edition2024` | `cargo update -p blake3 --precise 1.5.5` |
| BN254 pairing syscall error on localnet | Use `--clone-feature-set --url devnet` flag |
| snarkjs hangs in Bun | Ensure `node` is in PATH (auto-fallback to Node subprocess) |
| Backend says `PRIVACY_COIN_PROGRAM_ID required` | Run `./scripts/sync-env.sh` then start from `backend/` directory |
| FROST signer connection refused | Check `docker compose -f docker-compose.local.yml ps` |
| Esplora 502 Bad Gateway | Wait ~10s after Docker start, then retry |
| Surfpool already running | `pkill -f surfpool` then restart |

### Ports Reference

| Service | Port |
|---------|------|
| Solana Validator | 8899 |
| Bitcoin Esplora | 3002 |
| Backend API | 3001 |
| Frontend | 3000 |
| FROST Signer 1 | 9001 |
| FROST Signer 2 | 9002 |
| FROST Signer 3 | 9003 |
