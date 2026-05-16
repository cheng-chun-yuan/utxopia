# UTXOpia: Complete Transaction Flow

End-to-end lifecycle from BTC deposit through shielded transfers to withdrawal.

---

## Overview

```
BTC Deposit ──► Sweep ──► SPV Verify ──► Merkle Commitment
                                              │
                              ┌────────────────┼────────────────┐
                              ▼                ▼                ▼
                        JoinSplit          Unshield         Redemption
                     (private xfer)    (shielded→SPL)    (shielded→BTC)
```

All value lives as **shielded commitments** in a Poseidon Merkle tree (depth 16, 65,536 leaves).
There are no public zkBTC tokens — only commitments and nullifiers.

---

## 1. Deposit: BTC → Shielded Commitment

### 1.1 Client-Side (SDK)

```
createNonInteractiveDeposit(recipientMeta, groupPubKey)
```

1. Generate ephemeral Ed25519 keypair
2. ECDH: `sharedSecret = X25519(ephemeralPriv, recipient.viewingPub)`
3. Derive: `stealthScalar = KDF(sharedSecret)` then `npk = Poseidon(MPK, stealthScalar)` (Master Public Key (MPK), Note Public Key (NPK))
4. Build Taproot address from `npk` + FROST group key (BIP-341 tweak)
5. Build 64-byte OP_RETURN payload: `ephemeralPub(32) || npk(32)`

User broadcasts a BTC transaction:
- **Output 1**: P2TR to the derived Taproot address (any amount)
- **Output 2**: `OP_RETURN` with 64-byte payload (ephemeralPub + npk)

### 1.2 Backend Detection

Two detection methods run in parallel:
- **WebSocket**: mempool.space real-time events (`wss://mempool.space/testnet4/api/v1/ws`)
- **Esplora polling**: Fallback, 60s interval when WS is active

Detection logic:
1. Scan new blocks for transactions with 64-byte OP_RETURN
2. Parse OP_RETURN → extract `ephemeralPub` + `npk`
3. Verify P2TR output matches pool key tweaked with npk
4. Auto-register deposit (no API call needed)

### 1.3 Sweep

Backend sweeps the deposit UTXO into the pool wallet:

```
Deposit Address (user's Taproot) ──► Pool Wallet (single P2TR output, no OP_RETURN)
```

- Signing: FROST 2-of-3 threshold (production) or single-key (POC)
- Fee: ~111 vbytes × fee_rate

### 1.4 SPV Verification on Solana

Two on-chain instructions in sequence:

**Step A** — `btc-light-client::verify_transaction` (disc 3):
- Submits Merkle inclusion proof for the sweep TX
- Creates `VerifiedTransaction` PDA: `["verified_tx", block_hash, sweep_txid]`

**Step B** — `utxopia::complete_deposit` (disc 1):

Instruction data (80 bytes):
| Offset | Size | Field |
|--------|------|-------|
| 0 | 32 | `sweep_txid` |
| 32 | 8 | `block_height` |
| 40 | 4 | `sweep_tx_size` |
| 44 | 4 | `deposit_tx_size` |
| 48 | 32 | `deposit_txid` |

On-chain logic:
1. Verify `VerifiedTransaction` PDA exists (sweep TX is SPV-verified)
2. Check confirmations ≥ threshold (1 devnet / 6 mainnet)
3. Read sweep TX from ChadBuffer → extract deposit amount from output
4. Read deposit TX from ChadBuffer → extract `ephemeralPub` + `npk` from OP_RETURN
5. Verify sweep TX input spends from deposit TX (linkage proof)
6. Compute commitment: **`Poseidon(npk, 0x7a627463, amount_sats)`**
7. Insert commitment into Merkle tree → get `leaf_index`
8. Emit stealth announcement event (sol_log_data, disc=0x03)
9. Mint zkBTC to pool vault

### 1.5 Stealth Announcement Event (sol_log_data, disc=0x03)

| Segment | Size | Field | Description |
|---------|------|-------|-------------|
| 0 | 1 | discriminator | `0x03` |
| 1 | 1 | type | `0` = deposit (plaintext amount) |
| 2 | 32 | ephemeral_pub | Ed25519 |
| 3 | 8 | amount_bytes | u64 LE plaintext |
| 4 | 32 | commitment | Poseidon hash |
| 5 | 4 | leaf_index | tree position (u32 LE) |

### 1.6 Deposit Status Flow

```
DETECTED → CONFIRMING → CONFIRMED → SWEEPING → SWEEP_CONFIRMING → VERIFYING → READY → CLAIMED
```

---

## 2. Note Scanning: Recipient Discovers Their Notes

```
scanUnifiedNotes(keys, announcements) → ScannedNote[]
```

For each stealth announcement event (from indexer or tx logs):

1. ECDH: `sharedSecret = X25519(viewingPrivKey, ephemeralPub)`
2. Derive `stealthScalar` from shared secret
3. Compute `npk = Poseidon(MPK, stealthScalar)`
4. Get amount:
   - Type 0 (deposit): plaintext u64 LE
   - Type 1 (transfer): `amount = encryptedAmount XOR KDF(sharedSecret)`
5. Verify: `Poseidon(npk, token, amount) == commitment`
6. If match → this note belongs to the recipient

**Key model**:
```
spendingKey (Baby Jubjub)  ─► Signs JoinSplit proofs (EdDSA-Poseidon)
       ├─► nullifyingKey   ─► Poseidon(nullifyingKey, leafIndex) = nullifier
       └─► viewingKey      ─► Scans announcements (X25519 ECDH)

MPK = Poseidon(spendingPub.x, spendingPub.y, nullifyingKey)
```

---

## 3. JoinSplit Transact: Private Transfers

### 3.1 Circuit: `JoinSplit(N, M, 16)`

**Public signals** (verified on-chain):
- `merkleRoot` — current tree root
- `boundParamsHash` — chain/tree binding (anti-replay)
- `nullifiers[N]` — one per input (prevents double-spend)
- `commitmentsOut[M]` — one per output

**Private signals** (hidden by ZK proof):
- Spending Key, Nullifying Key, EdDSA signature
- Per input: amount, random (for npk), Merkle proof (16 siblings)
- Per output: npk, amount

**Circuit constraints**:
```
For each input i:
  NPK[i] = Poseidon(MPK, random[i])
  commitment[i] = Poseidon(NPK[i], token, value[i])
  Verify: commitment[i] is in tree at merkleRoot
  nullifier[i] = Poseidon(nullifyingKey, leafIndex[i])

For each output j:
  Verify: Poseidon(npkOut[j], token, valueOut[j]) == commitmentsOut[j]
  Range check: valueOut[j] fits in 120 bits

Conservation: sum(valueIn) == sum(valueOut)

Signature: EdDSA-Poseidon(spendingKey, H(merkleRoot, boundParamsHash, nullifiers, commitments))
```

**Proof**: Groth16 on BN254, 256 bytes (2 G1 + 1 G2 points).

### 3.2 Variants

91 total variants where N + M ≤ 14. Common use cases:

| Variant | Use Case |
|---------|----------|
| `1×2` | Claim deposit (1 in → payment + change) |
| `2×2` | Standard private transfer |
| `2×1` | Merge two notes into one |
| `N×1` | Consolidate N notes |

### 3.3 SDK Proof Generation

```typescript
const proof = await generateJoinSplitProof({
  nInputs: 2, nOutputs: 2,
  token: 0x7a627463n, // ZKBTC_TOKEN_ID
  publicKey: [spendingPub.x, spendingPub.y],
  signature: [R8x, R8y, S],
  nullifyingKey,
  inputs: [{ random, value, leafIndex, merkleProof }, ...],
  outputs: [{ npk: recipientNPK, value: 60000n }, { npk: changeNPK, value: 40000n }],
});
```

Note: Uses Node.js subprocess fallback when running in bun (snarkjs WASM incompatibility).

### 3.4 On-Chain: `transact` (disc 14)

Instruction data:
```
[0]        n_inputs
[1]        n_outputs
[2..258]   proof (256 bytes)
[258..290] merkle_root
[290..322] bound_params_hash
[322..]    nullifiers (N × 32)
[..]       commitments_out (M × 32)
[..]       stealth_data (M × 40: ephemeral_pub(32) + encrypted_amount(8))
```

Accounts: `pool_state, commitment_tree, vk_registry, user, system_program, nullifier_records[N]`

On-chain logic:
1. Verify Groth16 proof via BN254 pairing syscalls
2. Validate VK hash from registry for (N, M) variant
3. Create `NullifierRecord` PDA per input → prevents double-spend
4. Insert each output commitment into Merkle tree
5. Emit stealth announcement event per output (type=1, encrypted amount)

---

## 4. Withdrawal

### 4.1 Private Redemption: Shielded → BTC

The only mode that sends BTC back to the user. Requires a ZK proof of commitment ownership.

```
request_redemption ──► mark_processing ──► FROST signs BTC tx ──► complete_redemption
       │                                                                    │
       │ (timeout 7 days)                                                   │
       └──► cancel_redemption (funds re-minted to tree)                     └──► PDA closed, zkBTC burned
```

#### Step 1: `request_redemption` (disc 5)

User submits ZK proof that they own a shielded note, specifying a BTC destination.

Instruction data:
| Field | Size | Description |
|-------|------|-------------|
| proof_hash | 32 | SHA256 of ZK proof |
| merkle_root | 32 | Tree root |
| nullifier_hash | 32 | Prevents double-spend |
| amount_sats | 8 | Withdrawal amount |
| vk_hash | 32 | Verification key hash |
| btc_script_len | 1 | BTC scriptPubKey length |
| btc_script | 62 | BTC withdrawal address (P2TR, P2WPKH, etc.) |
| request_nonce | 8 | Unique nonce |

On-chain:
1. Validate ZK proof (nullifier check)
2. Create `NullifierRecord` PDA (prevents reuse)
3. Create `RedemptionRequest` PDA (118 bytes, status=Pending)
4. Decrement `total_shielded` (locks funds, does NOT burn yet)

#### Step 2: `mark_processing` (disc 2)

Pool authority signals FROST signing has begun. Records Solana slot for timeout tracking.

#### Step 3: Backend — FROST Signing & Broadcast

```
Build unsigned BTC tx ──► FROST Round 1 (commitments) ──► Round 2 (shares) ──► Aggregate Schnorr sig ──► Broadcast
```

Policy engine verifies: sighash, UTXOs, destination, amount/fee limits.

#### Step 4: `complete_redemption` (disc 6)

After BTC tx has 6+ confirmations:

1. Verify `VerifiedTransaction` PDA (SPV-verified BTC txid)
2. Read raw BTC tx from ChadBuffer → verify output pays correct address with correct amount
3. **Burn zkBTC** from pool vault (irreversible)
4. Close `RedemptionRequest` PDA (return rent)

#### Step 5 (alternative): `cancel_redemption` (disc 3)

User can cancel if:
- Status is still `Pending`, OR
- Processing has timed out (~7 days)

Cancellation re-mints the amount as a new commitment: `Poseidon(npk, ZKBTC_TOKEN_ID, amount)`.

### 4.2 Unshield: Shielded → Public SPL Tokens

Converts shielded zkBTC to public SPL tokens on Solana. This is a JoinSplit where the **last output** becomes a public token transfer instead of a tree commitment.

#### `unshield` (disc 15)

Instruction data:
```
[0]        n_inputs
[1]        n_outputs
[2..258]   proof (256 bytes Groth16)
[258..290] merkle_root
[290..322] bound_params_hash
[322..]    nullifiers (N × 32)
[..]       commitments_out (M × 32)
[..]       stealth_data ((M-1) × 40) — only for tree outputs, NOT the unshield output
[..]       unshield_amount (8 bytes)
[..]       unshield_address (32 bytes — recipient Solana pubkey)
```

On-chain logic:
1. Verify Groth16 proof (same circuit as transact — amounts still balance in ZK)
2. Create nullifier PDAs for all inputs
3. Insert M-1 output commitments into tree (change notes) with stealth announcements
4. **Last output**: transfer `unshield_amount` from pool vault → recipient's token account
5. Decrement `total_shielded`

### 4.3 Redeem: JoinSplit → BTC (disc 16)

Atomic JoinSplit + BTC redemption. The last output creates a `RedemptionRequest` PDA instead of a tree commitment. Remaining M-1 outputs are change notes inserted into the tree.

```
JoinSplit N→M  ──►  M-1 outputs → Merkle tree (change notes)
                    Last output → RedemptionRequest PDA → FROST signs → BTC
```

Instruction data (variable length — btc_script trimmed to actual size):
```
[0]        n_inputs
[1]        n_outputs
[2..258]   proof (256 bytes Groth16)
[258..290] merkle_root
[290..322] bound_params_hash (flag=2 for redeem)
[322..]    nullifiers (N × 32)
[..]       commitments_out (M × 32)
[..]       stealth_data ((M-1) × 40) — tree outputs only
[..]       redeem_amount (8 bytes)
[..]       btc_script_len (1 byte)
[..]       btc_script (btc_script_len bytes, max 62)
[..]       request_nonce (8 bytes)
```

Accounts: `pool_state, commitment_tree, vk_registry, user, system_program, nullifier_records[N], redemption_request`

On-chain logic:
1. Verify Groth16 proof (same circuit as transact/unshield)
2. Verify bound params hash (flag=2 for redeem mode)
3. Create nullifier PDAs for all inputs
4. Insert M-1 output commitments into tree, emit stealth announcement events
5. Create `RedemptionRequest` PDA (118 bytes, status=Pending)
6. Decrement `total_shielded`, increment `pending_redemptions`

The backend FROST pipeline auto-discovers and processes the PDA identically to `request_redemption`.

### 4.4 Public Redeem: SPL → BTC (disc 17)

Burns public SPL zkBTC tokens and creates a `RedemptionRequest` PDA. No ZK proof needed — user signs as token account authority.

```
User's SPL zkBTC  ──►  Token-2022 burn  ──►  RedemptionRequest PDA  ──►  FROST signs  ──►  BTC
```

Instruction data (variable length):
```
[0..8]     amount_sats (u64 LE)
[8]        btc_script_len (1 byte)
[9..]      btc_script (btc_script_len bytes, max 62)
[..]       request_nonce (8 bytes)
```

Accounts: `pool_state, zkbtc_mint, user_token_account, user(signer), system_program, token_program, redemption_request`

On-chain logic:
1. Validate pool not paused, verify mint matches
2. Burn tokens via Token-2022 (user signs as authority)
3. Create `RedemptionRequest` PDA (identical to all other redemption paths)
4. Increment `total_burned`, `pending_redemptions`

**No relay needed** — user signs directly since they own the token account.

---

## 5. Security Summary

| Mechanism | What It Prevents |
|-----------|-----------------|
| Nullifier PDA | Double-spending the same note |
| SPV verification | Fake deposit claims |
| Deposit→sweep linkage | Amount substitution attacks |
| On-chain npk extraction | Relayer manipulation of commitment |
| EdDSA-Poseidon signature | Unauthorized spending |
| Merkle root history (100) | Front-running on root changes |
| FROST 2-of-3 threshold | Single-party BTC theft |
| Escrow + timeout | Stuck redemptions (user can cancel after 7 days) |
| Groth16 proof | Invalid transfers (amount conservation, ownership) |

---

## 6. Key Constants

| Constant | Value | Used In |
|----------|-------|---------|
| `ZKBTC_TOKEN_ID` | `0x7a627463` ("zkbtc") | Commitment computation |
| `TREE_DEPTH` | 16 | Merkle tree (65,536 leaves) |
| `ROOT_HISTORY_SIZE` | 100 | Anti-front-running buffer |
| `DEPOSIT_OP_RETURN_SIZE` | 64 bytes | ephemeralPub + npk |
| Stealth announcement | sol_log_data event (disc=0x03) | Emitted per output |
| `PROOF_SIZE` | 256 bytes | Groth16 (2G1 + 1G2) |
| `MAX_FEE_SATS` | 50,000 | Redemption fee tolerance |
| `REDEMPTION_TIMEOUT_SLOTS` | ~7 days | Cancel window |
| `REQUIRED_CONFIRMATIONS` | 1 (devnet) / 6 (mainnet) | SPV verification |
