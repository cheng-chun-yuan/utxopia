# UTXOpia Backend

Rust backend for the privacy-preserving BTC-to-Solana bridge.

## Overview

The backend provides server-side services that cannot run on the client:
- **API Server** — REST + WebSocket endpoints for frontend
- **Deposit Tracker** — Monitors BTC deposits, sweeps UTXOs, submits SPV proofs
- **Redemption Processor** — Processes zkBTC burns and sends BTC via FROST signing
- **Header Relayer** — Syncs Bitcoin block headers to Solana light client (TypeScript)

## Deposit Flow (npk-based)

```
1. SDK generates npk via ECDH with recipient's viewing key
2. User sends BTC to Taproot address with OP_RETURN: ephemeral_pub(32) + npk(32)
3. Deposit Tracker detects tx, waits for confirmations
4. Sweeper moves funds to pool wallet (single-key or FROST signing)
5. SPV Verifier submits proof to Solana with npk + ephemeral_pub
6. On-chain: commitment = Poseidon(npk, ZKBTC_TOKEN_ID, amount) → Merkle tree
7. Recipient scans stealth announcement events using viewing key
```

## Quick Start

```bash
# Build
cargo build

# Run API server (port 3001)
cargo run -- api

# Run deposit tracker
cargo run -- tracker

# Run redemption processor
POOL_SIGNING_KEY=<hex> cargo run -- redemption
```

## Documentation

- [Architecture](./docs/ARCHITECTURE.md) — Module structure and data flow
- [Services](./docs/SERVICES.md) — Deposit tracker, sweeper, SPV verifier, redemption
- [API Reference](./docs/API.md) — REST endpoints and WebSocket
- [Configuration](./docs/CONFIGURATION.md) — Environment variables and network defaults
- [FROST Server](../docs/FROST.md) — Threshold signing documentation
- [Full Technical Docs](../docs/TECHNICAL.md) — System-wide architecture

## Testing

```bash
cargo test
```
