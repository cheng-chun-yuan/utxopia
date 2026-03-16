# Multi-Token Shielded Pool Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add shield/unshield support for any whitelisted SPL token, sharing the existing Merkle tree with BTC for maximum privacy.

**Architecture:** New `TokenConfig` PDA per whitelisted token. New `shield`/`unshield`/`register_token`/`update_token_config`/`claim_fees` instructions. Existing BTC paths (`verify_stealth_deposit`, `request_redemption`) modified to read from TokenConfig. `compute_deposit_commitment` parameterized by `token_id`. Circuit unchanged. Pool-level `deposit_fee_bps`/`withdrawal_fee_bps` replace old `service_fee_bps`/`service_fee_base`.

**Tech Stack:** Rust (Pinocchio), TypeScript (@solana/kit), circom (unchanged)

**Spec:** `docs/superpowers/specs/2026-03-16-multi-token-shielded-pool-design.md`

---

## Task Ordering Note

Task 16 (update `initialize`) should be done right after Task 2 (PoolState fee fields) so that pool initialization includes the new fee fields before any new instructions are tested. The implementer should execute: Tasks 1, 2, **16**, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20-24.

---

## Chunk 1: On-Chain State & Crypto Foundation

### Task 1: Add TokenConfig state account

**Files:**
- Create: `contracts/programs/aegis/src/state/token_config.rs`
- Modify: `contracts/programs/aegis/src/state/mod.rs`

- [ ] **Step 1: Create `token_config.rs` with zero-copy struct**

```rust
// contracts/programs/aegis/src/state/token_config.rs
//! Token configuration account (zero-copy)
//!
//! Per-token settings for multi-token shielded pool.
//! PDA seeds: ["token_config", mint_pubkey]

use pinocchio::program_error::ProgramError;

/// Discriminator for TokenConfig account
pub const TOKEN_CONFIG_DISCRIMINATOR: u8 = 0x0B;

/// Token configuration account (zero-copy layout)
#[repr(C)]
pub struct TokenConfig {
    /// Account discriminator (1 byte) — 0x0B
    pub discriminator: u8,
    /// PDA bump seed
    pub bump: u8,
    /// SPL mint address
    pub mint: [u8; 32],
    /// Poseidon(reduce_to_field(mint)) — precomputed at registration
    pub token_id: [u8; 32],
    /// Token account holding shielded deposits (PDA-owned vault)
    pub vault: [u8; 32],
    /// Token decimals
    pub decimals: u8,
    /// 0 = disabled, 1 = enabled
    pub enabled: u8,
    /// Flat service fee in token native units (u64 LE)
    service_fee: [u8; 8],
    /// Minimum deposit amount (u64 LE)
    min_deposit: [u8; 8],
    /// Maximum deposit amount (u64 LE)
    max_deposit: [u8; 8],
    /// Max total shielded for this token (u64 LE)
    deposit_cap: [u8; 8],
    /// Current total shielded (u64 LE)
    total_shielded: [u8; 8],
    /// Explicitly tracked accumulated protocol fees (u64 LE)
    accumulated_fees: [u8; 8],
    /// Reserved for future use
    _reserved: [u8; 16],
}

impl TokenConfig {
    pub const LEN: usize = core::mem::size_of::<Self>(); // 164 bytes
    pub const SEED: &'static [u8] = b"token_config";

    pub fn from_bytes(data: &[u8]) -> Result<&Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[0] != TOKEN_CONFIG_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(unsafe { &*(data.as_ptr() as *const Self) })
    }

    pub fn from_bytes_mut(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[0] != TOKEN_CONFIG_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(unsafe { &mut *(data.as_mut_ptr() as *mut Self) })
    }

    pub fn init(data: &mut [u8]) -> Result<&mut Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        data[..Self::LEN].fill(0);
        data[0] = TOKEN_CONFIG_DISCRIMINATOR;
        Ok(unsafe { &mut *(data.as_mut_ptr() as *mut Self) })
    }

    // Getters
    pub fn is_enabled(&self) -> bool { self.enabled != 0 }
    pub fn service_fee(&self) -> u64 { u64::from_le_bytes(self.service_fee) }
    pub fn min_deposit(&self) -> u64 { u64::from_le_bytes(self.min_deposit) }
    pub fn max_deposit(&self) -> u64 { u64::from_le_bytes(self.max_deposit) }
    pub fn deposit_cap(&self) -> u64 { u64::from_le_bytes(self.deposit_cap) }
    pub fn total_shielded(&self) -> u64 { u64::from_le_bytes(self.total_shielded) }
    pub fn accumulated_fees(&self) -> u64 { u64::from_le_bytes(self.accumulated_fees) }

    // Setters
    pub fn set_enabled(&mut self, v: bool) { self.enabled = v as u8; }
    pub fn set_service_fee(&mut self, v: u64) { self.service_fee = v.to_le_bytes(); }
    pub fn set_min_deposit(&mut self, v: u64) { self.min_deposit = v.to_le_bytes(); }
    pub fn set_max_deposit(&mut self, v: u64) { self.max_deposit = v.to_le_bytes(); }
    pub fn set_deposit_cap(&mut self, v: u64) { self.deposit_cap = v.to_le_bytes(); }
    pub fn set_total_shielded(&mut self, v: u64) { self.total_shielded = v.to_le_bytes(); }
    pub fn set_accumulated_fees(&mut self, v: u64) { self.accumulated_fees = v.to_le_bytes(); }

    // Increment helpers
    pub fn add_shielded(&mut self, amount: u64) -> Result<(), ProgramError> {
        let total = self.total_shielded();
        self.set_total_shielded(total.checked_add(amount).ok_or(ProgramError::ArithmeticOverflow)?);
        Ok(())
    }

    pub fn sub_shielded(&mut self, amount: u64) -> Result<(), ProgramError> {
        let total = self.total_shielded();
        self.set_total_shielded(total.checked_sub(amount).ok_or(ProgramError::ArithmeticOverflow)?);
        Ok(())
    }

    pub fn add_fees(&mut self, amount: u64) -> Result<(), ProgramError> {
        let total = self.accumulated_fees();
        self.set_accumulated_fees(total.checked_add(amount).ok_or(ProgramError::ArithmeticOverflow)?);
        Ok(())
    }

    pub fn sub_fees(&mut self, amount: u64) -> Result<(), ProgramError> {
        let total = self.accumulated_fees();
        self.set_accumulated_fees(total.checked_sub(amount).ok_or(ProgramError::ArithmeticOverflow)?);
        Ok(())
    }
}
```

- [ ] **Step 2: Register module in `state/mod.rs`**

Add to `contracts/programs/aegis/src/state/mod.rs`:
```rust
pub mod token_config;
pub use token_config::*;
```

- [ ] **Step 3: Add size test**

Add at bottom of `token_config.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_token_config_size() {
        assert_eq!(TokenConfig::LEN, 164);
    }

    #[test]
    fn test_token_config_init_roundtrip() {
        let mut buf = vec![0u8; TokenConfig::LEN];
        let tc = TokenConfig::init(&mut buf).unwrap();
        tc.set_service_fee(1000);
        tc.set_min_deposit(5000);
        tc.set_max_deposit(1_000_000);
        tc.set_deposit_cap(100_000_000);
        tc.set_enabled(true);

        let tc2 = TokenConfig::from_bytes(&buf).unwrap();
        assert_eq!(tc2.service_fee(), 1000);
        assert_eq!(tc2.min_deposit(), 5000);
        assert_eq!(tc2.max_deposit(), 1_000_000);
        assert_eq!(tc2.deposit_cap(), 100_000_000);
        assert!(tc2.is_enabled());
        assert_eq!(tc2.total_shielded(), 0);
        assert_eq!(tc2.accumulated_fees(), 0);
    }
}
```

- [ ] **Step 4: Run tests**

Run: `cd contracts && cargo test -p aegis -- token_config`
Expected: 2 tests pass

- [ ] **Step 5: Commit**

```bash
git add contracts/programs/aegis/src/state/token_config.rs contracts/programs/aegis/src/state/mod.rs
git commit -m "feat: add TokenConfig state account for multi-token support"
```

---

### Task 2: Update PoolState with deposit/withdrawal fee fields

**Files:**
- Modify: `contracts/programs/aegis/src/state/pool.rs`

**Fresh deploy** — we redesign PoolState. The existing fields `service_fee_bps`, `pending_service_fee_bps`, `service_fee_base`, `fee_pool`, `min_deposit`, `max_deposit`, `total_shielded`, and their pending timelock variants are **removed** (moved to per-token TokenConfig). We repurpose freed space for `deposit_fee_bps` and `withdrawal_fee_bps`.

Specifically, repurpose `service_fee_bps: [u8; 2]` → `deposit_fee_bps: [u8; 2]` and `pending_service_fee_bps: [u8; 2]` → `withdrawal_fee_bps: [u8; 2]`. The old `service_fee_base`, `fee_pool`, `min_deposit`, `max_deposit`, `total_shielded`, and pending timelock fields become `_deprecated` (zeroed on fresh deploy). Total stays 268 bytes.

- [ ] **Step 1: Carve fee fields from _reserved**

In `contracts/programs/aegis/src/state/pool.rs`, replace the `_reserved` field and add getters/setters:

Replace:
```rust
    /// Reserved for future use (remaining 10 bytes)
    _reserved: [u8; 10],
```
With:
```rust
    /// Percentage fee on all deposits (basis points, u16 LE)
    deposit_fee_bps: [u8; 2],
    /// Percentage fee on all withdrawals (basis points, u16 LE)
    withdrawal_fee_bps: [u8; 2],
    /// Reserved for future use (remaining 6 bytes)
    _reserved: [u8; 6],
```

Add getters/setters (after existing fee methods):
```rust
    pub fn deposit_fee_bps(&self) -> u16 {
        u16::from_le_bytes(self.deposit_fee_bps)
    }
    pub fn withdrawal_fee_bps(&self) -> u16 {
        u16::from_le_bytes(self.withdrawal_fee_bps)
    }
    pub fn set_deposit_fee_bps(&mut self, value: u16) {
        self.deposit_fee_bps = value.to_le_bytes();
    }
    pub fn set_withdrawal_fee_bps(&mut self, value: u16) {
        self.withdrawal_fee_bps = value.to_le_bytes();
    }

    /// Compute deposit fee: amount * deposit_fee_bps / 10000
    pub fn compute_deposit_fee(&self, amount: u64) -> u64 {
        let bps = self.deposit_fee_bps() as u64;
        amount.saturating_mul(bps) / 10_000
    }

    /// Compute withdrawal fee: amount * withdrawal_fee_bps / 10000
    pub fn compute_withdrawal_fee(&self, amount: u64) -> u64 {
        let bps = self.withdrawal_fee_bps() as u64;
        amount.saturating_mul(bps) / 10_000
    }
```

- [ ] **Step 2: Update size test**

The existing `test_pool_state_size_unchanged` should still pass since total stays 268.

- [ ] **Step 3: Add fee tests**

```rust
    #[test]
    fn test_pool_state_deposit_withdrawal_fees() {
        let mut buf = init_pool();
        let pool = PoolState::from_bytes_mut(&mut buf).unwrap();
        pool.set_deposit_fee_bps(50);  // 0.5%
        pool.set_withdrawal_fee_bps(100); // 1.0%

        assert_eq!(pool.deposit_fee_bps(), 50);
        assert_eq!(pool.withdrawal_fee_bps(), 100);
        assert_eq!(pool.compute_deposit_fee(100_000), 500); // 0.5%
        assert_eq!(pool.compute_withdrawal_fee(100_000), 1000); // 1.0%
    }

    #[test]
    fn test_pool_state_deposit_withdrawal_fees_default_zero() {
        let buf = init_pool();
        let pool = PoolState::from_bytes(&buf).unwrap();
        assert_eq!(pool.deposit_fee_bps(), 0);
        assert_eq!(pool.withdrawal_fee_bps(), 0);
    }
```

- [ ] **Step 4: Run tests**

Run: `cd contracts && cargo test -p aegis -- pool_state`
Expected: All pool_state tests pass (including existing ones)

- [ ] **Step 5: Commit**

```bash
git add contracts/programs/aegis/src/state/pool.rs
git commit -m "feat: add deposit_fee_bps and withdrawal_fee_bps to PoolState"
```

---

### Task 3: Parameterize `compute_deposit_commitment` by token_id

**Files:**
- Modify: `contracts/programs/aegis/src/utils/crypto.rs`

- [ ] **Step 1: Add `compute_commitment` that takes token_id**

In `contracts/programs/aegis/src/utils/crypto.rs`, add a new function below `compute_deposit_commitment`:

```rust
/// Compute commitment with explicit token_id: Poseidon(npk, token_id, amount)
///
/// Used by multi-token shield/unshield. The token_id is Poseidon(reduce_to_field(mint)).
pub fn compute_commitment(npk: &[u8; 32], token_id: &[u8; 32], amount_sats: u64) -> Result<[u8; 32], ProgramError> {
    let mut amount = [0u8; 32];
    amount[24..32].copy_from_slice(&amount_sats.to_be_bytes());

    poseidon3_hash(npk, token_id, &amount)
}

/// Compute token_id from mint address: Poseidon(reduce_to_field(mint))
pub fn compute_token_id(mint: &[u8; 32]) -> Result<[u8; 32], ProgramError> {
    let reduced = reduce_to_field_exact(mint)?;
    poseidon2_hash(&reduced, &[0u8; 32]) // Poseidon with single input padded
}
```

Wait — Poseidon1 (single input) may not be directly available. Check if `poseidon2_hash` exists or if we need to use a different approach. Looking at `crypto.rs`, there's `poseidon2_hash` and `poseidon3_hash`. For a single-input hash, use `poseidon2_hash(reduced_mint, &[0u8; 32])` — but this is Poseidon with 2 inputs. Better to just use `poseidon2_hash` with `(reduced_mint, zero_pad)` which is deterministic and unique.

Actually, re-reading the spec: `token_id = Poseidon(reduce_to_field(mint))`. We should use a single-input Poseidon. Since the Solana Poseidon syscall supports variable arity, let's check what's available:

The existing code uses `solana_poseidon::hashv` which supports variable inputs. So:

```rust
/// Compute token_id from mint address: Poseidon(reduce_to_field(mint), 0)
///
/// Uses 2-input Poseidon (consistent with existing poseidon2_hash).
/// The SDK must use the identical approach: poseidon([reduced_mint, 0n]).
pub fn compute_token_id(mint_bytes: &[u8; 32]) -> Result<[u8; 32], ProgramError> {
    let reduced = reduce_to_field_exact(mint_bytes)?;
    poseidon2_hash(&reduced, &[0u8; 32])
}
```

Note: We use `poseidon2_hash(reduced_mint, zero)` because the codebase has no single-input Poseidon variant. The `solana_poseidon::hashv` syscall supports variable arity but our wrapper only exposes 2 and 3 input versions. Using 2-input with zero padding is deterministic and sufficient.

- [ ] **Step 2: Keep old `compute_deposit_commitment` for backward compat during transition**

The old function stays but internally calls the new one:
```rust
/// Legacy: compute deposit commitment with hardcoded ZKBTC_TOKEN_ID
/// DEPRECATED: Use compute_commitment() with explicit token_id
pub fn compute_deposit_commitment(npk: &[u8; 32], amount_sats: u64) -> Result<[u8; 32], ProgramError> {
    let mut token_id = [0u8; 32];
    token_id[28..32].copy_from_slice(&ZKBTC_TOKEN_ID.to_be_bytes());
    compute_commitment(npk, &token_id, amount_sats)
}
```

- [ ] **Step 3: Run existing tests**

Run: `cd contracts && cargo test -p aegis`
Expected: All existing tests still pass

- [ ] **Step 4: Commit**

```bash
git add contracts/programs/aegis/src/utils/crypto.rs
git commit -m "feat: parameterize commitment computation by token_id"
```

---

### Task 4: Update event emission for multi-token (add token_id)

**Files:**
- Modify: `contracts/programs/aegis/src/utils/events.rs`

- [ ] **Step 1: Add `emit_stealth_announcement_v2` with token_id**

Keep the old function for backward compat. Add new version:

```rust
/// Emit a stealth announcement with token_id (multi-token support).
///
/// Layout: disc(1) + type(1) + ephemeral_pub(32) + encrypted_amount(8)
///         + commitment(32) + leaf_index(4) + token_id(32) = 110 bytes
pub fn emit_stealth_announcement_v2(
    announcement_type: u8,
    ephemeral_pub: &[u8; 32],
    encrypted_amount: &[u8; 8],
    commitment: &[u8; 32],
    leaf_index: u32,
    token_id: &[u8; 32],
) {
    let disc = [EVENT_STEALTH_ANNOUNCEMENT];
    let atype = [announcement_type];
    let li = leaf_index.to_le_bytes();
    sol_log_data(&[&disc, &atype, ephemeral_pub, encrypted_amount, commitment, &li, token_id]);
}
```

Also update `AnnouncementItem` and `emit_announcements_batch` for multi-token:

```rust
/// Data for a single announcement in a batch (v2 with token_id)
pub struct AnnouncementItemV2<'a> {
    pub announcement_type: u8,
    pub ephemeral_pub: &'a [u8; 32],
    pub encrypted_amount: &'a [u8; 8],
    pub commitment: &'a [u8; 32],
    pub leaf_index: u32,
    pub token_id: &'a [u8; 32],
}

/// Emit batch of stealth announcements with token_id.
///
/// Layout: disc(1) + count(1) + [type(1) + ephemeral(32) + amount(8) + commitment(32) + leaf_index(4) + token_id(32)] x count
/// Per-item: 109 bytes
pub fn emit_announcements_batch_v2(items: &[AnnouncementItemV2]) {
    if items.len() == 1 {
        emit_stealth_announcement_v2(
            items[0].announcement_type,
            items[0].ephemeral_pub,
            items[0].encrypted_amount,
            items[0].commitment,
            items[0].leaf_index,
            items[0].token_id,
        );
        return;
    }

    let n = items.len().min(MAX_BATCH);
    // Max payload: 2 + 14 * 109 = 1528 bytes
    let mut buf = [0u8; 2 + MAX_BATCH * 109];
    buf[0] = EVENT_ANNOUNCEMENTS_BATCH;
    buf[1] = n as u8;
    let mut offset = 2;
    for i in 0..n {
        buf[offset] = items[i].announcement_type;
        offset += 1;
        buf[offset..offset + 32].copy_from_slice(items[i].ephemeral_pub);
        offset += 32;
        buf[offset..offset + 8].copy_from_slice(items[i].encrypted_amount);
        offset += 8;
        buf[offset..offset + 32].copy_from_slice(items[i].commitment);
        offset += 32;
        let li = items[i].leaf_index.to_le_bytes();
        buf[offset..offset + 4].copy_from_slice(&li);
        offset += 4;
        buf[offset..offset + 32].copy_from_slice(items[i].token_id);
        offset += 32;
    }
    sol_log_data(&[&buf[..offset]]);
}
```

- [ ] **Step 2: Run tests**

Run: `cd contracts && cargo test -p aegis`
Expected: All pass (new functions are additive)

- [ ] **Step 3: Commit**

```bash
git add contracts/programs/aegis/src/utils/events.rs
git commit -m "feat: add v2 stealth announcement events with token_id field"
```

---

## Chunk 2: New Instructions (register_token, shield, unshield, update_token_config, claim_fees)

### Task 5: Implement `register_token` instruction

**Files:**
- Create: `contracts/programs/aegis/src/instructions/register_token.rs`
- Modify: `contracts/programs/aegis/src/instructions/mod.rs`
- Modify: `contracts/programs/aegis/src/lib.rs`

- [ ] **Step 1: Create `register_token.rs`**

```rust
// contracts/programs/aegis/src/instructions/register_token.rs
//! Register a new token for the multi-token shielded pool.
//!
//! Admin-only instruction that creates a TokenConfig PDA for a whitelisted SPL token.
//!
//! # Accounts
//! 0. `[signer]`   Authority (must match pool.authority)
//! 1. `[]`         Pool state PDA
//! 2. `[]`         SPL mint account (Token-2022)
//! 3. `[writable]` TokenConfig PDA (to create; seeds: ["token_config", mint])
//! 4. `[writable]` Vault token account (PDA-owned)
//! 5. `[]`         System program
//! 6. `[]`         Token-2022 program

use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::find_program_address,
    sysvars::rent::Rent,
    ProgramResult,
};

use crate::error::AegisError;
use crate::state::{PoolState, TokenConfig};
use crate::utils::{
    crypto::compute_token_id,
    validate_program_owner, validate_account_writable,
    validate_token_2022_owner, validate_token_program_key,
};

/// Instruction data layout:
/// service_fee(8) + min_deposit(8) + max_deposit(8) + deposit_cap(8) = 32 bytes
const DATA_LEN: usize = 32;

pub fn process_register_token(
    program_id: &pinocchio::pubkey::Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 7 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }

    let authority = &accounts[0];
    let pool_state_info = &accounts[1];
    let mint_info = &accounts[2];
    let token_config_info = &accounts[3];
    let vault_info = &accounts[4];
    let system_program = &accounts[5];
    let _token_program = &accounts[6];

    // Validate signer
    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Validate pool state and authority
    validate_program_owner(pool_state_info, program_id)?;
    {
        let pool_data = pool_state_info.try_borrow_data()?;
        let pool = PoolState::from_bytes(&pool_data)?;
        if authority.key().as_ref() != pool.authority {
            return Err(AegisError::Unauthorized.into());
        }
    }

    // Validate mint is Token-2022
    validate_token_2022_owner(mint_info)?;

    // Read decimals from mint (offset 44 in Token-2022 mint layout)
    let decimals = {
        let mint_data = mint_info.try_borrow_data()?;
        if mint_data.len() < 82 {
            return Err(ProgramError::InvalidAccountData);
        }
        mint_data[44]
    };

    // Derive and validate TokenConfig PDA
    let tc_seeds: &[&[u8]] = &[TokenConfig::SEED, mint_info.key().as_ref()];
    let (expected_pda, tc_bump) = find_program_address(tc_seeds, program_id);
    if token_config_info.key() != &expected_pda {
        return Err(AegisError::InvalidPDA.into());
    }

    // Compute token_id = Poseidon(reduce_to_field(mint))
    let token_id = compute_token_id(mint_info.key().as_ref().try_into().unwrap())?;

    // Create TokenConfig PDA
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(TokenConfig::LEN);
    let bump_bytes = [tc_bump];
    let create_seeds: &[&[u8]] = &[TokenConfig::SEED, mint_info.key().as_ref(), &bump_bytes];

    pinocchio::sysvars::rent::create_account_with_seed(
        authority,
        token_config_info,
        system_program,
        program_id,
        lamports,
        TokenConfig::LEN as u64,
        create_seeds,
    )?;

    // Wait — Pinocchio doesn't have a built-in create_account helper like that.
    // Use CPI to system program create_account with PDA signer seeds.
    // Follow the pattern from other PDA creation in the codebase.

    // Parse instruction data
    let service_fee = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let min_deposit = u64::from_le_bytes(data[8..16].try_into().unwrap());
    let max_deposit = u64::from_le_bytes(data[16..24].try_into().unwrap());
    let deposit_cap = u64::from_le_bytes(data[24..32].try_into().unwrap());

    // Initialize TokenConfig
    {
        let mut tc_data = token_config_info.try_borrow_mut_data()?;
        let tc = TokenConfig::init(&mut tc_data)?;
        tc.bump = tc_bump;
        tc.mint.copy_from_slice(mint_info.key().as_ref());
        tc.token_id = token_id;
        tc.vault.copy_from_slice(vault_info.key().as_ref());
        tc.decimals = decimals;
        tc.set_enabled(true);
        tc.set_service_fee(service_fee);
        tc.set_min_deposit(min_deposit);
        tc.set_max_deposit(max_deposit);
        tc.set_deposit_cap(deposit_cap);
    }

    pinocchio::msg!("Aegis: registered token");
    Ok(())
}
```

Note: The PDA creation pattern needs to match the existing codebase pattern. Check how `register_deposit_intent.rs` or `request_redemption.rs` creates PDAs — they use `pinocchio::cpi::invoke_signed` with a system program CreateAccount instruction. The implementer should follow that exact pattern.

- [ ] **Step 2: Add to `instructions/mod.rs`**

```rust
pub mod register_token;
pub use register_token::*;
```

- [ ] **Step 3: Add routing in `lib.rs`**

Add to the `instruction` const block:
```rust
    pub const REGISTER_TOKEN: u8 = 24;
```

Add to the match statement:
```rust
        instruction::REGISTER_TOKEN => {
            instructions::process_register_token(program_id, accounts, data)
        }
```

Note: The old `REGISTER_DEPOSIT_INTENT(24)`, `VERIFY_DEPOSIT_V2(25)`, `CLAIM_FEES(26)`, `SET_POOL_CONFIG(27)` are removed in the fresh deployment, freeing those slots. New assignments (matching spec):
- 24 = `REGISTER_TOKEN`
- 25 = `UPDATE_TOKEN_CONFIG`
- 26 = `SHIELD`
- 27 = `UNSHIELD` (replaces old UNSHIELD at disc 15)
- 28 = `CLAIM_FEES` (replaces old CLAIM_FEES at disc 26)

Also remove these old instruction discriminators and their routing:
- 15 = old `UNSHIELD`
- 16 = `REDEEM`
- 17 = `PUBLIC_REDEEM`
- 24 = old `REGISTER_DEPOSIT_INTENT`
- 25 = old `VERIFY_DEPOSIT_V2`
- 26 = old `CLAIM_FEES`
- 27 = old `SET_POOL_CONFIG`

- [ ] **Step 4: Run `cargo build-sbf --features devnet`**

Verify it compiles. Fix any issues.

- [ ] **Step 5: Commit**

```bash
git add contracts/programs/aegis/src/instructions/register_token.rs \
        contracts/programs/aegis/src/instructions/mod.rs \
        contracts/programs/aegis/src/lib.rs
git commit -m "feat: add register_token instruction for multi-token whitelisting"
```

---

### Task 6: Implement `shield` instruction

**Files:**
- Create: `contracts/programs/aegis/src/instructions/shield.rs`
- Modify: `contracts/programs/aegis/src/instructions/mod.rs`
- Modify: `contracts/programs/aegis/src/lib.rs`

- [ ] **Step 1: Create `shield.rs`**

```rust
// contracts/programs/aegis/src/instructions/shield.rs
//! Shield SPL tokens into the privacy pool.
//!
//! User deposits SPL tokens, which become a shielded commitment in the Merkle tree.
//! No ZK proof needed — the program computes the commitment directly.
//!
//! # Accounts
//! 0. `[signer]`   User
//! 1. `[writable]` User's token account (source)
//! 2. `[]`         Pool state PDA (read deposit_fee_bps, check paused)
//! 3. `[writable]` TokenConfig PDA (check enabled, limits, update total_shielded)
//! 4. `[writable]` Vault token account (destination)
//! 5. `[writable]` Commitment tree
//! 6. `[]`         Token-2022 program

use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    ProgramResult,
};

use crate::error::AegisError;
use crate::state::{CommitmentTree, PoolState, TokenConfig};
use crate::utils::{
    crypto::compute_commitment,
    events::{emit_stealth_announcement_v2, ANNOUNCEMENT_TYPE_DEPOSIT},
    validate_account_writable, validate_program_owner,
    validate_token_2022_owner, validate_token_program_key,
};

/// Instruction data: amount(8) + npk(32) + ephemeral_pub(32) = 72 bytes
const DATA_LEN: usize = 72;

pub fn process_shield(
    program_id: &pinocchio::pubkey::Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 7 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }

    let user = &accounts[0];
    let user_token_account = &accounts[1];
    let pool_state_info = &accounts[2];
    let token_config_info = &accounts[3];
    let vault = &accounts[4];
    let commitment_tree_info = &accounts[5];
    let token_program = &accounts[6];

    // Parse instruction data
    let amount = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let npk: &[u8; 32] = data[8..40].try_into().unwrap();
    let ephemeral_pub: &[u8; 32] = data[40..72].try_into().unwrap();

    // Validate signer
    if !user.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Validate accounts
    validate_program_owner(pool_state_info, program_id)?;
    validate_program_owner(token_config_info, program_id)?;
    validate_program_owner(commitment_tree_info, program_id)?;
    validate_token_2022_owner(user_token_account)?;
    validate_token_2022_owner(vault)?;
    validate_token_program_key(token_program)?;
    validate_account_writable(user_token_account)?;
    validate_account_writable(token_config_info)?;
    validate_account_writable(vault)?;
    validate_account_writable(commitment_tree_info)?;

    // Read pool state — check paused, read deposit_fee_bps
    let deposit_fee_bps = {
        let pool_data = pool_state_info.try_borrow_data()?;
        let pool = PoolState::from_bytes(&pool_data)?;
        if pool.is_paused() {
            return Err(AegisError::PoolPaused.into());
        }
        pool.deposit_fee_bps()
    };

    // Read token config — validate enabled, limits, vault
    let (token_id, shielded_amount) = {
        let tc_data = token_config_info.try_borrow_data()?;
        let tc = TokenConfig::from_bytes(&tc_data)?;

        if !tc.is_enabled() {
            return Err(AegisError::TokenDisabled.into());
        }

        // Validate vault matches
        if vault.key().as_ref() != tc.vault {
            return Err(AegisError::InvalidVault.into());
        }

        // Validate amount limits
        if amount < tc.min_deposit() || amount > tc.max_deposit() {
            return Err(AegisError::AmountOutOfRange.into());
        }

        // Compute fee
        let protocol_fee = (amount as u128 * deposit_fee_bps as u128 / 10_000) as u64;
        let shielded = amount.checked_sub(protocol_fee).ok_or(ProgramError::ArithmeticOverflow)?;

        // Check deposit cap
        if tc.total_shielded().checked_add(shielded).ok_or(ProgramError::ArithmeticOverflow)? > tc.deposit_cap() {
            return Err(AegisError::DepositCapExceeded.into());
        }

        let mut tid = [0u8; 32];
        tid.copy_from_slice(&tc.token_id);
        (tid, shielded)
    };

    let protocol_fee = amount - shielded_amount;

    // Transfer tokens from user → vault
    // Use invoke (not invoke_signed) since user is the signer
    crate::utils::transfer_token(
        token_program,
        user_token_account,
        vault,
        user,
        amount,
    )?;

    // Compute commitment: Poseidon(npk, token_id, shielded_amount)
    let commitment = compute_commitment(npk, &token_id, shielded_amount)?;

    // Insert into Merkle tree
    let leaf_index = {
        let mut tree_data = commitment_tree_info.try_borrow_mut_data()?;
        let tree = CommitmentTree::from_bytes_mut(&mut tree_data)?;
        tree.insert_leaf(&commitment)?;
        tree.next_index() - 1
    };

    // Emit stealth announcement with token_id
    let amount_bytes = shielded_amount.to_le_bytes();
    emit_stealth_announcement_v2(
        ANNOUNCEMENT_TYPE_DEPOSIT,
        ephemeral_pub,
        &amount_bytes,
        &commitment,
        leaf_index as u32,
        &token_id,
    );

    // Update token config
    {
        let mut tc_data = token_config_info.try_borrow_mut_data()?;
        let tc = TokenConfig::from_bytes_mut(&mut tc_data)?;
        tc.add_shielded(shielded_amount)?;
        tc.add_fees(protocol_fee)?;
    }

    pinocchio::msg!("Aegis: shielded tokens");
    Ok(())
}
```

Note: `transfer_token` is a new helper function needed in `utils/token.rs` — a non-signed transfer (user is signer via invoke, not invoke_signed). The existing `transfer_zkbtc` uses PDA signing. We need a plain `invoke` variant. The implementer should add this helper to `utils/token.rs`.

- [ ] **Step 2: Add `transfer_token` helper to `utils/token.rs`**

Add a non-PDA transfer function:
```rust
/// Transfer tokens from a user-signed account (no PDA signing needed)
pub fn transfer_token(
    _token_program: &AccountInfo,
    source: &AccountInfo,
    destination: &AccountInfo,
    authority: &AccountInfo,  // user signer
    amount: u64,
) -> ProgramResult {
    let mut data = [0u8; 9];
    data[0] = token_instruction::TRANSFER;
    data[1..9].copy_from_slice(&amount.to_le_bytes());

    let token_program_id = Pubkey::from(TOKEN_2022_PROGRAM_ID);

    let accounts = [
        AccountMeta::writable(source.key()),
        AccountMeta::writable(destination.key()),
        AccountMeta::readonly_signer(authority.key()),
    ];

    let instruction = Instruction {
        program_id: &token_program_id,
        accounts: &accounts,
        data: &data,
    };

    invoke(&instruction, &[source, destination, authority])
}
```

- [ ] **Step 3: Add error variants to `error.rs`**

Add new error variants needed by multi-token instructions:
```rust
    TokenDisabled,
    InvalidVault,
    AmountOutOfRange,
    DepositCapExceeded,
    InsufficientFees,
```

- [ ] **Step 4: Register in `mod.rs` and `lib.rs`**

Add to `instructions/mod.rs`:
```rust
pub mod shield;
pub use shield::*;
```

Add to `lib.rs` instruction block:
```rust
    pub const SHIELD: u8 = 26;
```

Add to match:
```rust
        instruction::SHIELD => {
            instructions::process_shield(program_id, accounts, data)
        }
```

- [ ] **Step 5: Build and fix compilation**

Run: `cd contracts && cargo build-sbf --features devnet`

- [ ] **Step 6: Commit**

```bash
git add contracts/programs/aegis/src/instructions/shield.rs \
        contracts/programs/aegis/src/instructions/mod.rs \
        contracts/programs/aegis/src/lib.rs \
        contracts/programs/aegis/src/utils/token.rs \
        contracts/programs/aegis/src/error.rs
git commit -m "feat: add shield instruction for SPL token deposits"
```

---

### Task 7: Implement `unshield` instruction (multi-token)

**Files:**
- Create: `contracts/programs/aegis/src/instructions/unshield_v2.rs`
- Modify: `contracts/programs/aegis/src/instructions/mod.rs`
- Modify: `contracts/programs/aegis/src/lib.rs`

- [ ] **Step 1: Create `unshield_v2.rs`**

This is similar to the existing `unshield.rs` but:
- Takes `token_config` PDA as account
- Uses `token_config.token_id` for burn commitment verification
- Applies `withdrawal_fee_bps` from PoolState
- Transfers from token-specific vault (not pool_vault)
- Updates `token_config.total_shielded` and `accumulated_fees`

Follow the structure of `unshield.rs` closely:

```rust
// contracts/programs/aegis/src/instructions/unshield_v2.rs
//! Unshield SPL tokens from the privacy pool (multi-token).
//!
//! User provides JoinSplit ZK proof, last output is a burn commitment.
//! Revealed amount minus fees is transferred from vault to user.
//!
//! # Accounts
//! 0. `[signer]`     User (recipient)
//! 1. `[writable]`   User's token account (destination)
//! 2. `[]`           Pool state PDA
//! 3. `[writable]`   TokenConfig PDA
//! 4. `[writable]`   Vault token account
//! 5. `[writable]`   Commitment tree
//! 6. `[]`           VK registry
//! 7. `[]`           Token-2022 program
//! 8. `[]`           System program
//! 9..9+N_INPUTS:    Nullifier record PDAs (writable)
```

The implementation should mirror `unshield.rs` but replace:
- `ZKBTC_TOKEN_ID` with `token_config.token_id`
- Pool vault with token-specific vault
- Service fee computation with `withdrawal_fee_bps`
- Track fees in `token_config.accumulated_fees`

Key verification: `last_commitment == Poseidon([0u8; 32], token_config.token_id, amount)`

- [ ] **Step 2: Register in `mod.rs` and `lib.rs`**

```rust
pub mod unshield_v2;
pub use unshield_v2::*;
```

Discriminator: `pub const UNSHIELD_V2: u8 = 27;`

- [ ] **Step 3: Build**

Run: `cd contracts && cargo build-sbf --features devnet`

- [ ] **Step 4: Commit**

```bash
git add contracts/programs/aegis/src/instructions/unshield_v2.rs \
        contracts/programs/aegis/src/instructions/mod.rs \
        contracts/programs/aegis/src/lib.rs
git commit -m "feat: add multi-token unshield instruction with ZK proof verification"
```

---

### Task 8: Implement `update_token_config` instruction

**Files:**
- Create: `contracts/programs/aegis/src/instructions/update_token_config.rs`
- Modify: `contracts/programs/aegis/src/instructions/mod.rs`
- Modify: `contracts/programs/aegis/src/lib.rs`

- [ ] **Step 1: Create `update_token_config.rs`**

```rust
// contracts/programs/aegis/src/instructions/update_token_config.rs
//! Update token configuration (admin only).
//!
//! # Accounts
//! 0. `[signer]`   Authority
//! 1. `[]`         Pool state PDA
//! 2. `[writable]` TokenConfig PDA

/// Instruction data: flags(1) + service_fee(8) + min_deposit(8) + max_deposit(8) + deposit_cap(8) + enabled(1)
/// flags byte: bit 0 = update service_fee, bit 1 = update min_deposit,
///             bit 2 = update max_deposit, bit 3 = update deposit_cap,
///             bit 4 = update enabled
```

The implementer reads a flags byte to determine which fields to update, then reads the corresponding values sequentially.

- [ ] **Step 2: Register and route**

Discriminator: `pub const UPDATE_TOKEN_CONFIG: u8 = 25;`

- [ ] **Step 3: Build and commit**

```bash
git commit -m "feat: add update_token_config admin instruction"
```

---

### Task 9: Implement multi-token `claim_fees` instruction

**Files:**
- Create: `contracts/programs/aegis/src/instructions/claim_fees_v2.rs`
- Modify: `contracts/programs/aegis/src/instructions/mod.rs`
- Modify: `contracts/programs/aegis/src/lib.rs`

- [ ] **Step 1: Create `claim_fees_v2.rs`**

```rust
// contracts/programs/aegis/src/instructions/claim_fees_v2.rs
//! Claim accumulated protocol fees for a specific token.
//!
//! # Accounts
//! 0. `[signer]`   Authority
//! 1. `[]`         Pool state PDA
//! 2. `[writable]` TokenConfig PDA (tracks accumulated_fees)
//! 3. `[writable]` Vault token account (source)
//! 4. `[writable]` Admin token account (destination)
//! 5. `[]`         Token-2022 program
//!
//! Instruction data: amount(8) — allows partial claims
```

Logic:
1. Validate authority
2. Read `amount` from data
3. Check `amount <= token_config.accumulated_fees`
4. Transfer from vault → admin token account (PDA-signed)
5. `token_config.accumulated_fees -= amount`

- [ ] **Step 2: Register and route**

Discriminator: `pub const CLAIM_FEES_V2: u8 = 28;`

- [ ] **Step 3: Build and commit**

```bash
git commit -m "feat: add per-token claim_fees instruction"
```

---

## Chunk 3: Modify Existing BTC Instructions

### Task 10: Update `verify_stealth_deposit` for multi-token

**Files:**
- Modify: `contracts/programs/aegis/src/instructions/verify_stealth_deposit.rs`

- [ ] **Step 1: Add TokenConfig as additional account**

Add account index for `token_config` (position 12, after existing 12 accounts — check current layout).

- [ ] **Step 2: Replace `compute_deposit_commitment` with `compute_commitment`**

Replace the hardcoded call:
```rust
// OLD:
let commitment = compute_deposit_commitment(&npk, amount_sats)?;

// NEW:
let token_id = {
    let tc_data = token_config_info.try_borrow_data()?;
    let tc = TokenConfig::from_bytes(&tc_data)?;
    tc.token_id
};
// Apply deposit fee
let deposit_fee = pool.compute_deposit_fee(amount_sats);
let service_fee = tc.service_fee();
let shielded_amount = amount_sats
    .checked_sub(deposit_fee).ok_or(ProgramError::ArithmeticOverflow)?
    .checked_sub(service_fee).ok_or(ProgramError::ArithmeticOverflow)?;
let commitment = compute_commitment(&npk, &token_id, shielded_amount)?;
```

- [ ] **Step 3: Update token_config totals**

After inserting leaf, update:
```rust
tc.add_shielded(shielded_amount)?;
tc.add_fees(deposit_fee + service_fee)?;
```

- [ ] **Step 4: Use `emit_stealth_announcement_v2` with token_id**

- [ ] **Step 5: Build and test**

Run: `cd contracts && cargo build-sbf --features devnet`

- [ ] **Step 6: Commit**

```bash
git commit -m "feat: update verify_stealth_deposit for multi-token (uses TokenConfig)"
```

---

### Task 11: Update `request_redemption` for multi-token

**Files:**
- Modify: `contracts/programs/aegis/src/instructions/request_redemption.rs`

- [ ] **Step 1: Add TokenConfig as additional account**

- [ ] **Step 2: Replace hardcoded burn commitment verification**

```rust
// OLD:
let expected = compute_deposit_commitment(&zero_npk, redeem_amount)?;

// NEW:
let token_id = { /* read from token_config */ };
let expected = compute_commitment(&zero_npk, &token_id, redeem_amount)?;
```

- [ ] **Step 3: Apply withdrawal_fee_bps + service_fee**

```rust
let withdrawal_fee = pool.compute_withdrawal_fee(redeem_amount);
let service_fee = tc.service_fee();
let payout = redeem_amount
    .checked_sub(withdrawal_fee).ok_or(...)?
    .checked_sub(service_fee).ok_or(...)?;
```

- [ ] **Step 4: Update token_config totals**

- [ ] **Step 5: Build and commit**

```bash
git commit -m "feat: update request_redemption for multi-token (uses TokenConfig)"
```

---

### Task 12: Remove superseded instructions (fresh deploy cleanup)

**Files:**
- Modify: `contracts/programs/aegis/src/lib.rs`
- Modify: `contracts/programs/aegis/src/instructions/mod.rs`

The following instructions are removed per the spec (fresh deployment):
- `UNSHIELD` (disc 15) — replaced by `UNSHIELD_V2` (disc 27)
- `REDEEM` (disc 16) — BTC withdrawals use `request_redemption` (disc 5) only
- `PUBLIC_REDEEM` (disc 17) — replaced by `UNSHIELD_V2` (disc 27)
- `REGISTER_DEPOSIT_INTENT` (disc 24) — v2 deposit flow removed
- `VERIFY_DEPOSIT_V2` (disc 25) — v2 deposit flow removed
- Old `CLAIM_FEES` (disc 26) — replaced by `CLAIM_FEES_V2` (disc 28)
- `SET_POOL_CONFIG` (disc 27) — replaced by `UPDATE_TOKEN_CONFIG` (disc 25)

- [ ] **Step 1: Remove match arms and module declarations for superseded instructions**

Remove from `lib.rs` match statement: disc 15, 16, 17, 24, 25, 26, 27 routing.
Remove from `instructions/mod.rs`: `pub mod unshield;`, `pub mod redeem;`, `pub mod public_redeem;`, `pub mod register_deposit_intent;`, `pub mod verify_deposit_v2;`, old `pub mod claim_fees;`, `pub mod set_pool_config;` and their re-exports.

Note: Keep the actual `.rs` files for reference but remove them from compilation. Or delete them entirely since this is a fresh deploy.

- [ ] **Step 2: Build to verify clean compilation**

Run: `cd contracts && cargo build-sbf --features devnet`

- [ ] **Step 3: Commit**

```bash
git commit -m "chore: remove superseded instructions for fresh multi-token deploy"
```

---

## Chunk 4: SDK Changes

### Task 13: Add `computeTokenId` and parameterize token in SDK

**Files:**
- Modify: `sdk/src/poseidon.ts` — add `computeTokenId(mint)`
- Modify: `sdk/src/note.ts` — parameterize `ZKBTC_TOKEN_ID` usage
- Modify: `sdk/src/config.ts` — add token registry types

- [ ] **Step 1: Add `computeTokenId` to `sdk/src/poseidon.ts`**

```typescript
import { BN254_FIELD_PRIME } from './crypto';

/**
 * Reduce a 32-byte value to BN254 scalar field (mod p).
 * Must match on-chain reduce_to_field_exact.
 */
export function reduceToField(bytes: Uint8Array): bigint {
  const value = bytesToBigint(bytes);
  return value % BN254_FIELD_PRIME;
}

/**
 * Compute token_id from mint address: Poseidon(reduce_to_field(mint))
 * Must match on-chain compute_token_id in crypto.rs
 */
export function computeTokenId(mintBytes: Uint8Array): bigint {
  const reduced = reduceToField(mintBytes);
  // Single-input Poseidon — match the on-chain implementation
  return poseidonHash([reduced]);
}
```

- [ ] **Step 2: Parameterize `createJoinSplitNote` in `note.ts`**

```typescript
// OLD: export const ZKBTC_TOKEN_ID = 0x7a627463n;
// NEW: Keep for backward compat, add computeTokenId

export function createJoinSplitNote(
  mpk: bigint,
  random: bigint,
  amount: bigint,
  tokenId: bigint,  // NEW PARAMETER (was hardcoded)
  leafIndex: number = -1,
): JoinSplitNote {
  const npk = computeNPKSync(mpk, random);
  const commitment = computeJoinSplitCommitmentSync(npk, tokenId, amount);
  return { npk, token: tokenId, amount, random, leafIndex, commitment };
}
```

- [ ] **Step 3: Add convenience `getZkBtcTokenId`**

```typescript
export function getZkBtcTokenId(zkbtcMint: PublicKey): bigint {
  return computeTokenId(zkbtcMint.toBytes());
}
```

- [ ] **Step 4: Run SDK tests**

Run: `cd sdk && bun test`
Expected: Existing tests may need updating to pass tokenId parameter.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(sdk): add computeTokenId and parameterize token in note creation"
```

---

### Task 14: Add SDK instruction builders for multi-token

**Files:**
- Modify: `sdk/src/instructions.ts`
- Modify: `sdk/src/pda.ts`

- [ ] **Step 1: Add `deriveTokenConfigPDA` to `pda.ts`**

```typescript
export async function deriveTokenConfigPDA(
  mint: Address,
  programId?: Address,
): Promise<Address> {
  const config = getConfig();
  const pid = programId ?? config.programId;
  const [pda] = await getProgramDerivedAddress({
    programAddress: pid,
    seeds: ["token_config", address(mint).toBytes()],
  });
  return pda;
}
```

- [ ] **Step 2: Add instruction discriminators**

Add to `INSTRUCTION` in `instructions.ts`:
```typescript
  REGISTER_TOKEN: 24,
  UPDATE_TOKEN_CONFIG: 25,
  SHIELD: 26,
  UNSHIELD: 27,     // replaces old UNSHIELD (15)
  CLAIM_FEES: 28,   // replaces old CLAIM_FEES (26)
```

- [ ] **Step 3: Add `buildShieldInstruction`**

```typescript
export function buildShieldInstruction(params: {
  user: Address;
  userTokenAccount: Address;
  poolState: Address;
  tokenConfig: Address;
  vault: Address;
  commitmentTree: Address;
  tokenProgram: Address;
  amount: bigint;
  npk: Uint8Array;
  ephemeralPub: Uint8Array;
}): Instruction {
  const data = new Uint8Array(1 + 72); // disc + amount(8) + npk(32) + ephemeralPub(32)
  data[0] = INSTRUCTION.SHIELD;
  // ... encode amount, npk, ephemeralPub
  // ... build accounts array
}
```

- [ ] **Step 4: Add `buildUnshieldInstruction`, `buildRegisterTokenInstruction`, `buildClaimFeesInstruction`**

Follow same pattern.

- [ ] **Step 5: Run SDK tests**

Run: `cd sdk && bun test`

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(sdk): add multi-token instruction builders and PDA derivation"
```

---

### Task 15: Update SDK event parsing for v2 format

**Files:**
- Modify: `sdk/src/events.ts`

- [ ] **Step 1: Update `parseStealthAnnouncement` to handle 110-byte v2 events**

Check event length: if 78 bytes → v1 (no token_id), if 110 bytes → v2 (has token_id).

```typescript
export interface StealthAnnouncementV2 extends StealthAnnouncement {
  tokenId?: Uint8Array; // 32 bytes, present in v2
}

export function parseStealthAnnouncement(data: Uint8Array): StealthAnnouncementV2 {
  // ... existing parsing for first 78 bytes ...
  const result: StealthAnnouncementV2 = { /* ... */ };

  // v2: has token_id after leaf_index
  if (data.length >= 110) {
    result.tokenId = data.slice(78, 110);
  }

  return result;
}
```

- [ ] **Step 2: Run tests and commit**

```bash
git commit -m "feat(sdk): parse v2 stealth announcement events with token_id"
```

---

## Chunk 5: Integration & Cleanup

### Task 16: Update `initialize` instruction for new fee fields

**Files:**
- Modify: `contracts/programs/aegis/src/instructions/initialize.rs`

- [ ] **Step 1: Accept `deposit_fee_bps` and `withdrawal_fee_bps` in init data**

Add to instruction data parsing:
```rust
let deposit_fee_bps = u16::from_le_bytes(data[offset..offset+2].try_into().unwrap());
let withdrawal_fee_bps = u16::from_le_bytes(data[offset+2..offset+4].try_into().unwrap());
pool.set_deposit_fee_bps(deposit_fee_bps);
pool.set_withdrawal_fee_bps(withdrawal_fee_bps);
```

- [ ] **Step 2: Build and commit**

```bash
git commit -m "feat: accept deposit/withdrawal fee bps in initialize instruction"
```

---

### Task 17: Update discriminator uniqueness tests in `lib.rs`

**Files:**
- Modify: `contracts/programs/aegis/src/lib.rs`

- [ ] **Step 1: Update instruction discriminator uniqueness test**

Add the new discriminators (24-28) to the uniqueness test. Remove old discriminators (15, 16, 17, old 24-27).

- [ ] **Step 2: Update account discriminator uniqueness test**

Add `0x0B` (TokenConfig) to the uniqueness test.

- [ ] **Step 3: Run all contract tests**

Run: `cd contracts && cargo test -p aegis`

- [ ] **Step 4: Build SBF**

Run: `cd contracts && cargo build-sbf --features devnet`

- [ ] **Step 5: Commit**

```bash
git commit -m "test: update discriminator uniqueness tests for multi-token instructions"
```

---

### Task 18: Update SDK init script for multi-token

**Files:**
- Modify: `scripts/init-devnet.mjs` (or equivalent init script)

- [ ] **Step 1: Add `register_token` call for zkBTC**

After pool initialization, register the zkBTC mint as a token:
```javascript
// Register zkBTC as a token
const tokenConfigPDA = await deriveTokenConfigPDA(zkbtcMint);
const registerIx = buildRegisterTokenInstruction({
  authority: authority.publicKey,
  poolState: poolStatePDA,
  mint: zkbtcMint,
  tokenConfig: tokenConfigPDA,
  vault: poolVault,
  // ...
  serviceFee: 1000n,    // 1000 sats
  minDeposit: 5000n,
  maxDeposit: 100_000_000n,
  depositCap: 2_100_000_000_000_000n,
});
```

- [ ] **Step 2: Test on localnet**

Run the init script against a local validator.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: register zkBTC as token in init script"
```

---

### Task 19: Final build and SBF compilation check

- [ ] **Step 1: Full build**

Run: `cd contracts && cargo build-sbf --features devnet`
Expected: Clean compilation

- [ ] **Step 2: Run all Rust tests**

Run: `cd contracts && cargo test -p aegis`
Expected: All pass

- [ ] **Step 3: Run SDK tests**

Run: `cd sdk && bun test`
Expected: All pass (with updated token parameters)

- [ ] **Step 4: Final commit if any fixups needed**

```bash
git commit -m "chore: fix compilation and test issues for multi-token"
```

---

## Chunk 6: Backend & Frontend Updates

### Task 20: Update backend deposit tracker for TokenConfig account

**Files:**
- Modify: `backend/src/deposit_tracker/` — the module that builds and submits `verify_stealth_deposit` transactions

- [ ] **Step 1: Add TokenConfig PDA derivation**

The deposit tracker must derive the TokenConfig PDA for zkBTC and include it as account index 12 when building `verify_stealth_deposit` transactions.

- [ ] **Step 2: Update transaction builder to include TokenConfig account**

- [ ] **Step 3: Test deposit flow end-to-end**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(backend): pass TokenConfig PDA in verify_stealth_deposit"
```

---

### Task 21: Update backend redemption processor for TokenConfig account

**Files:**
- Modify: `backend/src/redemption/` — the module that builds `request_redemption` transactions

- [ ] **Step 1: Add TokenConfig PDA to redemption request transaction builder**

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(backend): pass TokenConfig PDA in request_redemption"
```

---

### Task 22: Update backend event indexer for v2 announcement events

**Files:**
- Modify: `backend/src/event_indexer/parser.rs` — parses sol_log_data events

- [ ] **Step 1: Update stealth announcement parser to handle 110-byte v2 events**

If event is 78 bytes → v1 (no token_id). If 110 bytes → v2 (token_id at bytes 78-110).

- [ ] **Step 2: Store/expose token_id in indexed events**

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(backend): parse v2 stealth announcement events with token_id"
```

---

### Task 23: Update frontend for multi-token support

**Files:**
- Modify: `aegis-app/src/` — multiple frontend files

- [ ] **Step 1: Update instruction builders in frontend**

Add new discriminators (24-28) and update SDK imports.

- [ ] **Step 2: Add token selection UI (if applicable)**

For SPL shield/unshield, users need to select which token to shield.

- [ ] **Step 3: Update event parsing for v2 format**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(frontend): multi-token support in UI and instruction builders"
```

---

### Task 24: Update SDK instruction discriminators

**Files:**
- Modify: `sdk/src/instructions.ts`

- [ ] **Step 1: Update INSTRUCTION const to include new discriminators and remove old ones**

```typescript
const INSTRUCTION = {
  INITIALIZE: 0,
  VERIFY_STEALTH_DEPOSIT: 1,
  REQUEST_REDEMPTION: 5,
  COMPLETE_REDEMPTION: 6,
  SET_PAUSED: 7,
  INIT_VK_REGISTRY: 11,
  UPDATE_VK_REGISTRY: 12,
  ADD_DEMO_STEALTH: 13,
  TRANSACT: 14,
  // 15 (old UNSHIELD), 16 (REDEEM), 17 (PUBLIC_REDEEM) — removed
  PROPOSE_POOL_UPDATE: 21,
  EXECUTE_POOL_UPDATE: 22,
  CANCEL_POOL_UPDATE: 23,
  // New multi-token instructions
  REGISTER_TOKEN: 24,
  UPDATE_TOKEN_CONFIG: 25,
  SHIELD: 26,
  UNSHIELD: 27,
  CLAIM_FEES: 28,
} as const;
```

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(sdk): update instruction discriminators for multi-token"
```
