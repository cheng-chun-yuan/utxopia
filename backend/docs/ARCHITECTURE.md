# Aegis Backend Architecture

## Overview

The Aegis backend provides server-side services for the privacy-preserving Bitcoin-to-Solana bridge. It handles operations that cannot run on the client, including Bitcoin transaction signing, SPV verification submission, and real-time deposit tracking.

## High-Level Architecture

```
                                    ┌─────────────────────────────────────────────────────────┐
                                    │                    Aegis Backend                        │
                                    │                                                         │
┌──────────────┐                   │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│   Frontend   │───HTTP/WS────────▶│  │  API Layer  │  │  Deposit    │  │  Event      │    │
│  (Next.js)   │                   │  │  (Axum)     │──│  Tracker    │──│  Indexer    │    │
└──────────────┘                   │  └─────────────┘  └─────────────┘  └─────────────┘    │
                                    │         │               │                             │
                                    │         ▼               ▼                             │
                                    │  ┌─────────────┐  ┌─────────────┐                    │
                                    │  │   Bitcoin   │  │   Solana    │                    │
                                    │  │   Layer     │  │   Layer     │                    │
                                    │  └─────────────┘  └─────────────┘                    │
                                    │         │               │                             │
                                    └─────────┼───────────────┼─────────────────────────────┘
                                              │               │
                                              ▼               ▼
                                    ┌─────────────┐  ┌─────────────┐
                                    │   Bitcoin   │  │   Solana    │
                                    │  (Testnet)  │  │  (Devnet)   │
                                    └─────────────┘  └─────────────┘
```

## Module Structure

```
backend/src/
├── lib.rs                    # Library root with re-exports
├── main.rs                   # CLI entry point (tracker subcommand)
├── config.rs                 # AEGISConfig (env-based, SigningMode)
├── api_server.rs             # Combined API server (REST + WS, all routers merged)
├── merkle_tree.rs            # Poseidon Merkle tree (depth 16)
│
├── common/                   # Shared Infrastructure
│   ├── error.rs             # Common error types (AegisError)
│   └── logging.rs           # Structured JSON logging
│
├── bitcoin/                  # Bitcoin Layer
│   ├── client.rs            # Esplora API client (address watching, UTXO, broadcast)
│   ├── signer.rs            # Transaction signing (SingleKey, FROST)
│   ├── frost_client.rs      # FROST threshold signing client
│   ├── taproot.rs           # Taproot address generation (npk-tweaked)
│   └── spv.rs               # SPV proof generation (Merkle proofs)
│
├── solana/                   # Solana Layer
│   └── client.rs            # Solana RPC client
│
├── api/                      # API Layer
│   └── middleware.rs         # Rate limiting, input validation, security headers
│
├── deposit_tracker/          # Deposit Tracking Service
│   ├── service.rs           # Main orchestrator (poll + process lifecycle)
│   ├── api.rs               # REST endpoints (/api/deposits, /api/pool/info)
│   ├── watcher.rs           # Esplora address polling
│   ├── sweeper.rs           # UTXO sweep (SingleKey or FROST)
│   ├── verifier.rs          # SPV proof submission (npk + ephemeral_pub)
│   ├── websocket.rs         # Real-time status updates
│   ├── ws_listener.rs       # mempool.space WebSocket (real-time deposits + blocks)
│   ├── header_relayer.rs    # Bitcoin header relay to Solana light client
│   ├── db.rs                # In-memory deposit store
│   ├── sqlite_db.rs         # SQLite persistence
│   └── types.rs             # Service-specific types
│
├── redemption/               # Redemption Service
│   ├── service.rs           # Main orchestrator (Solana PDA scanner)
│   ├── builder.rs           # BTC transaction construction
│   ├── signer.rs            # Transaction signing (SingleKey, MpcSigner)
│   ├── queue.rs             # Request queue management
│   ├── watcher.rs           # Solana burn event watcher
│   ├── tracking.rs          # Redemption tracking store
│   ├── ws_redemption.rs     # WebSocket listener for redemption events
│   └── types.rs             # Service-specific types
│
├── stealth/                  # Stealth Deposit Service
│   ├── service.rs           # Stealth address handling
│   ├── api.rs               # REST endpoints
│   └── types.rs             # Stealth-specific types
│
├── event_indexer/            # On-Chain Event Indexer
│   ├── service.rs           # Solana log parser and indexer
│   ├── parser.rs            # sol_log_data event parsing
│   ├── storage.rs           # SQLite storage for leaves, nullifiers, announcements
│   ├── routes.rs            # REST endpoints (/tree/*, /nullifiers/*)
│   ├── solana_ws.rs         # Solana logsSubscribe WebSocket
│   └── tree_cache.rs        # In-memory Merkle tree cache
│
└── bin/
    └── redemption.rs        # Standalone redemption binary
```

## Data Flow

### 1. Deposit Flow (npk-based)

```
User                    Frontend/SDK              Backend                 Bitcoin/Solana
 │                           │                       │                         │
 │  Generate Deposit        │                       │                         │
 │  (npk via ECDH)          │                       │                         │
 │─────────────────────────▶│                       │                         │
 │                           │  Register Deposit    │                         │
 │                           │──────────────────────▶│                         │
 │                           │  Taproot Address     │                         │
 │                           │◀──────────────────────│                         │
 │                           │                       │                         │
 │  Send BTC (any amount)   │                       │                         │
 │  + OP_RETURN: eph(32)    │                       │                         │
 │    + npk(32) = 64 bytes  │                       │                         │
 │──────────────────────────────────────────────────────────────────────────▶│
 │                           │                       │  Watch Address         │
 │                           │                       │◀────────────────────────│
 │                           │                       │  Sweep (P2TR, no OP_R) │
 │                           │                       │────────────────────────▶│
 │                           │                       │  Submit SPV Proof      │
 │                           │                       │  (npk + ephemeral_pub) │
 │                           │                       │────────────────────────▶│
 │                           │                       │                         │
 │                           │                       │  On-chain: compute     │
 │                           │                       │  Poseidon(npk, token,  │
 │                           │                       │  amount) → commitment  │
 │                           │                       │  → Merkle tree insert  │
 │                           │                       │  → stealth event       │
 │                           │  WebSocket: Ready    │                         │
 │                           │◀──────────────────────│                         │
```

### 2. Redemption Flow

```
User                    Frontend/SDK              Backend                 Bitcoin/Solana
 │                           │                       │                         │
 │  Request Withdrawal      │                       │                         │
 │─────────────────────────▶│                       │                         │
 │                           │  Burn zkBTC (PDA)    │                         │
 │                           │──────────────────────────────────────────────▶│
 │                           │                       │  Detect Burn Event     │
 │                           │                       │◀────────────────────────│
 │                           │                       │  Sign BTC TX           │
 │                           │                       │────────────────────────▶│
 │  Receive BTC             │                       │                         │
 │◀─────────────────────────────────────────────────────────────────────────│
```

## Key Components

### Bitcoin Layer

| Component | Purpose |
|-----------|---------|
| `EsploraClient` | HTTP client for Esplora API (address watching, UTXO fetching, TX broadcast) |
| `SingleKeySigner` | Single-key transaction signing (development) |
| `FrostClient` | FROST threshold signing client (broadcast verification, session retry) |
| `Signer` trait | Abstraction for single-key / FROST signing modes |
| `TaprootDeposit` | Taproot address generation with npk-tweaked keys |
| `SpvProofGenerator` | Merkle proof generation for SPV verification |

### Solana Layer

| Component | Purpose |
|-----------|---------|
| `SolClient` | Solana RPC client for program interaction |

### API Layer

| Component | Purpose |
|-----------|---------|
| `RateLimiter` | Per-IP rate limiting with burst allowance |
| `validate_*` | Input validation for addresses, amounts, hex |

## Error Handling

The `AegisError` enum provides unified error handling:

```rust
pub enum AegisError {
    BitcoinRpc(String),
    TransactionBuild(String),
    SigningFailed(String),
    SolanaRpc(String),
    ProgramError(String),
    DatabaseError(String),
    NotFound(String),
    InvalidInput(String),
    Internal(String),
}
```

## Security Considerations

1. **API Key Auth**: Protected endpoints require `X-API-Key` header
2. **Rate Limiting**: All endpoints protected by per-IP rate limiting
3. **Input Validation**: Strict validation of addresses, amounts, hex data
4. **CORS**: Configurable CORS for cross-origin requests
5. **Security Headers**: HSTS, CSP, X-Frame-Options
6. **Key Storage**: Signing keys loaded from environment variables
7. **No Secret Logging**: Sensitive data excluded from logs
