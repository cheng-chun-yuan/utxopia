# Excalidraw Architecture Diagrams — Design

**Date**: 2026-02-21
**Audience**: Hackathon judges/investors + developer onboarding
**Location**: `docs/diagrams/*.excalidraw` (separate files per diagram)

---

## Diagrams

### 1. `system-overview.excalidraw`
3-layer architecture (BTC / Solana / Client). Color-coded horizontal bands:
- **Bitcoin Layer (orange)**: User Wallet → Taproot Address → Bitcoin Network → Header Relayer
- **Solana Layer (purple)**: BTC Light Client ↔ Aegis Program (Commitment Tree, Nullifier Registry, Stealth Announcements, Name Registry, VK Registry)
- **Client Layer (blue)**: @aegis/sdk → Web App, Mobile App, Backend API, FROST Server

### 2. `deposit-withdraw-flow.excalidraw`
End-to-end lifecycle as 3 horizontal swimlanes:
- **Deposit (green)**: Generate Keys → Taproot Addr → Send BTC → 6+ Confirms → Header Relay → SPV Verify → Stealth Announcement → Scan → JoinSplit 1x2 Claim → Commitment in Tree
- **Private Transfer (blue)**: Commitment → JoinSplit 2x2 proof → Transact → Nullifiers burned → New commitments → Stealth announcement
- **Withdrawal (red)**: Request Redemption → Nullifier → zkBTC burned → FROST 2-of-3 signing → BTC broadcast → Complete

### 3. `crypto-key-model.excalidraw`
Two sections:
- **Key Hierarchy (left)**: Spending Key (BJJ) → Spending Pub + Nullifying Key + Viewing Key → MPK → NPK → Commitment + Nullifier. Poseidon hashes as hexagon nodes. Color-coded keys.
- **Stealth Protocol (right)**: Sender/Recipient ECDH flow. Ephemeral key → shared secret → stealth pub → commitment → scan + claim.

### 4. `joinsplit-circuit.excalidraw`
Circuit internals inside a boundary box:
- Private inputs (gray) and public inputs (blue)
- 6 numbered verification steps: MPK check → Merkle proof → Nullifier derivation → Output commitment + range check → Value balance (Σin == Σout) → EdDSA signature
- Output: 256-byte Groth16 proof

### 5. `frost-signing.excalidraw`
Two sections:
- **DKG**: 3 signers → Round 1 (commitments) → Round 2 (encrypted shares via X25519/AES-GCM) → Group public key
- **Signing**: Backend → Policy Engine (sighash, destination, amount/fee validation) → 2-of-3 signers → Round 1 (nonces) → Round 2 (shares) → Aggregate Schnorr signature → BTC broadcast

---

## Style Guide
- Rounded rectangles for components
- Color-coded by layer/role (orange=BTC, purple=Solana, blue=client, green=deposit, red=withdraw)
- Labeled arrows for data flow
- Hexagons for Poseidon hash operations
- Dashed boxes for annotations
- Clean, presentation-ready aesthetic
