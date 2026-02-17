# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

zVault is a privacy-preserving Bitcoin-to-Solana bridge using Zero-Knowledge Proofs. Users deposit BTC to receive private zkBTC tokens that can be transferred using stealth addresses and ZK proofs (Groth16 via circom/snarkjs).

**Key Technologies**: Pinocchio (Solana), circom circuits (Groth16 proofs), Taproot (BTC deposits), Grumpkin ECDH (stealth addresses), FROST (threshold signing)

## Commands

### Frontend (Next.js) - `/zvault-app`
```bash
bun run dev          # Start dev server (port 3000)
bun run build        # Production build (builds SDK first)
bun run lint         # ESLint
bun run test         # Vitest tests
```

### SDK - `/sdk`
```bash
bun run build        # Compile TypeScript
bun test             # Run tests
bun run e2e          # End-to-end tests (localnet)
bun run e2e:devnet   # E2E tests on devnet
```

### Contracts (Pinocchio) - `/contracts`
```bash
anchor build         # Build programs
anchor deploy        # Deploy to devnet
bun run test         # TypeScript tests
```

### FROST Server - `/frost_server`
```bash
cargo run --bin frost-server       # Start FROST signing server
cargo run --bin generate_deposit_address  # Generate Taproot address
cargo run --bin spend_utxo         # Spend UTXO with threshold sig
cargo test                         # Run tests
```

### Backend (Rust) - `/backend`
```bash
cargo run                # Start API server
cargo test               # Run tests
```

### Mobile App (Expo) - `/mobile-app`
```bash
bun run start        # Start Expo dev server
bun run ios          # Run on iOS simulator
bun run android      # Run on Android emulator
```

### circom Circuits - `/circuits`
```bash
bun install               # Install dependencies
bash scripts/compile.sh   # Compile all 6 circuits
bash scripts/setup.sh     # Groth16 trusted setup
bun run test              # Run circuit tests
```

### Header Relayer - `/backend/header-relayer`
```bash
bun run init         # Initialize light client (first time)
bun run start        # Start header relay service
```

## Architecture

```
BTC Deposit → Taproot Address (commitment-derived) → SPV Verification → On-chain Commitment
                                                                              ↓
Claim: Provide nullifier+secret → Generate Groth16 ZK Proof → Verify → Mint zkBTC
                                                                              ↓
Redeem: Burn zkBTC → FROST threshold signature → Return BTC to user
```

### Main Components

| Directory | Purpose | Language |
|-----------|---------|----------|
| `contracts/programs/zvault` | Main Solana program | Rust (Pinocchio) |
| `contracts/programs/btc-light-client` | Bitcoin header tracking | Rust |
| `circuits` | Groth16 ZK circuits (6 circuits) | circom |
| `sdk` | TypeScript SDK (@zvault/sdk) | TypeScript |
| `frost_server` | FROST threshold signing for BTC | Rust |
| `backend` | API server + header relayer | Rust + Node.js |
| `zvault-app` | Web interface | Next.js + React |
| `mobile-app` | Mobile app | Expo + React Native |

### circom Circuits

| Circuit | Purpose |
|---------|---------|
| `claim` | Claim deposited BTC as zkBTC |
| `spend_split` | Split 1 note into 2 notes |
| `spend_partial_public` | Partial public spend |
| `pool_deposit` | Deposit into yield pool |
| `pool_withdraw` | Withdraw from yield pool |
| `pool_claim_yield` | Claim yield rewards |

### Key Privacy Features

| Feature | Description |
|---------|-------------|
| **Client-Side Proving** | All ZK proofs generated in browser/app via snarkjs - no trusted backend required |
| **Groth16 (~256 byte proofs)** | Small proof size fits inline in Solana transactions |
| **Viewing/Spending Key Separation** | Share viewing key for audits without compromising spend ability |
| **Stealth Addresses** | Unlinkable one-time addresses via DKSAP (EIP-5564) |
| **.zkey Names** | Human-readable stealth addresses (SNS-style registry) |

### Key Model

```
Spending Key (private) ─► Can spend funds, must keep secret
       │
       └─► Viewing Key (derived) ─► Can view balances/history, safe to share with auditors
```

- **Spending Key**: Full control - generate nullifiers, sign transactions
- **Viewing Key**: Read-only access - scan for incoming payments, view transaction history
- Use case: Share viewing key with accountants, regulators, or compliance without risk

### Cryptography

1. **Commitment**: Poseidon hash (in-circuit) bound to Taproot address
2. **ZK Proof**: Groth16 via circom/snarkjs (client-side, ~256 byte proofs)
3. **Stealth**: Grumpkin ECDH (~2k constraints vs ~300k for X25519)
4. **Redemption**: FROST threshold signatures (secp256k1-tr)

## Key Program IDs

- **zVault (devnet)**: `GqdjVMBDmFEd6wSV4TzRsvnVWnE4pMMdhVo8U4iXvYUX`
- **BTC Light Client**: `S6rgPjCeBhkYBejWyDR1zzU3sYCMob36LAf8tjwj8pn`

## SDK Usage (@zvault/sdk)

```typescript
import { generateNote, createClaimProof, createStealthDeposit } from '@zvault/sdk';

// Create note with nullifier/secret
const note = generateNote(amount);

// Generate Groth16 proof for claim
const proof = await createClaimProof(note, merkleProof);

// ECDH-based stealth sends
const stealth = createStealthDeposit(recipientPubkey, amount);
```

## Documentation

- `docs/TECHNICAL.md` - Full technical documentation
- `docs/SDK.md` - SDK API reference

## Development Notes

- **Package Manager**: Always use `bun` instead of `npm`
- **Network**: Solana devnet + Bitcoin testnet
- **Poseidon Hashing**: Done inside circom circuits (BN254 curve)
- **Token**: zkBTC uses Token-2022 program
- **Solana SDK**: Uses `@solana/kit` (new framework-kit)
