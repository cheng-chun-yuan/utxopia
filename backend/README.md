# zkBTC Backend

Rust backend for the privacy-preserving BTC to Solana bridge.

## Simplified Flow

```
1. User generates: nullifier + secret (random 32 bytes each)
2. User computes: commitment = Hash(nullifier, secret)
3. Backend returns: taproot address for commitment
4. User sends BTC to taproot address
5. Relayer detects BTC, records (commitment, amount) on-chain
6. User claims with: nullifier + secret → amount looked up from chain
```

**Privacy Guarantee:**
- `commitment ≠ nullifier_hash` (different hash functions)
- Without knowing 'secret', you cannot link deposit → claim
- Amount is public at deposit time but claim is unlinkable

## Quick Start

### Prerequisites

- Rust 1.70+
- Solana CLI (for Anchor programs)
- Anchor framework

### Build

```bash
cargo build
```

### Run API Server

```bash
cargo run --bin zkbtc-api
```

The API server starts on `http://localhost:8080`.

### Run Demo

```bash
cargo run --bin zkbtc-api -- demo
```

## API Endpoints

### Health & Status
- `GET /api/health` - Health check
- `GET /api/stats` - Service statistics
- `GET /api/pool` - Pool information

### Deposit Flow
- `POST /api/deposit/prepare` - Get taproot address for commitment
- `POST /api/deposit/record` - Record deposit after BTC confirms (relayer)
- `GET /api/deposit/status/:commitment` - Check deposit status

### Claim Flow
- `POST /api/claim` - Claim zkBTC with nullifier + secret
- `POST /api/claim/verify` - Verify claim would succeed

### Redemption Flow (zkBTC → BTC)
- `POST /api/redeem` - Submit withdrawal request
- `GET /api/withdrawal/status/:id` - Check withdrawal status

## Key Components

### Cryptographic Primitives (`src/crypto.rs`)

```rust
// Commitment = Hash(nullifier, secret)
pub struct Commitment(pub [u8; 32]);

// Leaf = Hash(commitment, amount) - for Merkle tree
pub struct Leaf(pub [u8; 32]);

// NullifierHash = Hash(nullifier) - revealed at claim time
pub fn nullifier_hash(nullifier: &Nullifier) -> [u8; 32];
```

### Note Structure (`src/note.rs`)

```rust
pub struct StealthNote {
    pub nullifier: Nullifier,  // 32 bytes
    pub secret: Secret,        // 32 bytes
}

impl StealthNote {
    pub fn new() -> Self;                    // Generate random
    pub fn commitment(&self) -> Commitment;  // Hash(nullifier, secret)
    pub fn nullifier_hash(&self) -> [u8; 32];
}

// Claim link format: ?n=<nullifier>&s=<secret>
pub struct ClaimLink {
    pub nullifier: String,  // hex
    pub secret: String,     // hex
}
```

### Pool (`src/pool.rs`)

```rust
pub struct DepositRecord {
    pub commitment: [u8; 32],
    pub amount: u64,
    pub leaf: [u8; 32],
    pub leaf_index: u64,
}

impl StealthPool {
    pub fn record_deposit(&mut self, commitment: &Commitment, amount: u64)
        -> Result<DepositRecord, PoolError>;

    pub fn get_deposit_amount(&self, commitment: &str) -> Option<u64>;

    pub fn spend_nullifier(&mut self, nullifier_hash: [u8; 32])
        -> Result<(), PoolError>;
}
```

## Testing

```bash
# Run all tests
cargo test

# Run with output
cargo test -- --nocapture
```

## Security

**WARNING: This is a proof-of-concept for hackathon demonstration.**

Current limitations:
- Uses deterministic keys (POC only)
- Simulated integrations
- No production security audits

For production:
- Implement FROST threshold signatures
- Real MPC key generation
- Security audits
- Rate limiting
