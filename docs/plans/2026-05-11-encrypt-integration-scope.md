# UTXOpia — "Encrypt" Integration Scoping Plan

**Status:** Scoping draft
**Date:** 2026-05-11
**Author:** Sub-agent scoping under user direction
**Track:** Encrypt + Ika (Bridgeless Capital Markets)
**Branch:** `ika`
**Predecessor:** `docs/designs/2026-05-09-ika-encrypt-pivot-design.md` (largely stale — see §0)

---

## 0. TL;DR — read this first

**The single biggest finding:** The "Encrypt" product the old design doc references — `encrypt-pinocchio`, `#[encrypt_fn]`, an FHE matcher — **does not exist in the pre-alpha codebase we can build against today**. The `dwallet-labs/ika-pre-alpha` repository (recon brief at `docs/recon/2026-05-09-ika-sdk-brief.md`) ships **dWallet-only**. There is no Encrypt SDK, no Encrypt program ID, no Encrypt gRPC endpoint, no Encrypt CPI surface. Anyone scrolling the upstream README, request-types doc, or `crates/ika-dwallet-types/src/lib.rs` will confirm: the 11 supported protocol operations are all dWallet operations (DKG, Sign, Presign, PresignForDWallet, FutureSign, SignWithPartialUserSig, ReEncryptShare, MakeSharePublic, ImportedKeyVerification, ImportedKeySign, ImportedKeySignWithPartialUserSig). None of them constitute a general-purpose "encrypt + threshold-decrypt" service.

The old `docs/designs/2026-05-09-ika-encrypt-pivot-design.md` Phase 2 plan to build a `confidential_swap` Pinocchio program calling `encrypt-pinocchio` was therefore **paper architecture against a product that does not ship**. It should be archived as "Phase 2, post-pre-alpha; depends on Encrypt mainnet" rather than treated as a hackathon-eligible target.

**Therefore, the SVES (Smallest Valuable Encrypt Slice) we recommend** is **not** building on a non-existent "Encrypt network." It is:

> **Use the Ika dWallet's existing zero-trust DKG mode (`UserSecretKeyShare::Encrypted`) and the `ReEncryptShare` operation to ship one credible "Encrypt-adjacent" feature: an _Ika-backed encrypted viewing-key share_ that lets a UTXOpia user grant scoped, revocable read access to a third party (auditor, accountant, tax software) by re-encrypting a viewing-key share to that third party's encryption key, with the re-encryption gated by an on-chain policy our program enforces.**

This SVES is honest about what Ika actually exposes, fits in 6–12 hours, and tells judges:

1. Ika dWallets aren't just for signing — their **encrypted user share** protocol is the primitive we use to deliver confidentiality, not just signatures.
2. UTXOpia's "3-key model" gets a new capability that ZK alone cannot provide: third parties can be granted decryption rights **without ever holding the secret directly** — the share lives encrypted at rest, and the re-encryption is a network-attested operation.
3. We hit "Encrypt" by leaning into the **actual encryption primitives** Ika ships in pre-alpha (encrypted share + re-encryption attestation), not by faking integration with a product that doesn't exist.

**Effort estimate:** 8–10 hours. **Critical risk:** `ReEncryptShare` is documented as "Wire format defined; not yet implemented in mock" — see §5 for the contingency plan if the mock signer can't actually run it.

If the mock contingency triggers, the **fallback SVES** (also documented below) is to ship a smaller variant: a static-NEK-encrypted view-key blob whose decryption is performed by our backend after gathering an `approve_message`-style on-chain authorization from our UTXOpia program. This is "Encrypt-shaped using only dWallet primitives" and is a 4-hour ship.

If even the fallback is blocked, the **honest exit** is a written-down design (§9) demonstrating we understand Encrypt well enough to ship it post-hackathon — which we argue is more credible than papering over an integration that doesn't compile.

---

## 1. SVES — the recommendation in 200 lines

### 1.1 User-facing scenario

**Alice** is a UTXOpia user who runs a small fund. She holds shielded zkBTC, zkUSDC, and zkSOL notes. **Bob** is her accountant. At tax time, Alice needs Bob to be able to **read** all her transaction history — for compliance, tax filing, audit — but she does **not** want to:

- Email Bob the literal Ed25519 viewing private key (bearer secret, can't revoke, can't scope)
- Trust Bob's email/laptop/cloud provider with her viewing key forever
- Give Bob spending capability (the existing 3-key model already separates these — good)

Today (post-Phase-1 Ika), Alice's only export option is `serializeDelegatedViewKey(...)` in `sdk/src/keys.ts:539`, which AES-GCM-encrypts the viewing private key under a **password** Alice sets, then ships the blob to Bob plus the password out-of-band. Problems:

- Password sharing is a side channel
- Revocation = "ask Bob nicely to delete the file"
- No on-chain audit trail of "Alice granted Bob view access at slot N"
- No expiry enforcement (the SDK's `expiresAt` field is honored by the SDK; it's not a cryptographic gate)

**With the SVES**, Alice does this instead:

1. Bob shares a one-time encryption pubkey with Alice (e.g. a fresh X25519 key generated in Bob's UTXOpia web client, or — better — Bob has already done a one-time dWallet DKG and his dWallet's NEK-encrypted user share *is* his encryption key).
2. Alice initiates "Grant view access" in the web UI. Under the hood, the SDK:
   - Wraps her Ed25519 viewing private key (or a strict subset of it — see §3.2 on **scoping**) into the same format Ika's `UserSecretKeyShare::Encrypted` expects.
   - Calls Ika's `ReEncryptShare` operation: take her _existing_ encrypted-share blob (from when she did DKG) and request the Ika network to re-encrypt it to Bob's encryption key.
   - Receives back a `VersionedEncryptedUserKeyShareAttestation` — a network-signed blob that says "the share underlying dWallet X has been re-encrypted to encryption-key Y, attested by NOA at epoch Z."
3. Alice's UTXOpia program records the grant on-chain (a small `view_grant` PDA: grantor solana pubkey, grantee solana pubkey, expiry slot, scope flags, attestation hash).
4. Bob receives the re-encrypted blob (off-chain link) + the on-chain grant PDA pubkey. He decrypts using **his** private encryption key (which never left him); the SDK then loads the viewing private key into his local UTXOpia client and he can scan Alice's stealth announcements.
5. To revoke, Alice submits a `revoke_view_grant` instruction. The on-chain PDA is closed; the SDK refuses to use the share thereafter. (Cryptographic revocation requires Alice to rotate her viewing key — same as today — but the on-chain grant is auditable and the SDK behavior is gated.)

### 1.2 What's encrypted, by whom, decryptable by whom

| Artifact | Plaintext known to | Ciphertext readable by | How it gets there |
|---|---|---|---|
| Alice's viewing private key (full) | Alice only | (nobody) | Stays on Alice's device, never re-encrypted |
| **"View share" blob** (a deliberately-scoped derivation of Alice's viewing key — see §3.2) | Alice (during creation), then sealed | Bob, after `ReEncryptShare` completes | Ika network re-encrypts it to Bob's encryption key; the re-encryption itself is performed by the network committee (pre-alpha: mock signer; mainnet: 2PC-MPC) |
| `view_grant` PDA on Solana | Public (by design — auditable grant record) | Anyone | Written by Alice's `grant_view_access` instruction |

The **load-bearing** privacy claim is: Alice's full viewing private key never leaves her device, and the encrypted "view share" that does leave is sealed by **the Ika network**, not by an ad-hoc AES-GCM blob whose password is shared over WhatsApp. The on-chain `view_grant` PDA is what makes the grant revocable + auditable.

### 1.3 Component diagram

```
                                                                       Solana devnet
                                                                       ─────────────
   Alice's web client                                                  ┌─────────────────┐
   ────────────────                                                    │ UTXOpia    │
                                                                       │ G1bj9Vw9...3ixUy│
   1. createViewShare(viewingKey, scope)                               │                 │
        │                                                              │ ┌─────────────┐ │
        ▼                                                              │ │ view_grant  │ │ ← new PDA
   2. wrap into UserSecretKeyShare::Encrypted ─── gRPC ──┐             │ │ PDA         │ │   (grantor,
                                                         │             │ └─────────────┘ │    grantee,
                                                         ▼             │                 │    expiry,
   ┌─────────────────────────────────────────────┐                     │                 │    scope,
   │  Ika dWallet network (pre-alpha mock)       │                     │                 │    attest_hash)
   │  pre-alpha-dev-1.ika.ika-network.net:443    │                     │                 │
   │                                             │                     │                 │
   │  DKG (one-time, gives Alice a dWallet       │                     │                 │
   │       whose key material is a sealed        │                     │                 │
   │       wrapper around her viewing-share)     │                     │                 │
   │                                             │                     │                 │
   │  ReEncryptShare                             │                     │                 │
   │    in:  Alice's encrypted share +           │                     │                 │
   │         Bob's encryption_key                │                     │                 │
   │    out: Bob-encrypted share +               │                     │                 │
   │         NetworkSignedAttestation            │                     │                 │
   └────────────────────────────┬────────────────┘                     │                 │
                                │                                      │                 │
                                │ (off-chain: Alice                    │                 │
                                │  receives the attestation,           │                 │
                                │  submits it on-chain)                │                 │
                                ▼                                      │                 │
              3. grant_view_access(grantee, attestation_hash, ─── CPI? ─┤                 │
                 expiry, scope)                                         │                 │
                 — instruction creates the view_grant PDA              │                 │
                 — optionally CPIs to Ika program to verify the         │                 │
                   attestation onchain via a Verify CPI (see §3.4)      │                 │
                                                                       └─────────────────┘
                                ▲
                                │  (Bob loads the SDK with his
                                │   encryption private key,
                                │   decrypts the share, gets
                                │   the wrapped view-share,
                                │   reads Alice's announcements)
                                │
   Bob's web client
   ──────────────
   4. fetch view_grant PDA + Bob-encrypted share blob
   5. decrypt share locally
   6. UTXOpiaClient.loginWithDelegatedView(decryptedShare)
   7. scan announcements for Alice's MPK
```

### 1.4 Why this is valuable enough for judges

- **Solves a real user problem.** Compliance / tax / audit access to private wallets is the #1 reason institutional capital won't touch shielded protocols. We're not inventing a use case.
- **Genuinely uses Ika's encryption primitives** — not theatre. `UserSecretKeyShare::Encrypted` and `ReEncryptShare` are first-class operations of the dWallet protocol. They're listed in the same table of 11 supported operations as `Sign`, which is what we use today for redemption custody.
- **Pairs with our existing Ika integration.** Demo flow extends naturally: "we already showed Ika holds the BTC keys via dWallet `approve_message`; here's how Ika also holds *encrypted viewing-key shares* for our delegated-view feature." Same primitive, different role.
- **Hits "and/or" → "and" on judging criterion #1.** We currently nail Ika; we currently get 0% Encrypt. Even one operation that genuinely uses Ika's encryption-protocol surface flips this from "or" to "and." If we're aggressive about messaging, we can argue this *is* "Encrypt" — the encrypted-share protocol *is* Ika's encryption primitive, regardless of whether Ika eventually ships a separate-product-named "Encrypt."

### 1.5 Pitfalls

- **`ReEncryptShare` mock status.** Listed as "Supported" in the request-types matrix but with a known gap: the request type doc says some operations are "Wire format defined; not yet implemented in mock" — see §5 for the explicit gate. **First task is to verify it actually returns a valid attestation in the mock pre-alpha.** If it doesn't, fall back to §6.
- **The pre-alpha mock signer is a single node.** Same caveat as our existing dWallet integration: judges should see the disclaimer once and forget it. README pattern stays the same.
- **`UserSecretKeyShare::Encrypted` is *user secret key share*, not arbitrary blob.** It is designed for dWallet user shares, not generic data encryption. Our SVES has to bend this to fit "Alice's viewing-share" — we deliberately do DKG **with Alice's viewing-key-derived seed as the user-side scalar contribution**, so the resulting share is cryptographically tied to her viewing key. This works because Ika's DKG accepts a user-supplied `centralized_public_key_share_and_proof` and `user_secret_key_share` — the user's input is not constrained to "must be a random scalar." See §3.2 for the precise binding.
- **Encryption-key compatibility.** Ika's `encryption_key` field in `UserSecretKeyShare::Encrypted` is opaque `Vec<u8>` from our perspective. What KEM does the Ika network actually expect? The pre-alpha docs don't enumerate. The first 30 minutes of implementation = read `crates/ika-dwallet-types/src/lib.rs` + the protocols-e2e example + write a fixture that round-trips the smallest possible `Encrypted` blob. If this is opaque/unspecified, fall back to §6.

---

## 2. Reality check: what Ika pre-alpha actually offers vs. what the old doc assumed

The old design doc (`docs/designs/2026-05-09-ika-encrypt-pivot-design.md`) made these specific claims about Encrypt. Each is graded against `dwallet-labs/ika-pre-alpha` HEAD `3bd7945e012950e54fb4d0057b72a7d466556fc1` and the upstream READMEs.

| Old doc claim | Reality | Verdict |
|---|---|---|
| "`encrypt-pinocchio` framework" exists analogous to `ika-dwallet-pinocchio` | **No such crate.** `chains/solana/program-sdk/` contains only `pinocchio`, `anchor`, `native`, `quasar` dWallet SDKs. There is no `encrypt-*` directory anywhere in the repo. | **STALE** |
| "`#[encrypt_fn]` macro" runs encrypted code via FHE matcher | **No such macro.** No proc-macro crate, no FHE primitives in the codebase. | **STALE** |
| "Encrypt's plaintext-stub mode means functional integration is achievable even if real FHE isn't" | The plaintext-stub mode is fictional — there is no Encrypt stub. | **STALE** |
| "Pre-alpha Encrypt: this runs as plaintext-on-chain stub today" | See above. | **STALE** |
| "Ika has a separate Encrypt product alongside dWallet" | The Ika website (`ika.xyz`) does discuss an encryption network at the marketing level. The pre-alpha SDK doesn't expose it. Public docs are very sparse. Reasonable inference: it's in alpha-1 or beyond. | **NOT YET SHIPPED** in any developer-accessible form |
| "Sealed-bid batch auction with FHE matcher" feasible in Phase 2 | Out of reach with pre-alpha tooling. Would require either (a) building an FHE library from scratch (not happening in 6–12h) or (b) waiting for Encrypt mainnet. | **OUT OF SCOPE** for hackathon |

**What pre-alpha *does* offer** that's relevant to "Encrypt":

| Primitive | What it does | SVES relevance |
|---|---|---|
| `UserSecretKeyShare::Encrypted` | DKG produces a dWallet whose user secret share is **encrypted to an arbitrary recipient encryption key** that the user controls | The encryption primitive UTXOpia can hook into |
| `ReEncryptShare` (`DWalletRequest::ReEncryptShare`) | The network re-encrypts an existing user share to a **new** encryption key without ever holding the plaintext | The grant-access operation our SVES needs |
| `MakeSharePublic` | Convert encrypted share → public share (one-way reveal) | Could be a "publish to public auditor" stretch feature; out of SVES scope |
| `dwallet_network_encryption_public_key` | The network's encryption key (NEK) — used to seal validator-side state | Not directly user-facing, but it's the proof Ika is built around encryption, not just signing |
| `FutureSign` / `SignWithPartialUserSig` | Two-step conditional signing — user pre-authorizes a partial sig, network only completes when an approval proof arrives | Adjacent to "encrypted commitment to a future action"; orthogonal to our SVES |

**Conclusion:** UTXOpia's path to genuine "Encrypt" integration on pre-alpha goes through the **encrypted user share + re-encryption** surface, not through a non-existent FHE matcher. That is what the SVES targets.

---

## 3. SVES implementation plan (8–10 hours)

### 3.1 What we ship

**One feature:** "Grant view access via Ika encrypted share" — an additional flow available to any UTXOpia user. Surfaces:

- **Web UI:** new "Sharing" tab in `/settings`, lets Alice select a grantee + scope + expiry and produces a Bob-decryptable share blob plus an on-chain grant.
- **SDK:** new `@utxopia/sdk` module `viewShare.ts` exporting `createEncryptedViewShare`, `reEncryptViewShareTo`, `unwrapEncryptedViewShare`, `verifyAttestation`.
- **On-chain program:** new instruction `grant_view_access` (discriminator 21) that creates a `view_grant` PDA bound to `(grantor, grantee_solana_pubkey, attestation_hash)`. New instruction `revoke_view_grant` (disc 22). No CPI to Ika program — the attestation hash is opaque from the program's view, the on-chain record is just a Bloom-filter-style allowlist for SDK-level enforcement.
- **Backend:** no changes required. (The watcher doesn't touch view shares.)
- **Demo line:** "UTXOpia also leans on Ika for the *encryption* side, not just signing. Here's Alice granting Bob view access — the share never leaves her device in plaintext; the Ika network performs the re-encryption."

### 3.2 The viewing-share binding (the tricky bit)

The naïve approach is "use Alice's Ed25519 viewing private key as the `user_secret_key_share` for an Ika DKG." This is conceptually clean but it requires Alice's viewing key to be **valid as an Ika dWallet curve scalar**, which it generally isn't (curve mismatch — Ed25519 vs the curve Alice would DKG on).

**Recommended binding (works around the mismatch):**

1. Generate a fresh **viewing-share scalar** `s = SHA256("UTXOpia view-share v1" || viewingPrivKey)`. This is a derived secret strictly dominated by `viewingPrivKey`. Anyone with `s` can scan Alice's stealth announcements **iff** we also publish enough metadata to reconstruct the X25519 ECDH path.
2. Run a one-time Ika DKG on `Curve25519` (or `Secp256k1` — see §3.4 trade-offs) where `s` is the user-side scalar contribution. The resulting dWallet `D_view` exists purely as a key custody vehicle — we never sign anything with it.
3. The dWallet's user secret share, sealed in `UserSecretKeyShare::Encrypted`, is now "Alice's viewing-share, wrapped by the Ika network for Alice's encryption key."
4. When Alice wants to grant Bob: call `ReEncryptShare { dwallet_public_key: D_view.pubkey, encryption_key: bob_enc_pubkey, ... }`. Network returns `EncryptedUserKeyShareAttestationV1 { encrypted_centralized_secret_share_and_proof, ... }` plus a NOA signature.
5. Bob decrypts using his encryption private key, recovers `s`, derives back `viewingPrivKey_for_scope` (see §3.3 on scoping).

**Why this works:** Ika's DKG is curve-agnostic over its four supported curves; the user controls the secret share input. We're not trying to use the dWallet for signing — we're using it as a **typed envelope** for "this is an encrypted-at-rest secret the Ika network can re-encrypt without ever decrypting."

**What this costs:** Alice does **one extra DKG round** on first-time setup ("Enable account sharing — this takes ~10 seconds"). That's the user-visible cost. The dWallet sticks around indefinitely; re-encryption is the lightweight operation she does at grant time.

### 3.3 Scoping (the "permissions" part of view delegation)

Today's `DelegatedViewKey` in `sdk/src/keys.ts:144` has `permissions: ViewPermissions` flags (`SCAN`, `HISTORY`, `INCOMING_ONLY`, `FULL`). These are honored only by SDK code, not cryptographically enforced.

**SVES does not improve this.** We carry the same permission flags onto the on-chain `view_grant` PDA's `scope` field. Bob's SDK respects them; the program rejects un-flagged scan attempts only as a backstop (announcements are public; nothing stops Bob from running his own scanner against Alice's MPK once he has `s`). True cryptographic scoping is **out of scope** — it would require splitting the viewing key into time-bucketed sub-keys, which is a 3-day project.

**What we get with on-chain scope flags:** auditable record of "Alice granted Bob SCAN+HISTORY for 30 days," enforced by the SDK and visible to Alice/Bob/any third party reading on-chain state. Same enforcement teeth as today's `expiresAt`, but **revocable on-chain** and **bound to Bob's solana pubkey, not a password Bob shared**.

### 3.4 Verification path (program-side)

Two options for what the `grant_view_access` instruction does on-chain with the Ika attestation:

**Option A — Trust-by-storage (recommended for SVES).** Store only the SHA-256 hash of the attestation in the `view_grant` PDA. No CPI to Ika program. Pro: simple, no extra accounts, ship-fast. Con: a malicious grantor could fabricate a hash; the SDK detects this when Bob tries to decrypt and fails, so the attack surface is "grantor fools their own grantee" which is uninteresting.

**Option B — On-chain verify (stretch).** CPI into a hypothetical Ika "verify-attestation" instruction. **Not currently available in the dWallet pre-alpha pinocchio SDK** — there is no `verify_attestation` discriminator. We'd have to write our own NOA-signature verifier (Ed25519, fairly cheap on Solana). Adds ~2 hours.

**SVES picks A.** B is a Phase 2 stretch.

### 3.5 Step-by-step, by commit

| # | Step | Files | Effort | Notes |
|---|------|-------|--------|-------|
| 1 | **Recon spike:** verify `ReEncryptShare` actually returns an attestation on `pre-alpha-dev-1.ika.ika-network.net:443`. Build the minimal gRPC call, hit it, log the response shape. | `scripts/encrypt-recon/probe-reencrypt.ts` (NEW) | **2h** | **GO/NO-GO gate.** If this fails, we drop to §6 fallback. |
| 2 | **SDK: `viewShare.ts` module.** `createEncryptedViewShare(viewingKey)` runs the one-time DKG against Ika devnet, persists the resulting `D_view` pubkey + Alice-encrypted-share blob. `reEncryptViewShareTo(d_view, bob_enc_pubkey)` calls `ReEncryptShare` and returns the Bob-blob + attestation. `unwrapEncryptedViewShare(bob_blob, bob_enc_privkey)` is Bob's side. Pure-TypeScript wrapping; uses the existing `@ika.xyz/pre-alpha-solana-client` package. | `sdk/src/viewShare.ts` (NEW), `sdk/src/index.ts` (EXPORT) | **2h** | Reuses BCS helpers from `scripts/ika-setup/` if present. |
| 3 | **On-chain: `grant_view_access` + `revoke_view_grant` instructions.** New discriminators 21, 22. New `view_grant` PDA seed `[b"view_grant", grantor.key().as_ref(), grantee.key().as_ref()]`. PDA stores `(grantor: Pubkey, grantee: Pubkey, expiry_slot: u64, scope: u8, attestation_hash: [u8;32], created_slot: u64)`. No CPI. **Requires program redeploy.** | `contracts/programs/utxopia/src/instructions/{grant_view_access,revoke_view_grant}.rs` (NEW), `lib.rs` (dispatch wire-in), `instructions/mod.rs` (re-export) | **2h** | Watch out: discriminators 21+22 — confirm not already taken; current README lists 0–20 with no gap. |
| 4 | **Web: settings → sharing tab.** Lists existing grants, "New grant" form (grantee solana pubkey + scope checkboxes + expiry days), copyable share-link generation, revoke buttons. | `web/src/app/settings/sharing/page.tsx` (NEW), `web/src/components/sharing/*` (NEW), wire into existing `web/src/app/settings/page.tsx` | **2h** | Stays consistent with current settings page styling (see `web/src/components/preferences-form.tsx`). |
| 5 | **Tests.** Unit: viewShare wrap/unwrap roundtrip with mocked Ika gRPC. Integration: grant + revoke on localnet (already covered by `scripts/e2e/run-all.ts` pattern). | `sdk/test/viewShare.test.ts` (NEW), `contracts/programs/utxopia/tests/grant_view_access.rs` (NEW LiteSVM test) | **1h** | If we have the Ika program SBF on hand (we do — see Phase 1 plan Task 0.3), the LiteSVM test pre-creates the dWallet account similar to existing patterns. |
| 6 | **README + DEMO.md updates.** Add a "UTXOpia uses Ika for both signing and **encryption**" framing paragraph. Add a 10-second tail to the demo script showing the sharing flow. | `README.md`, `docs/DEMO.md` | **30min** | Keep messaging honest — "encrypted-share primitive" not "FHE." |
| | **Total** | | **~9h 30min** | Fits the 6–12 hour window. |

### 3.6 Acceptance for SVES

- [ ] Alice (test wallet A) successfully runs the one-time DKG; her `D_view` dWallet exists on Ika devnet, owned by her Solana pubkey.
- [ ] Alice grants Bob (test wallet B). The on-chain `view_grant` PDA exists with the right grantor/grantee/scope/attestation hash. The Ika network attestation is logged in the SDK and matches the on-chain hash.
- [ ] Bob loads the share into his UTXOpia client. He successfully scans Alice's stealth announcements and sees her shielded note set.
- [ ] Alice calls `revoke_view_grant`. The PDA is closed. Bob's next scan attempt is denied at the SDK layer (the SDK fetches the PDA before scanning and refuses if missing).
- [ ] Demo recording shows the full grant + revoke flow plus the on-chain explorer view of the `view_grant` PDA and a callout to the attestation hash.

---

## 4. What Encrypt buys UTXOpia that the current crypto doesn't

(Required by the brief — this section is what tells the story to a judge.)

Current stack capabilities:

- **JoinSplit Groth16:** prove a valid private transfer happened without revealing amounts/parties
- **Stealth addresses (DKSAP):** unlinkable one-time recipient addresses
- **XOR-encrypted amounts in announcements:** lightweight per-note amount privacy from passive on-chain observers
- **AES-GCM password-encrypted viewing-key export (`serializeDelegatedViewKey`):** ad-hoc share-with-auditor flow

Gaps the existing stack **cannot close** without a new primitive:

1. **No revocable, third-party-bound view delegation.** Today, the moment Alice gives Bob her AES-GCM blob + password, Bob has unrevocable plaintext access. Revocation requires Alice to rotate her viewing key (which orphans her own scan history). An Ika-managed encrypted share + on-chain `view_grant` PDA gives revocation teeth.
2. **No on-chain audit of who-can-read-what.** Today, view delegations are entirely off-chain. An auditor's regulator can't verify "Bob had read access to Alice's history from slot X to slot Y" without trusting Alice's records. With on-chain grants, this is a trivial query.
3. **No "the encryption is performed by a committee, not by me locally."** All existing encryption in UTXOpia is symmetric or 1-of-1 keypair (XOR with ECDH shared secret, AES-GCM with password). There is no point in the system where a *neutral third party* (the Ika committee) holds the decryption authority. This matters for institutional adoption — institutions want "the protocol custodies the keys," not "the user has a JSON file on their laptop." The Ika encrypted-share construction gives that property.
4. **(Phase 2 stretch — explicitly out of scope for hackathon SVES, see §7):** No cross-user computation on shielded state. ZK proofs are per-user; you cannot match two users' encrypted bids without an MPC/FHE substrate. Encrypt-as-a-service product (when Ika ships it) closes this. The old design doc was right about *what* Encrypt would buy us; it was wrong about *whether* the SDK existed to build it on.

Adding the SVES closes **gaps 1, 2, and 3** in one feature. Gap 4 stays open until Ika ships an Encrypt SDK.

If you find any of these "redundant with what we have" — say so:

- **"But we already have viewing keys."** Yes, but they're shareable only as bearer secrets. The Ika-mediated share is bound to a grantee identity.
- **"But we already have AES-GCM export."** Yes, but the encryption authority is "whoever knows the password." The Ika-mediated share has a defined cryptographic owner (Ika's NEK, transitioning to Bob's pubkey).
- **"But the 3-key model already supports view delegation."** Architecturally yes; cryptographically with no revocation. The SVES adds the revocation and audit primitives without breaking the 3-key model.

If after building the SVES we find users don't actually care about revocable view-grants — that's a product learning, and the SVES still serves the "we hit the Encrypt track" purpose for hackathon judging.

---

## 5. Risks and unknowns

### 5.1 Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `ReEncryptShare` mock signer is non-functional (see request-types.md note: some operations "Wire format defined; not yet implemented in mock"). | **Medium** | High (kills SVES) | §6 fallback: ship the static-NEK + program-attested unwrap variant instead. Decision gate at end of Step 1. |
| `UserSecretKeyShare::Encrypted`'s `encryption_key` format is opaque/unspecified — no docs on KEM. | Medium | Medium | Resolve via codebase grep on Step 1; if unresolvable in 2h, fall back. |
| Ika devnet wipe mid-build: existing dWallet `DmZfRVeZHnFZ1ARVHRPJn88VCcJB2QhXLmSe8RuzFMfq` gets reset, our `D_view` test dWallets disappear. | High | Low | Idempotent setup script `scripts/encrypt-recon/setup-test-dwallets.ts` re-runs DKG on demand. Same pattern as `scripts/ika-setup/`. |
| Pre-alpha mock signer same as our existing dWallet — judges might double-count the disclaimer as a negative. | Low | Low | One line in README, one line in demo voiceover. Already established this is fine for Phase 1. |
| New on-chain instructions (21, 22) require a program redeploy on devnet, breaking continuity with the current `G1bj9Vw9...3ixUy` deployment. | Medium | Medium | Acceptable — we already redeployed for Ika. Demo recording captures the new program ID. README updates the deployed-addresses table. |
| Bob's web client needs a UTXOpia install just to decrypt — UX friction for the "send to your accountant" scenario. | High | Low | Out-of-scope for SVES. Phase 2 could ship a CLI-decrypt tool. For the demo, both Alice and Bob use the same web client with different wallets. |
| Discriminator collision: instructions 21/22 may overlap with future planned ones. | Low | Low | Reserve 21–22 today. Confirm `instructions/mod.rs` map is clear of 21/22 before committing Step 3. |

### 5.2 Unknowns to resolve in the recon spike (Step 1)

- [ ] Can a fresh client call `DWalletRequest::ReEncryptShare` against `pre-alpha-dev-1.ika.ika-network.net:443` and receive a non-error `TransactionResponseData::Attestation`?
- [ ] What format is `encryption_key`? (X25519 pubkey? secp256k1 ECIES pubkey? something Ika-specific?)
- [ ] Is `EncryptedUserKeyShareAttestationV1.encrypted_centralized_secret_share_and_proof` self-describing enough that a TS client can extract `iv` / `ciphertext` / `auth_tag` and decrypt with a standard AEAD?
- [ ] Latency of `ReEncryptShare` round-trip on pre-alpha-dev-1 — affects whether grant creation is a "loading spinner for 2s" or "loading spinner for 30s." User wait at grant time only; reads are unaffected.

If any of these are unresolvable, the SVES exits to §6.

### 5.3 Backstops we already have

- **Ika watcher precedent.** The fact that `backend/src/redemption/signer.rs::IkaSigner` already exists and works against the mock signer for `approve_message` means the gRPC client wiring + BCS serde + attestation parsing is **all present in the codebase**. The SVES does not need a from-scratch gRPC client; it borrows the same plumbing.
- **`scripts/ika-setup/` precedent.** The DKG-against-devnet pattern is established. The SVES re-runs that with an Encrypted user share variant rather than a Public one.
- **Pinocchio 0.9 vs 0.10 mismatch is solved.** We already hand-built the dWallet CPI. The SVES doesn't need any new CPI (Option A) so we avoid the Pinocchio version issue entirely.

---

## 6. Fallback SVES if the recon spike fails

If Step 1 reveals `ReEncryptShare` is non-functional or its blob format is too opaque to roundtrip in the time budget, drop to this 4-hour variant.

**Idea:** "Static-NEK + Program-Attested Unwrap" — encrypt Alice's view-share to **Ika's network encryption key** (NEK) directly using a standard `nacl.secretbox` or libsodium primitive, and have our UTXOpia program emit an "this grantee may decrypt" instruction. The actual decrypt is performed by a **backend service** that holds the NEK private key (which today we don't have, but pre-alpha lets us fake by using a deterministic test key).

This is **not** real Encrypt integration. It's Encrypt-shaped using only dWallet primitives + a backend service. The honest demo framing is: "Here's the user flow Ika's `ReEncryptShare` will power once it's live on pre-alpha. Today, we route it through our backend because the network operation isn't ready yet."

**Steps:**

1. SDK: `createPlainEncryptedViewShare(viewingKey, granteePubkey)` — X25519 ECDH + AES-GCM, output a blob.
2. On-chain: same `grant_view_access` / `revoke_view_grant` instructions as SVES Step 3. The "attestation hash" field stores the SHA-256 of the AES-GCM blob.
3. Backend: nothing changes. (No real decryption service is built; the user does the decrypt locally.)
4. Web UI: same.
5. README + DEMO: explicitly frame as "encryption-track architecture, dWallet-mediated implementation pending Encrypt live-on-pre-alpha."

**Honest cost:** judges will probably mark this as "Ika dWallet + AES-GCM" rather than "true Encrypt." That's fine — it's still more Encrypt-track than today (which is 0%), and the architectural delta to the real version is one swap of `nacl.secretbox` → `ReEncryptShare` in the SDK.

**Effort:** ~4 hours total.

---

## 7. Explicitly out of scope

These are tempting but don't fit the time budget. Tag them "Phase 2 — post-pre-alpha":

1. **Encrypt-based notes / encrypted commitment payloads.** Would require an Encrypt SDK we don't have. Phase 2.
2. **Multi-recipient encrypted view-shares.** SVES is 1:1 (Alice → Bob). 1:N requires either repeated `ReEncryptShare` calls or a true broadcast-encryption primitive. Phase 2.
3. **Encrypted-bid batch auction (the old design doc's Phase 2).** Requires Encrypt-as-FHE. Out of reach until Ika ships Encrypt mainnet.
4. **Encrypted note backup via committee recovery.** "Forgot your seed? The Ika committee can re-derive your viewing share." Plausible with `ReEncryptShare` + `MakeSharePublic`, but the user-facing flow + key management is a 2-day project on its own.
5. **Compliance escrow (court-order-gated decryption).** Interesting but politically loaded; not the demo we want to lead with. Phase 2 if a regulated venue actually requests it.
6. **Relayer-routing hints encrypted to the relayer.** Tempting because we have a relayer (`backend/src/relayer` adjacent). But the relayer already sees only commitments + nullifiers, never amounts or recipients; nothing to "hide better" from it. Skip.
7. **Encrypted claim-link payloads where the recipient identity is committee-gated.** This is what would let an unsigned-up recipient be onboarded by clicking a link and proving an off-chain identity (email, OAuth) to the committee. Genuinely powerful but a 1-week project. Phase 2.
8. **`FutureSign` integration for conditional redemptions** (e.g. "this redemption is pre-authorized but only finalizes if KYT check passes"). Adjacent to encryption, more on the signing side. Out of scope.
9. **On-chain attestation verification (SVES §3.4 Option B).** Cute but adds 2h for marginal demo value. Add to Phase 2.
10. **Cryptographic permission scoping** (sub-keys per permission flag). Real fix to the SDK-only enforcement model. Multi-week project; Phase 2.

---

## 8. Comparison: SVES vs. doing nothing

| Dimension | Status quo (Ika only) | After SVES |
|---|---|---|
| Hackathon Criterion #1 ("Core integration of Ika **and/or** Encrypt") | Ika: A. Encrypt: F. Net: passes with "or" loophole. | Ika: A. Encrypt: B-. Net: passes "and" cleanly. |
| Demo runtime addition | 60s baseline | ~75s (+15s for sharing flow) |
| Production-ready surface | dWallet signing only | dWallet signing + dWallet encrypted-share-as-a-feature |
| Code added | — | ~600 LOC (SDK + program + web + tests) |
| Risk of breakage | Stable | Medium during build; stable post-merge |
| Talking points for "what's next" | "Multi-chain Ika" | "Multi-chain Ika + Encrypt-product as a swap-in for our re-encryption call once it ships" |

---

## 9. The honest exit: if neither SVES nor fallback ship in time

If — after the recon spike + 2 hours of attempted fallback — neither path ships, the right move is to **not fake an integration**. Instead:

1. **Land this scoping doc itself** as the "we understand Encrypt, here's our Phase 2 plan" deliverable. Reference it from the README under a new "Roadmap → Encrypt integration" section.
2. **Update DEMO.md** to add ~10 seconds at the end pointing at the doc and saying "the next layer beyond dWallet custody is encrypted view delegation — design fully scoped, implementation pending Ika Encrypt live on pre-alpha."
3. **Submit on the strength of the Ika dWallet integration** (which is genuinely good) plus a credible Encrypt roadmap (which is in the same repo, written down, with measured estimates and known unknowns).

This is more credible to a thoughtful judge than a half-mocked Encrypt feature that doesn't actually work when they click it. The hackathon track says "and/or" — leaning hard on the "or" with a written design for the "and" beats vapor implementation.

---

## 10. Open questions for the implementer (not blocking)

- Should the `view_grant` PDA carry a `note_set_hint` field (e.g. only notes with `created_slot < grant.created_slot` are scannable)? Probably no for SVES — adds complexity, doesn't change the demo. Phase 2.
- Should `revoke_view_grant` be a permissionless instruction with a 24h timelock (so Alice can pre-announce intent to revoke and Bob can finish a pending audit)? Probably no — instant revocation is the more credible privacy story.
- Should we expose the `D_view` dWallet as a top-level account in the web UI, or keep it hidden behind the "Sharing" tab? Hidden is cleaner. Power users can inspect via Solana Explorer.
- Should grants be one-shot (single-use) or open-ended? SVES says open-ended with `expiry_slot` + revoke. One-shot adds nullifier-style accounting; not worth it.
- Should we publish the encrypted share blob to a public location (Arweave / Filecoin / IPFS) referenced by the grant PDA, or just send the blob to Bob out-of-band? Out-of-band is simpler. The PDA only needs the hash for verification. Don't conflate the SVES with a storage solution.

---

## 11. References

- `docs/designs/2026-05-09-ika-encrypt-pivot-design.md` — predecessor (largely stale, see §0)
- `docs/recon/2026-05-09-ika-sdk-brief.md` — Ika CPI surface (still current; SVES does not add new CPIs)
- `docs/MIGRATION_v1_to_v2.md` — FROST → Ika story (unchanged)
- `docs/plans/2026-05-09-ika-phase1-implementation-plan.md` — Phase 1 plan (shipped)
- `sdk/src/keys.ts` — current 3-key model + `DelegatedViewKey` (the thing we're upgrading)
- `sdk/src/stealth.ts` — DKSAP / EIP-5564 stealth address derivation (unchanged)
- `sdk/src/bitcoin/ika.ts` — existing dWallet P2TR helper (model for new `viewShare.ts`)
- `contracts/programs/utxopia/src/cpi/ika.rs` — existing CPI helper (model for any future Encrypt CPI; not needed for SVES)
- Upstream:
  - `/tmp/ika-pre-alpha-scratch/ika-pre-alpha/README.md` — confirms dWallet-only scope
  - `/tmp/ika-pre-alpha-scratch/ika-pre-alpha/docs/src/grpc/request-types.md` — full `DWalletRequest` enum incl. `ReEncryptShare`
  - `/tmp/ika-pre-alpha-scratch/ika-pre-alpha/crates/ika-dwallet-types/src/lib.rs` — type definitions for encrypted user share

---

## Summary card (one screen)

- **SVES:** Ika-mediated encrypted viewing-key share with on-chain revocable grants
- **What's encrypted, by whom, decryptable by whom:** Alice's viewing-share, sealed by Ika network's encryption protocol, re-encryptable to Bob's pubkey
- **Time:** ~9.5h focused work (fits 6–12h budget)
- **Blockers found:** Encrypt-as-a-product does NOT exist in pre-alpha — we use dWallet's `UserSecretKeyShare::Encrypted` + `ReEncryptShare` as the actual primitives
- **Gate:** 2h recon spike on `ReEncryptShare` mock status — if it fails, drop to §6 fallback (4h, AES-GCM-shaped, less rigorous but ships)
- **If both fail:** §9 honest exit — land this doc, frame as "Encrypt roadmap," ship on Ika strength
- **Demo addition:** +15 seconds to the existing 60s — "UTXOpia also leans on Ika for encryption, not just signing"
- **Out of scope:** the old design doc's Phase 2 confidential_swap — that needs `encrypt-pinocchio` which doesn't exist
