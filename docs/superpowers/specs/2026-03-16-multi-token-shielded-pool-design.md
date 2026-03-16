# Multi-Token Shielded Pool Design

**Date:** 2026-03-16
**Status:** Draft

## Overview

Extend Aegis to support shielding any whitelisted SPL token alongside BTC. All tokens share a single Merkle tree for maximum privacy. Users deposit SPL tokens via a new `shield` instruction and withdraw via `unshield`. BTC retains its existing Taproot/SPV/FROST flow. The JoinSplit circuit is unchanged.

## Goals

- Shield/unshield any whitelisted SPL token
- Shared Merkle tree across all tokens (privacy through mixing)
- Per-token configuration (fees, limits, vault)
- Pool-level percentage fees on deposit/withdrawal
- Clean deployment — no migration from existing state

## Non-Goals

- Cross-chain bridging for non-BTC assets
- Cross-token swaps inside the shielded pool
- Permissionless token listing

---

## On-Chain State

### PoolState Changes

Fresh deployment — redesigned PoolState. The old `service_fee_bps`, `service_fee_base`, `fee_pool`, `min_deposit`, `max_deposit`, and pending timelock fields for these are **removed**. Fee/limit config moves to per-token TokenConfig PDAs. The old `total_shielded`, `total_minted`, `total_burned` fields are removed — each TokenConfig tracks its own `total_shielded`.

New pool-level fee fields added:

| Field | Type | Description |
|-------|------|-------------|
| `deposit_fee_bps` | `u16` | Percentage fee on all deposits (e.g., 50 = 0.5%) |
| `withdrawal_fee_bps` | `u16` | Percentage fee on all withdrawals |

These apply uniformly to all tokens (BTC and SPL). Pool-level timelock (`propose_pool_update` / `execute_pool_update`) still applies for updating these values.

### New: TokenConfig PDA

**Seeds:** `["token_config", mint_pubkey]`

| Field | Type | Size | Description |
|-------|------|------|-------------|
| `discriminator` | `u8` | 1 | `0x08` |
| `bump` | `u8` | 1 | PDA bump seed |
| `mint` | `[u8; 32]` | 32 | SPL mint address |
| `token_id` | `[u8; 32]` | 32 | `Poseidon(reduce_to_field(mint))` — precomputed at registration |
| `vault` | `[u8; 32]` | 32 | Token account holding shielded deposits |
| `decimals` | `u8` | 1 | Token decimals |
| `enabled` | `u8` | 1 | 0 = disabled, 1 = enabled |
| `service_fee` | `[u8; 8]` | 8 | Flat fee in token's native units (u64 LE) |
| `min_deposit` | `[u8; 8]` | 8 | Minimum deposit amount (u64 LE) |
| `max_deposit` | `[u8; 8]` | 8 | Maximum deposit amount (u64 LE) |
| `deposit_cap` | `[u8; 8]` | 8 | Max total shielded for this token (u64 LE) |
| `total_shielded` | `[u8; 8]` | 8 | Current total shielded (u64 LE) |
| `accumulated_fees` | `[u8; 8]` | 8 | Explicitly tracked protocol fees (u64 LE) |
| `_reserved` | `[u8; 16]` | 16 | Reserved for future use |

**Total: 164 bytes.** One PDA per whitelisted token.

Note: `accumulated_fees` is tracked explicitly rather than computed as `vault.balance - total_shielded`. This prevents edge cases where accidental direct transfers to the vault inflate claimable fees.

### BTC as a Registered Token

BTC (zkBTC mint) is registered as a TokenConfig like any other token. Its `token_id = Poseidon(reduce_to_field(zkbtc_mint))`, replacing the old hardcoded `ZKBTC_TOKEN_ID = 0x7a627463`. This is a breaking change — acceptable because we're doing a fresh deployment.

### Removed/Superseded Instructions (Fresh Deploy)

The following existing instructions are **removed** in the fresh deployment:

| Old Disc | Instruction | Reason |
|----------|-------------|--------|
| 15 | `UNSHIELD` | Replaced by new multi-token `unshield` (disc 27) |
| 16 | `REDEEM` | Replaced by `request_redemption` with token_config |
| 17 | `PUBLIC_REDEEM` | Replaced by new `unshield` (disc 27) |
| 24 | `REGISTER_DEPOSIT_INTENT` | Removed (v2 deposit flow) |
| 25 | `VERIFY_DEPOSIT_V2` | Removed (v2 deposit flow) |
| 26 | `CLAIM_FEES` (old) | Replaced by new `claim_fees` (disc 28) with per-token support |
| 27 | `SET_POOL_CONFIG` | Replaced by `update_token_config` (disc 25) + pool timelock |

The existing `UNSHIELD` (disc 15) used `Poseidon(unshield_address, ZKBTC_TOKEN_ID, amount)` as the burn commitment. The new `unshield` (disc 27) uses `Poseidon([0u8; 32], token_id, amount)` — unified with `request_redemption`'s burn commitment formula. The zero-NPK pattern is cleaner: it signals "this commitment is being destroyed" without binding to a specific Solana address (the recipient address is passed separately).

### Account Discriminators

| Disc | Account Type | Status |
|------|-------------|--------|
| 0x01 | PoolState | Kept |
| 0x02 | CommitmentTree | Kept |
| 0x03 | NullifierRecord | Kept |
| 0x04 | VkRegistry | Kept |
| 0x05 | RedemptionRequest | Kept |
| 0x06 | DepositReceipt | Kept |
| 0x07 | DepositIntent | **Removed** |
| 0x08 | TokenConfig | **New** |

### Token ID Derivation

All tokens use `token_id = Poseidon(reduce_to_field(mint_address))`:
1. **Reduce**: The 32-byte mint pubkey (256 bits) is reduced modulo the BN254 scalar field (~254 bits) to produce a valid field element. This uses the existing `reduce_to_field` function in `crypto.rs`.
2. **Hash**: `Poseidon(reduced_mint)` produces the token_id.
3. **Store**: Computed once at token registration, stored in TokenConfig.
4. **SDK parity**: The SDK must perform the identical field reduction before hashing. Both on-chain and off-chain must produce the same token_id.

---

## Fee Model

### Pool-Level Percentage Fees

Stored in PoolState, applied to all tokens uniformly:
- `deposit_fee_bps` — deducted on shield / verify_stealth_deposit
- `withdrawal_fee_bps` — deducted on unshield / request_redemption

### Per-Token Service Fee

Stored in TokenConfig, flat amount in token's native units. Only applies to BTC operations where backend infrastructure does work on behalf of the user:

| Operation | Percentage (pool-level) | Service Fee (per-token) | Rationale |
|-----------|------------------------|-------------------------|-----------|
| **shield** (SPL deposit) | `deposit_fee_bps` | No | User pays own gas |
| **verify_stealth_deposit** (BTC deposit) | `deposit_fee_bps` | Yes | Relayer pays Solana gas |
| **unshield** (SPL withdraw) | `withdrawal_fee_bps` | No | User pays own gas |
| **request_redemption** (BTC withdraw) | `withdrawal_fee_bps` | Yes | FROST signing + BTC miner fee |
| **transact** (JoinSplit transfer) | None | None | Optional relayer fee (in-circuit) |

### Fee Computation

For SPL deposits: `shielded_amount = amount - (amount * deposit_fee_bps / 10000)`
For BTC deposits: `shielded_amount = amount - (amount * deposit_fee_bps / 10000) - service_fee`
For SPL withdrawals: `payout = amount - (amount * withdrawal_fee_bps / 10000)`
For BTC withdrawals: `payout = amount - (amount * withdrawal_fee_bps / 10000) - service_fee`

Fees are tracked via `token_config.accumulated_fees`. Admin claims via `claim_fees`.

### Relayer Fee (Transact)

- No protocol fee on JoinSplit transfers
- Users can self-submit (fee = 0) or use a relayer
- Relayer fee is in-circuit: `sum(inputs) = sum(outputs) + fee`
- Fee amount and relayer address are public inputs — relayer verifies before submitting
- Fee paid in the same token being transacted

---

## New Instructions

### `register_token` (admin only)

**Discriminator:** 24

**Accounts:**
1. `authority` (signer) — pool admin
2. `pool_state` — validates authority
3. `mint` — SPL mint to register (Token-2022)
4. `token_config` — PDA to create (seeds: `["token_config", mint]`)
5. `vault` — token account for this mint (PDA-owned)
6. `system_program`
7. `token_program` — Token-2022 only

**Instruction Data:**
- `service_fee: u64`
- `min_deposit: u64`
- `max_deposit: u64`
- `deposit_cap: u64`

**Logic:**
1. Validate authority is pool admin
2. Validate mint is Token-2022 owned
3. Compute `token_id = Poseidon(reduce_to_field(mint_pubkey))` — this is the only place where Poseidon(mint) is computed on-chain
4. Read decimals from mint account
5. Create TokenConfig PDA with provided config, store bump
6. Validate/create vault token account (PDA-owned)

### `update_token_config` (admin only)

**Discriminator:** 25

**Accounts:**
1. `authority` (signer)
2. `pool_state`
3. `token_config`

**Instruction Data:** (all optional, update only provided fields)
- `service_fee: Option<u64>`
- `min_deposit: Option<u64>`
- `max_deposit: Option<u64>`
- `deposit_cap: Option<u64>`
- `enabled: Option<bool>`

### `shield` (user deposits SPL token)

**Discriminator:** 26

**Accounts:**
1. `user` (signer)
2. `user_token_account` — must be for the correct mint
3. `pool_state` — checked not paused, read deposit_fee_bps
4. `token_config` — PDA for the token being shielded, checked enabled
5. `vault` — validated matches `token_config.vault`
6. `commitment_tree`
7. `token_program` — Token-2022

**Instruction Data:**
- `amount: u64` — amount to shield (before fees)
- `npk: [u8; 32]` — note public key
- `ephemeral_pub: [u8; 32]` — ephemeral Ed25519 pubkey for ECDH stealth scanning

**Logic:**
1. Validate pool is not paused
2. Validate token is enabled
3. Validate `vault == token_config.vault`
4. Validate user_token_account mint matches token_config.mint
5. Validate `amount >= min_deposit && amount <= max_deposit`
6. Compute `protocol_fee = amount * deposit_fee_bps / 10000` (truncates down — user-favorable rounding)
7. `shielded_amount = amount - protocol_fee`
8. Validate `total_shielded + shielded_amount <= deposit_cap`
9. Transfer `amount` from user → vault
10. Compute commitment: `Poseidon(npk, token_config.token_id, shielded_amount)`
11. Insert commitment into shared Merkle tree
12. Emit stealth announcement event (disc=0x03, type=0, ephemeral_pub, plaintext shielded_amount, commitment, leaf_index, token_id)
13. Update `token_config.total_shielded += shielded_amount`
14. Update `token_config.accumulated_fees += protocol_fee`

Note: Unlike `unshield`, `shield` does NOT require a ZK proof. The on-chain program computes and inserts the commitment directly — this is safe because the user is depositing (not withdrawing) value.

### `unshield` (user withdraws SPL token)

**Discriminator:** 27

**Accounts:**
1. `user` (signer)
2. `user_token_account`
3. `pool_state` — checked not paused, read withdrawal_fee_bps
4. `token_config` — PDA for the token being unshielded
5. `vault` — validated matches `token_config.vault`
6. `commitment_tree`
7. `vk_registry` — for Groth16 proof verification
8. `token_program` — Token-2022
9. `system_program` — for nullifier PDA creation
10..10+n_inputs: `nullifier_records` — one PDA per input nullifier

**Instruction Data:**
- Groth16 proof bytes (256 bytes)
- `merkle_root: [u8; 32]`
- `bound_params_hash: [u8; 32]` — hash binding chain-specific params (same as existing transact/unshield)
- `n_inputs: u8`
- `n_outputs: u8`
- `nullifier_hashes: [[u8; 32]; n_inputs]`
- `commitments_out: [[u8; 32]; n_outputs]` — change outputs
- `amount: u64` — revealed withdrawal amount

**Logic:**
1. Validate pool is not paused, token is enabled
2. Validate `vault == token_config.vault`
3. Verify last output commitment = `Poseidon([0u8; 32], token_config.token_id, amount)` (burn commitment — npk=0 signals unshield)
4. Verify Groth16 proof against public inputs: `[merkleRoot, boundParamsHash, nullifiers..., commitmentsOut...]`
5. Check each nullifier is unspent, create nullifier record PDAs
6. Insert change output commitments (all except last) into Merkle tree
7. Compute `protocol_fee = amount * withdrawal_fee_bps / 10000`
8. `payout = amount - protocol_fee`
9. Transfer `payout` from vault → user
10. Update `token_config.total_shielded -= amount`
11. Update `token_config.accumulated_fees += protocol_fee`
12. Emit nullifier spent events

### `claim_fees` (admin only)

**Discriminator:** 28

**Accounts:**
1. `authority` (signer) — pool admin
2. `pool_state`
3. `token_config` — derived from chosen mint
4. `vault`
5. `admin_token_account`
6. `token_program`

**Instruction Data:**
- `amount: u64` — amount to claim (allows partial claims)

**Logic:**
1. Validate authority is pool admin
2. Validate `amount <= token_config.accumulated_fees`
3. Transfer `amount` from vault → admin token account
4. Update `token_config.accumulated_fees -= amount`

---

## Modified Instructions

### `verify_stealth_deposit` (BTC deposit)

Changes from current:
- Additional account: `token_config` PDA for zkBTC
- Uses `token_config.token_id` instead of hardcoded `ZKBTC_TOKEN_ID`
- Applies `deposit_fee_bps` (from pool_state) + `service_fee` (from token_config) before computing commitment
- `shielded_amount = btc_amount - (btc_amount * deposit_fee_bps / 10000) - service_fee`
- Commitment computed on `shielded_amount`
- Updates `token_config.total_shielded += shielded_amount`
- Updates `token_config.accumulated_fees += protocol_fee + service_fee`
- `compute_deposit_commitment` is parameterized: takes `token_id: &[u8; 32]` instead of using hardcoded constant
- Stealth announcement event includes `token_id` field

### `request_redemption` (BTC withdrawal)

Changes from current:
- Additional account: `token_config` PDA for zkBTC
- Burn commitment verification uses `Poseidon([0u8; 32], token_config.token_id, amount)` — parameterized, not hardcoded
- Applies `withdrawal_fee_bps` (from pool_state) + `service_fee` (from token_config)
- `payout = amount - (amount * withdrawal_fee_bps / 10000) - service_fee`
- FROST signs for `payout` amount
- Updates `token_config.total_shielded -= amount`
- Updates `token_config.accumulated_fees += protocol_fee + service_fee`

### `transact` (JoinSplit)

**No changes required.** The `transact` instruction verifies Groth16 proofs and manages nullifiers/commitments. It has no concept of token identity — the circuit enforces that all inputs/outputs use the same token via the private `token` signal. The on-chain verifier only sees commitments (which embed the token_id) and nullifiers. There is no need for the instruction to know which token is being transacted.

### `initialize`

Changes:
- Accepts `deposit_fee_bps` and `withdrawal_fee_bps` as init parameters
- Stores them in PoolState
- Removes old `service_fee_bps`, `service_fee_base`, `min_deposit`, `max_deposit` from init (moved to per-token config)

---

## Circuit

**No changes required.**

The JoinSplit circuit already has `token` as a private input signal. It enforces:
- All inputs use the same token value
- All outputs use the same token value
- `commitment = Poseidon(npk, token, amount)` for each note

The only difference is what value gets passed as `token`:
- Before: hardcoded `0x7a627463`
- After: `Poseidon(reduce_to_field(mint_address))` — computed off-chain by the SDK

No circuit recompilation needed.

---

## SDK Changes

### Token ID

- Remove `ZKBTC_TOKEN_ID` constant
- Add `computeTokenId(mint: PublicKey): bigint` → `reduceToField(mint_bytes)` then `PoseidonHash(reduced)`
- The `reduceToField` step must match the on-chain `reduce_to_field` function exactly (mod BN254 scalar field order)
- Convenience: `getZkBtcTokenId(config): bigint` → `computeTokenId(config.zkbtcMint)`

### Note Creation

- `createJoinSplitNote()` takes `tokenId: bigint` parameter instead of hardcoding
- `JoinSplitNote.token` becomes caller-provided

### New Instruction Builders

- `buildShieldInstruction(user, mint, amount, npk, ...)`
- `buildUnshieldInstruction(user, mint, amount, proof, ...)`
- `buildRegisterTokenInstruction(authority, mint, config)`
- `buildUpdateTokenConfigInstruction(authority, mint, updates)`
- `buildClaimFeesInstruction(authority, mint, amount)`

### Config

- `initConfig()` updated to support token registry lookups
- `getTokenConfig(mint): TokenConfig` — fetch and parse TokenConfig PDA
- `deriveTokenConfigPDA(mint): PublicKey` — derive PDA address

### Stealth Announcement Parsing

- Event format extended: disc(0x03) + type(1) + ephemeral_pub(32) + encrypted_amount(8) + commitment(32) + leaf_index(4) + **token_id(32)** = 110 bytes
- SDK parsers updated to extract token_id from events
- Note scanning filters by token_id when reconstructing wallet balances

---

## Architecture Diagram

```
SPL Token Deposit ──→ shield ──→ Poseidon(npk, Poseidon(mint), amount) ──┐
                                                                          ├──→ Shared Merkle Tree
BTC Deposit ──→ Taproot → SPV → verify_stealth_deposit ──→ Poseidon(npk, Poseidon(zkbtc_mint), amount) ──┘
                                                                          │
                                                  JoinSplit transact (ZK) ←┘
                                                          │
                                  ┌─────────────────────────┴──────────────────────────┐
                                  ↓                                                    ↓
                          unshield (SPL)                                request_redemption (BTC)
                        vault → user - fees                           FROST → BTC payout - fees
```

---

## Security Considerations

1. **Cross-token prevention**: Circuit enforces all inputs/outputs use same token. An attacker cannot mix tokens in a single JoinSplit.
2. **Token ID binding**: `token_id = Poseidon(reduce_to_field(mint))` is deterministic. The unshield instruction verifies against `token_config.token_id` to prevent claiming wrong token.
3. **Field reduction**: Mint pubkeys (256-bit) are reduced modulo BN254 scalar field before Poseidon hashing. SDK and on-chain must use identical reduction to produce matching token_ids.
4. **Fee manipulation**: Fees computed on-chain from pool/token config. User cannot bypass. `accumulated_fees` tracked explicitly to prevent vault balance drift.
5. **Deposit cap**: Prevents excessive exposure to any single token.
6. **Admin controls**: Token enable/disable provides emergency circuit breaker per token.
7. **Vault isolation**: Each token has its own vault. A bug in one token's accounting cannot drain another token's vault.
8. **Shared tree privacy**: Observers cannot distinguish token types from Merkle tree operations. Token identity is hidden inside ZK proofs.
9. **Token-2022 only**: All tokens must use Token-2022 program. No dual-program complexity.
10. **Burn commitment formula**: Uses `Poseidon([0u8; 32], token_id, amount)` — the zero NPK signals an unshield. Both `unshield` and `request_redemption` verify this consistently.
11. **Fee rounding**: Integer division truncates toward zero (user-favorable). `protocol_fee = amount * bps / 10000` rounds fees down. This is intentional and consistent with existing behavior.
12. **Event format change**: Stealth announcement events grow from 78 to 110 bytes (adding `token_id`). All parsers (backend indexer, frontend, SDK) must be updated. Acceptable for fresh deployment.

---

## Instruction Discriminator Table

| Discriminator | Instruction | Status |
|---------------|-------------|--------|
| 0 | `initialize` | Modified |
| 1 | `verify_stealth_deposit` | Modified |
| 5 | `request_redemption` | Modified |
| 14 | `transact` | Unchanged |
| 24 | `register_token` | **New** |
| 25 | `update_token_config` | **New** |
| 26 | `shield` | **New** |
| 27 | `unshield` | **New** |
| 28 | `claim_fees` | **New** |
