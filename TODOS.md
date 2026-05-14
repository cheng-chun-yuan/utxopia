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

### Phase 2b sender memos — remaining follow-ups
Primitive is fully wired: on-chain `transact` (disc 13) detects + emits, SDK `buildSenderMemosForTransact` composes client-side, `/api/relay` forwards opaquely, auditor honors `ViewPermissions.INCOMING_ONLY`. The vault UI doesn't yet compose memos when calling the relay — that's the opt-in step below.
- [ ] **In-app vault opt-in**: when the vault page submits a transact, read `next_leaf_index` from the `commitmentTree` PDA, call `buildSenderMemosForTransact(viewingPrivKey, outputs)`, and attach the hex strings to the `/api/relay` body. Document the race window (concurrent transacts in one slot → loser's memos won't decrypt — non-fatal, just a gap in outgoing history).
- [ ] **Live E2E**: `scripts/e2e/step-sender-memo.ts` is unit-style today. Extend to submit a real transact with memos to a deployed program and assert the auditor scanner produces an OUT record. Wire into `run-all.ts`.

### Phase 3 PoI — remaining follow-ups
- [ ] Phase 3d: merged JoinSplit+PoI circuit so the attestation hides the spent commitment. Today `attest_poi` (disc 22) takes the commitment as a clear public input — fine for the honor-system flow, blocks privacy-sensitive callers.
- [ ] Frontend `/prove` page: end-user UX for invoking `attest_poi` (today it's CLI-only via `scripts/auditor/attest-poi.ts`).
- [ ] Curation policy for the association set: deposit-confirmation-only today; consider taint-graph propagation à la Railgun PPOI as a v2.

### Phase 4 selective disclosure — remaining follow-ups
- [ ] Compile range-sum companions N=4, N=16 (today only N=8 is compiled — see `RANGE_SUM_N` in `sdk/src/selective-disclosure.ts`).
- [ ] Verification surface: separate verifier program endpoint, or a thin web verifier page that consumes `proof.json` + public inputs so auditors don't need bun installed to verify.

### Additional compliance levers (scaffolds not yet started)
- [ ] **BTC-deposit origin attestation**: each confirmed deposit emits a signed `(block_height, txid, vout, commitment)` attestation as a `sol_log_data` event so third-party auditors can build their own association sets without trusting us. Complements PoI by giving auditors raw deposit-origin data.
- [ ] **Per-stealth-address compliance toggle**: SNS subdomain record carries an optional encrypted `DelegatedViewKey` v2 stub — when set, payers know the address is "auditor-disclosable by default" and the sender wallet can attach a memo aimed at the receiver's pre-registered auditor.
- [ ] **DelegatedViewKey v1 → v2 forced migration**: refuse v1 keys past a deprecation slot; today they deserialize but `auditScan` errors out at use time.
- [ ] **Audit trail sync**: `~/.utxopia/delegations.json` is per-machine — optional encrypted cloud sync for users issuing keys from multiple devices.

## Regtest / hybrid stack — remaining follow-ups
The `/api/faucet/regtest` route is feature-complete for dev/hybrid use: `docker exec` → bitcoin-cli, per-address in-memory cooldown, auto-bootstrap (mines 101 blocks on first drip if the wallet is empty), optional `X-API-Key` auth gate via `REGTEST_FAUCET_API_KEY`. Outstanding:
- [ ] **Persistent cooldown store**: today the cooldown map lives in-process and resets on Next.js restart. Move to a small file-backed store (or Redis if you grow one) once the faucet is internet-reachable.
