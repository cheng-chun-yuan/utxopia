# FROST Server for zVault

FROST (Flexible Round-Optimized Schnorr Threshold) threshold signing server for secure Bitcoin operations in zVault.

## Overview

- **2-of-3 threshold signing**: Requires 2 of 3 signers to produce a valid signature
- **Taproot compatible**: Uses `frost-secp256k1-tr` for Taproot-tweaked signatures
- **Dual-path addresses**: Supports vault sweep (immediate) and user refund (after 24hr)

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        zVault Backend                           │
│           ┌─────────────────────┐                               │
│           │  FrostClient        │  ← Coordinates FROST rounds   │
│           │  (implements Signer)│  ← Aggregates signatures      │
│           └──────────┬──────────┘                               │
└──────────────────────┼──────────────────────────────────────────┘
                       │ HTTP/JSON
         ┌─────────────┼─────────────┐
         ▼             ▼             ▼
┌────────────┐  ┌────────────┐  ┌────────────┐
│  Signer 1  │  │  Signer 2  │  │  Signer 3  │
│ (port 9001)│  │ (port 9002)│  │ (port 9003)│
└────────────┘  └────────────┘  └────────────┘
```

## Quick Start

### 1. Generate Test Keys (Development Only)

```bash
cd frost_server
cargo run -- generate-test-keys --threshold 2 --total 3 --password your-password
```

This creates:
- `config/signer1.key.enc`
- `config/signer2.key.enc`
- `config/signer3.key.enc`
- `config/group_pubkey.txt`

### 2. Start Signers

```bash
# Terminal 1
FROST_KEY_PASSWORD=your-password cargo run -- run --id 1 --bind 0.0.0.0:9001

# Terminal 2
FROST_KEY_PASSWORD=your-password cargo run -- run --id 2 --bind 0.0.0.0:9002

# Terminal 3
FROST_KEY_PASSWORD=your-password cargo run -- run --id 3 --bind 0.0.0.0:9003
```

### 3. Configure Backend

```bash
export FROST_SIGNER_URLS=http://localhost:9001,http://localhost:9002,http://localhost:9003
export FROST_GROUP_PUBKEY=$(cat frost_server/config/group_pubkey.txt)
export FROST_THRESHOLD=2
export ZVAULT_SIGNING_MODE=frost
```

## Production DKG Ceremony

For production, use distributed key generation instead of trusted dealer:

```bash
# Start signers in DKG mode (each in separate terminal/machine)
FROST_KEY_PASSWORD=secure-pw cargo run -- run --id 1 --bind 0.0.0.0:9001
FROST_KEY_PASSWORD=secure-pw cargo run -- run --id 2 --bind 0.0.0.0:9002
FROST_KEY_PASSWORD=secure-pw cargo run -- run --id 3 --bind 0.0.0.0:9003

# Run DKG coordinator
cargo run -- dkg-coordinator \
  --signers http://signer1:9001,http://signer2:9002,http://signer3:9003 \
  --threshold 2 \
  --password secure-pw
```

## API Endpoints

### Health & Info

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/info` | GET | Signer info and public key |

### Signing (2 rounds)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/round1` | POST | Generate FROST commitment |
| `/round2` | POST | Generate signature share |

### DKG (Key Generation)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/dkg/round1` | POST | DKG round 1 |
| `/dkg/round2` | POST | DKG round 2 |
| `/dkg/finalize` | POST | Finalize and save key |

## Address Derivation

The FROST group public key is used to derive Taproot deposit addresses with dual spending paths:

1. **Key Path (Vault Sweep)**: Pool can spend immediately using FROST threshold signature
2. **Script Path (User Refund)**: User can refund after 144 blocks (~24hr) with their signature

```
Address = P2TR(
  internal_key = FROST_GROUP_PUBKEY,
  scripts = [
    refund_script: <user_pubkey> OP_CHECKSIGVERIFY <144> OP_CSV
  ],
  tweak = H(output_key || commitment)
)
```

## Security Considerations

1. **Key Share Encryption**: AES-256-GCM with password-derived key
2. **Transport Security**: Use HTTPS in production
3. **Authentication**: Implement shared secret for coordinator requests
4. **Rate Limiting**: Prevent DoS attacks
5. **Audit Logging**: Log all signing requests

## Environment Variables

### Signer

| Variable | Description |
|----------|-------------|
| `FROST_KEY_PASSWORD` | Password for key share encryption |
| `RUST_LOG` | Log level (e.g., `info,frost_server=debug`) |

### Backend

| Variable | Description |
|----------|-------------|
| `FROST_SIGNER_URLS` | Comma-separated signer URLs |
| `FROST_GROUP_PUBKEY` | X-only group public key (hex) |
| `FROST_THRESHOLD` | Signing threshold (default: 2) |
| `ZVAULT_SIGNING_MODE` | Set to `frost` for threshold signing |

## Testing

```bash
# Unit tests
cargo test

# Integration tests (requires running signers)
cargo test --test integration -- --ignored
```

## License

MIT
