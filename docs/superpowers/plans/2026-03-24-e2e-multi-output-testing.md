# E2E Test Update for Multi-Output JoinSplit

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix broken e2e tests after discriminator reallocation, update unshield tests for 4-byte header, add multi-output unshield and redeem test steps.

**Architecture:** Update existing step7/7b/8b/10 scripts for new instruction formats, add step7c (multi-output unshield) and step8c (multi-output redeem via REDEEM disc=15), wire into run-all.ts.

**Tech Stack:** TypeScript (bun), Solana test-validator, circom/snarkjs (Groth16), @aegis/sdk

---

## Task 1: Fix hardcoded discriminator bugs

**Files:**
- Modify: `scripts/e2e/step8b-complete-redemption.ts:166,372`
- Modify: `scripts/e2e/step10-security-negative.ts:146,233,347`

- [ ] **Step 1: Fix step8b mark_processing disc**
  - Line 166: `mpData[0] = 2` → `mpData[0] = Disc.MARK_PROCESSING`

- [ ] **Step 2: Fix step8b complete_redemption disc**
  - Line 372: `crData[off++] = 6` → `crData[off++] = Disc.COMPLETE_REDEMPTION`

- [ ] **Step 3: Fix step10 complete_redemption disc (2 locations)**
  - Line 146: `crData[off++] = 6` → `crData[off++] = Disc.COMPLETE_REDEMPTION`
  - Line 233: `crData[off++] = 6` → `crData[off++] = Disc.COMPLETE_REDEMPTION`

- [ ] **Step 4: Fix step10 verify_stealth_deposit disc**
  - Line 347: `ixData[off++] = 1` → `ixData[off++] = Disc.VERIFY_STEALTH_DEPOSIT`

---

## Task 2: Update step7-unshield.ts for 4-byte header

**Files:**
- Modify: `scripts/e2e/step7-unshield.ts`

The unshield instruction now uses a 4-byte header: `n_inputs(1) + n_outputs(1) + n_public_outputs(1) + proof_source(1)`.
Account layout changes: token_program moves before recipient.

Changes needed:

- [ ] **Step 1: Update bound params computation**
  The bound params now require `SHA256(owner)` as the destinations_hash. Replace the raw `sdkComputeBoundParamsHash(...)` call with:
  ```ts
  import { createUnshieldBoundParams, computeStealthDataHash } from "@aegis/sdk";
  const stealthDataHash = computeStealthDataHash([]); // no tree outputs
  const ownerBytes = authority.publicKey.toBytes(); // token account owner
  const unshieldParams = createUnshieldBoundParams(ownerBytes, stealthDataHash, 103n);
  const boundParamsHash = sdkComputeBoundParamsHash(unshieldParams);
  ```

- [ ] **Step 2: Update instruction data layout**
  Change from 2-byte to 4-byte header:
  ```
  OLD: disc(1) + n_inputs(1) + n_outputs(1) + proof(256) + ...
  NEW: disc(1) + n_inputs(1) + n_outputs(1) + n_public_outputs(1) + proof_source(1) + proof(256) + ...
  ```
  - dataLen calculation: add +2 bytes for n_public_outputs + proof_source
  - After writing n_outputs, add: `txData[off++] = 1; // n_public_outputs` and `txData[off++] = 0; // proof_source=inline`

- [ ] **Step 3: Update account layout**
  New order: pool_state, commitment_tree, vk_registry, user, system_program, token_config, vault, **token_program**, user_token_account, nullifier_records
  (token_program moves to position 7, recipient moves to position 8)

- [ ] **Step 4: Update comments**
  - Change `disc=30` → `disc=14` in comments
  - Update data layout comment

---

## Task 3: Update step7b-unshield-btc.ts for 4-byte header

**Files:**
- Modify: `scripts/e2e/step7b-unshield-btc.ts`

Same changes as Task 2 but for zkBTC unshield. Identical pattern.

- [ ] **Step 1: Update bound params** (same pattern as Task 2 Step 1)
- [ ] **Step 2: Update instruction data layout** (same +2 bytes)
- [ ] **Step 3: Update account layout** (same token_program swap)
- [ ] **Step 4: Update comments** (disc=30 → disc=14)

---

## Task 4: Add step7c-multi-unshield.ts (new test)

**Files:**
- Create: `scripts/e2e/step7c-multi-unshield.ts`

**Purpose:** Test JoinSplit 1x2 with 2 public unshield outputs.

**Circuit:** `joinsplit_1x2` — 1 input, 2 outputs (both burn commitments, 0 tree outputs)

**Flow:**
1. Load state, pick a tUSDC note from step5 shield
2. Compute 2 burn commitments with different amounts (split the note)
3. Build bound params with 2 recipient addresses: `createUnshieldBoundParams([owner1, owner2], stealthDataHash)`
4. Generate JoinSplit proof
5. Build instruction with 4-byte header: n_pub=2, proof_source=0
6. Amounts array: [amount1, amount2] appended after commitments
7. Accounts: 8 fixed + 2 recipient token accounts + 1 nullifier PDA
8. Submit and verify:
   - Both recipients received correct amounts
   - Nullifier PDA created
   - TokenConfig total_shielded decreased by sum

Note: If step5 doesn't have enough notes, we can use a 1x3 circuit with 1 tree output (change) + 2 public outputs. Check available notes during implementation.

---

## Task 5: Add step8c-multi-redeem.ts (new test)

**Files:**
- Create: `scripts/e2e/step8c-multi-redeem.ts`

**Purpose:** Test REDEEM (disc=15) with 2 public BTC outputs.

**Circuit:** `joinsplit_1x3` — 1 input, 3 outputs (1 tree change + 2 redeem outputs)

**Flow:**
1. Load state, pick a zkBTC note (from deposit)
2. Compute 1 tree output (change) + 2 burn commitments for different BTC amounts
3. Build bound params: `createRedeemBoundParams([script1, script2], stealthDataHash)`
4. Generate JoinSplit proof
5. Build instruction with 4-byte header: n_pub=2, proof_source=0
6. Per-output data: amount(8) + script_len(1) + script(var) + nonce(8) × 2
7. Accounts: 6 fixed + 1 nullifier PDA + 2 redemption PDAs
8. Submit and verify:
   - Both RedemptionRequest PDAs created with correct amounts/scripts
   - Nullifier PDA created
   - Pool total_shielded decreased
   - pending_redemptions increased by 2

---

## Task 6: Update run-all.ts

**Files:**
- Modify: `scripts/e2e/run-all.ts`

- [ ] **Step 1: Add new steps to orchestrator**
  Insert after step7b and step8:
  ```ts
  { file: "step7c-multi-unshield.ts", label: "Multi-Output Unshield" },
  // ... existing step8 ...
  { file: "step8c-multi-redeem.ts", label: "Multi-Output Redeem" },
  ```

---

## Task 7: Verify full e2e suite

- [ ] **Step 1: Build contracts** `cd contracts && cargo build-sbf --features devnet`
- [ ] **Step 2: Build SDK** `cd sdk && bun run build`
- [ ] **Step 3: Run full e2e** `bun run scripts/e2e/run-all.ts`
- [ ] **Step 4: Verify all steps pass**

---

## Verification Checklist
1. `cargo check` — contracts compile
2. `cargo test` — 98+ tests pass
3. `bun test sdk/test/unit/bound-params.test.ts` — cross-language parity
4. All e2e steps pass on localnet
5. Multi-output unshield transfers correct amounts to 2 recipients
6. Multi-output redeem creates 2 RedemptionRequest PDAs
