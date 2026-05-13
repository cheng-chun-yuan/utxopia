# TODOS

## SDK Migration — Route Refactoring ✅

### P1: Replace inline instruction building in API routes with SDK calls ✅
- ✅ **`/api/relay`**: Replaced `buildTransactIx()` (~90 lines) with SDK `buildTransactInstructionData({ proofSource: 1 })`
- ✅ **`/api/unshield`**: Replaced inline data packing (~60 lines) with SDK `buildUnshieldInstructionData()`
- ✅ **`/api/redeem`**: Kept disc=16 (atomic JoinSplit + redemption), added SDK `buildRedeemInstructionData()`
- ✅ **Stealth data**: Updated from 40 bytes to 72 bytes (added encrypted_token_id field)
- **`/api/verify` left as-is** — SPV logic is frontend-specific, not covered by core SDK.

## Proof Binding Security Hardening ✅

### boundParamsHash now binds ALL relayer-tamperable fields:
- ✅ **BTC destination**: SHA256(btcScript) hashed into address field for redeem (mode=2)
- ✅ **Unshield recipient**: Verified against token account owner on-chain
- ✅ **Stealth data**: SHA256(concat(stealthData)) added to all modes (77-byte layout)
- ✅ **Amount**: Already bound via burn commitment verification (Poseidon(0, token_id, amount))

### Cross-language parity tests:
- ✅ 8 Rust unit tests for bound params hash (determinism, mode separation, btcScript binding, stealth binding)
- ✅ 10 SDK tests including 4 cross-language vector tests (Rust hex == SDK hex)
- ✅ Fixed test-env SHA256: Rust tests now use real `sha2` crate (was XOR-based fake hash)

## Auditable Disclosure Roadmap — Future Work

Phase 1 (auditor toolkit) and the sender-memo crypto layer are shipped. Items below are the
follow-ups that turn the "compliance-friendly" claim from partly aspirational into something
a CEX integrations / regulator conversation can defend. Ordered roughly by cost-to-credibility.

### Phase 2b: wire sender memo into `transact`
- [x] Extend `transact` (disc 14) instruction data with optional trailing 80-byte memo slice per output (nonce(24) + ct_and_tag(56)). — `contracts/programs/utxopia/src/instructions/transact.rs` already detects + parses + emits per output (lines 164–170, 378–391).
- [x] Emit `emit_sender_memo` (disc 0x12) per output when memos are supplied. — same file as above.
- [x] SDK `buildTransactInstructionData` already accepts `senderMemos?: Uint8Array[]`; high-level encrypt-and-pack helper `buildSenderMemosForTransact(viewingPrivKey, outputs[])` lands in `sdk/src/sender-memo.ts` with 7 dedicated tests (AAD-race detection, ordering, length/range checks).
- [ ] **Next**: wire `senderMemos` through `/api/relay` route — request body needs to accept per-output `{ tokenId, amount, commitment, predictedLeafIndex }`, then the route calls `buildSenderMemosForTransact` server-side. Today the route silently drops memos.
- [ ] **Next**: read `next_leaf_index` from the `commitmentTree` PDA inside the relay route (or have the client predict + sign) so leaf indices match what the program inserts. Doc the race window: if two `transact`s land in the same slot, the loser's memos won't decrypt.
- [ ] Backend indexer parses memos already (`parser.rs::parse_sender_memo`); confirm storage/exposure to auditor scanner.
- [ ] E2E: `scripts/e2e/step-sender-memo.ts` exists — extend to actually submit a transact with memos to a live program and assert the auditor scanner produces an OUT record. Wire into `run-all.ts`.
- [ ] Enforce `ViewPermissions.INCOMING_ONLY` by skipping memo emission for outputs whose delegation forbids OUT records.

### Phase 3: Proof of Innocence — production path
- [ ] Trusted setup ceremony for `circuits/circom/proof_of_innocence.circom` (multi-party contribution, depth 20).
- [ ] `node circuits/scripts/export-vk-rust.js proof_of_innocence` to emit the on-chain VK constants.
- [ ] On-chain VK registration (extend disc 11/12 registry or add a PoI-specific slot).
- [ ] New instruction `transact_with_poi` (and/or `unshield_with_poi`): same as `transact` but additionally verifies a PoI proof anchored to a recent association root.
- [ ] Association-set service: minimal HTTP backend that ingests confirmed deposit commitments, builds a depth-20 Merkle tree, exposes `/api/poi/inclusion?commitment=...` (already consumed by `sdk/src/poi.ts::fetchPoIInclusion`).
- [ ] Frontend `/prove` page: optional "include proof of innocence" toggle on transact / unshield.
- [ ] Decide curation policy for the association set (deposit-confirmation-only vs. taint-graph propagation à la Railgun PPOI).

### Phase 4: Selective disclosure proofs
- [ ] Trusted setup for `circuits/circom/ownership.circom` (depth-16, threshold via GreaterEqThan-120).
- [ ] Trusted setup for `circuits/circom/range_sum.circom` (N=8 first; N=4, N=16 companions later).
- [ ] Prover wrappers: wire `sdk/src/selective-disclosure.ts::generateOwnershipProof` / `generateRangeSumProof` to the generic snarkjs prover.
- [ ] CLIs: `scripts/auditor/prove-ownership.ts`, `scripts/auditor/prove-range-sum.ts`.
- [ ] Verification surface: separate verifier program endpoint, or a thin web verifier page that consumes `proof.json` + public inputs.

### Additional compliance levers (scaffolds not yet started)
- [ ] **BTC-deposit origin attestation**: each confirmed deposit emits a signed `(block_height, txid, vout, commitment)` attestation as a `sol_log_data` event so third-party auditors can build their own association sets without trusting us.
- [ ] **Per-stealth-address compliance toggle**: SNS subdomain record carries an optional encrypted `DelegatedViewKey` v2 stub — when set, payers know the address is "auditor-disclosable by default" and the sender wallet can attach a memo aimed at the receiver's pre-registered auditor.
- [ ] **DelegatedViewKey v1 → v2 forced migration**: refuse v1 keys past a deprecation slot; today they deserialize but `auditScan` errors out at use time.
- [ ] **Audit trail sync**: `~/.utxopia/delegations.json` is per-machine — optional encrypted cloud sync for users issuing keys from multiple devices.

## Regtest / hybrid stack — Future Work
- [ ] **Regtest faucet backend route**: `/api/faucet/regtest` that calls bitcoind `sendtoaddress` via the regtest container; currently the frontend page assumes this endpoint exists.
- [ ] **Auto-mine block on faucet drip**: regtest needs explicit block generation; faucet should mine 1 block after each send so the user's address sees confirmed UTXOs.
- [ ] **Cooldown / rate limit**: simple per-address cooldown so the faucet isn't drained by accident.
