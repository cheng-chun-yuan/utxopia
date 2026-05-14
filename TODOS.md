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
- [x] **N=16 range-sum** with chunked attestation hash. `circuits/circom/range_sum_16.circom` is a standalone template (not derived from `range_sum_template.circom`) because circomlib's Poseidon caps at arity 16. SDK helper `computeRangeSumAttestation` + variant registry dispatch on `attestation: "flat" | "chunked"`. Only the vkey is committed to `web/public/`; the 81 MB zkey goes to R2.
- [x] **Web verifier page** at `/verify-proof`: pure client-side Groth16 verifier (snarkjs lazy-loaded via `verifyGroth16Proof` from the SDK). Pick a known circuit from the dropdown and the page fetches the vkey from the CDN; for one-off VKs, switch to "Custom" and paste/upload the JSON. Nothing is sent to a server.
- [ ] **Deploy `range_sum_4.zkey` (20 MB) + `range_sum_16.zkey` (81 MB) to R2**: too big to commit. Run `bash scripts/upload-circuits-r2.sh --aux range_sum_4 && bash scripts/upload-circuits-r2.sh --aux range_sum_16` once a bucket alias is wired. Same script handles `proof_of_innocence`, `ownership`, `range_sum` if those move out of `web/public/` later.

### Additional compliance levers
- [x] **BTC-deposit origin attestation**: every successful `verify_stealth_deposit` now emits `EVENT_BTC_ORIGIN_ATTESTATION` (disc 0x15) carrying `(block_height, deposit_txid, sweep_vout, commitment, amount_sats)`. SDK parser + dispatch + 5 dedicated tests in `events.test.ts`. Third-party auditors can subscribe and build their own association sets without trusting our backend.
- [x] **DelegatedViewKey v1→v2 forced migration**: `deserializeDelegatedViewKey` refuses v1 blobs at parse time with a clear error. Migration tooling can opt in via `{ acceptV1: true }`. Two new tests pin both branches.
- [x] **Per-stealth-address compliance toggle**: SNS subdomain records carry an optional `complianceFlags: u8` byte (bit 0 = AUDITOR_DISCLOSABLE). SDK reader is back-compat with legacy 65-byte records (flags default to 0); Send-form preview-resolves the SNS name and renders an "Auditor-disclosable" chip when the bit is set. Owners set / clear via `scripts/sns-set-compliance.ts <subdomain> --enable|--disable` OR via the Settings page toggle (uses the wallet adapter instead of a local keypair).
  - [ ] **v2 schema**: extend the byte to carry an encrypted `DelegatedViewKey` stub pointing at the receiver's pre-registered auditor, so senders can compose memos addressed to that auditor without out-of-band coordination.
- [ ] **Audit trail sync**: `~/.utxopia/delegations.json` is per-machine — optional encrypted cloud sync for users issuing keys from multiple devices.

## Regtest / hybrid stack — remaining follow-ups
The `/api/faucet/regtest` route is feature-complete for dev/hybrid use: `docker exec` → bitcoin-cli, file-backed per-address cooldown (`.faucet-cooldown.json` — survives Next.js restarts, prunes entries older than 2× the cooldown window), auto-bootstrap (mines 101 blocks on first drip if the wallet is empty), optional `X-API-Key` auth gate via `REGTEST_FAUCET_API_KEY`. No outstanding regtest TODOs — graduate to per-IP rate limit + Redis store if/when this gets exposed publicly.
