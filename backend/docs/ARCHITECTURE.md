# zVault Backend Architecture

## Overview

The zVault backend provides server-side services for the privacy-preserving Bitcoin-to-Solana bridge. It handles operations that cannot run on the client, including Bitcoin transaction signing, SPV verification submission, and real-time deposit tracking.

## High-Level Architecture

```
                                    ┌─────────────────────────────────────────────────────────┐
                                    │                    zVault Backend                        │
                                    │                                                         │
┌──────────────┐                   │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│   Frontend   │───HTTP/WS────────▶│  │  API Layer  │  │  Services   │  │   Storage   │    │
│  (Next.js)   │                   │  │  (Axum)     │──│  (Domain)   │──│  (SQLite)   │    │
└──────────────┘                   │  └─────────────┘  └─────────────┘  └─────────────┘    │
                                    │         │               │                             │
┌──────────────┐                   │         ▼               ▼                             │
│  Mobile App  │───HTTP/WS────────▶│  ┌─────────────┐  ┌─────────────┐                    │
│   (Expo)     │                   │  │   Bitcoin   │  │   Solana    │                    │
└──────────────┘                   │  │   Layer     │  │   Layer     │                    │
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
├── main.rs                   # CLI entry point
│
├── common/                   # Shared Infrastructure
│   ├── config.rs            # Unified configuration management
│   ├── error.rs             # Common error types (ZVaultError)
│   ├── logging.rs           # Structured JSON logging
│   └── mod.rs               # Re-exports
│
├── bitcoin/                  # Bitcoin Layer
│   ├── client.rs            # Esplora API client
│   ├── signer.rs            # Transaction signing (SingleKey, FROST-ready)
│   ├── taproot.rs           # Taproot address generation with commitments
│   ├── spv.rs               # SPV proof generation
│   └── mod.rs               # Re-exports
│
├── solana/                   # Solana Layer
│   ├── client.rs            # Solana RPC client
│   └── mod.rs               # Re-exports
│
├── storage/                  # Storage Layer
│   ├── traits.rs            # DepositStore, StealthStore traits
│   ├── sqlite.rs            # SQLite implementation
│   ├── memory.rs            # In-memory implementation (testing)
│   └── mod.rs               # Re-exports
│
├── types/                    # Shared Types
│   ├── deposit.rs           # DepositRecord, DepositStatus
│   ├── redemption.rs        # WithdrawalRequest, WithdrawalStatus
│   ├── stealth.rs           # StealthDepositRecord, StealthData
│   ├── units.rs             # BTC/satoshi conversion utilities
│   └── mod.rs               # Re-exports
│
├── services/                 # Domain Services (re-exports)
│   └── mod.rs               # Re-exports from deposit_tracker/, redemption/, stealth/
│
├── api/                      # API Layer
│   ├── middleware.rs        # Rate limiting, input validation
│   ├── server.rs            # Application state, server setup
│   ├── websocket.rs         # Real-time WebSocket handlers
│   ├── routes/              # Route handlers (planned)
│   └── mod.rs               # Re-exports
│
├── deposit_tracker/          # Deposit Tracking Service
│   ├── service.rs           # Main orchestrator
│   ├── watcher.rs           # Esplora address polling
│   ├── sweeper.rs           # UTXO sweep transactions
│   ├── verifier.rs          # SPV proof submission to Solana
│   ├── websocket.rs         # Real-time status updates
│   ├── api.rs               # REST endpoints
│   ├── db.rs                # In-memory store
│   ├── sqlite_db.rs         # SQLite persistence
│   └── types.rs             # Service-specific types
│
├── redemption/               # Redemption Service
│   ├── service.rs           # Main orchestrator
│   ├── builder.rs           # BTC transaction construction
│   ├── signer.rs            # Transaction signing
│   ├── queue.rs             # Request queue management
│   ├── watcher.rs           # Solana burn event watcher
│   └── types.rs             # Service-specific types
│
└── stealth/                  # Stealth Deposit Service
    ├── service.rs           # Stealth address handling
    ├── api.rs               # REST endpoints
    └── types.rs             # Stealth-specific types
```

## Data Flow

### 1. Deposit Flow

```
User                    Frontend/SDK              Backend                 Bitcoin/Solana
 │                           │                       │                         │
 │  Generate Note           │                       │                         │
 │  (nullifier + secret)    │                       │                         │
 │─────────────────────────▶│                       │                         │
 │                           │                       │                         │
 │                           │  Register Deposit    │                         │
 │                           │──────────────────────▶│                         │
 │                           │                       │                         │
 │                           │  Taproot Address     │                         │
 │                           │◀──────────────────────│                         │
 │                           │                       │                         │
 │  Send BTC                │                       │                         │
 │──────────────────────────────────────────────────────────────────────────▶│
 │                           │                       │                         │
 │                           │                       │  Watch Address         │
 │                           │                       │◀────────────────────────│
 │                           │                       │                         │
 │                           │                       │  Sweep to Pool         │
 │                           │                       │────────────────────────▶│
 │                           │                       │                         │
 │                           │                       │  Submit SPV Proof      │
 │                           │                       │────────────────────────▶│
 │                           │                       │                         │
 │                           │  WebSocket: Ready    │                         │
 │                           │◀──────────────────────│                         │
```

### 2. Claim Flow (Client-Side)

```
User                    Frontend/SDK              Solana
 │                           │                       │
 │  Claim with Note         │                       │
 │─────────────────────────▶│                       │
 │                           │                       │
 │                           │  Generate ZK Proof   │
 │                           │  (circom/Groth16)      │
 │                           │                       │
 │                           │  Submit Claim TX     │
 │                           │──────────────────────▶│
 │                           │                       │
 │                           │  Receive zkBTC      │
 │                           │◀──────────────────────│
```

### 3. Redemption Flow

```
User                    Frontend/SDK              Backend                 Bitcoin/Solana
 │                           │                       │                         │
 │  Request Withdrawal      │                       │                         │
 │─────────────────────────▶│                       │                         │
 │                           │                       │                         │
 │                           │  Burn zkBTC (PDA)    │                         │
 │                           │──────────────────────────────────────────────▶│
 │                           │                       │                         │
 │                           │                       │  Detect Burn Event     │
 │                           │                       │◀────────────────────────│
 │                           │                       │                         │
 │                           │                       │  Sign BTC TX           │
 │                           │                       │────────────────────────▶│
 │                           │                       │                         │
 │  Receive BTC             │                       │                         │
 │◀─────────────────────────────────────────────────────────────────────────│
```

## Key Components

### Bitcoin Layer

| Component | Purpose |
|-----------|---------|
| `EsploraClient` | HTTP client for Esplora API (address watching, UTXO fetching, TX broadcast) |
| `SingleKeySigner` | Single-key transaction signing (production-ready) |
| `Signer` trait | Abstraction for FROST threshold signing migration |
| `TaprootDeposit` | Taproot address generation with embedded commitments |
| `SpvProofGenerator` | Merkle proof generation for SPV verification |

### Solana Layer

| Component | Purpose |
|-----------|---------|
| `SolClient` | Solana RPC client for program interaction |
| `record_deposit` | Submit verified deposit to zVault program |
| `verify_btc_deposit` | Submit SPV proof for verification |

### Storage Layer

| Component | Purpose |
|-----------|---------|
| `DepositStore` trait | Abstract deposit record persistence |
| `StealthStore` trait | Abstract stealth deposit persistence |
| `SqliteDepositStore` | SQLite implementation with connection pooling |
| `StealthDepositStore` | In-memory implementation for stealth deposits |

### API Layer

| Component | Purpose |
|-----------|---------|
| `RateLimiter` | Per-IP rate limiting with burst allowance |
| `validate_*` | Input validation for addresses, amounts, hex |
| `WebSocketState` | Broadcast channel for real-time updates |
| `AppState` | Shared application state across handlers |

## Error Handling

The `ZVaultError` enum provides unified error handling:

```rust
pub enum ZVaultError {
    // Bitcoin errors
    BitcoinRpc(String),
    TransactionBuild(String),
    SigningFailed(String),

    // Solana errors
    SolanaRpc(String),
    ProgramError(String),

    // Storage errors
    DatabaseError(String),
    NotFound(String),

    // Validation errors
    InvalidInput(String),

    // Other
    Internal(String),
}
```

Each error includes:
- Error code for programmatic handling
- Human-readable message
- Retry guidance (is_retryable method)

## Security Considerations

1. **Rate Limiting**: All endpoints protected by per-IP rate limiting
2. **Input Validation**: Strict validation of addresses, amounts, hex data
3. **CORS**: Configurable CORS for cross-origin requests
4. **Security Headers**: HSTS, CSP, X-Frame-Options, etc.
5. **Key Storage**: Signing keys loaded from environment variables
6. **No Secret Logging**: Sensitive data excluded from logs

## Performance

- **Connection Pooling**: r2d2 pool for SQLite connections
- **Async Runtime**: Tokio for concurrent request handling
- **Broadcast Channels**: Efficient pub/sub for WebSocket updates
- **Parallel Requests**: Independent operations run concurrently
