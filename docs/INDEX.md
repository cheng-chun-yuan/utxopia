# UTXOpia Documentation Index

Privacy-preserving Bitcoin-to-Solana bridge using Zero-Knowledge Proofs.

---

## Quick Links

| Doc | Description |
|-----|-------------|
| [Technical Overview](./TECHNICAL.md) | Architecture, cryptography, stealth addresses, program instructions |
| [How to Run](./RUNNING.md) | Build, deploy, and run all services locally and on devnet |
| [FROST Server](./FROST.md) | Threshold signing: DKG, signing protocol, policy engine, audit |
| [Circuits](./CIRCUITS.md) | JoinSplit(N,M) ZK circuit design, build pipeline, variant system |
| [SDK Reference](../sdk/docs/SDK.md) | TypeScript SDK: deposits, scanning, proof generation, key derivation |
| [Backend Architecture](../backend/docs/ARCHITECTURE.md) | Module structure, data flow diagrams |
| [Backend Services](../backend/docs/SERVICES.md) | Deposit tracker, sweeper, SPV verifier, redemption processor |
| [Backend API](../backend/docs/API.md) | REST endpoints, WebSocket, request/response formats |
| [Backend Configuration](../backend/docs/CONFIGURATION.md) | Environment variables, network defaults, security |

---

## Recommended Reading Order

### New to UTXOpia

1. **[Technical Overview](./TECHNICAL.md)** - Understand the architecture and key innovations
2. **[Circuits](./CIRCUITS.md)** - How JoinSplit proofs work
3. **[SDK Reference](../sdk/docs/SDK.md)** - Client-side API
4. **[How to Run](./RUNNING.md)** - Set up a local development environment

### Operating UTXOpia

1. **[How to Run](./RUNNING.md)** - Start all services
2. **[Backend Configuration](../backend/docs/CONFIGURATION.md)** - Environment setup
3. **[FROST Server](./FROST.md)** - Set up threshold signing
4. **[Backend Services](../backend/docs/SERVICES.md)** - Monitor deposit tracker and redemption

### Contributing

1. **[Technical Overview](./TECHNICAL.md)** - Architecture context
2. **[Backend Architecture](../backend/docs/ARCHITECTURE.md)** - Code structure
3. **[Circuits](./CIRCUITS.md)** - Circuit modification guide
4. **[SDK Reference](../sdk/docs/SDK.md)** - SDK API surface

---

## Component-to-Doc Mapping

| Component | Directory | Documentation |
|-----------|-----------|---------------|
| Solana Programs (Pinocchio) | `contracts/` | [Technical Overview](./TECHNICAL.md) |
| BTC Light Client | `contracts/programs/btc-light-client/` | [Technical Overview](./TECHNICAL.md) |
| ZK Circuits (circom) | `circuits/` | [Circuits](./CIRCUITS.md) |
| TypeScript SDK | `sdk/` | [SDK Reference](../sdk/docs/SDK.md) |
| FROST Signing Server | `frost_server/` | [FROST Server](./FROST.md) |
| Backend API + Tracker | `backend/` | [Architecture](../backend/docs/ARCHITECTURE.md), [Services](../backend/docs/SERVICES.md), [API](../backend/docs/API.md) |
| Header Relayer | `backend/header-relayer/` | [Services](../backend/docs/SERVICES.md), [How to Run](./RUNNING.md) |
| Web Frontend | `utxopia-app/` | [How to Run](./RUNNING.md) |

---

## Key Constants

| Constant | Value | Used In |
|----------|-------|---------|
| `ZKBTC_TOKEN_ID` | `0x7a627463` ("zkbtc" as u32) | Commitment computation |
| `DEPOSIT_OP_RETURN_SIZE` | 64 bytes | `ephemeralPub(32) + npk(32)` |
| Stealth announcements | sol_log_data events | disc=0x03, type: 0=deposit, 1=transfer |
| Merkle tree depth | 16 (65,536 leaves) | Commitment storage |
| Groth16 proof size | 256 bytes | 2 G1 + 1 G2 on BN254 |
| FROST threshold | 2-of-3 | BTC custody signing |
| JoinSplit max | N + M <= 14 | Poseidon arity constraint |

---

## Program IDs (Devnet)

| Program | Address |
|---------|---------|
| UTXOpia | `4Gt66pJd6N3hYEVWnaWTSLfxotsPvShYEWYvbUB9Ubx1` |
| BTC Light Client | `Ho6UTeF8yFnRdCK15tSZtcJozvkDABJZWYxkgGyWAfyq` |
| ChadBuffer | `6VrJmWbhN9WbEkg87JizunVMpL6CHKGVmzWCf3o3LRgy` |
