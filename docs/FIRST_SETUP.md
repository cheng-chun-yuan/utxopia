# First-Time Setup

Complete onboarding for a fresh UTXOpia deployment. Walks from "bare repo on a new machine" to "backend serving real deposits at api.utxopia.com."

If you already have a working devnet (the case for this checkout), most of this is reference — jump to the section you need.

## 0. Prerequisites

```bash
# Toolchain
brew install bun                                                  # JS runtime + package mgr
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh    # Rust + cargo
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"     # Solana CLI
npm install -g snarkjs                                            # circuit prover
curl -L https://github.com/iden3/circom/releases/download/v2.2.3/circom-macos-amd64 \
  -o ~/.local/bin/circom && chmod +x ~/.local/bin/circom          # circom v2.2.3 (Rosetta-OK)
brew install --cask docker                                        # backend stack
brew install cloudflare/cloudflare/cloudflared                    # public tunnel
```

Verify:
```bash
bun --version && cargo --version && solana --version
circom --version && snarkjs | head -1
docker --version && cloudflared --version
```

## 1. Repo + dependencies

```bash
git clone https://github.com/cheng-chun-yuan/utxopia.git
cd utxopia
bun install                          # installs workspace deps (sdk + web)
cd circuits && bun install && cd ..  # circomlib for compilation
```

## 2. Solana program deploys

Two programs: `utxopia` (main) and `btc-light-client`. Both need their own program-IDs and BPF buffers.

```bash
# Configure Solana CLI for devnet
solana config set --url https://api.devnet.solana.com

# Generate a deployer keypair (or reuse ~/.config/solana/id.json)
solana-keygen new --outfile ~/.config/solana/id.json

# Fund it (devnet faucet, 2 SOL per request; need ~10 SOL for fresh deploy)
solana airdrop 2
# Repeat or use https://faucet.solana.com if rate-limited

# Build BPF binaries
cd contracts
cargo build-sbf --features devnet    # devnet build; use --features mainnet for prod

# Deploy both programs (this script also writes program IDs to state JSON)
bun run scripts/deploy-devnet.ts
```

Outputs go to `scripts/devnet-state.json`:
```json
{
  "utxopiaProgramId": "G1bj9...",
  "btcLightClientProgramId": "C8JoSK...",
  "zkbtcMint": "CDqY9...",
  ...
}
```

If you're continuing an existing deploy, skip this — current devnet IDs are already in `CLAUDE.md`.

## 3. Initialize pool state

```bash
cd contracts
bun run scripts/init-deployed.ts
```

This calls `INITIALIZE` (disc 0) on the utxopia program, creating the pool state PDA and commitment tree PDA. One-time per program deployment.

## 4. BTC Light Client init

The light client tracks BTC headers on-chain. First-time init (or re-anchor on switch):

```bash
# Initial setup: anchor at a recent BTC tip
cd contracts
bun run scripts/init-btc-light-client.ts
# Or for re-anchor (after dev/network change), use the script from earlier:
node /tmp/reanchor_lc.mjs       # See logs from May 11 — uses Hermez ptau in CF account
```

Parameters embedded:
- network byte: `2` for testnet4
- starting height + block hash from `mempool.space/testnet4/api/blocks/tip/hash`
- difficulty params from the current epoch start block

## 5. Ika dWallet ceremony (custody setup)

UTXOpia's BTC custody is held by an Ika 2PC-MPC dWallet whose authority is a Solana PDA. One-time DKG ceremony:

```bash
UTXOPIA_PROGRAM_ID=<your-pid> PAYER_KEYPAIR_PATH=~/.config/solana/id.json \
  node --experimental-strip-types scripts/ika-setup/dkg.ts --network devnet
```

This produces a `dWallet ID` and an `x-only pubkey`. Save both.

Pin the dWallet on-chain so only UTXOpia can sign with it:
```bash
UTXOPIA_PROGRAM_ID=<your-pid> PAYER_KEYPAIR_PATH=~/.config/solana/id.json \
  node --experimental-strip-types scripts/ika-setup/set-pool-config.ts --network devnet
```

Derives the pool receive address (`tb1p...` for testnet4) and writes the pool config PDA.

## 6. Circuit artifacts

Two paths — pick one.

### 6a. Fresh ceremony (~30min, deterministic-ish)

```bash
cd circuits
bash scripts/compile.sh --tier2      # 19 variants, ~5min on M-series
bash scripts/setup.sh --tier2        # Downloads ~150MB Hermez ptau, runs Phase 2, ~25min
```

Outputs:
- `build/joinsplit_*/joinsplit_*.r1cs` (constraints)
- `build/joinsplit_*/joinsplit_*_js/joinsplit_*.wasm` (witness generator)
- `build/joinsplit_*/joinsplit_*.zkey` (prover key)
- `build/joinsplit_*/joinsplit_*.vkey.json` (verifier key — committed to repo)

### 6b. Fetch from release (when artifacts are published)

```bash
bash scripts/fetch-circuits.sh
```

Downloads `circuits-tier2.tar.gz` from `github.com/cheng-chun-yuan/utxopia/releases/latest/download`. Faster if you trust the release.

## 7. Register VK hashes

The on-chain program verifies proofs against a pinned vkey hash per (n_in, n_out) shape. Run once per Phase 2 ceremony output:

```bash
bun run scripts/register-vk-hashes.ts
```

What it does, per circuit:
- Reads `circuits/build/joinsplit_NxM/joinsplit_NxM.vkey.json`
- Computes sha256 over the Groth16 vkey elements
- Derives PDA `[seed("vk_registry"), n_in:u8, n_out:u8]`
- Skips if already registered (disc 0x14 marker)
- Otherwise calls `INIT_VK_REGISTRY` (disc 6) to pin the hash

If you re-run setup.sh after a registration, the new vkeys will have different hashes — use `UPDATE_VK_REGISTRY` (disc 7) instead (extend the script to add an `--update` flag if needed).

## 8. Register tokens

zkBTC is the primary token; the program also supports SOL/USDC/USDT/jupUSD shielding.

```bash
bun run scripts/register-token.ts
```

For each token: creates a TokenConfig PDA with mint, vault ATA, min/max deposit, deposit cap. Allowance is `REGISTER_TOKEN` for new tokens, `UPDATE_TOKEN_CONFIG` to change limits.

## 9. Sync env files (single source of truth)

State files drive every config:

```bash
PRIVACY_COIN_NETWORK=devnet ./scripts/sync-env.sh   # legacy name still works
# Generates: backend/.env.devnet, web/.env.devnet, web/src/lib/networks.json
```

After this, `docker-compose.backend.yml` reads from the gitignored `.env` file at the repo root.

## 10. Start backend stack

```bash
# Required: BACKEND_API_KEY set in .env (the docker compose fails-closed without it)
cat .env  # ← should contain BACKEND_API_KEY=<hex>
# Plus UTXOPIA_TUNNEL_TOKEN for the cloudflared service (from Zero Trust dashboard)

docker compose -f docker-compose.backend.yml up --build -d
docker compose -f docker-compose.backend.yml logs -f backend
```

Expected log lines:
- `=== zkBTC Unified API ===`
- `[redemption] Loaded on-chain PoolState`
- `[header-relay] Initial sync: already at tip` (or "Syncing N blocks")
- `[ws-stream] Subscribed to program account changes`

Health:
```bash
curl http://localhost:3010/api/tree/status
curl https://api.utxopia.com/api/tree/status
```

## 11. Frontend

### Local dev
```bash
cd web && bun run dev   # http://localhost:3002 (port set in .env.local)
```

### Production
Connected to Vercel via GitHub auto-deploy. Env vars in dashboard per `docs/VERCEL_ENV.md`. Custom domain in `app.utxopia.com`.

## 12. End-to-end deposit smoke

```bash
set -a && source .env && set +a
bun run scripts/demo-deposit.ts
```

Prints a Taproot BTC address + 64-byte OP_RETURN. Send testnet BTC via Sparrow Wallet (Settings → Advanced → custom OP_RETURN). Backend detects within 60s of confirmation, mints the commitment.

---

## Critical files & their purpose

| Path | What |
|---|---|
| `~/.config/solana/id.json` | Solana deployer + relayer keypair (uFBM... is the live devnet authority) |
| `.env` | `BACKEND_API_KEY` + `UTXOPIA_TUNNEL_TOKEN` (gitignored) |
| `docker-compose.backend.yml` | Backend + cloudflared services |
| `scripts/devnet-state.json` | Program IDs, mint addresses (single source of truth) |
| `circuits/build/joinsplit_*/*.vkey.json` | Verification keys (committed; on-chain pinned) |
| `web/.env.local` | Frontend env for local dev (gitignored) |

## Discriminator quick reference

| Disc | Instruction |
|---|---|
| 0 | `initialize` (pool state + tree) |
| 1 | `complete_deposit` |
| 2 | `set_pool_config` |
| 5 | `request_redemption` |
| 6 | `init_vk_registry` |
| 7 | `update_vk_registry` |
| 14 | `transact` (JoinSplit N→M) |
| 15 | `unshield` |
| 17 | `complete_redemption` (CPIs Ika `approve_message`) |

## When in doubt

- Existing deployment? `bun run contracts/scripts/devnet-status.ts` shows what's live.
- Lost track of program IDs? `cat scripts/devnet-state.json`.
- Backend won't start? `docker compose logs backend` first; usually a missing env var with `:?` failing the parser.
- Public URL not reaching backend? Check `docker logs utxopia-cloudflared` for tunnel connection state; verify the Public Hostname target in CF Zero Trust dashboard points at `backend:3001` (docker network DNS), not `host.docker.internal:3010`.
