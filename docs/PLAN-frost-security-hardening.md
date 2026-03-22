# Plan: FROST Signer Security Hardening + On-Chain Path Audit

## Problem

The FROST threshold signers must independently verify that every BTC transaction they sign corresponds to a legitimate on-chain request. Currently there are gaps:

1. **FROST doesn't verify UTXO inputs** — signers don't check that BTC tx inputs match on-chain Reserved UtxoRecord PDAs
2. **No mint-without-deposit protection audit** — need to verify all paths to `verify_stealth_deposit` require valid SPV proof
3. **No withdraw-without-request protection audit** — need to verify all paths to `complete_redemption` require valid RedemptionRequest PDA

## Security Invariants (must hold)

```
MINT INVARIANT:
  zkBTC can ONLY be minted via verify_stealth_deposit, which requires:
  1. VerifiedTransaction PDA (SPV proof from btc-light-client)
  2. Valid OP_RETURN with npk + ephemeral_pub
  3. deposit_receipt PDA prevents duplicate verification
  → No SPV proof = no mint. Period.

WITHDRAW INVARIANT:
  BTC can ONLY leave the pool via complete_redemption, which requires:
  1. RedemptionRequest PDA in Processing status
  2. VerifiedTransaction PDA (SPV proof of BTC tx)
  3. BTC tx output matches PDA's btc_script with sufficient amount
  4. completion_receipt PDA prevents double-complete
  → No on-chain request = no withdrawal. Period.

FROST SIGNING INVARIANT:
  FROST signers will ONLY sign a BTC tx if:
  1. RedemptionRequest PDA exists on Solana with status=Processing
  2. BTC tx outputs match PDA amount/script (cross-validated)
  3. BTC tx inputs match Reserved UtxoRecord PDAs (NEW)
  4. Sighash recomputed independently matches claimed sighash
  5. Fee within limits
  → Compromised backend cannot fabricate transactions.
```

## Changes Required

### 1. FROST: Verify BTC inputs match on-chain UTXO PDAs

**File:** `frost_server/src/solana_verifier.rs`

Add `verify_utxo_inputs()`:
- For each BTC tx input (txid, vout), derive UtxoRecord PDA
- Fetch PDA via Solana RPC
- Verify: status=Reserved(1), amount matches prevout value
- Sum all UTXO amounts = expected total_input_sats

**File:** `frost_server/src/policy.rs`

Call `verify_utxo_inputs()` during signing validation:
- After sighash verification, before signing
- Reject if any input doesn't match a Reserved UTXO PDA
- Log all verified UTXOs in audit trail

### 2. FROST: Pass UTXO verification data in signing request

**File:** `frost_server/src/types.rs`

Extend `SolanaVerification::Withdrawal` with:
```rust
utxo_inputs: Vec<(String, u32, u64)>, // (txid_hex, vout, amount_sats)
```

**File:** `backend/src/redemption/builder.rs`

After building the unsigned tx, include UTXO data in the signing request.

### 3. On-Chain Audit: verify_stealth_deposit paths

**File:** `contracts/programs/aegis/src/instructions/verify_stealth_deposit.rs`

Verify these checks exist (they should already):
- [ ] VerifiedTransaction PDA owned by btc-light-client program
- [ ] Sweep tx contains OP_RETURN with valid npk data
- [ ] deposit_receipt PDA prevents duplicate minting
- [ ] Pool state update is atomic with mint

### 4. On-Chain Audit: complete_redemption paths

**File:** `contracts/programs/aegis/src/instructions/complete_redemption.rs`

Verify these checks exist:
- [ ] RedemptionRequest PDA status=Processing
- [ ] VerifiedTransaction PDA owned by btc-light-client
- [ ] BTC tx output >= expected_send to correct script
- [ ] completion_receipt prevents double-complete
- [ ] total_input_sats > 0 (no backward compat) ← DONE
- [ ] Consumed UTXOs are Reserved status before closing

### 5. E2E Security Test

Add negative test cases:
- Try complete_redemption without mark_processing → should fail
- Try complete_redemption with wrong BTC txid → should fail
- Try verify_stealth_deposit with duplicate txid → should fail (deposit_receipt)

## Files to Change

| File | Change | Effort |
|------|--------|--------|
| `frost_server/src/solana_verifier.rs` | Add `verify_utxo_inputs()` | Medium |
| `frost_server/src/policy.rs` | Call UTXO verification during signing | Small |
| `frost_server/src/types.rs` | Add UTXO data to signing request | Small |
| `backend/src/redemption/builder.rs` | Include UTXO data in signing request | Small |
| On-chain audit (read-only) | Verify all security checks exist | Medium |

## NOT in scope
- Changing on-chain contract security checks (they're already correct)
- Multi-sig admin key rotation
- Rate limiting on FROST signing requests
- BTC mempool fee estimation improvements
