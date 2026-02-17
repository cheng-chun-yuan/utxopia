# zVault Backend Services

The zVault backend consists of three main services that run as background processes.

## Overview

| Service | Purpose | Command |
|---------|---------|---------|
| **API Server** | REST API for frontend/mobile | `cargo run -- api` |
| **Deposit Tracker** | Monitor deposits, sweep, verify | `cargo run -- tracker` |
| **Redemption Processor** | Process zkBTC burns, send BTC | `cargo run -- redemption` |
| **Header Relayer** | Sync Bitcoin headers to Solana | `bun run start` (TypeScript) |

---

## API Server

The API server provides REST and WebSocket endpoints for client applications.

### Starting the Server

```bash
# Default port 3001
cargo run -- api

# Custom port
cargo run -- api --port 8080

# Or via environment variable
API_PORT=8080 cargo run -- api
```

### Features

- **REST Endpoints**: Deposit registration, status checking, redemption
- **WebSocket**: Real-time deposit status updates
- **Rate Limiting**: Per-IP rate limiting with burst allowance
- **CORS**: Cross-origin support for web clients
- **Security Headers**: HSTS, CSP, X-Frame-Options

### Endpoints

See [API.md](./API.md) for complete endpoint documentation.

---

## Deposit Tracker

The deposit tracker monitors Bitcoin deposits and processes them through the verification pipeline.

### Starting the Tracker

```bash
# Default configuration
cargo run -- tracker

# Custom configuration
cargo run -- tracker \
  --interval 30 \
  --confirmations 3 \
  --db-path data/deposits.db \
  --max-retries 5
```

### Configuration Options

| Option | Environment Variable | Default | Description |
|--------|---------------------|---------|-------------|
| `--interval` | `DEPOSIT_POLL_INTERVAL_SECS` | 30 | Poll interval in seconds |
| `--confirmations` | `DEPOSIT_REQUIRED_CONFIRMATIONS` | 3 | Required BTC confirmations |
| `--db-path` | `DEPOSIT_DB_PATH` | `data/deposits.db` | SQLite database path |
| `--max-retries` | `DEPOSIT_MAX_RETRIES` | 5 | Max retry attempts |

### Pipeline Stages

```
┌──────────┐    ┌──────────┐    ┌───────────┐    ┌──────────┐    ┌─────────┐
│ PENDING  │───▶│ DETECTED │───▶│ CONFIRMED │───▶│ SWEEPING │───▶│ READY   │
└──────────┘    └──────────┘    └───────────┘    └──────────┘    └─────────┘
     │               │               │                │              │
     │               ▼               ▼                ▼              │
     │          (mempool)      (N confirms)    (sweep + SPV)        │
     │                                                               │
     └──────────────────────────────────────────────────────────────┘
                            (expiry/failure)
```

### Components

#### 1. Address Watcher
- Polls Esplora API for transactions to watched addresses
- Detects new deposits in mempool
- Updates confirmation counts

```rust
// Polling loop
loop {
    for deposit in pending_deposits {
        let status = esplora.get_address_txs(&deposit.address).await?;
        if let Some(tx) = status.find_deposit() {
            deposit.mark_detected(tx);
        }
    }
    tokio::time::sleep(poll_interval).await;
}
```

#### 2. UTXO Sweeper
- Builds sweep transactions from deposit addresses to pool wallet
- Signs with embedded commitment data
- Broadcasts to Bitcoin network

```rust
// Sweep confirmed deposits
for deposit in confirmed_deposits.filter(|d| d.can_sweep()) {
    let sweep_tx = build_sweep_tx(&deposit, &pool_address)?;
    let signed_tx = signer.sign(sweep_tx)?;
    esplora.broadcast(signed_tx).await?;
    deposit.mark_sweep_broadcast(txid);
}
```

#### 3. SPV Verifier
- Generates Merkle proofs for sweep transactions
- Submits proofs to Solana light client
- Records verified deposits on-chain

```rust
// Verify swept deposits
for deposit in swept_deposits.filter(|d| d.can_verify()) {
    let proof = spv.generate_proof(&deposit.sweep_txid).await?;
    let sig = solana.verify_btc_deposit(proof).await?;
    deposit.mark_ready(sig, leaf_index);
}
```

### Persistence

The tracker uses SQLite for persistent storage:

```sql
CREATE TABLE deposits (
    id TEXT PRIMARY KEY,
    taproot_address TEXT NOT NULL UNIQUE,
    commitment TEXT NOT NULL,
    amount_sats INTEGER NOT NULL,
    status TEXT NOT NULL,
    actual_amount_sats INTEGER,
    confirmations INTEGER DEFAULT 0,
    deposit_txid TEXT,
    sweep_txid TEXT,
    solana_tx TEXT,
    leaf_index INTEGER,
    retry_count INTEGER DEFAULT 0,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
```

### Error Handling

Failed operations are retried with exponential backoff:

| Retry | Delay |
|-------|-------|
| 1 | 60s |
| 2 | 120s |
| 3 | 240s |
| 4 | 480s |
| 5 | 960s |

After max retries, the deposit is marked as `failed` and requires manual intervention.

---

## Redemption Processor

The redemption processor watches for zkBTC burn events on Solana and sends BTC to users.

### Starting the Processor

```bash
# Default configuration
cargo run -- redemption

# Custom configuration
cargo run -- redemption \
  --interval 30 \
  --min-amount 10000
```

### Configuration Options

| Option | Environment Variable | Default | Description |
|--------|---------------------|---------|-------------|
| `--interval` | - | 30 | Check interval in seconds |
| `--min-amount` | - | 10,000 | Minimum withdrawal (sats) |

### Required Environment Variables

```bash
# Pool signing key (required for BTC signing)
POOL_SIGNING_KEY=<hex-encoded-private-key>

# Pool receive address
POOL_RECEIVE_ADDRESS=tb1q...

# Solana RPC
SOLANA_RPC_URL=https://api.devnet.solana.com
```

### Pipeline Stages

```
┌─────────┐    ┌──────────┐    ┌─────────┐    ┌─────────────┐    ┌──────────┐
│ PENDING │───▶│ BUILDING │───▶│ SIGNING │───▶│ BROADCASTING│───▶│ COMPLETE │
└─────────┘    └──────────┘    └─────────┘    └─────────────┘    └──────────┘
```

### Components

#### 1. Burn Event Watcher
- Polls Solana for RedemptionRequest PDAs
- Validates burn amounts and addresses
- Queues valid requests for processing

#### 2. Transaction Builder
- Selects UTXOs from pool wallet
- Calculates fees (5 sat/vbyte target)
- Builds transaction with proper outputs

#### 3. Transaction Signer
- Signs with pool private key
- Supports future FROST threshold signing

#### 4. Broadcaster
- Broadcasts signed transaction
- Waits for confirmation
- Updates Solana with completion status

### UTXO Management

The processor maintains a UTXO pool for efficient withdrawals:

```rust
pub struct PoolUtxo {
    pub txid: String,
    pub vout: u32,
    pub amount: u64,
    pub script_pubkey: Vec<u8>,
}
```

UTXOs are tracked in-memory and refreshed periodically from Esplora.

---

## Header Relayer (TypeScript)

The header relayer syncs Bitcoin block headers to the Solana light client.

### Location

```
backend/header-relayer/
├── index.ts              # Main entry point
├── init-light-client.ts  # Initialize light client PDA
├── solana.ts            # Solana program interaction
└── mempool.ts           # Bitcoin header fetching
```

### Starting the Relayer

```bash
cd backend/header-relayer

# First time: initialize light client
bun run init

# Start relaying headers
bun run start
```

### Configuration

```bash
# Environment variables
SOLANA_RPC_URL=https://api.devnet.solana.com
RELAYER_KEYPAIR_PATH=~/.config/solana/id.json
BITCOIN_NETWORK=testnet  # or mainnet
```

### How It Works

1. **Fetch Headers**: Get latest headers from mempool.space API
2. **Validate Chain**: Ensure headers connect to known tip
3. **Submit to Solana**: Call `submit_block_header` instruction
4. **Track Progress**: Store last submitted height locally

```typescript
async function relayHeaders() {
  const tipHeight = await getLightClientTip();
  const latestHeight = await getBitcoinHeight();

  for (let h = tipHeight + 1; h <= latestHeight; h++) {
    const header = await getBlockHeader(h);
    await submitHeader(header);
    console.log(`Submitted header ${h}`);
  }
}
```

### Light Client State

The Solana light client maintains:

- **Block Headers**: Last N headers for SPV verification
- **Chain Tip**: Current best block hash and height
- **Difficulty**: For header validation

---

## Monitoring & Operations

### Health Checks

```bash
# API server
curl http://localhost:3001/api/health

# Tracker
curl http://localhost:3001/api/tracker/health
```

### Logs

All services use structured JSON logging:

```json
{
  "timestamp": "2024-01-01T00:00:00Z",
  "level": "INFO",
  "target": "zvault::deposit_tracker",
  "message": "Deposit confirmed",
  "deposit_id": "dep_...",
  "confirmations": 3
}
```

### Metrics

Track via `/api/tracker/stats`:

- Total deposits by status
- Total satoshis received
- Failed deposit count
- Average confirmation time

### Manual Intervention

For failed deposits:
```bash
# List failed deposits
curl http://localhost:3001/api/tracker/failed

# Retry a specific deposit
curl -X POST http://localhost:3001/api/tracker/retry/dep_123
```

---

## Running All Services

### Development

```bash
# Terminal 1: API + Tracker
cargo run -- api &
cargo run -- tracker

# Terminal 2: Header Relayer
cd header-relayer && bun run start

# Terminal 3: Redemption (when needed)
cargo run -- redemption
```

### Production (systemd)

Create service files for each component:

```ini
# /etc/systemd/system/zvault-tracker.service
[Unit]
Description=zVault Deposit Tracker
After=network.target

[Service]
Type=simple
User=zvault
WorkingDirectory=/opt/zvault/backend
ExecStart=/opt/zvault/backend/target/release/zbtc-api tracker
Restart=always
Environment=DEPOSIT_DB_PATH=/var/lib/zvault/deposits.db

[Install]
WantedBy=multi-user.target
```

### Docker

```dockerfile
FROM rust:1.75 as builder
WORKDIR /app
COPY . .
RUN cargo build --release

FROM debian:bookworm-slim
COPY --from=builder /app/target/release/zbtc-api /usr/local/bin/
CMD ["zbtc-api", "tracker"]
```
