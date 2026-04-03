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
    │                     │ (zero-trust)│             │ (zero-trust)│
    │                     │ 1. Sighash  │             │ 1. Sighash  │
    │                     │ 2. UTXOs    │             │ 2. UTXOs    │
    │                     │ 3. Addr/Dst │             │ 3. Addr/Dst │
    │                     │ 4-5. Limits │             │ 4-5. Limits │
    │                     │ 6. PDA ✓    │             │ 6. PDA ✓    │
    │                     │ 7. Dup ✓    │             │ 7. Dup ✓    │
    │                     │ 8. Cross ✓  │             │ 8. Cross ✓  │
    │                     │ 9. Mempool  │             │ 9. Mempool  │
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

## Policy Engine (Zero-Trust)

Each signer independently verifies transaction data before generating commitments. **No signer trusts the backend coordinator** — every signer validates on-chain state, transaction structure, and signing history independently.

### Checks Performed

Checks are executed in order. A failure at any step rejects the signing request.

| # | Check | Applies To | Description | Error Code |
|---|-------|-----------|-------------|------------|
| 1 | **Sighash Verification** | All | Recomputes BIP-341 Taproot sighash from raw tx + prevouts | `POLICY_SIGHASH_MISMATCH` |
| 2 | **UTXO Verification** | All | Queries Esplora to confirm UTXOs exist on-chain with correct amounts | `POLICY_UTXO_NOT_FOUND` |
| 3a | **Address Validity** | All | All non-OP_RETURN outputs must parse as valid Bitcoin addresses | `POLICY_INVALID_ADDRESS` |
| 3b | **Destination Whitelist** | Sweeps | Non-OP_RETURN outputs checked against allowed pool address(es) | `POLICY_DESTINATION_NOT_ALLOWED` |
| 4 | **Amount Limits** | All | Total output must not exceed configured maximum | `POLICY_AMOUNT_EXCEEDED` |
| 5 | **Fee Limits** | All | Transaction fee must not exceed configured maximum | `POLICY_FEE_EXCEEDED` |
| 6 | **Solana PDA Verification** | Withdrawals | RedemptionRequest PDA must exist on-chain with status=Processing | `POLICY_SOLANA_REDEMPTION_NOT_FOUND` |
| 7 | **Duplicate Signing Prevention** | Withdrawals | (requester, nonce) must not have been signed before (in-memory set from audit log) | `POLICY_DUPLICATE_SIGNING` |
| 8 | **Cross-Validation** | Withdrawals | Tx output scriptPubKey and amount must match on-chain PDA's `btc_script` and `amount_sats` | `POLICY_CROSS_VALIDATION_FAILED` |
| 9 | **Mempool/Previous TX Check** | Withdrawals | Destination address must not already have received payments (Esplora query) | `POLICY_ALREADY_PAID` |

### Sweep vs Withdrawal Policy

| Concern | Sweep (Deposit) | Withdrawal (Redemption) |
|---------|----------------|------------------------|
| Destination constraint | Static whitelist (pool address) | Dynamic: must match on-chain PDA `btc_script` |
| Duplicate protection | Not needed (UTXO consumed = idempotent) | In-memory set + audit log persistence |
| On-chain verification | Optional (DepositIntent PDA) | Required (RedemptionRequest PDA must be Processing) |
| Mempool check | Not needed (pool receives many txs) | Required (destination should have zero prior txs) |

### Duplicate Signing Prevention

On startup, each signer scans its audit log for `signing_complete` entries and rebuilds an in-memory set of `(requester, nonce)` pairs. After a successful round 2, the pair is recorded to both the in-memory set and the audit log. This prevents:

- **Pre-completion duplicates**: Backend retries while signing is in-progress
- **Post-restart duplicates**: Backend redeploys with empty tracking state
- **Post-completion duplicates**: Backend re-requests after tx is already broadcast

### Configuration

```bash
cargo run -- run --id 1 --key-file signer1.key.enc --password <pwd> \
  --esplora-url https://mempool.space/testnet4/api \ # UTXO + mempool checks
  --pool-address tb1p...                           \ # Whitelist for sweeps
  --max-amount 1000000000                          \ # 10 BTC limit
  --max-fee 50000                                  \ # 50k sats max fee
  --require-context                                \ # Reject blind signing
  --network testnet4                               \
  --solana-rpc-url https://api.devnet.solana.com   \ # On-chain PDA verification
  --aegis-program-id 4Gt66pJd...                   \ # Privacy Coin program for PDA derivation
  --audit-log /var/log/frost/signer-1.jsonl          # Persist signing history
```

### Operational Modes

| Mode | Policy | Audit | Use Case |
|------|--------|-------|----------|
| **Dev** | None (blind signing OK) | Disabled | Local development |
| **Staging** | Enforced | Enabled | Testing with real UTXOs |
| **Production** | Strict (context + Solana verification required) | Required | Live deployment |

---

## Audit Logging

Append-only JSON-lines log of all policy decisions and signing events. The audit log also serves as persistent storage for duplicate signing prevention — on startup, the signer scans it to rebuild the in-memory set of already-signed redemptions.

### Log Format

```json
{"ts":"2026-03-11T10:30:00Z","session_id":"abc-123","action":"policy_check","sighash":"a1b2c3d4e5f6...","result":"allow","destinations":["tb1p..."],"amount_sats":50000,"fee_sats":250}
{"ts":"2026-03-11T10:30:01Z","session_id":"abc-123","action":"round1","signer_id":1,"result":"ok"}
{"ts":"2026-03-11T10:30:02Z","session_id":"abc-123","action":"round2","signer_id":1,"result":"ok"}
{"ts":"2026-03-11T10:30:02Z","session_id":"abc-123","action":"signing_complete","signer_id":1,"result":"ok","requester":"7Xf2...","redemption_nonce":42}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `ts` | string | ISO-8601 UTC timestamp |
| `session_id` | string | UUID of signing session |
| `action` | string | `policy_check`, `round1`, `round2`, `signing_complete` |
| `sighash` | string? | First 16 chars of sighash |
| `result` | string | `allow`, `deny`, `ok`, `error` |
| `reason` | string? | Deny reason or error message |
| `destinations` | string[]? | Transaction recipient addresses |
| `amount_sats` | number? | Total output amount |
| `fee_sats` | number? | Transaction fee |
| `signer_id` | number? | Which signer performed action |
| `requester` | string? | Requester Solana pubkey (base58, for duplicate tracking) |
| `redemption_nonce` | number? | Redemption nonce (for duplicate tracking) |

### Startup Scan

On startup, the signer reads the audit log and extracts all `signing_complete` entries to rebuild the duplicate prevention set. This means:

- Restarting a signer preserves knowledge of past signings
- No external database needed — the audit log is the source of truth
- The scan runs once at startup; new entries are added in-memory + appended to file

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
  },
  "solana_verification": {
    "type": "Withdrawal",
    "requester": "base58 Solana pubkey",
    "nonce": 42,
    "expected_amount_sats": 50000,
    "expected_btc_address": "hex scriptPubKey"
  }
}
```

The `solana_verification` field supports two variants:
- **Withdrawal**: Verifies RedemptionRequest PDA exists on-chain (status=Processing, matching amount and btc_script)
- **Sweep**: Verifies DepositIntent PDA exists on-chain (discriminator=0x07)

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
| `FROST_API_KEY` | — | API authentication (required in production) |
| `FROST_NETWORK` | `testnet` | Bitcoin network: `bitcoin`, `testnet`, `testnet4`, `signet`, `regtest` |
| `FROST_ESPLORA_URL` | auto | Esplora API for UTXO + mempool checks (defaults to mempool.space for network) |
| `FROST_POOL_ADDRESS` | — | Comma-separated allowed destination addresses (for sweeps) |
| `FROST_MAX_AMOUNT` | `1000000000` | Maximum output amount (sats) |
| `FROST_MAX_FEE` | `50000` | Maximum transaction fee (sats) |
| `FROST_REQUIRE_CONTEXT` | — | Reject blind signing if set |
| `FROST_AUDIT_LOG` | — | Audit log file path (enables duplicate prevention persistence) |
| `FROST_SOLANA_RPC_URL` | — | Solana JSON-RPC URL for on-chain PDA verification |
| `FROST_PRIVACY_COIN_PROGRAM_ID` | — | Privacy Coin program ID (base58) for PDA derivation |
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
| `--audit-log` | — | — | Audit log file path (enables duplicate prevention) |
| `--network` | — | `testnet` | Bitcoin network |
| `--solana-rpc-url` | — | env: `FROST_SOLANA_RPC_URL` | Solana RPC for on-chain verification |
| `--aegis-program-id` | — | env: `FROST_PRIVACY_COIN_PROGRAM_ID` | Privacy Coin program ID for PDA derivation |

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
2. **Zero-trust coordinator**: Each signer independently verifies all data — a compromised backend cannot fabricate withdrawals
3. **Signer-side sighash verification**: Recomputes BIP-341 sighash from raw transaction data, rejects mismatches
4. **On-chain PDA verification**: Each signer queries Solana RPC to confirm RedemptionRequest exists with status=Processing
5. **Cross-validation**: Tx output scriptPubKey and amount must match on-chain PDA — prevents paying wrong address
6. **Duplicate prevention**: In-memory set (backed by audit log) prevents signing the same redemption twice
7. **Mempool check**: Queries Esplora to reject if destination already received payment
8. **Address validity**: All tx outputs must parse as valid Bitcoin addresses before signing
9. **E2E encrypted DKG**: Coordinator never sees plaintext key shares (X25519 + AES-256-GCM)
10. **Broadcast equivocation detection**: SHA-256 commitment digest prevents coordinator from sending different data to different signers
11. **Session isolation**: 5-minute timeout, single-use sessions (round 2 cannot be replayed)
12. **Encrypted key storage**: Key shares saved with Argon2id KDF + AES-256-GCM
13. **Append-only audit**: JSONL log for forensic review and duplicate prevention persistence

---

## Source Files

| File | Purpose |
|------|---------|
| `frost_server/src/main.rs` | CLI entry points (run, dkg-coordinator, generate-test-keys) |
| `frost_server/src/server.rs` | Axum HTTP server, handlers, middleware, duplicate tracker wiring |
| `frost_server/src/signing.rs` | FROST 2-round signing with Taproot tweak |
| `frost_server/src/dkg.rs` | 3-round DKG ceremony with E2E encryption |
| `frost_server/src/policy.rs` | Zero-trust policy engine (9 checks: sighash, UTXO, whitelist, limits, Solana PDA, duplicate, cross-validation, mempool, address validity) |
| `frost_server/src/audit.rs` | Append-only JSONL audit logger + startup scan for duplicate prevention |
| `frost_server/src/solana_verifier.rs` | Solana RPC client for on-chain PDA verification (RedemptionRequest, DepositIntent) |
| `frost_server/src/crypto.rs` | X25519/AES-256-GCM encryption, commitment digest |
| `frost_server/src/types.rs` | Request/response types (including SolanaVerification) |

---

## Related Documentation

- [Technical Overview](./TECHNICAL.md) - Full system architecture
- [How to Run](./RUNNING.md) - Operational guide
- [Backend Architecture](../backend/docs/ARCHITECTURE.md) - Backend integration with FROST
- [Documentation Index](./INDEX.md) - All docs hub
