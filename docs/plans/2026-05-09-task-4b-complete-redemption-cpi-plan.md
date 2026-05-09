# Task 4b — `complete_redemption` CPIs Ika `approve_message`: Implementation Plan

> **Sub-plan of:** `docs/plans/2026-05-09-ika-phase1-implementation-plan.md` (Task 4).
> **Predecessors:** Tasks 0–3 (recon, PoolConfig fields, SDK helpers) plus Task 4a (manual CPI helper at `contracts/programs/privacy-coin/src/cpi/ika.rs`) — all landed.
> **Successor:** Task 5 (off-chain Ika watcher polls `MessageApproval`/`Sign` PDAs).
> **Branch:** `ika`.

## Executive summary

Task 4a landed a Pinocchio-0.9 manual CPI helper (`cpi::ika::approve_message`) that wraps the Ika dWallet program's `approve_message` (discriminator 8). Task 4b finishes the on-chain side of the FROST→Ika pivot: when `complete_redemption` succeeds, the Privacy Coin program (1) runs the *pure* portion of `frost_server::policy` against the redemption (amount limits, fee bound, paused state) on-chain, (2) accepts the BIP-341 taproot sighash as opaque 32-byte instruction data from the trusted backend caller, and (3) issues the CPI to Ika to create a `MessageApproval` PDA. The off-chain mock signer (Task 5) populates the `Sign` PDA asynchronously; this plan stops at the CPI dispatch and `MessageApproval` creation.

The architecturally load-bearing decision is to **pass the sighash as a 32-byte field in instruction data** rather than recompute it on-chain. The Privacy Coin program already SPV-validates the *settled* BTC tx in `complete_redemption` (against a `VerifiedTransaction` PDA owned by `btc-light-client`). The pre-broadcast unsigned-tx sighash, by contrast, would require the program to re-serialize a full Bitcoin transaction (inputs + prevouts + scripts + scheme byte) and call BIP-341 hashing — none of which is currently in `utils/secp256k1.rs` and all of which costs CU we cannot afford. The trust boundary stays at the Privacy Coin program (it owns the redemption PDA, its `btc_script`, and its `amount_sats`); the backend's only freedom in choosing the sighash is to choose a different unsigned tx, which we constrain via on-chain policy + the existing post-settlement `complete_redemption` SPV check that ties the *broadcast* tx output back to the redemption's `btc_script` and amount.

## Architectural decisions (locked in)

1. **BTC sighash provenance: opaque-from-caller.** The 32-byte taproot sighash is appended to `complete_redemption` instruction data. The on-chain program does *not* recompute it. Rationale: porting BIP-341 (with prevout serialization, script bytes, sighash type byte, key-spend vs. script-spend differentiation, segwit annex handling) into Pinocchio is multi-week work; it cannot meaningfully validate without the unsigned tx + prevouts, which would balloon CU and account count. The on-chain program already constrains the *destination + amount* via the existing redemption PDA and the post-broadcast SPV check; the sighash is just the message we want Ika to sign for *some* unsigned tx whose outputs we'll later verify via `verify_stealth_deposit`-style SPV. Lower bar acceptable because the worst case (caller submits a wrong sighash) produces a non-broadcastable signature → no funds move → safe failure mode. Hackathon-correct.

2. **`complete_redemption` account list: append-only.** Existing 13 baseline + variable consumed-UTXO tail. We append 6 new Ika accounts at fixed positions starting *after* the variable tail's upper bound. Concretely, we add a single new instruction-data byte `consumed_utxo_count` is already present at the end of ix data; the SDK already writes consumed UTXOs after position 13/14. We change neither baseline indices [0..12] nor the change-utxo / consumed-utxo positions. Instead, the *backend caller* learns the new account positions from `accounts.length`: the trailing 6 Ika accounts come at `[base_after_consumed .. base_after_consumed+6)` where `base_after_consumed = (pool_script_len > 0 ? 14 : 13) + consumed_utxo_count`. The on-chain code re-derives that same offset.

   Rationale: this keeps the existing E2E test path unchanged for callers that don't yet know about Ika (they get a hard `NotEnoughAccountKeys` failure, not silent miscompute) while letting Ika-aware callers extend cleanly. Interleaving would force re-numbering 14 positions and silently break every existing SDK call.

3. **CPI authority bump: cached.** `pool_config.cpi_authority_bump` (already added in Task 1, see `state/pool_config.rs:42`) is read once and passed to `cpi::ika::approve_message`. We do *not* call `find_program_address(&[CPI_AUTHORITY_SEED], program_id)` on the hot path — that's ~1500 CU per redemption we can avoid.

4. **On-chain policy: only the pure validation parts port.** Read of `frost_server/src/policy.rs` shows nine sections: (1) sighash recompute → drop (decision 1); (2) Esplora UTXO check → drop (off-chain only, requires HTTP); (3) destination address parsing → drop (Bitcoin address parsing is heavy); (4) amount limit; (5) fee limit; (6) Solana on-chain verification → already done elsewhere in this same instruction; (6b) PDA service-fee sanity → already done at request time; (6c) UTXO PDA cross-check → already done in `mark_processing`; (7) duplicate signing → already done by `CompletionReceipt` + `RedemptionStatus`; (8) cross-validate outputs → already done by `complete_redemption`'s output-match block; (9) mempool check → off-chain only.

   Net port: **only #4 (`max_amount_sats`) and #5 (`max_fee_sats`) survive.** Plus a `paused` check pulled from `PoolState::is_paused()` (already in tree). New file `contracts/programs/privacy-coin/src/utils/policy.rs` with one public function: `pub fn check_redemption_signing(pool: &PoolState, amount_sats: u64, miner_fee: u64) -> Result<(), ProgramError>`. Constants `MAX_REDEMPTION_AMOUNT_SATS` and `MAX_MINER_FEE_SATS` are local consts (matching `complete_redemption.rs`'s existing `MAX_FEE_SATS = 50_000`).

5. **Test harness: Mollusk with the pre-built `ika_dwallet_program.so`.** We reuse the upstream-provided binary at `/tmp/ika-pre-alpha-scratch/ika-pre-alpha/bin/ika_dwallet_program.so` (referenced in recon brief). We pre-populate Coordinator + DWallet + payer accounts following the voting example's `litesvm.rs` pattern, then drive `complete_redemption`, then assert the `MessageApproval` PDA was created and contains the right `message_hash`. The Mollusk recorder is *not* needed — the upstream Ika program creates a real PDA we can read post-execution.

## File-structure map

| File | Status | Responsibility |
|---|---|---|
| `contracts/programs/privacy-coin/src/utils/policy.rs` | **NEW** | Pure on-chain redemption-signing policy: amount cap + fee cap + paused. Single public fn `check_redemption_signing`. |
| `contracts/programs/privacy-coin/src/utils/mod.rs` | **MODIFY** | Add `pub mod policy;` and re-export. |
| `contracts/programs/privacy-coin/src/instructions/complete_redemption.rs` | **MODIFY** | Accept new 32-byte `btc_sighash` field at end of ix data. After existing SPV+burn block, run `policy::check_redemption_signing`, then CPI `cpi::ika::approve_message` with cached `cpi_authority_bump`. New 6 accounts appended after consumed UTXOs. |
| `contracts/programs/privacy-coin/src/error.rs` | **MODIFY** | Add three error variants: `RedemptionAmountExceedsLimit`, `RedemptionFeeExceedsLimit`, `IkaCpiAccountsMissing`. |
| `contracts/programs/privacy-coin/tests/complete_redemption_ika_cpi.rs` | **NEW** | Mollusk test: load `ika_dwallet_program.so`, build `complete_redemption` ix with full 19+ accounts, assert program returns Ok and `MessageApproval` PDA was created with the expected `message_hash`. |
| `contracts/programs/privacy-coin/Cargo.toml` | **MODIFY** | Bump `[dev-dependencies]` already has `mollusk-svm` and `litesvm`; only add new test target if `tests/` dir didn't exist. (It doesn't — first integration test in this crate.) |

## Pre-flight check

- [ ] **Step P.1: Confirm clean working tree on `ika` branch and Task 4a baseline**

```bash
cd /Users/chengchunyuan/project/hackathon/private_coin
git status
git log --oneline -5
git branch --show-current
```

Expected: branch `ika`; recent commit history mentions Task 4a (the `cpi/ika.rs` landing).

- [ ] **Step P.2: Confirm baseline test green (102/102 + 5 new = 107)**

```bash
cd /Users/chengchunyuan/project/hackathon/private_coin/contracts
cargo test -p privacy-coin 2>&1 | tail -20
```

Expected: `test result: ok. 107 passed` (or higher). Any failure here is blocking — fix before starting Task 4b.

- [ ] **Step P.3: Confirm SBF build green**

```bash
cd /Users/chengchunyuan/project/hackathon/private_coin
cargo build-sbf --features localnet --manifest-path contracts/programs/privacy-coin/Cargo.toml 2>&1 | tail -5
```

Expected: `Finished`.

- [ ] **Step P.4: Confirm Ika SBF binary available for tests**

```bash
ls -lh /tmp/ika-pre-alpha-scratch/ika-pre-alpha/bin/ika_dwallet_program.so
```

Expected: file exists, size >100KB. If missing, restore from upstream repo before starting.

---

## Task 4b.1 — Add error variants

**Why this exists:** New policy checks need typed errors so callers can react. Reusing `ProgramError::Custom(N)` is fine but typed errors keep `cargo test` failure messages readable.

**Files:** `contracts/programs/privacy-coin/src/error.rs`

- [ ] **Step 4b.1.1: Read existing error tail to find next free discriminant**

```bash
grep -nE "^[[:space:]]*[A-Z][a-zA-Z]+ = [0-9]+" /Users/chengchunyuan/project/hackathon/private_coin/contracts/programs/privacy-coin/src/error.rs | tail -10
```

Capture the highest variant number — the new ones append after it.

- [ ] **Step 4b.1.2: Add three new variants**

In `error.rs`, immediately before the closing `}` of `enum PrivacyCoinError`, insert:

```rust
    #[error("Redemption amount exceeds policy limit")]
    RedemptionAmountExceedsLimit = 6080,

    #[error("Computed miner fee exceeds policy limit")]
    RedemptionFeeExceedsLimit = 6081,

    #[error("Required Ika CPI accounts missing from accounts slice")]
    IkaCpiAccountsMissing = 6082,
```

(Use `6080..6082` if those slots are free; otherwise pick the next three from your captured tail. Don't reuse existing slots.)

- [ ] **Step 4b.1.3: Build to confirm**

```bash
cd /Users/chengchunyuan/project/hackathon/private_coin/contracts
cargo build -p privacy-coin 2>&1 | tail -5
```

Expected: `Finished`.

---

## Task 4b.2 — Pure on-chain policy module

**Files:** `contracts/programs/privacy-coin/src/utils/policy.rs` (new), `contracts/programs/privacy-coin/src/utils/mod.rs` (modify).

- [ ] **Step 4b.2.1: Create `utils/policy.rs` with the minimal port**

Create the file with this exact content:

```rust
//! Pure on-chain signing policy for redemptions.
//!
//! This is the *minimal* port of `frost_server/src/policy.rs` — only the
//! validation predicates that (a) are computable from on-chain data alone,
//! and (b) are not already covered elsewhere in `complete_redemption`.
//!
//! Surviving from the FROST policy:
//! - amount limit (max gross redemption per signing operation)
//! - fee limit  (max miner fee per signing operation)
//! - paused state (pool-wide kill switch)
//!
//! Dropped (handled elsewhere or impossible on-chain):
//! - sighash recomputation: too expensive on-chain; sighash arrives opaque
//!   in instruction data, signed off-chain by Ika
//! - destination whitelist: redemption PDA's `btc_script` already pins this
//! - UTXO existence check: requires Esplora HTTP
//! - duplicate signing: `CompletionReceipt` PDA already prevents this
//! - cross-validate outputs: `complete_redemption` already does this against
//!   the SPV-verified broadcast tx
//! - mempool already-paid check: requires Esplora HTTP

use pinocchio::program_error::ProgramError;

use crate::error::PrivacyCoinError;
use crate::state::PoolState;

/// Maximum gross redemption amount per signing operation, in satoshis.
/// Set conservatively at 1 BTC for the hackathon — bumps via PoolConfig
/// require redeploy and audit.
pub const MAX_REDEMPTION_AMOUNT_SATS: u64 = 100_000_000;

/// Maximum allowed miner fee per signing operation, in satoshis.
/// Matches `complete_redemption::MAX_FEE_SATS` to avoid divergence.
pub const MAX_MINER_FEE_SATS: u64 = 50_000;

/// Run all pre-CPI signing policy checks.
///
/// Called from `complete_redemption` *after* SPV/output verification and
/// *before* the Ika `approve_message` CPI. The intent is symmetric with the
/// FROST signers' independent verification: even though Ika is one entity,
/// we still gate the on-chain CPI so that a compromised backend cannot drain
/// funds by submitting forged sighashes for sky-high amounts.
pub fn check_redemption_signing(
    pool: &PoolState,
    amount_sats: u64,
    miner_fee_sats: u64,
) -> Result<(), ProgramError> {
    if pool.is_paused() {
        return Err(PrivacyCoinError::PoolPaused.into());
    }
    if amount_sats > MAX_REDEMPTION_AMOUNT_SATS {
        return Err(PrivacyCoinError::RedemptionAmountExceedsLimit.into());
    }
    if miner_fee_sats > MAX_MINER_FEE_SATS {
        return Err(PrivacyCoinError::RedemptionFeeExceedsLimit.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unpaused_pool() -> Vec<u8> {
        let mut buf = vec![0u8; PoolState::LEN];
        let p = PoolState::init(&mut buf).expect("init pool");
        // Default-constructed pool is unpaused. (Sanity: fail if init changes.)
        assert!(!p.is_paused());
        buf
    }

    #[test]
    fn accepts_amount_and_fee_at_limit() {
        let mut buf = unpaused_pool();
        let pool = PoolState::from_bytes(&buf).unwrap();
        assert!(check_redemption_signing(
            pool,
            MAX_REDEMPTION_AMOUNT_SATS,
            MAX_MINER_FEE_SATS,
        )
        .is_ok());
    }

    #[test]
    fn rejects_amount_over_limit() {
        let buf = unpaused_pool();
        let pool = PoolState::from_bytes(&buf).unwrap();
        let err = check_redemption_signing(
            pool,
            MAX_REDEMPTION_AMOUNT_SATS + 1,
            0,
        )
        .unwrap_err();
        assert_eq!(err, PrivacyCoinError::RedemptionAmountExceedsLimit.into());
    }

    #[test]
    fn rejects_fee_over_limit() {
        let buf = unpaused_pool();
        let pool = PoolState::from_bytes(&buf).unwrap();
        let err = check_redemption_signing(
            pool,
            0,
            MAX_MINER_FEE_SATS + 1,
        )
        .unwrap_err();
        assert_eq!(err, PrivacyCoinError::RedemptionFeeExceedsLimit.into());
    }

    #[test]
    fn rejects_when_paused() {
        let mut buf = unpaused_pool();
        {
            let p = PoolState::from_bytes_mut(&mut buf).unwrap();
            p.set_paused(true);
        }
        let pool = PoolState::from_bytes(&buf).unwrap();
        let err = check_redemption_signing(pool, 0, 0).unwrap_err();
        assert_eq!(err, PrivacyCoinError::PoolPaused.into());
    }
}
```

> Note: if `PoolState::init` and `set_paused` have different signatures than assumed, adjust by reading `contracts/programs/privacy-coin/src/state/pool_state.rs`. The test logic stays the same — only the helper accessors change.

- [ ] **Step 4b.2.2: Wire into `utils/mod.rs`**

Edit `contracts/programs/privacy-coin/src/utils/mod.rs`. After the existing `pub mod validation;` line, add:

```rust
pub mod policy;
```

Do **not** glob-re-export — `policy::check_redemption_signing` is intentionally namespaced.

- [ ] **Step 4b.2.3: Confirm tests pass**

```bash
cd /Users/chengchunyuan/project/hackathon/private_coin/contracts
cargo test -p privacy-coin policy:: 2>&1 | tail -10
```

Expected: 4 new tests pass.

- [ ] **Step 4b.2.4: Full crate test still green**

```bash
cd /Users/chengchunyuan/project/hackathon/private_coin/contracts
cargo test -p privacy-coin 2>&1 | tail -5
```

Expected: 111+ tests pass (107 baseline + 4 new). Zero new failures.

---

## Task 4b.3 — Extend `CompleteRedemptionData` with sighash

**Files:** `contracts/programs/privacy-coin/src/instructions/complete_redemption.rs`

- [ ] **Step 4b.3.1: Extend the `CompleteRedemptionData` struct**

In `complete_redemption.rs`, modify the struct + `MIN_SIZE` + `from_bytes` to read a trailing 32-byte `btc_sighash` field:

```rust
pub struct CompleteRedemptionData {
    pub btc_txid: [u8; 32],
    pub tx_size: u32,
    pub pool_script_len: u8,
    pub pool_script: [u8; 34],
    pub consumed_utxo_count: u8,
    /// 32-byte BIP-341 taproot key-spend sighash for the *unsigned* withdrawal tx.
    /// The on-chain program does NOT recompute this — it forwards the bytes to
    /// the Ika `approve_message` CPI as the `message_digest`. The trust boundary
    /// is the existing settled-tx SPV check + redemption PDA constraints.
    pub btc_sighash: [u8; 32],
}

impl CompleteRedemptionData {
    /// 32 (txid) + 4 (tx_size) + 1 (script_len) + 1 (consumed_count) + 32 (sighash) = 70.
    /// `pool_script` is variable (0..=34) and inserted between script_len and
    /// consumed_count, so `MIN_SIZE` is the no-script case.
    pub const MIN_SIZE: usize = 32 + 4 + 1 + 1 + 32;

    pub fn from_bytes(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < Self::MIN_SIZE {
            return Err(ProgramError::InvalidInstructionData);
        }

        let mut btc_txid = [0u8; 32];
        btc_txid.copy_from_slice(&data[0..32]);

        let tx_size = u32::from_le_bytes(data[32..36].try_into().unwrap());

        let pool_script_len = data[36];
        let mut pool_script = [0u8; 34];

        let mut offset = 37;
        if pool_script_len > 0 {
            let end = offset + pool_script_len as usize;
            if end > data.len() || pool_script_len as usize > 34 {
                return Err(ProgramError::InvalidInstructionData);
            }
            pool_script[..pool_script_len as usize].copy_from_slice(&data[offset..end]);
            offset = end;
        }

        let consumed_utxo_count = if offset < data.len() {
            data[offset]
        } else {
            return Err(ProgramError::InvalidInstructionData);
        };
        offset += 1;

        // 32-byte sighash is the trailing field.
        if offset + 32 > data.len() {
            return Err(ProgramError::InvalidInstructionData);
        }
        let mut btc_sighash = [0u8; 32];
        btc_sighash.copy_from_slice(&data[offset..offset + 32]);

        Ok(Self {
            btc_txid,
            tx_size,
            pool_script_len,
            pool_script,
            consumed_utxo_count,
            btc_sighash,
        })
    }
}
```

- [ ] **Step 4b.3.2: Add unit test for the new layout**

Append to `complete_redemption.rs` (or create a `#[cfg(test)] mod` if absent):

```rust
#[cfg(test)]
mod ix_data_layout_tests {
    use super::*;

    #[test]
    fn parses_sighash_with_no_pool_script() {
        let mut buf = Vec::with_capacity(70);
        buf.extend_from_slice(&[0xAA; 32]); // btc_txid
        buf.extend_from_slice(&123u32.to_le_bytes()); // tx_size
        buf.push(0); // pool_script_len
        buf.push(2); // consumed_utxo_count
        buf.extend_from_slice(&[0xBB; 32]); // btc_sighash

        let parsed = CompleteRedemptionData::from_bytes(&buf).unwrap();
        assert_eq!(parsed.btc_txid, [0xAA; 32]);
        assert_eq!(parsed.tx_size, 123);
        assert_eq!(parsed.pool_script_len, 0);
        assert_eq!(parsed.consumed_utxo_count, 2);
        assert_eq!(parsed.btc_sighash, [0xBB; 32]);
    }

    #[test]
    fn parses_sighash_with_pool_script() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&[0x11; 32]); // btc_txid
        buf.extend_from_slice(&99u32.to_le_bytes()); // tx_size
        buf.push(34); // pool_script_len
        buf.extend_from_slice(&[0x51; 34]); // pool_script (P2TR pattern, contents arbitrary)
        buf.push(0); // consumed_utxo_count
        buf.extend_from_slice(&[0xCC; 32]); // btc_sighash

        let parsed = CompleteRedemptionData::from_bytes(&buf).unwrap();
        assert_eq!(parsed.pool_script_len, 34);
        assert_eq!(parsed.btc_sighash, [0xCC; 32]);
    }

    #[test]
    fn rejects_truncated_sighash() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&[0; 32]);
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf.push(0); // pool_script_len
        buf.push(0); // consumed_utxo_count
        buf.extend_from_slice(&[0; 16]); // only 16 bytes of sighash → short
        let res = CompleteRedemptionData::from_bytes(&buf);
        assert!(res.is_err());
    }
}
```

- [ ] **Step 4b.3.3: Run only these new tests**

```bash
cd /Users/chengchunyuan/project/hackathon/private_coin/contracts
cargo test -p privacy-coin ix_data_layout_tests 2>&1 | tail -10
```

Expected: 3 new tests pass.

- [ ] **Step 4b.3.4: Verify no existing test regressed**

```bash
cd /Users/chengchunyuan/project/hackathon/private_coin/contracts
cargo test -p privacy-coin 2>&1 | tail -5
```

Expected: count went up by 3 (or 7 counting the policy tests from Task 4b.2). Zero failures.

---

## Task 4b.4 — Wire the Ika CPI into `complete_redemption`

**Files:** `contracts/programs/privacy-coin/src/instructions/complete_redemption.rs`

The instruction's existing burn + change-utxo + consumed-utxo + close-PDA flow stays unchanged. We add (a) policy gate before the burn, (b) Ika CPI block after the burn but before the close-redemption step (so the redemption PDA is still readable for cross-checks if a future policy needs it; close happens last).

- [ ] **Step 4b.4.1: Add imports**

At the top of the file, after the existing `use` block, add:

```rust
use crate::cpi::ika::{approve_message, ApproveMessageAccounts, SIG_SCHEME_TAPROOT_SHA256};
use crate::utils::policy::check_redemption_signing;
```

- [ ] **Step 4b.4.2: Wire the policy check before burn**

In `process_complete_redemption`, find the line:

```rust
    let burn_amount = actual_received.saturating_add(miner_fee);
```

(approximately line 353 of the existing file). Immediately *before* that line — i.e. right after `miner_fee` is computed and bounded by `MAX_FEE_SATS` — insert:

```rust
    // --- Pure on-chain signing policy gate ---
    {
        let pool_data = pool_state_info.try_borrow_data()?;
        let pool = PoolState::from_bytes(&pool_data)?;
        check_redemption_signing(pool, amount_sats, miner_fee)?;
    }
```

This adds an early-out for amount/fee/paused before any irreversible state change.

- [ ] **Step 4b.4.3: Compute the Ika account-slice base offset**

After the consumed-UTXO close loop completes (the `for i in 0..consumed_count` block ending around line 458), and *before* the pool-state update block (`// --- Update pool state with exact accounting ---`), insert:

```rust
    // --- Ika approve_message CPI ---
    // Accounts beyond the consumed-UTXO tail are the Ika CPI inputs.
    // Layout (after consumed UTXOs):
    //   [base + 0] ika_program            (read, executable)
    //   [base + 1] coordinator            (read, owned by Ika program)
    //   [base + 2] message_approval       (write, will be created)
    //   [base + 3] dwallet                (read, owned by Ika program)
    //   [base + 4] caller_program         (read; this Privacy Coin program account)
    //   [base + 5] cpi_authority          (read, signer via invoke_signed; PDA)
    //   [base + 6] payer                  (write, signer)
    //   [base + 7] ika_system_program     (read, system program — re-used because
    //                                      account dedup is not guaranteed across the
    //                                      complete_redemption tail; pass the same
    //                                      system program account from index 11 if
    //                                      it's the right key, otherwise require a
    //                                      separate handle)
    //   [base + 8] message_approval_bump  via instruction-data trailer? No — derived
    //                                      on-chain via find_program_address against
    //                                      the Ika program. See below.
    let ika_base = consumed_start + consumed_count;
    if accounts.len() < ika_base + 7 {
        return Err(PrivacyCoinError::IkaCpiAccountsMissing.into());
    }
    let ika_program = &accounts[ika_base];
    let ika_coordinator = &accounts[ika_base + 1];
    let ika_message_approval = &accounts[ika_base + 2];
    let ika_dwallet = &accounts[ika_base + 3];
    let caller_program = &accounts[ika_base + 4];
    let cpi_authority = &accounts[ika_base + 5];
    let ika_payer = &accounts[ika_base + 6];
    // The system program is shared with index 11; if absent in the tail,
    // reuse `_system_program`.
    let ika_system_program = &accounts[11];

    // Read cached CPI authority bump from PoolConfig (already validated owner above
    // when pool_script_len > 0; do a read-only re-fetch when not).
    let cpi_authority_bump = {
        let cfg_data = pool_config_info.try_borrow_data()?;
        if cfg_data.len() < PoolConfig::LEN || cfg_data[0] != POOL_CONFIG_DISCRIMINATOR {
            return Err(PrivacyCoinError::IkaCpiAccountsMissing.into());
        }
        let cfg = PoolConfig::from_bytes(&cfg_data)?;
        cfg.get_cpi_authority_bump()
    };

    // Derive MessageApproval PDA bump on-chain.
    // Seeds (from upstream voting example): ["message_approval", dwallet, message_hash]
    let (expected_ma_pda, ma_bump) = pinocchio::pubkey::find_program_address(
        &[
            b"message_approval",
            ika_dwallet.key().as_ref(),
            ix_data.btc_sighash.as_ref(),
        ],
        ika_program.key(),
    );
    if ika_message_approval.key() != &expected_ma_pda {
        return Err(ProgramError::InvalidSeeds);
    }

    // The user_pubkey field is opaque to the dWallet; we echo `btc_sighash`
    // back so the off-chain watcher can correlate by sighash without needing
    // an extra index. Could also be the requester's pubkey — kept simple.
    let user_pubkey: [u8; 32] = ix_data.btc_sighash;
    let metadata_zero: [u8; 32] = [0u8; 32];

    approve_message(
        ApproveMessageAccounts {
            coordinator: ika_coordinator,
            message_approval: ika_message_approval,
            dwallet: ika_dwallet,
            caller_program,
            cpi_authority,
            payer: ika_payer,
            system_program: ika_system_program,
            dwallet_program: ika_program,
        },
        &ix_data.btc_sighash,
        &metadata_zero,
        &user_pubkey,
        SIG_SCHEME_TAPROOT_SHA256,
        ma_bump,
        cpi_authority_bump,
    )?;
```

> Note: `pinocchio::pubkey::find_program_address` exists in 0.9; verify by `grep -n "fn find_program_address" $(rustc --print sysroot)/lib/...` only if the build fails — the existing `complete_redemption.rs` already imports `find_program_address` at the top so this is just adding another call site.

- [ ] **Step 4b.4.4: Update the `# Accounts` doc comment block**

Above `pub fn process_complete_redemption`, extend the existing `/// # Accounts` comment with:

```rust
/// 14+N..14+N+7 (where N = consumed_utxo_count) `[]` Ika CPI accounts:
///   - [+0] `[]`           Ika dWallet program (executable)
///   - [+1] `[]`           Ika DWalletCoordinator PDA
///   - [+2] `[writable]`   MessageApproval PDA (created by Ika program)
///   - [+3] `[]`           dWallet account (owned by Ika program)
///   - [+4] `[]`           This Privacy Coin program's program-account (caller)
///   - [+5] `[]`           CPI authority PDA (PDA of this program)
///   - [+6] `[writable, signer]` Payer for MessageApproval rent
///
/// (System program is shared with account index 11 — caller passes it once.)
```

- [ ] **Step 4b.4.5: Build to confirm compile**

```bash
cd /Users/chengchunyuan/project/hackathon/private_coin/contracts
cargo build -p privacy-coin 2>&1 | tail -10
cargo build-sbf --features localnet --manifest-path contracts/programs/privacy-coin/Cargo.toml 2>&1 | tail -10
```

Expected: both green. If the second command fails, that's blocking — likely `find_program_address` is not exposed for SBF target; in that case use the upstream import path used elsewhere in this file (the file already calls `find_program_address` for `RedemptionRequest::SEED`, so this should compile).

- [ ] **Step 4b.4.6: Confirm existing tests still pass (no SDK callers updated yet — this is expected)**

```bash
cd /Users/chengchunyuan/project/hackathon/private_coin/contracts
cargo test -p privacy-coin --lib 2>&1 | tail -10
```

Expected: lib tests still pass (110+). Integration tests not yet present.

---

## Task 4b.5 — Mollusk integration test

**Files:** `contracts/programs/privacy-coin/tests/complete_redemption_ika_cpi.rs` (new)

This is the load-bearing acceptance test: it loads the upstream Ika program SBF, constructs a complete_redemption call with a fake (but well-formed) redemption + light-client + chadbuffer state, executes it, and verifies the `MessageApproval` PDA was populated by Ika.

The test is large because it must seed every account `complete_redemption` reads. Most of the harness mirrors `voting/pinocchio/tests/litesvm.rs` but uses Mollusk for instruction-level isolation rather than full LiteSVM transaction processing.

- [ ] **Step 4b.5.1: Create the test file with the harness**

Create `contracts/programs/privacy-coin/tests/complete_redemption_ika_cpi.rs` with:

```rust
//! Mollusk integration test: complete_redemption issues approve_message CPI
//! against the real Ika dWallet program SBF binary and a MessageApproval PDA
//! is created.
//!
//! Source of truth for account/data layouts: docs/recon/2026-05-09-ika-sdk-brief.md.
//! Harness pattern adapted from
//! /tmp/ika-pre-alpha-scratch/ika-pre-alpha/chains/solana/examples/voting/pinocchio/tests/litesvm.rs.

#![cfg(not(target_os = "solana"))]

use mollusk_svm::Mollusk;
use solana_sdk::{
    account::Account,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
};

// ── Path to the Ika dWallet program SBF binary (pre-built upstream) ──
const IKA_PROGRAM_BINARY: &str =
    "/tmp/ika-pre-alpha-scratch/ika-pre-alpha/bin/ika_dwallet_program.so";

const PRIVACY_COIN_PROGRAM_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../target/deploy/privacy_coin"
);

// ── Ika constants (mirrored from upstream litesvm.rs) ──
const IKA_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c,
    0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x01,
]);
const CPI_AUTHORITY_SEED: &[u8] = b"__ika_cpi_authority";
const SYSTEM_PROGRAM_ID: Pubkey = Pubkey::new_from_array([0u8; 32]);
const NATIVE_LOADER_ID: Pubkey = Pubkey::new_from_array([
    0x05, 0x87, 0x84, 0xbf, 0x14, 0x8b, 0xa4, 0x28, 0x2f, 0xb0, 0x12, 0x57, 0x48, 0x88, 0xa9, 0xf1,
    0x53, 0xa0, 0x7d, 0xad, 0xf7, 0x65, 0xc0, 0x45, 0x5c, 0x9a, 0x97, 0x03, 0x80, 0x00, 0x00, 0x00,
]);

const DISC_COORDINATOR: u8 = 1;
const DISC_DWALLET: u8 = 2;
const DISC_NEK: u8 = 3;
const DISC_MESSAGE_APPROVAL: u8 = 14;

const COORDINATOR_LEN: usize = 2 + 114;
const DWALLET_LEN: usize = 2 + 690;
const NEK_LEN: usize = 2 + 162;

const DW_AUTHORITY: usize = 2;
const DW_PUBLIC_KEY: usize = 37;
const DW_CREATED_EPOCH: usize = 102;
const DW_NOA_PUBLIC_KEY: usize = 110;
const DW_IS_IMPORTED: usize = 142;
const DW_BUMP: usize = 659;
const DW_STATE_ACTIVE: u8 = 1;
const CURVE_SECP256K1: u8 = 0; // secp256k1 (BTC) — confirm at first run; recon brief notes this is "likely 0"

const COORD_AUTHORITY: usize = 2;
const COORD_EPOCH: usize = 34;
const COORD_TOTAL_DWALLETS: usize = 42;
const COORD_PAUSED: usize = 50;
const COORD_BUMP: usize = 51;

const NEK_NOA_PUBKEY: usize = 2;
const NEK_STATE: usize = 34;
const NEK_CREATED_EPOCH: usize = 35;
const NEK_BUMP: usize = 147;
const NEK_STATE_ACTIVE: u8 = 1;

const MA_DWALLET: usize = 2;
const MA_MESSAGE_HASH: usize = 34;

// ── Privacy Coin constants ──
const PRIVACY_COIN_INSTRUCTION_COMPLETE_REDEMPTION: u8 = 17;

// ── Helpers ──
fn funded() -> Account {
    Account {
        lamports: 10_000_000_000,
        data: vec![],
        owner: SYSTEM_PROGRAM_ID,
        executable: false,
        rent_epoch: 0,
    }
}
fn empty() -> Account {
    Account {
        lamports: 0,
        data: vec![],
        owner: SYSTEM_PROGRAM_ID,
        executable: false,
        rent_epoch: 0,
    }
}
fn program_account(owner: &Pubkey, data: Vec<u8>) -> Account {
    Account {
        lamports: ((data.len() as u64 + 128) * 6960).max(1),
        data,
        owner: *owner,
        executable: false,
        rent_epoch: 0,
    }
}
fn system_program_account() -> Account {
    Account {
        lamports: 1,
        data: b"system_program".to_vec(),
        owner: NATIVE_LOADER_ID,
        executable: true,
        rent_epoch: 0,
    }
}
fn upstream_program_account() -> Account {
    Account {
        lamports: 1,
        data: vec![],
        owner: NATIVE_LOADER_ID,
        executable: true,
        rent_epoch: 0,
    }
}

fn build_coord_data(authority: &Pubkey, bump: u8) -> Vec<u8> {
    let mut d = vec![0u8; COORDINATOR_LEN];
    d[0] = DISC_COORDINATOR;
    d[1] = 1;
    d[COORD_AUTHORITY..COORD_AUTHORITY + 32].copy_from_slice(authority.as_ref());
    d[COORD_EPOCH..COORD_EPOCH + 8].copy_from_slice(&5u64.to_le_bytes());
    d[COORD_TOTAL_DWALLETS..COORD_TOTAL_DWALLETS + 8].copy_from_slice(&0u64.to_le_bytes());
    d[COORD_PAUSED] = 0;
    d[COORD_BUMP] = bump;
    d
}

fn build_nek_data(noa: &Pubkey, bump: u8) -> Vec<u8> {
    let mut d = vec![0u8; NEK_LEN];
    d[0] = DISC_NEK;
    d[1] = 1;
    d[NEK_NOA_PUBKEY..NEK_NOA_PUBKEY + 32].copy_from_slice(noa.as_ref());
    d[NEK_STATE] = NEK_STATE_ACTIVE;
    d[NEK_CREATED_EPOCH..NEK_CREATED_EPOCH + 8].copy_from_slice(&1u64.to_le_bytes());
    d[NEK_BUMP] = bump;
    d
}

fn build_dwallet_data(authority: &Pubkey, noa: &Pubkey, bump: u8) -> Vec<u8> {
    let mut d = vec![0u8; DWALLET_LEN];
    d[0] = DISC_DWALLET;
    d[1] = 1;
    d[DW_AUTHORITY..DW_AUTHORITY + 32].copy_from_slice(authority.as_ref());
    d[34] = CURVE_SECP256K1;
    d[35] = DW_STATE_ACTIVE;
    d[36] = 33; // public_key_len for compressed secp256k1
    let pubkey = [0x02u8; 33]; // synthetic compressed pubkey
    d[DW_PUBLIC_KEY..DW_PUBLIC_KEY + 33].copy_from_slice(&pubkey);
    d[DW_CREATED_EPOCH..DW_CREATED_EPOCH + 8].copy_from_slice(&1u64.to_le_bytes());
    d[DW_NOA_PUBLIC_KEY..DW_NOA_PUBLIC_KEY + 32].copy_from_slice(noa.as_ref());
    d[DW_IS_IMPORTED] = 0;
    d[DW_BUMP] = bump;
    d
}

#[test]
#[ignore = "requires upstream Ika SBF binary at /tmp/...; gated to keep CI green"]
fn complete_redemption_dispatches_approve_message_cpi() {
    // ── Set up Mollusk with both programs loaded ──
    let privacy_coin_program_id = Pubkey::new_unique();
    let mut mollusk = Mollusk::new(&privacy_coin_program_id, PRIVACY_COIN_PROGRAM_PATH);
    mollusk.add_program(&IKA_PROGRAM_ID, IKA_PROGRAM_BINARY, &solana_sdk::bpf_loader::ID);

    // ── Derive CPI authority PDA + bump for our program ──
    let (cpi_authority_pda, cpi_authority_bump) =
        Pubkey::find_program_address(&[CPI_AUTHORITY_SEED], &privacy_coin_program_id);

    // ── Synthetic NoA + dwallet seeds ──
    let noa = Pubkey::new_unique();
    let (coord_pda, coord_bump) =
        Pubkey::find_program_address(&[b"dwallet_coordinator"], &IKA_PROGRAM_ID);
    let (nek_pda, nek_bump) = Pubkey::find_program_address(
        &[b"network_encryption_key", noa.as_ref()],
        &IKA_PROGRAM_ID,
    );
    let dwallet_seed_payload = pack_dwallet_seed_payload(CURVE_SECP256K1, &[0x02u8; 33]);
    let mut dwallet_seeds: Vec<&[u8]> = vec![b"dwallet"];
    for chunk in dwallet_seed_payload.chunks(32) {
        dwallet_seeds.push(chunk);
    }
    let (dwallet_pda, dwallet_bump) = Pubkey::find_program_address(&dwallet_seeds, &IKA_PROGRAM_ID);

    // ── MessageApproval PDA derived from sighash we will pass ──
    let btc_sighash = [0x77u8; 32];
    let (message_approval_pda, _ma_bump) = Pubkey::find_program_address(
        &[b"message_approval", dwallet_pda.as_ref(), &btc_sighash],
        &IKA_PROGRAM_ID,
    );

    // ── Privacy Coin accounts. We seed enough state to reach the CPI block. ──
    // NOTE: the existing complete_redemption requires a populated VerifiedTransaction
    // PDA, light-client tip, ChadBuffer with raw tx bytes, redemption PDA, etc. The
    // simplest robust path is to construct a *minimal valid* redemption that passes
    // existing checks. This requires non-trivial fixture construction; the helper
    // below mints a deterministic redemption + verified-tx PDA + chadbuffer + utxo
    // pair such that miner_fee == 0 and amount_sats well below the policy cap.
    //
    // To keep this test focused on the CPI dispatch path, we wire it with
    // pool_script_len = 0 and consumed_utxo_count = 0 — eliminates the change UTXO
    // and consumed UTXO branches entirely.
    let fixture = build_redemption_fixture(&privacy_coin_program_id, &btc_sighash);

    // ── Build instruction data ──
    let mut ix_data = Vec::with_capacity(1 + 70);
    ix_data.push(PRIVACY_COIN_INSTRUCTION_COMPLETE_REDEMPTION);
    ix_data.extend_from_slice(&fixture.btc_txid);
    ix_data.extend_from_slice(&fixture.tx_size.to_le_bytes());
    ix_data.push(0); // pool_script_len = 0 (no change tracking)
    ix_data.push(0); // consumed_utxo_count = 0
    ix_data.extend_from_slice(&btc_sighash); // 32-byte sighash trailer

    // ── Account list (matches complete_redemption.rs documented order) ──
    let payer = Pubkey::new_unique();
    let accounts = vec![
        AccountMeta::new(fixture.pool_state_pda, false),         // 0
        AccountMeta::new(fixture.redemption_pda, false),         // 1
        AccountMeta::new(fixture.authority, true),               // 2 signer
        AccountMeta::new_readonly(fixture.rent_recipient, false),// 3
        AccountMeta::new_readonly(fixture.verified_tx_pda, false),// 4
        AccountMeta::new_readonly(fixture.light_client_pda, false),// 5
        AccountMeta::new_readonly(fixture.tx_buffer_pda, false), // 6
        AccountMeta::new(fixture.zkbtc_mint, false),             // 7
        AccountMeta::new(fixture.pool_vault, false),             // 8
        AccountMeta::new_readonly(fixture.token_program, false), // 9
        AccountMeta::new(fixture.completion_receipt_pda, false), // 10
        AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),     // 11
        AccountMeta::new_readonly(fixture.pool_config_pda, false),// 12
        // (no change_utxo because pool_script_len = 0)
        // (no consumed_utxos because count = 0)
        // ── Ika tail ──
        AccountMeta::new_readonly(IKA_PROGRAM_ID, false),        // 13 ika_program
        AccountMeta::new_readonly(coord_pda, false),             // 14 coordinator
        AccountMeta::new(message_approval_pda, false),           // 15 message_approval
        AccountMeta::new_readonly(dwallet_pda, false),           // 16 dwallet
        AccountMeta::new_readonly(privacy_coin_program_id, false),// 17 caller_program
        AccountMeta::new_readonly(cpi_authority_pda, false),     // 18 cpi_authority
        AccountMeta::new(payer, true),                            // 19 payer (signer)
    ];

    let ix = Instruction {
        program_id: privacy_coin_program_id,
        accounts,
        data: ix_data,
    };

    let result = mollusk.process_instruction(
        &ix,
        &[
            (fixture.pool_state_pda, fixture.pool_state_account()),
            (fixture.redemption_pda, fixture.redemption_account()),
            (fixture.authority, funded()),
            (fixture.rent_recipient, funded()),
            (fixture.verified_tx_pda, fixture.verified_tx_account()),
            (fixture.light_client_pda, fixture.light_client_account()),
            (fixture.tx_buffer_pda, fixture.tx_buffer_account()),
            (fixture.zkbtc_mint, fixture.zkbtc_mint_account()),
            (fixture.pool_vault, fixture.pool_vault_account()),
            (fixture.token_program, fixture.token_program_account()),
            (fixture.completion_receipt_pda, empty()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
            (fixture.pool_config_pda, fixture.pool_config_account(cpi_authority_bump)),
            (IKA_PROGRAM_ID, upstream_program_account()),
            (coord_pda, program_account(&IKA_PROGRAM_ID, build_coord_data(&Pubkey::new_unique(), coord_bump))),
            (message_approval_pda, empty()),
            (dwallet_pda, program_account(&IKA_PROGRAM_ID, build_dwallet_data(&cpi_authority_pda, &noa, dwallet_bump))),
            (privacy_coin_program_id, upstream_program_account()),
            (cpi_authority_pda, empty()),
            (payer, funded()),
        ],
    );

    assert!(
        result.program_result.is_ok(),
        "complete_redemption failed: {:?}",
        result.program_result
    );

    // ── Assert MessageApproval PDA was populated by the Ika program ──
    let ma_data = &result
        .resulting_accounts
        .iter()
        .find(|(k, _)| *k == message_approval_pda)
        .expect("message_approval account in result")
        .1
        .data;
    assert!(!ma_data.is_empty(), "message_approval data should be populated");
    assert_eq!(ma_data[0], DISC_MESSAGE_APPROVAL, "discriminator");
    assert_eq!(
        &ma_data[MA_DWALLET..MA_DWALLET + 32],
        dwallet_pda.as_ref(),
        "MessageApproval.dwallet"
    );
    assert_eq!(
        &ma_data[MA_MESSAGE_HASH..MA_MESSAGE_HASH + 32],
        &btc_sighash,
        "MessageApproval.message_hash should equal the btc_sighash we passed"
    );
}

// ── Fixture builders ──

/// Pack `curve || pubkey` into 32-byte chunks for the dwallet PDA seed.
fn pack_dwallet_seed_payload(curve: u8, pubkey: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(1 + pubkey.len());
    v.push(curve);
    v.extend_from_slice(pubkey);
    v
}

struct RedemptionFixture {
    pool_state_pda: Pubkey,
    redemption_pda: Pubkey,
    authority: Pubkey,
    rent_recipient: Pubkey,
    verified_tx_pda: Pubkey,
    light_client_pda: Pubkey,
    tx_buffer_pda: Pubkey,
    zkbtc_mint: Pubkey,
    pool_vault: Pubkey,
    token_program: Pubkey,
    completion_receipt_pda: Pubkey,
    pool_config_pda: Pubkey,
    btc_txid: [u8; 32],
    tx_size: u32,
}

impl RedemptionFixture {
    // Each `*_account` method returns a populated Account with the correct
    // discriminator, owner, and minimal data layout that complete_redemption's
    // existing checks accept. The exact byte layouts come from
    // contracts/programs/privacy-coin/src/state/*.rs and src/utils/*.rs —
    // mirror those when implementing.
    fn pool_state_account(&self) -> Account { /* impl: PoolState::init + set authority + unpaused */ unimplemented!() }
    fn redemption_account(&self) -> Account { /* impl: RedemptionRequest::init with btc_script matching the verified tx output, status = Pending, total_input_sats > 0 */ unimplemented!() }
    fn verified_tx_account(&self) -> Account { /* owner = BTC_LIGHT_CLIENT_PROGRAM_ID, txid + block_height fields */ unimplemented!() }
    fn light_client_account(&self) -> Account { /* owner = BTC_LIGHT_CLIENT_PROGRAM_ID, tip_height >= block_height + 6 */ unimplemented!() }
    fn tx_buffer_account(&self) -> Account { /* ChadBuffer with a raw BTC tx whose hash == btc_txid and which has a single output paying btc_script with amount_sats - service_fee */ unimplemented!() }
    fn zkbtc_mint_account(&self) -> Account { unimplemented!() }
    fn pool_vault_account(&self) -> Account { unimplemented!() }
    fn token_program_account(&self) -> Account { unimplemented!() }
    fn pool_config_account(&self, cpi_authority_bump: u8) -> Account { /* PoolConfig::init, set_cpi_authority_bump, set_ika_dwallet, set_ika_dwallet_xonly_pubkey, pool_script_len = 0 */ unimplemented!() }
}

fn build_redemption_fixture(_program_id: &Pubkey, _sighash: &[u8; 32]) -> RedemptionFixture {
    // Implementation note: this is non-trivial — see the inlined comment on
    // each unimplemented! above. The fixture must produce a redemption that
    // sails through every existing check in complete_redemption (txid match,
    // confirmation count, output match, miner fee bound) so the *new* CPI
    // block actually runs.
    //
    // Recommended sequencing: write this fixture in Step 4b.5.2 below by
    // copying the test fixtures already used by the existing 107-test suite
    // for adjacent instructions (e.g., mark_processing or cancel_redemption).
    unimplemented!("fill in from existing test fixtures in src/instructions/*.rs and src/state/*.rs")
}
```

> The `#[ignore]` attribute keeps the test out of default `cargo test` runs until the fixture builder is filled in (Step 4b.5.2). This avoids piling new failures on the 107-green baseline.

- [ ] **Step 4b.5.2: Fill in the fixture builders**

Walk through each `unimplemented!()` above and produce the byte-correct account data. Pattern: every one of these account types already has an `init` or `from_bytes_mut` constructor in `src/state/`. Read each, then write a `Vec<u8>` of length `T::LEN`, call the constructor on a slice into it, set fields, and wrap in `Account { data, owner, ... }`.

Concretely:
- `pool_state_account`: see `src/state/pool_state.rs`. Owner = `program_id`. Call `PoolState::init`, then `set_authority(&self.authority)`. Leave `total_shielded` >= `amount_sats` (e.g. 1_000_000) and `pending_redemptions = 1`.
- `redemption_account`: see `src/state/redemption_request.rs`. Owner = `program_id`. Set status = `Pending`, set `btc_script` to a P2WPKH-ish script your fake raw tx will match (32 bytes from `[0x51, 0x14, ...]` is fine), set `amount_sats = 50_000`, `service_fee = 1_000`, `total_input_sats = 50_500`, `requester = authority`.
- `verified_tx_account`: see `src/state/btc_light_client.rs::VerifiedTransactionView`. Owner = `BTC_LIGHT_CLIENT_PROGRAM_ID` (pull from `src/constants.rs`). `txid` matches `self.btc_txid`. `block_height = 100`.
- `light_client_account`: synthesize a minimal `LightClient` blob — only `light_client_tip_height` is read (see `src/state/btc_light_client.rs`). Set tip_height = 200 (gives 101 confirmations).
- `tx_buffer_account`: a real raw BTC tx whose hash matches `btc_txid`. Easiest path: pre-compute `btc_txid` as `compute_tx_hash(raw_tx)` using `src/utils/bitcoin.rs::compute_tx_hash` so the fixture is internally consistent. The raw tx must have at least one output paying `btc_script` with value `amount_sats - service_fee = 49_000`. Set `tx_size` to `raw_tx.len() as u32`.
- `zkbtc_mint_account` / `pool_vault_account`: these are token-2022 / SPL token accounts. Use the same fake-mint helpers that `src/instructions/mark_processing.rs` tests use — check existing test code: `grep -rn "Token-2022\|fake_mint\|build_mint_account" contracts/programs/privacy-coin/src/`. If no existing helper, mint a minimal mint blob: Token-2022 mint is 82 bytes minimum, owner = TOKEN_2022_PROGRAM_ID. Set `supply >= burn_amount`.
- `token_program_account`: load Token-2022 program SBF from upstream Solana — Mollusk has helpers, or use `mollusk_svm::program::token::add_program` if available; fall back to `upstream_program_account()` with key = `spl_token_2022::ID`.
- `pool_config_account`: owner = `program_id`. `PoolConfig::init`, `set_pool_script(&[])` (length 0), `set_cpi_authority_bump(bump)`, `set_ika_dwallet(&[0x42; 32])`, `set_ika_dwallet_xonly_pubkey(&[0x02; 32])`.

After filling in, remove the `#[ignore]` attribute.

- [ ] **Step 4b.5.3: First run — expect Ika program to fail validation**

```bash
cd /Users/chengchunyuan/project/hackathon/private_coin
cargo test -p privacy-coin --test complete_redemption_ika_cpi -- --nocapture 2>&1 | tail -30
```

Expected (most likely): the Ika program rejects because (a) the dwallet `authority` doesn't match the CPI authority PDA, or (b) the curve byte is wrong, or (c) `MessageApproval` PDA seeds differ. Capture the exact error message and resolve by:
1. Pre-running `transfer_dwallet` against a Mollusk-loaded Ika program in a setup phase before the `complete_redemption` invocation. Mollusk doesn't process transactions sequentially, so use `LiteSVM` here instead — convert the test to LiteSVM mirroring `voting/pinocchio/tests/litesvm.rs` line 224 (`DWalletTestContext::new`) verbatim. This is the recommended path; rewrite the test under `tests/complete_redemption_ika_cpi_litesvm.rs` if needed.
2. Confirm `CURVE_SECP256K1 = 0` by reading `/tmp/ika-pre-alpha-scratch/ika-pre-alpha/crates/ika-dwallet-types/src/lib.rs` lines around 119 (per recon brief). If wrong, fix the constant.
3. Confirm MessageApproval seeds are `["message_approval", dwallet_key, message_hash]` by re-reading the upstream `litesvm.rs` line 530 — this is what we're using.

- [ ] **Step 4b.5.4: Iterate to green**

Re-run after each fix. Allow up to 3 fixup iterations. Hard cap: if after 3 iterations the test still doesn't reach the assertion, halt and re-read the upstream `examples/voting/pinocchio/tests/litesvm.rs` end-to-end — the harness pattern there is the canonical reference and any deviation is suspicious.

```bash
cd /Users/chengchunyuan/project/hackathon/private_coin
cargo test -p privacy-coin --test complete_redemption_ika_cpi -- --nocapture 2>&1 | tail -30
```

Expected at success: `test result: ok. 1 passed`.

- [ ] **Step 4b.5.5: Confirm full crate test count**

```bash
cd /Users/chengchunyuan/project/hackathon/private_coin/contracts
cargo test -p privacy-coin 2>&1 | tail -10
```

Expected: 107 baseline + 4 (policy) + 3 (ix data layout) + 1 (CPI integration) = 115. No new failures elsewhere.

---

## Task 4b.6 — Update SDK builder for the new layout

This is intentionally minimal — the SDK changes are bigger work that belongs to Task 5 (where the backend builder also changes). Here we only update the on-chain-side builder so the new ix data trailer is documented and an existing SDK test can still target the old shape via a new option.

**Files:** `sdk/src/instructions.ts`

- [ ] **Step 4b.6.1: Add optional `btcSighash` field to `CompleteRedemptionInstructionOptions`**

In `sdk/src/instructions.ts`, locate the interface (~line 336). Modify:

```typescript
export interface CompleteRedemptionInstructionOptions {
  /** BTC transaction ID (internal byte order, 32 bytes) */
  btcTxid: Uint8Array;
  /** Raw tx size in ChadBuffer */
  txSize: number;
  /** Pool scriptPubKey for change UTXO tracking (empty = no tracking) */
  poolScript: Uint8Array;
  /** Number of consumed UTXO PDAs in remaining accounts */
  consumedUtxoCount: number;
  /** BIP-341 taproot key-spend sighash (32 bytes) for the unsigned BTC tx.
   *  Forwarded as-is to Ika `approve_message` as `message_digest`. */
  btcSighash: Uint8Array;
  /** Account addresses */
  accounts: { /* existing */ };
}
```

And modify `buildCompleteRedemptionInstructionData` to append the 32-byte sighash:

```typescript
export function buildCompleteRedemptionInstructionData(options: {
  btcTxid: Uint8Array;
  txSize: number;
  poolScript: Uint8Array;
  consumedUtxoCount: number;
  btcSighash: Uint8Array;
}): Uint8Array {
  const { btcTxid, txSize, poolScript, consumedUtxoCount, btcSighash } = options;
  if (btcSighash.length !== 32) {
    throw new Error("btcSighash must be exactly 32 bytes");
  }

  const totalLen = 1 + 32 + 4 + 1 + poolScript.length + 1 + 32;
  const data = new Uint8Array(totalLen);
  const view = new DataView(data.buffer);

  let offset = 0;
  data[offset++] = INSTRUCTION.COMPLETE_REDEMPTION;
  data.set(btcTxid, offset); offset += 32;
  view.setUint32(offset, txSize, true); offset += 4;
  data[offset++] = poolScript.length;
  if (poolScript.length > 0) {
    data.set(poolScript, offset); offset += poolScript.length;
  }
  data[offset++] = consumedUtxoCount;
  data.set(btcSighash, offset); offset += 32;

  return data;
}
```

- [ ] **Step 4b.6.2: Extend `accounts` interface with Ika-tail fields and append them in the builder**

```typescript
export interface CompleteRedemptionInstructionOptions {
  // ... existing fields ...
  accounts: {
    // ... existing 12 fields ...
    /** Ika dWallet program (executable) */
    ikaProgram: Address;
    /** Ika DWalletCoordinator PDA */
    ikaCoordinator: Address;
    /** MessageApproval PDA (will be created) */
    ikaMessageApproval: Address;
    /** dWallet account */
    ikaDwallet: Address;
    /** This Privacy Coin program's program-account */
    callerProgram: Address;
    /** CPI authority PDA */
    cpiAuthority: Address;
    /** Payer for MessageApproval rent (signer) */
    ikaPayer: Address;
  };
}
```

In `buildCompleteRedemptionInstruction`, after the consumed-UTXO append loop, push the seven Ika accounts in order:

```typescript
  accounts.push(
    { address: options.accounts.ikaProgram, role: AccountRole.READONLY },
    { address: options.accounts.ikaCoordinator, role: AccountRole.READONLY },
    { address: options.accounts.ikaMessageApproval, role: AccountRole.WRITABLE },
    { address: options.accounts.ikaDwallet, role: AccountRole.READONLY },
    { address: options.accounts.callerProgram, role: AccountRole.READONLY },
    { address: options.accounts.cpiAuthority, role: AccountRole.READONLY },
    { address: options.accounts.ikaPayer, role: AccountRole.WRITABLE_SIGNER }
  );
```

- [ ] **Step 4b.6.3: Run SDK tests; confirm new SDK failures are limited to baseline**

```bash
cd /Users/chengchunyuan/project/hackathon/private_coin/sdk
bun test 2>&1 | tail -30
```

Expected: 27 baseline failures (recorded at `/tmp/sdk-baseline-failures.txt`) — no new failures introduced by the schema additions. If the diff count vs baseline is > 0, identify the new ones, fix only those by adding `btcSighash: new Uint8Array(32)` placeholder + Ika-tail fields to the call sites that broke (they'll need fixing in Task 5 anyway).

---

## Task 4b.7 — End-to-end build sanity

- [ ] **Step 4b.7.1: SBF build green**

```bash
cd /Users/chengchunyuan/project/hackathon/private_coin
cargo build-sbf --features localnet --manifest-path contracts/programs/privacy-coin/Cargo.toml 2>&1 | tail -10
```

Expected: `Finished`.

- [ ] **Step 4b.7.2: Full host-side test green**

```bash
cd /Users/chengchunyuan/project/hackathon/private_coin/contracts
cargo test -p privacy-coin 2>&1 | tail -10
```

Expected: 115 passed (107 baseline + 8 new). If the count is lower or any failures appear, halt — do not proceed to commit.

- [ ] **Step 4b.7.3: SDK delta still at baseline (27 failures, no new)**

```bash
cd /Users/chengchunyuan/project/hackathon/private_coin/sdk
bun test 2>&1 | grep -E "(pass|fail)" | tail -5
diff <(cd /Users/chengchunyuan/project/hackathon/private_coin/sdk && bun test 2>&1 | grep -oE "[a-z0-9_/-]+\.test\.ts:[0-9]+" | sort -u) <(sort -u /tmp/sdk-baseline-failures.txt) | head -20
```

Expected: empty diff (or, if formats differ, manual confirmation that no new test files appear failing).

- [ ] **Step 4b.7.4: Backend test still at baseline (1 pre-existing failure, no new)**

```bash
cd /Users/chengchunyuan/project/hackathon/private_coin/backend
cargo test 2>&1 | tail -10
```

Expected: same single pre-existing failure, no new ones. (Backend wiring is Task 5.)

---

## Task 4b.8 — Commit

- [ ] **Step 4b.8.1: Stage and commit**

```bash
cd /Users/chengchunyuan/project/hackathon/private_coin
git add contracts/programs/privacy-coin/src/utils/policy.rs \
        contracts/programs/privacy-coin/src/utils/mod.rs \
        contracts/programs/privacy-coin/src/instructions/complete_redemption.rs \
        contracts/programs/privacy-coin/src/error.rs \
        contracts/programs/privacy-coin/tests/complete_redemption_ika_cpi.rs \
        sdk/src/instructions.ts
git commit -m "$(cat <<'EOF'
Task 4b: complete_redemption CPIs Ika approve_message

- New utils/policy.rs with on-chain redemption signing policy:
  amount cap, miner-fee cap, paused gate. Pure validation only;
  the FROST-era sighash recompute, Esplora UTXO checks, and
  duplicate-signing tracker stay off-chain (or are already
  enforced elsewhere in complete_redemption).
- complete_redemption now accepts a 32-byte btc_sighash trailer
  in instruction data and appends 7 Ika CPI accounts after the
  consumed-UTXO tail. After existing SPV/burn validation it
  invokes cpi::ika::approve_message which creates the
  MessageApproval PDA on the Ika dWallet program.
- Mollusk integration test loads the upstream
  ika_dwallet_program.so and asserts the MessageApproval PDA
  is populated with our btc_sighash as message_hash.
- SDK builder updated to emit the new ix data layout and the
  7 Ika accounts.
EOF
)"
```

- [ ] **Step 4b.8.2: Confirm commit landed**

```bash
git log --oneline -3
git status
```

Expected: clean tree, top commit references Task 4b.

---

## Risk callouts

1. **CURVE_SECP256K1 byte value is unconfirmed.** The recon brief notes this is "likely 0" but the upstream TS example uses Curve25519 (index 2). If wrong, the dwallet account fixture won't match what Ika expects and the CPI will fail. *Mitigation:* before Step 4b.5.3, read `/tmp/ika-pre-alpha-scratch/ika-pre-alpha/crates/ika-dwallet-types/src/lib.rs` around line 119 and confirm the enum order — patch the constant if needed. The on-chain CPI itself doesn't read the curve byte (Ika does, internally), so production behavior is gated by a successful test, not by reading a constant.

2. **Account-list extension breaks every existing SDK caller.** Every TS/Rust call site that builds a `complete_redemption` instruction now MUST append the 7 Ika tail accounts and the 32-byte sighash trailer. The existing E2E test (`scripts/e2e/run-all.ts`) is the most acute case. *Mitigation:* Step 4b.6 updates the canonical SDK builder; downstream call sites will surface as compile or runtime errors in Tasks 5–7. We accept this — the FROST→Ika pivot is intentionally a hard cutover, not a feature-flagged dual code path. This is also why the SDK delta against baseline is checked in Step 4b.7.3.

3. **MessageApproval PDA seeds may not be `["message_approval", dwallet, message_hash]`.** This is read from the upstream voting example (`litesvm.rs:530`). If Ika's program handles the seeds differently for the secp256k1+Taproot scheme, the on-chain `find_program_address` call in Step 4b.4.3 will derive the wrong PDA and the CPI will reject with `InvalidSeeds`. *Mitigation:* the test exercises the exact end-to-end derivation; if Step 4b.5 reveals a mismatch, the fix is to re-read the upstream `chains/solana/program-sdk/pinocchio/src/cpi.rs` constants, copy the exact seed format into our derivation, and re-run.

4. **Mollusk vs LiteSVM: Mollusk doesn't pre-process auxiliary transactions.** The Ika program checks that `dwallet.authority == cpi_authority_pda`, but in our fixture we pre-populate the dwallet with that already set — no `transfer_dwallet` ix needed in test setup. This works in Mollusk; if a future Ika version adds invariants requiring real transaction history (e.g. a coordinator update epoch), we'd have to convert the test to LiteSVM. Step 4b.5.3 documents this fallback.

## Total estimated duration

Reading the file structure cleanly — Task 4b.1 (10m), Task 4b.2 (25m), Task 4b.3 (30m), Task 4b.4 (45m), Task 4b.5 (90m — fixture builder is the long pole), Task 4b.6 (30m), Task 4b.7 (15m), Task 4b.8 (10m). **~4.5 hours of focused work**, plus a generous 1h iteration buffer for the Mollusk test in Step 4b.5.3–4b.5.4. Hard cap **6 hours**; if you blow through, escalate before Step 4b.8.
```

### Critical files for implementation

- /Users/chengchunyuan/project/hackathon/private_coin/contracts/programs/privacy-coin/src/instructions/complete_redemption.rs
- /Users/chengchunyuan/project/hackathon/private_coin/contracts/programs/privacy-coin/src/cpi/ika.rs
- /Users/chengchunyuan/project/hackathon/private_coin/contracts/programs/privacy-coin/src/utils/policy.rs (new)
- /Users/chengchunyuan/project/hackathon/private_coin/contracts/programs/privacy-coin/tests/complete_redemption_ika_cpi.rs (new)
- /Users/chengchunyuan/project/hackathon/private_coin/sdk/src/instructions.ts

Note: I am in strict read-only mode (no Write/Edit tools available), so I cannot save the markdown to disk myself. The full plan content is the body of the assistant message above — copy everything between the opening ```` ```markdown ```` fence and its closing ```` ``` `
