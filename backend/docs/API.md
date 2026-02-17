# zVault Backend API Reference

## Base URL

- **Development**: `http://localhost:3001`
- **Production**: Configure via `API_PORT` environment variable

## Authentication

Currently, the API does not require authentication. Rate limiting is applied per IP address.

## Rate Limiting

| Endpoint Type | Requests/Minute | Burst |
|---------------|-----------------|-------|
| Default | 100 | 20 |
| Read-only | 500 | 100 |
| Sensitive (redeem) | 10 | 5 |

Rate limit headers:
- `X-RateLimit-Remaining`: Remaining requests in window
- `Retry-After`: Seconds until rate limit resets (when exceeded)

---

## Health & Monitoring

### GET /api/health

Health check endpoint.

**Response**
```json
{
  "status": "ok",
  "service": "zkbtc-api",
  "version": "0.1.0"
}
```

### GET /api/tracker/health

Deposit tracker health check.

**Response**
```json
{
  "status": "ok",
  "service": "zkbtc-deposit-tracker",
  "version": "0.1.0"
}
```

### GET /api/tracker/stats

Get deposit tracker statistics.

**Response**
```json
{
  "total_deposits": 42,
  "pending": 5,
  "confirming": 3,
  "ready": 30,
  "claimed": 2,
  "failed": 2,
  "total_sats_received": 5000000
}
```

---

## Deposit Tracking

### POST /api/deposits

Register a new deposit for tracking.

**Request Body**
```json
{
  "taproot_address": "tb1p...",
  "commitment": "abcd1234...",
  "amount_sats": 100000
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `taproot_address` | string | Yes | Taproot deposit address (tb1p... for testnet) |
| `commitment` | string | Yes | 32-byte commitment hash (64 hex chars) |
| `amount_sats` | number | Yes | Expected deposit amount in satoshis |

**Response (Success)**
```json
{
  "success": true,
  "deposit_id": "dep_1234567890_abc123",
  "message": "Deposit registered for tracking"
}
```

**Response (Error)**
```json
{
  "success": false,
  "deposit_id": null,
  "message": "Invalid taproot address format"
}
```

### GET /api/deposits/:id

Get status of a specific deposit.

**Response**
```json
{
  "id": "dep_1234567890_abc123",
  "status": "confirming",
  "taproot_address": "tb1p...",
  "commitment": "abcd1234...",
  "amount_sats": 100000,
  "actual_amount_sats": 100000,
  "confirmations": 2,
  "sweep_confirmations": 0,
  "can_claim": false,
  "deposit_txid": "abc123...",
  "sweep_txid": null,
  "solana_tx": null,
  "error": null,
  "created_at": 1704067200,
  "updated_at": 1704067500,
  "expires_at": 1704153600
}
```

**Status Values**:
| Status | Description |
|--------|-------------|
| `pending` | Waiting for BTC deposit |
| `detected` | Transaction seen in mempool |
| `confirming` | Waiting for confirmations |
| `confirmed` | BTC confirmed, ready to sweep |
| `sweeping` | Building sweep transaction |
| `sweep_confirming` | Waiting for sweep confirmations |
| `verifying` | Submitting SPV proof to Solana |
| `ready` | Verified on Solana, can claim |
| `expired` | No deposit within 24 hours |
| `failed` | Error occurred (see error field) |

### GET /api/deposits

List all deposits (admin/debugging).

**Response**
```json
{
  "deposits": [
    { /* DepositStatusResponse */ }
  ],
  "stats": {
    "total_deposits": 42,
    "pending": 5,
    "confirming": 3,
    "ready": 30,
    "claimed": 2,
    "failed": 2
  }
}
```

### GET /api/tracker/pending

List all pending deposits.

**Response**
```json
{
  "count": 5,
  "deposits": [
    { /* DepositStatusResponse */ }
  ]
}
```

### GET /api/tracker/failed

List all failed deposits with error details.

**Response**
```json
{
  "count": 2,
  "deposits": [
    {
      "id": "dep_...",
      "taproot_address": "tb1p...",
      "amount_sats": 100000,
      "error": "SPV verification failed",
      "retry_count": 3,
      "last_retry_at": 1704067500,
      "can_retry": true,
      "created_at": 1704067200,
      "updated_at": 1704067500
    }
  ]
}
```

### POST /api/tracker/retry/:id

Manually retry a failed deposit.

**Response (Success)**
```json
{
  "success": true,
  "message": "Retry initiated for deposit dep_..."
}
```

**Response (Error)**
```json
{
  "success": false,
  "error": "Deposit not found"
}
```

---

## Stealth Deposits (V2)

### POST /api/stealth/prepare

Prepare a stealth deposit address with ephemeral key.

**Request Body**
```json
{
  "viewing_pub": "02abcd...",
  "spending_pub": "03efgh..."
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `viewing_pub` | string | Yes | Recipient's viewing public key (66 hex chars) |
| `spending_pub` | string | Yes | Recipient's spending public key (66 hex chars) |

**Response (Success)**
```json
{
  "success": true,
  "deposit_id": "sdep_1234567890_abc123",
  "btc_address": "tb1p...",
  "ephemeral_pub": "02xyz...",
  "expires_at": 1704153600,
  "error": null
}
```

### GET /api/stealth/:id

Get stealth deposit status.

**Response**
```json
{
  "id": "sdep_1234567890_abc123",
  "status": "ready",
  "btc_address": "tb1p...",
  "ephemeral_pub": "02xyz...",
  "actual_amount_sats": 100000,
  "confirmations": 6,
  "sweep_confirmations": 3,
  "deposit_txid": "abc123...",
  "sweep_txid": "def456...",
  "solana_tx": "sig123...",
  "leaf_index": 42,
  "error": null,
  "created_at": 1704067200,
  "updated_at": 1704070800,
  "expires_at": 1704153600
}
```

### GET /api/stealth

List all stealth deposits.

**Response**
```json
{
  "deposits": [
    { /* StealthDepositStatusResponse */ }
  ],
  "stats": {
    "total": 10,
    "pending": 2,
    "confirming": 1,
    "sweeping": 0,
    "verifying": 1,
    "ready": 6,
    "failed": 0,
    "total_sats": 1500000
  }
}
```

### POST /api/stealth/announce

Manual announcement for self-custody mode.

**Request Body**
```json
{
  "stealth_data": "zvault:1:eyJhbGciOiJI..."
}
```

**Response**
```json
{
  "success": true,
  "solana_tx": "sig123...",
  "leaf_index": 42,
  "message": "Announcement submitted"
}
```

---

## Redemption

### POST /api/redeem

Submit a withdrawal request (burn zkBTC, receive BTC).

**Request Body**
```json
{
  "amount_sats": 100000,
  "btc_address": "tb1q...",
  "solana_address": "ABC123..."
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `amount_sats` | number | Yes | Amount to withdraw in satoshis (min: 10,000) |
| `btc_address` | string | Yes | Bitcoin address to receive funds |
| `solana_address` | string | Yes | Solana wallet that burned zkBTC |

**Response (Success)**
```json
{
  "success": true,
  "request_id": "api_request_1704067200000",
  "message": "Withdrawal request submitted"
}
```

**Response (Error)**
```json
{
  "success": false,
  "request_id": null,
  "message": "Amount below minimum threshold"
}
```

### GET /api/withdrawal/status/:id

Check withdrawal request status.

**Response**
```json
{
  "request_id": "api_request_1704067200000",
  "status": "broadcasting",
  "amount_sats": 100000,
  "btc_address": "tb1q...",
  "btc_txid": "abc123...",
  "created_at": 1704067200,
  "updated_at": 1704067500
}
```

**Status Values**:
| Status | Description |
|--------|-------------|
| `pending` | Request queued |
| `processing` | Building/signing transaction |
| `broadcasting` | Transaction broadcast, waiting for confirms |
| `completed` | BTC sent successfully |
| `failed` | Error occurred |

---

## WebSocket Endpoints

### WS /ws/deposits/:id

Subscribe to real-time updates for a specific deposit.

**Message Format (Server → Client)**
```json
{
  "deposit_id": "dep_...",
  "status": "confirming",
  "confirmations": 3,
  "sweep_confirmations": 0,
  "can_claim": false,
  "error": null
}
```

### WS /ws/deposits

Subscribe to all deposit updates (admin dashboard).

**Message Format**: Same as above for all deposits.

### WS /ws/stealth/:id

Subscribe to stealth deposit updates.

**Message Format (Server → Client)**
```json
{
  "deposit_id": "sdep_...",
  "status": "ready",
  "actual_amount_sats": 100000,
  "confirmations": 6,
  "sweep_confirmations": 3,
  "is_ready": true,
  "error": null
}
```

---

## Error Responses

All errors follow a consistent format:

```json
{
  "error": "Human-readable error message",
  "code": "ERROR_CODE",
  "details": ["Additional context"],
  "retry_after": 30
}
```

**Common Error Codes**:
| Code | HTTP Status | Description |
|------|-------------|-------------|
| `RATE_LIMITED` | 429 | Too many requests |
| `VALIDATION_ERROR` | 400 | Invalid input |
| `NOT_FOUND` | 404 | Resource not found |
| `INTERNAL_ERROR` | 500 | Server error |

---

## Input Validation

### Bitcoin Addresses
- Valid prefixes: `1`, `3`, `bc1`, `m`, `n`, `2`, `tb1`, `bcrt1`
- Length: 26-90 characters
- Base58 or Bech32 character sets

### Solana Addresses
- Length: 32-44 characters
- Base58 character set (no 0, O, I, l)

### Hex Strings
- Valid hexadecimal characters only
- `0x` prefix optional
- Commitment: 64 characters (32 bytes)
- Public keys: 66 characters (33 bytes compressed)

### Amounts
- Must be greater than 0
- Minimum withdrawal: 10,000 satoshis
- Maximum withdrawal: 100,000,000 satoshis (1 BTC)
