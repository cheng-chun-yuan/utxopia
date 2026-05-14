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
Primitive is fully wired end-to-end: on-chain `transact` (disc 13) detects + emits, SDK `buildSenderMemosForTransact` composes client-side, `/api/relay` forwards opaquely, auditor honors `ViewPermissions.INCOMING_ONLY`. The in-app vault flow (`use-joinsplit-submit.ts`) now reads `next_leaf_index` from the commitmentTree PDA and attaches memos to every transfer by default (kill switch: `NEXT_PUBLIC_DISABLE_SENDER_MEMOS=1`).
- [ ] **Live E2E**: `scripts/e2e/step-sender-memo.ts` is unit-style today. Extend to submit a real transact with memos to a deployed program and assert the auditor scanner produces an OUT record. Wire into `run-all.ts`.

### Phase 3 PoI — remaining follow-ups
- [ ] Phase 3d: merged JoinSplit+PoI circuit so the attestation hides the spent commitment. Today `attest_poi` (disc 22) takes the commitment as a clear public input — fine for the honor-system flow, blocks privacy-sensitive callers.
- [x] Frontend PoI page lives at `/poi` (collides with the existing `/prove` SPV-verify widget if put under `/prove`). Pipes the user's commitment → backend `/api/poi/inclusion` → browser Groth16 → `/api/attest-poi` (relayer-signed submit of disc 22).
- [ ] Curation policy for the association set: deposit-confirmation-only today; consider taint-graph propagation à la Railgun PPOI as a v2.

### Phase 4 selective disclosure — remaining follow-ups
- [x] Compile range-sum N=4 companion. Circuit at `circuits/circom/range_sum_4.circom`, build under `circuits/build/range_sum_4/`. SDK picks the variant automatically via `pickRangeSumVariant(notes.length)`; new builds register in `RANGE_SUM_VARIANTS`.
- [ ] **N=16 range-sum**: blocked by circomlib's Poseidon-16 limit. The current template hashes `Poseidon(n+1)` for the attestation public input, which exceeds the max arity at N=16. Refactor the template to chunk the attestation hash (e.g. `Poseidon(Poseidon(idx[0..8]), Poseidon(idx[8..16]), viewerNonce)`); this is a wire-format change so N=8 callers need to update too.
- [x] **Web verifier page** at `/verify-proof`: pure client-side Groth16 verifier (snarkjs lazy-loaded via `verifyGroth16Proof` from the SDK). Pick a known circuit from the dropdown and the page fetches the vkey from the CDN; for one-off VKs, switch to "Custom" and paste/upload the JSON. Nothing is sent to a server.
- [ ] **Deploy `range_sum_4.zkey` to R2**: 20 MB, doesn't belong in the repo. Use `bash scripts/upload-circuits-r2.sh --aux range_sum_4` once a bucket alias is wired. Same script handles `proof_of_innocence`, `ownership`, `range_sum` if those move out of `web/public/` later.

### Additional compliance levers (scaffolds not yet started)
- [ ] **BTC-deposit origin attestation**: each confirmed deposit emits a signed `(block_height, txid, vout, commitment)` attestation as a `sol_log_data` event so third-party auditors can build their own association sets without trusting us. Complements PoI by giving auditors raw deposit-origin data.
- [ ] **Per-stealth-address compliance toggle**: SNS subdomain record carries an optional encrypted `DelegatedViewKey` v2 stub — when set, payers know the address is "auditor-disclosable by default" and the sender wallet can attach a memo aimed at the receiver's pre-registered auditor.
- [ ] **DelegatedViewKey v1 → v2 forced migration**: refuse v1 keys past a deprecation slot; today they deserialize but `auditScan` errors out at use time.
- [ ] **Audit trail sync**: `~/.utxopia/delegations.json` is per-machine — optional encrypted cloud sync for users issuing keys from multiple devices.

## Regtest / hybrid stack — remaining follow-ups
The `/api/faucet/regtest` route is feature-complete for dev/hybrid use: `docker exec` → bitcoin-cli, file-backed per-address cooldown (`.faucet-cooldown.json` — survives Next.js restarts, prunes entries older than 2× the cooldown window), auto-bootstrap (mines 101 blocks on first drip if the wallet is empty), optional `X-API-Key` auth gate via `REGTEST_FAUCET_API_KEY`. No outstanding regtest TODOs — graduate to per-IP rate limit + Redis store if/when this gets exposed publicly.
