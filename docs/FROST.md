# FROST Threshold Signing Server

2-of-3 FROST threshold signing for BTC custody and withdrawals. Each signer runs as an independent HTTP server with policy enforcement, audit logging, and encrypted DKG.

---

## Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        FROST Architecture                                │
│                                                                          │
│   ┌────────────┐    ┌────────────┐    ┌────────────┐                   │
│   │  Signer 1  │    │  Signer 2  │    │  Signer 3  │                   │
│   │  :9001     │    │  :9002     │    │  :9003     │                   │
│   │            │    │            │    │            │                   │
│   │  KeyShare  │    │  KeyShare  │    │  KeyShare  │                   │
│   │  Policy    │    │  Policy    │    │  Policy    │                   │
│   │  Audit Log │    │  Audit Log │    │  Audit Log │                   │
│   └──────┬─────┘    └──────┬─────┘    └──────┬─────┘                   │
│          │                 │                 │                          │
│          └────────┬────────┴────────┬────────┘                         │
│                   │                 │                                   │
│                   ▼                 ▼                                   │
│          ┌──────────────┐  ┌──────────────┐                            │
│          │  Backend     │  │  Group       │                            │
│          │  Coordinator │  │  Public Key  │                            │
│          │  (Rust)      │  │  (Taproot)   │                            │
│          └──────────────┘  └──────────────┘                            │
│                                                                          │
│   Threshold: 2-of-3  │  Curve: secp256k1-tr  │  Protocol: FROST-TR    │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## DKG Ceremony (Distributed Key Generation)

Three-round protocol where each signer generates a key share without any party learning the full private key. Round 2 packages are E2E encrypted — the coordinator never sees plaintext shares.

### Protocol Flow

```
Coordinator                  Signer 1              Signer 2              Signer 3

    │  POST /dkg/round1          │                     │                     │
    ├───────────────────────────▶│                     │                     │
    ├─────────────────────────────────────────────────▶│                     │
    ├───────────────────────────────────────────────────────────────────────▶│
    │                            │                     │                     │
    │  ◄── commitment_pkg       │                     │                     │
    │       + X25519 pubkey     │                     │                     │
    │                            │                     │                     │
    │  POST /dkg/round2          │                     │                     │
    │  (all round1 packages +    │                     │                     │
    │   all X25519 pubkeys)      │                     │                     │
    ├───────────────────────────▶│                     │                     │
    ├─────────────────────────────────────────────────▶│                     │
    ├───────────────────────────────────────────────────────────────────────▶│
    │                            │                     │                     │
    │  ◄── encrypted shares     │                     │                     │
    │      (per-target, AES-GCM) │                     │                     │
    │                            │                     │                     │
    │  POST /dkg/finalize        │                     │                     │
    │  (round1 + encrypted       │                     │                     │
    │   round2 packages)         │                     │                     │
    ├───────────────────────────▶│                     │                     │
    ├─────────────────────────────────────────────────▶│                     │
    ├───────────────────────────────────────────────────────────────────────▶│
    │                            │                     │                     │
    │  ◄── group_public_key     │                     │                     │
    │      (all must match)      │                     │                     │
    │                            │                     │                     │
    │  ✓ Verify all group keys match                                        │
    │  ✓ Output Taproot address                                             │
```

### Encryption Details

Round 2 shares are encrypted end-to-end so the coordinator never sees plaintext:

| Step | Algorithm | Purpose |
|------|-----------|---------|
| Key Agreement | X25519 ECDH | Derive shared secret between signer pairs |
| Key Derivation | HKDF-SHA256 (info: `frost-dkg-round2`) | Stretch shared secret to AES key |
| Encryption | AES-256-GCM (12-byte nonce) | Encrypt share package |
| Output | `nonce(12) \|\| ciphertext \|\| tag(16)` | Wire format |

### Running a DKG Ceremony

```bash
# Option A: Real DKG ceremony (production)
cargo run -- dkg-coordinator \
  --signers "http://localhost:9001,http://localhost:9002,http://localhost:9003" \
  --threshold 2 \
  --password "secure_password"

# Option B: Trusted dealer (development only)
cargo run -- generate-test-keys --output-dir config --threshold 2 --total 3 --password "pw"
```

---

## Signing Protocol

Two-round FROST signing with BIP-341 Taproot tweak support.

### Protocol Flow

```
Backend/Coordinator          Signer 1                    Signer 2

    │                            │                           │
    │  1. POST /round1           │                           │
    │     {session_id, sighash,  │                           │
    │      signing_context?,     │                           │
    │      merkle_root?}         │                           │
    ├───────────────────────────▶│                           │
    ├────────────────────────────────────────────────────────▶│
    │                            │                           │
    │                     ┌──────┴──────┐             ┌──────┴──────┐
    │                     │ Policy Check│             │ Policy Check│
    │                     │ (if enabled)│             │ (if enabled)│
    │                     │ - Sighash   │             │ - Sighash   │
    │                     │ - UTXOs     │             │ - UTXOs     │
    │                     │ - Dest.     │             │ - Dest.     │
    │                     │ - Limits    │             │ - Limits    │
    │                     └──────┬──────┘             └──────┬──────┘
    │                            │                           │
    │  ◄── commitment + id      │                           │
    │                            │                           │
    │  2. POST /verify-commitments (optional)                │
    │     {all commitments}      │                           │
    ├───────────────────────────▶│                           │
    ├────────────────────────────────────────────────────────▶│
    │  ◄── SHA-256 digest       │                           │
    │  ✓ All digests must match (equivocation check)         │
    │                            │                           │
    │  3. POST /round2           │                           │
    │     {commitments from all, │                           │
    │      identifier_map}       │                           │
    ├───────────────────────────▶│                           │
    ├────────────────────────────────────────────────────────▶│
    │                            │                           │
    │  ◄── signature_share      │                           │
    │                            │                           │
    │  4. POST /aggregate        │                           │
    │     {commitments, shares,  │                           │
    │      sighash, merkle_root?}│                           │
    ├───────────────────────────▶│ (any signer can aggregate)│
    │                            │                           │
    │  ◄── 64-byte Schnorr sig  │                           │
    │     + group_public_key     │                           │
```

### Taproot Support (BIP-341)

When `merkle_root` is provided in signing requests:
1. Each signer tweaks their key package before generating nonces
2. Round 2 uses tweaked key for signature share computation
3. Aggregation uses `aggregate_with_tweak()` for final signature
4. Signature verifies against the tweaked output key (not internal key)

---

## Policy Engine

Each signer independently verifies transaction data before generating commitments. This prevents a compromised coordinator from fabricating sighashes.

### Checks Performed

| Check | Description | Error Code |
|-------|-------------|------------|
| **Sighash Verification** | Recomputes BIP-341 Taproot sighash from raw tx + prevouts | `POLICY_SIGHASH_MISMATCH` |
| **UTXO Verification** | Queries Esplora to confirm UTXOs exist on-chain | `POLICY_UTXO_NOT_FOUND` |
| **Destination Whitelist** | Validates non-OP_RETURN outputs against allowed addresses | `POLICY_DESTINATION_NOT_ALLOWED` |
| **Amount Limits** | Total output amount must not exceed configured maximum | `POLICY_AMOUNT_EXCEEDED` |
| **Fee Limits** | Transaction fee must not exceed configured maximum | `POLICY_FEE_EXCEEDED` |
| **Context Required** | Reject blind signing (no `signing_context`) | `POLICY_CONTEXT_REQUIRED` |

### Configuration

```bash
cargo run -- run --id 1 --key-file signer1.key.enc --password <pwd> \
  --esplora-url https://mempool.space/testnet/api \  # Enable UTXO checks
  --pool-address tb1p...                            \  # Whitelist destinations
  --max-amount 1000000000                           \  # 10 BTC limit
  --max-fee 50000                                   \  # 50k sats max fee
  --require-context                                 \  # Reject blind signing
  --network testnet
```

### Operational Modes

| Mode | Policy | Audit | Use Case |
|------|--------|-------|----------|
| **Dev** | None (blind signing OK) | Disabled | Local development |
| **Staging** | Enforced | Enabled | Testing with real UTXOs |
| **Production** | Strict (context required) | Required | Live deployment |

---

## Audit Logging

Append-only JSON-lines log of all policy decisions and signing events.

### Log Format

```json
{"ts":"2024-01-15T10:30:00Z","session_id":"abc-123","action":"policy_check","sighash":"a1b2c3d4e5f6...","result":"allow","destinations":["tb1q..."],"amount_sats":50000,"fee_sats":250}
{"ts":"2024-01-15T10:30:01Z","session_id":"abc-123","action":"round1","signer_id":1,"result":"ok"}
{"ts":"2024-01-15T10:30:02Z","session_id":"abc-123","action":"round2","signer_id":1,"result":"ok"}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `ts` | string | ISO-8601 UTC timestamp |
| `session_id` | string | UUID of signing session |
| `action` | string | `policy_check`, `round1`, `round2` |
| `sighash` | string | First 16 chars of sighash |
| `result` | string | `allow`, `deny`, `ok`, `error` |
| `reason` | string? | Deny reason or error message |
| `destinations` | string[]? | Transaction recipient addresses |
| `amount_sats` | number? | Total output amount |
| `fee_sats` | number? | Transaction fee |
| `signer_id` | number? | Which signer performed action |

### Configuration

```bash
cargo run -- run --id 1 ... --audit-log /var/log/frost/signer-1.jsonl
```

---

## API Reference

### Public Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check (returns `ready` or `no_key`) |

### Protected Endpoints (require `X-API-Key` header if `FROST_API_KEY` is set)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/info` | GET | Signer info: pubkey share, group key, threshold |
| `/round1` | POST | Generate signing commitment |
| `/round2` | POST | Generate signature share |
| `/verify-commitments` | POST | Broadcast channel equivocation check |
| `/aggregate` | POST | Combine shares into final 64-byte Schnorr signature |
| `/dkg/round1` | POST | DKG round 1 (commitment + X25519 key) |
| `/dkg/round2` | POST | DKG round 2 (encrypted shares) |
| `/dkg/finalize` | POST | DKG finalize (decrypt shares, compute key) |

### Request/Response Types

#### Round1Request
```json
{
  "session_id": "uuid",
  "sighash": "hex (32 bytes)",
  "tweak": "hex (32 bytes, optional)",
  "merkle_root": "hex (32 bytes, optional)",
  "signing_context": {
    "raw_tx_hex": "...",
    "prevouts": [{"txid": "...", "vout": 0, "amount_sats": 100000, "script_pubkey_hex": "..."}],
    "input_index": 0
  }
}
```

#### Round1Response
```json
{
  "commitment": "hex (FROST commitment)",
  "signer_id": 1,
  "frost_identifier": "hex (FROST ID for round 2)"
}
```

#### AggregateResponse
```json
{
  "signature": "hex (64 bytes, Schnorr)",
  "group_public_key": "hex (32 bytes, x-only)"
}
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FROST_KEY_PASSWORD` | — | Password for encrypted key files |
| `FROST_API_KEY` | — | API authentication (optional, dev mode if unset) |
| `FROST_NETWORK` | `testnet` | Bitcoin network: `bitcoin`, `testnet`, `signet`, `regtest` |
| `FROST_ESPLORA_URL` | — | Esplora API for UTXO verification |
| `FROST_POOL_ADDRESS` | — | Comma-separated allowed destination addresses |
| `FROST_MAX_AMOUNT` | `1000000000` | Maximum output amount (sats) |
| `FROST_MAX_FEE` | `50000` | Maximum transaction fee (sats) |
| `FROST_REQUIRE_CONTEXT` | — | Reject blind signing if set |
| `FROST_AUDIT_LOG` | — | Audit log file path |
| `RUST_LOG` | `info,frost_server=debug` | Log level filter |

### CLI Flags

```bash
frost-server run [OPTIONS]
```

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--bind` | `-b` | `0.0.0.0:9001` | Bind address (host:port) |
| `--id` | `-i` | — | Signer ID (1-indexed, required) |
| `--key-file` | `-k` | `config/signer{id}.key.enc` | Path to encrypted key file |
| `--password` | `-p` | env: `FROST_KEY_PASSWORD` | Key encryption password |
| `--esplora-url` | — | env: `FROST_ESPLORA_URL` | Esplora API URL |
| `--pool-address` | — | env: `FROST_POOL_ADDRESS` | Allowed destinations (comma-separated) |
| `--max-amount` | — | `1000000000` | Max signing amount (sats) |
| `--max-fee` | — | `50000` | Max fee (sats) |
| `--require-context` | — | `false` | Reject blind signing |
| `--audit-log` | — | — | Audit log file path |
| `--network` | — | `testnet` | Bitcoin network |

### Subcommands

```bash
# Run signer server
frost-server run --id 1 --bind 0.0.0.0:9001 --password <pwd>

# Run DKG ceremony (coordinator)
frost-server dkg-coordinator --signers "url1,url2,url3" --threshold 2 --password <pwd>

# Generate test keys (dev only, trusted dealer)
frost-server generate-test-keys --output-dir config --threshold 2 --total 3 --password <pwd>
```

---

## Security Considerations

1. **No single point of failure**: 2-of-3 threshold means any 1 signer can be compromised without fund loss
2. **Signer-side verification**: Each signer independently recomputes BIP-341 sighash from raw transaction data
3. **E2E encrypted DKG**: Coordinator never sees plaintext key shares (X25519 + AES-256-GCM)
4. **Broadcast equivocation detection**: SHA-256 commitment digest prevents coordinator from sending different data to different signers
5. **Session isolation**: 5-minute timeout, single-use sessions (round 2 cannot be replayed)
6. **Encrypted key storage**: Key shares saved with password-based encryption
7. **Append-only audit**: JSONL log for forensic review of all policy and signing decisions

---

## Source Files

| File | Purpose |
|------|---------|
| `frost_server/src/main.rs` | CLI entry points (run, dkg-coordinator, generate-test-keys) |
| `frost_server/src/server.rs` | Axum HTTP server, handlers, middleware |
| `frost_server/src/signing.rs` | FROST 2-round signing with Taproot tweak |
| `frost_server/src/dkg.rs` | 3-round DKG ceremony with E2E encryption |
| `frost_server/src/policy.rs` | Signing policy engine (sighash, UTXO, whitelist, limits) |
| `frost_server/src/audit.rs` | Append-only JSONL audit logger |
| `frost_server/src/crypto.rs` | X25519/AES-256-GCM encryption, commitment digest |
| `frost_server/src/types.rs` | Request/response types |

---

## Related Documentation

- [Technical Overview](./TECHNICAL.md) - Full system architecture
- [How to Run](./RUNNING.md) - Operational guide
- [Backend Architecture](../backend/docs/ARCHITECTURE.md) - Backend integration with FROST
- [Documentation Index](./INDEX.md) - All docs hub
