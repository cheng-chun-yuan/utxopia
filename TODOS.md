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

## Passive Attestation — New primary compliance path (NEXT)

The PoI ZK route (Phase 3 / 3d) is now positioned as **advanced/backup**. The
default compliance path is passive attestation by registered third-party
screeners. User stays unaware of compliance plumbing; CEX queries a simple
on-chain attestation status. See `docs/COMPLIANCE.md` §2.1 + §5 for the
canonical spec.

- [ ] **ScreenerRegistry PDA** with admin-controlled add/remove of screener pubkeys
- [ ] **`register_screener` (disc 27)** + **`revoke_screener` (disc 28)** admin instructions
- [ ] **`attest_origin` (disc 29)** — anyone can submit, signature must match a registered active screener pubkey; emits `EVENT_ORIGIN_SCREENED` (disc 0x18)
- [ ] **Backend daemon** that subscribes to `EVENT_BTC_ORIGIN_ATTESTATION` (disc 0x15) + `EVENT_SHIELD_META` (disc 0x11), calls Chainalysis (or other screener API), and submits attestations
- [ ] **CEX integration SDK** with `checkAttestation({ commitment, acceptedScreeners, maxAgeSecs })`
- [ ] **Solana shield origin attestation** — analog of `EVENT_BTC_ORIGIN_ATTESTATION` for SPL deposits so passive attestation covers the SPL flow too
- [ ] Demote PoI page out of main nav (move to Settings → Advanced); reflect "advanced/backup" framing in docs

Estimated total: ~2 weeks engineering once the legal + screener contracts are
in motion.

## Auditable Disclosure Roadmap — Future Work

Phase 1 (auditor toolkit) and the sender-memo crypto layer are shipped. Items below are the
follow-ups that turn the "compliance-friendly" claim from partly aspirational into something
a CEX integrations / regulator conversation can defend. Ordered roughly by cost-to-credibility.

### Phase 2b sender memos — remaining follow-ups
Primitive is fully wired end-to-end: on-chain `transact` (disc 13) detects + emits, SDK `buildSenderMemosForTransact` composes client-side, `/api/relay` forwards opaquely, auditor honors `ViewPermissions.INCOMING_ONLY`. The in-app vault flow (`use-joinsplit-submit.ts`) now reads `next_leaf_index` from the commitmentTree PDA and attaches memos to every transfer by default (kill switch: `NEXT_PUBLIC_DISABLE_SENDER_MEMOS=1`).
- [ ] **Live E2E**: `scripts/e2e/step-sender-memo.ts` is unit-style today. Extend to submit a real transact with memos to a deployed program and assert the auditor scanner produces an OUT record. Wire into `run-all.ts`.

### Phase 3 PoI — remaining follow-ups
- [x] **Phase 3d-lite — hidden-commitment PoI**: new circuit `attest_poi_hidden.circom` swaps the public commitment for `blinded_id = Poseidon(commitment, nonce)`. On-chain instruction `attest_poi_hidden` (disc 23) verifies the proof; new event `EVENT_POI_HIDDEN_ATTESTED` (disc 0x16) emits `(association_root, blinded_id, version)` — no commitment. SDK: `generateHiddenPoIProof` + `computeBlindedId` + `buildAttestPoIHiddenInstructionData`. Frontend `/poi` has a "Hide commitment" toggle that surfaces the nonce in the success card for share-with-auditor. Routed via new `/api/attest-poi-hidden` endpoint.
- **Phase 3d-full (removed)**: the 1x2 `transact_with_poi` prototype was reverted. Co-attestation via JoinSplit+PoI requires per-variant ceremony work (~91 compiled zkeys for the full circuit set) and the resulting compliance outcome is already achieved by passive attestation (signed origin attestation from a registered screener) at far lower UX + engineering cost. The template `joinsplit_with_poi.circom` and the on-chain `transact_with_poi` instruction were deleted; the VK module and discriminator 26 are now reserved/unused. Multi-hop lineage stays a research item — see `docs/COMPLIANCE.md` §10 for the honest disclosure.
- [x] Frontend PoI page lives at `/poi` (collides with the existing `/prove` SPV-verify widget if put under `/prove`). Pipes the user's commitment → backend `/api/poi/inclusion` → browser Groth16 → `/api/attest-poi` (clear) or `/api/attest-poi-hidden` (blinded).
- [x] **Curation policy v1 — deposit-confirmation-only**: every SPV-verified deposit is auto-fed into the PoI association set. Backend `deposit_tracker::service::maybe_auto_feed_poi` runs on every successful verify; the new on-chain `EVENT_BTC_ORIGIN_ATTESTATION` (disc 0x15) is now parsed by `event_indexer/parser.rs` and routed through `service.rs` (logged) + `solana_ws.rs` (acknowledged as poll-indexer-owned), so third-party indexers can mirror the curation without trusting our backend.
- [ ] Curation policy v2: taint-graph propagation à la Railgun PPOI. Backend-only can't do this (nullifier→commitment is one-way without user keys). With Phase 3d-full removed, the practical alternatives are: (a) passive attestation re-runs at each unshield, treating each exit as a fresh decision rather than tracking lineage; (b) user-cooperated audit trails via Layer 3. Defer to actual demand.

### Phase 4 selective disclosure — remaining follow-ups
- [x] Compile range-sum N=4 companion. Circuit at `circuits/circom/range_sum_4.circom`, build under `circuits/build/range_sum_4/`. SDK picks the variant automatically via `pickRangeSumVariant(notes.length)`; new builds register in `RANGE_SUM_VARIANTS`.
- [x] **N=16 range-sum** with chunked attestation hash. `circuits/circom/range_sum_16.circom` is a standalone template (not derived from `range_sum_template.circom`) because circomlib's Poseidon caps at arity 16. SDK helper `computeRangeSumAttestation` + variant registry dispatch on `attestation: "flat" | "chunked"`. Only the vkey is committed to `web/public/`; the 81 MB zkey goes to R2.
- [x] **Web verifier page** at `/verify-proof`: pure client-side Groth16 verifier (snarkjs lazy-loaded via `verifyGroth16Proof` from the SDK). Pick a known circuit from the dropdown and the page fetches the vkey from the CDN; for one-off VKs, switch to "Custom" and paste/upload the JSON. Nothing is sent to a server.
- [ ] **Deploy `range_sum_4.zkey` (20 MB) + `range_sum_16.zkey` (81 MB) to R2**: too big to commit. Run `bash scripts/upload-circuits-r2.sh --aux range_sum_4 && bash scripts/upload-circuits-r2.sh --aux range_sum_16` once a bucket alias is wired. Same script handles `proof_of_innocence`, `ownership`, `range_sum` if those move out of `web/public/` later.

### Additional compliance levers
- [x] **BTC-deposit origin attestation**: every successful `verify_stealth_deposit` now emits `EVENT_BTC_ORIGIN_ATTESTATION` (disc 0x15) carrying `(block_height, deposit_txid, sweep_vout, commitment, amount_sats)`. SDK parser + dispatch + 5 dedicated tests in `events.test.ts`. Third-party auditors can subscribe and build their own association sets without trusting our backend.
- [x] **DelegatedViewKey v1→v2 forced migration**: `deserializeDelegatedViewKey` refuses v1 blobs at parse time with a clear error. Migration tooling can opt in via `{ acceptV1: true }`. Two new tests pin both branches.
- [x] **Per-stealth-address compliance toggle (v2)**: SNS subdomain records carry `complianceFlags: u8` (bit 0 = AUDITOR_DISCLOSABLE) + an optional 32-byte auditor Solana pubkey at offset 66. SDK reader is back-compat with legacy 65-byte records, v1 66-byte (flag-only) records, and the new 98-byte (flag + auditor) records. Send-form chip shows both the disclosure intent and the auditor's pubkey. Owners flip via the Settings page (`AuditorDisclosableToggle` + `AuditorPubkeyField`) or `scripts/sns-set-compliance.ts --enable --auditor <base58>`.
  - [ ] **v3 schema (future)**: replace the public pubkey hint with an encrypted `DelegatedViewKey` stub the sender can decrypt with the recipient's public key — so senders can compose memos addressed to the auditor without any out-of-band exchange. Requires an x25519 encrypt wrapper + a careful threat-model review (would expose the recipient ⇄ auditor relationship on chain to anyone who knows the recipient's viewing pub).
- [ ] **Audit trail sync**: `~/.utxopia/delegations.json` is per-machine — optional encrypted cloud sync for users issuing keys from multiple devices.

## Regtest / hybrid stack — remaining follow-ups
The `/api/faucet/regtest` route is feature-complete for dev/hybrid use: `docker exec` → bitcoin-cli, file-backed per-address cooldown (`.faucet-cooldown.json` — survives Next.js restarts, prunes entries older than 2× the cooldown window), auto-bootstrap (mines 101 blocks on first drip if the wallet is empty), optional `X-API-Key` auth gate via `REGTEST_FAUCET_API_KEY`. No outstanding regtest TODOs — graduate to per-IP rate limit + Redis store if/when this gets exposed publicly.
