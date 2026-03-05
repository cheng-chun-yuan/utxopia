# Aegis Backend Configuration

This document describes all configuration options for the Aegis backend services.

## Configuration Methods

Configuration can be provided via:

1. **Environment Variables** (recommended for production)
2. **Command-line Arguments** (override environment)
3. **`.env` File** (loaded automatically in development)

Priority: CLI args > Environment variables > `.env` file > Defaults

---

## Environment Variables

### Core Settings

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AEGIS_NETWORK` | No | `devnet` | Network mode: `mainnet`, `testnet`, `devnet` |
| `AEGIS_DEMO_MODE` | No | `false` | Enable demo mode (`"1"` to enable; devnet/testnet only) |
| `AEGIS_LOG_LEVEL` | No | `info` | Log level: `debug`, `info`, `warn`, `error` |
| `AEGIS_DEPOSIT_LIMIT_SATS` | No | network-based* | Maximum deposit per transaction |
| `API_PORT` | No | `3001` | REST API server port |

*Deposit limit defaults: mainnet=1,000,000,000 (10 BTC), testnet=10,000,000,000, devnet=100,000,000,000.

### Bitcoin Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AEGIS_BITCOIN_RPC` | No | network-based* | Esplora/Blockstream API endpoint |
| `POOL_SIGNING_KEY` | Yes** | - | Hex-encoded private key for BTC signing (legacy) |
| `POOL_RECEIVE_ADDRESS` | No | testnet faucet | Pool wallet address for swept funds |
| `ESPLORA_URL` | No | `https://mempool.space/testnet/api` | Esplora API endpoint (tracker) |

*Bitcoin API defaults: mainnet=`https://mempool.space/api`, testnet=`https://mempool.space/testnet/api`, devnet=`https://mempool.space/testnet4/api`.

**Required for redemption service, optional for deposit tracker (uses simulated mode). Prefer `AEGIS_BTC_SIGNER_KEY` in FROST config.

### Solana Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AEGIS_SOLANA_RPC` | No | network-based* | Solana RPC endpoint |
| `SOLANA_RPC_URL` | No | `https://api.devnet.solana.com` | Solana RPC (tracker service) |
| `VERIFIER_KEYPAIR` | Yes** | - | Path to Solana keypair JSON file |
| `AEGIS_PROGRAM_ID` | No*** | `AtztELZfz3GHA8hFQCv7aT9Mt47Xhknv3ZCNb3fmXsgf` | Aegis program ID |
| `AEGIS_POOL_STATE` | No*** | `8bbcVecB619HHsHn2TQMraJ8R8WjQjApdZY7h9JCJW7b` | Pool state PDA |
| `AEGIS_COMMITMENT_TREE` | No*** | `HtfDXZ5mBQNBdZrDxJMbXCDkyUqFdTDj7zAqo3aqrqiA` | Commitment tree PDA |
| `AEGIS_ZBTC_MINT` | No*** | `HiDyAcEBTS7SRiLA49BZ5B6XMBAksgwLEAHpvteR8vbV` | zBTC mint address |

*Solana RPC defaults: devnet=`https://api.devnet.solana.com`, testnet=`https://api.testnet.solana.com`, mainnet=`https://api.mainnet-beta.solana.com`.

**Required for SPV verification, optional for tracker-only mode.

***Devnet defaults are used automatically. Required for testnet/mainnet.

### Deposit Tracker Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DEPOSIT_DB_PATH` | No | `data/deposits.db` | SQLite database file path |
| `DEPOSIT_POLL_INTERVAL_SECS` | No | `30` | Address polling interval |
| `DEPOSIT_REQUIRED_CONFIRMATIONS` | No | `3` | Required BTC confirmations |
| `DEPOSIT_REQUIRED_SWEEP_CONFIRMATIONS` | No | `1` | Required sweep confirmations |
| `DEPOSIT_MAX_RETRIES` | No | `5` | Max retry attempts for failed ops |
| `DEPOSIT_RETRY_DELAY_SECS` | No | `60` | Base retry delay (exponential backoff) |
| `DEPOSIT_EXPIRY_HOURS` | No | `24` | Hours before pending deposit expires |

### Redemption Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `REDEMPTION_CHECK_INTERVAL` | No | `30` | Burn event check interval (seconds) |
| `REDEMPTION_MIN_WITHDRAWAL` | No | `10000` | Minimum withdrawal amount (sats) |
| `REDEMPTION_MAX_WITHDRAWAL` | No | `100000000` | Maximum withdrawal amount (sats) |
| `REDEMPTION_FEE_RATE` | No | `5` | Target fee rate (sat/vbyte) |

### FROST Signing Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AEGIS_SIGNING_MODE` | No | `single` (devnet) | Signing mode: `single` or `frost` |
| `AEGIS_BTC_SIGNER_KEY` | Yes* | — | Hex BTC private key (single-key mode) |
| `AEGIS_FROST_THRESHOLD` | Yes** | — | FROST threshold (e.g., 2) |
| `AEGIS_FROST_PARTICIPANTS` | Yes** | — | Total signers (e.g., 3) |
| `AEGIS_FROST_KEY_SHARE` | Yes** | — | Encrypted key share |
| `AEGIS_FROST_SIGNER_URLS` | Yes** | — | Comma-separated signer URLs |
| `AEGIS_FROST_API_KEY` | No | — | Optional API key for FROST servers |
| `AEGIS_FROST_GROUP_PUBKEY` | Yes** | — | Hex x-only group public key (64 chars) |

*Required when `AEGIS_SIGNING_MODE=single`. **Required when `AEGIS_SIGNING_MODE=frost`.

> **Note**: On mainnet, `AEGIS_SIGNING_MODE` defaults to `frost`. Single-key mode is rejected by `validate_for_production()`.

For FROST signer server configuration, see [FROST Server Documentation](../../docs/FROST.md).

### Logging Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RUST_LOG` | No | `info` | Log level filter (trace, debug, info, warn, error) |
| `LOG_FORMAT` | No | `json` | Log format: `json` or `pretty` |
| `LOG_TARGET` | No | - | Filter to specific module (e.g., `aegis::deposit_tracker`) |

---

## Command-Line Arguments

### API Server

```bash
cargo run -- api [OPTIONS]

Options:
  --port <PORT>    Server port (default: 3001, env: API_PORT)
```

### Deposit Tracker

```bash
cargo run -- tracker [OPTIONS]

Options:
  --interval <SECS>        Poll interval (default: 30)
  --confirmations <N>      Required confirmations (default: 3)
  --db-path <PATH>         SQLite database path (default: data/deposits.db)
  --max-retries <N>        Max retry attempts (default: 5)
```

### Redemption Processor

```bash
cargo run -- redemption [OPTIONS]

Options:
  --interval <SECS>        Check interval (default: 30)
  --min-amount <SATS>      Minimum withdrawal (default: 10000)
```

---

## Configuration Files

### .env File (Development)

Create a `.env` file in the backend directory:

```bash
# Network
AEGIS_NETWORK=testnet

# Bitcoin
POOL_SIGNING_KEY=your_private_key_hex
POOL_RECEIVE_ADDRESS=tb1q...
ESPLORA_URL=https://mempool.space/testnet/api

# Solana
SOLANA_RPC_URL=https://api.devnet.solana.com
VERIFIER_KEYPAIR=/path/to/keypair.json

# Deposit Tracker
DEPOSIT_DB_PATH=data/deposits.db
DEPOSIT_POLL_INTERVAL_SECS=30
DEPOSIT_REQUIRED_CONFIRMATIONS=3

# Logging
RUST_LOG=info
LOG_FORMAT=pretty
```

### Example Configurations

#### Development (Testnet)

```bash
# .env.development
AEGIS_NETWORK=testnet
AEGIS_DEMO_MODE=false
API_PORT=3001

ESPLORA_URL=https://mempool.space/testnet/api
SOLANA_RPC_URL=https://api.devnet.solana.com

DEPOSIT_DB_PATH=data/deposits-dev.db
DEPOSIT_POLL_INTERVAL_SECS=15
DEPOSIT_REQUIRED_CONFIRMATIONS=1

RUST_LOG=debug
LOG_FORMAT=pretty
```

#### Production (Mainnet)

```bash
# .env.production
AEGIS_NETWORK=mainnet
AEGIS_DEMO_MODE=false
API_PORT=8080

POOL_SIGNING_KEY=${VAULT_BTC_KEY}  # Use secret manager
POOL_RECEIVE_ADDRESS=bc1q...

ESPLORA_URL=https://mempool.space/api
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
VERIFIER_KEYPAIR=/etc/aegis/verifier.json

DEPOSIT_DB_PATH=/var/lib/aegis/deposits.db
DEPOSIT_POLL_INTERVAL_SECS=30
DEPOSIT_REQUIRED_CONFIRMATIONS=6

RUST_LOG=warn
LOG_FORMAT=json
```

#### Demo Mode

```bash
# .env.demo
AEGIS_NETWORK=testnet
AEGIS_DEMO_MODE=true
API_PORT=3001

# No signing key needed in demo mode
DEPOSIT_DB_PATH=:memory:
DEPOSIT_POLL_INTERVAL_SECS=5

RUST_LOG=info
LOG_FORMAT=pretty
```

---

## Network-Specific Defaults

### Testnet

| Setting | Value |
|---------|-------|
| Esplora URL | `https://mempool.space/testnet/api` |
| Solana RPC | `https://api.devnet.solana.com` |
| Required Confirmations | 3 |
| Address Prefix | `tb1p...` (Taproot) |

### Mainnet

| Setting | Value |
|---------|-------|
| Esplora URL | `https://mempool.space/api` |
| Solana RPC | `https://api.mainnet-beta.solana.com` |
| Required Confirmations | 6 |
| Address Prefix | `bc1p...` (Taproot) |

### Regtest (Local)

| Setting | Value |
|---------|-------|
| Esplora URL | `http://localhost:3000` |
| Solana RPC | `http://localhost:8899` |
| Required Confirmations | 1 |
| Address Prefix | `bcrt1p...` (Taproot) |

---

## Security Recommendations

### Secrets Management

**Never commit secrets to git!**

1. Use environment variables injected at runtime
2. Use a secrets manager (Vault, AWS Secrets Manager, etc.)
3. Use `.env.local` (gitignored) for development

```bash
# Example: Load from Vault
export POOL_SIGNING_KEY=$(vault kv get -field=key secret/aegis/btc)
```

### Key Rotation

1. Generate new signing keys periodically
2. Update `POOL_SIGNING_KEY` environment variable
3. Transfer UTXOs to new key's address
4. Restart services

### Access Control

1. Run services as non-root user
2. Restrict file permissions on keypair files
3. Use firewall rules to limit API access
4. Enable rate limiting in production

```bash
# Secure keypair file
chmod 600 /etc/aegis/verifier.json
chown aegis:aegis /etc/aegis/verifier.json
```

---

## Validation

The configuration is validated at startup. Invalid configurations will cause the service to exit with an error message.

### Common Validation Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `Invalid signing key format` | Malformed hex in `POOL_SIGNING_KEY` | Check for correct 64-character hex |
| `Database path not writable` | Permission issue | Check directory permissions |
| `Invalid Solana RPC URL` | Malformed URL | Check URL format |
| `Keypair file not found` | Wrong path in `VERIFIER_KEYPAIR` | Verify file path exists |

### Testing Configuration

```bash
# Validate configuration without starting services
cargo run -- demo

# Check environment loading
env | grep -E "^(AEGIS|POOL|SOLANA|DEPOSIT)"
```

---

## Programmatic Configuration

Configuration can also be created programmatically in Rust:

```rust
use zbtc::common::AEGISConfig;
use zbtc::deposit_tracker::TrackerConfig;

// Load from environment
let config = AEGISConfig::from_env()?;

// Or create manually
let tracker_config = TrackerConfig {
    db_path: "data/deposits.db".to_string(),
    poll_interval_secs: 30,
    required_confirmations: 3,
    required_sweep_confirmations: 1,
    max_retries: 5,
    retry_delay_secs: 60,
    ..Default::default()
};
```
