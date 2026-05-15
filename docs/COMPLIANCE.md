# UTXOpia Compliance Architecture

**Document audience**: CEX integrations · screener partners · regulators · institutional users
**Status**: pre-mainnet, design + primitive surface stabilized
**Last updated**: 2026-05-15

---

## Executive summary

UTXOpia is a Solana-native shielded-pool protocol that ships **compliance primitives as first-class infrastructure**, not as a bolt-on. The core design philosophy:

> **Privacy by default. Disclosure when warranted. Boundary screening at the exits.**

The protocol intentionally **does not** decide who is sanctioned, whose deposits are dirty, or which transactions to reject. Those judgments belong to licensed third-party screeners and regulated exit venues (CEXes). UTXOpia provides:

1. The on-chain primitives those parties need to express their decisions
2. The privacy guarantees honest users need to transact without surveillance
3. A clear cryptographic boundary between what the protocol enforces and what humans/services decide

This document is the canonical reference for compliance officers, screener partners, CEX integration teams, and regulators evaluating the system.

---

## 1. Trust model

| Party | What they trust | Why |
|---|---|---|
| **End user** | The cryptography (Groth16, Poseidon, Baby Jubjub, XChaCha20-Poly1305) and the published source code | These are protocol invariants — operator can't unilaterally weaken them without leaving on-chain evidence |
| **Auditor / regulator** | The user's voluntary disclosure (or the user being compelled by law to disclose) — never the protocol | Selective-disclosure tools are honor-system, enforced by legal regime, not by software backdoor |
| **CEX accepting an exit** | A screener's signed attestation that the user's funds trace to a clean origin | This is a normal third-party-vendor trust decision (the same one CEXes already make for Chainalysis / TRM / Elliptic) |
| **Screener** | Their own off-chain analysis pipeline (Chainalysis API, in-house heuristics, OFAC list) and the published on-chain origin events | Public on-chain primitives are the input; their signature is the output |
| **Protocol operator** | Nothing privileged in steady state | The operator can update admin-controlled state (screener registry, pool params via timelock, association root) but cannot read user balances, decrypt notes, or unilaterally move funds |

No party in this list trusts every other party. The cryptography enforces the protocol; legal regimes enforce the disclosure expectations; commercial contracts enforce screener / CEX behavior. **No backdoors.**

---

## 2. Compliance layers (in order of UX prominence)

### Layer 1 (default, invisible to user) — Passive attestation

**Purpose**: a CEX wants to know "did the funds the user is unshielding originate from a clean source?" without the user manually proving anything.

**How it works**:

```
1. User deposits BTC (or shields any Solana token).
   Chain emits EVENT_BTC_ORIGIN_ATTESTATION (or EVENT_SHIELD_META),
   linking the resulting commitment to the public-side origin.

2. Backend screener service (e.g. Chainalysis adapter) watches the
   event stream, runs analysis on the origin, and submits a signed
   attestation on-chain via a `attest_origin` instruction (see §5).

3. Anyone (CEX, auditor, the user themselves) can query:
   "Has commitment X been attested clean by a registered screener?"
   → yes / no / pending

4. User unshields normally — no extra clicks, no ZK proof, no extra tx.
   CEX checks the attestation status before crediting.
```

**Key property**: the user never sees a compliance dialog. The CEX never asks the user for proof — they query the chain. This is the **TradFi-equivalent UX**: AML happens in the back office, invisibly.

**Screener registry**: maintained by the protocol's compliance authority. Multiple screeners can register (Chainalysis, TRM Labs, in-house, etc.). CEXes decide off-chain which screeners they trust. Registry supports time-bound authorization (a screener's pubkey can have an expiration slot) and emergency revocation.

### Layer 2 (on warrant / user-initiated) — Delegated View Key

**Purpose**: a regulator with a warrant, or a user voluntarily disclosing to their accountant, gets read-only access to a specific user's transaction history.

**Mechanism** — `DelegatedViewKey` v2 (Phase 1, shipped):

- The user issues a viewing key scoped to a specific slot range (e.g. tax year 2026)
- The key contains the viewing private key (Ed25519), the spending public key, and the nullifying key — enough to decrypt incoming announcements + recompute the user's nullifiers
- **The spending private key is never disclosed** — the auditor can read every IN and OUT record, but cannot move funds
- Encryption at rest: PBKDF2 (600k iterations) + AES-GCM
- Audit trail: `~/.utxopia/delegations.json` (or browser localStorage) records every issuance with a fingerprint

**Auditor workflow**: paste the encrypted key + password into the `/audit` page (or `scripts/auditor/scan.ts`); decrypt client-side; receive a CSV with IN/OUT records over the chosen slot range.

**Limits** (be honest about these):
- Sender memos (Phase 2, the OUT half of audit) are only present for transactions after Phase 2 deployment
- The auditor sees this user's incoming/outgoing **amounts**, but cannot trivially identify the *other party* in a private transfer — that side of the audit needs the counterparty's cooperation or their own viewing key
- An `INCOMING_ONLY` permission bit suppresses OUT records (useful for limited disclosures)

---

## 3. Sanctions screening — who decides

**The protocol does not perform sanctions screening.** It cannot determine whether a Bitcoin address is on the OFAC SDN list, whether a transaction passes Travel Rule thresholds, or whether a user is a politically exposed person. These judgments require:

- Access to constantly-updated sanctions lists
- Heuristic analysis of address graphs
- Jurisdictional interpretation of regulatory boundaries
- Legal accountability for the screening decision

All four are the proper domain of **licensed third-party screeners** — Chainalysis, TRM Labs, Elliptic — and of the **regulated venues** (CEXes, OTC desks) that accept the protocol's exits.

What the protocol provides to support those decisions:

1. **Public origin attestations** on every deposit (`EVENT_BTC_ORIGIN_ATTESTATION`, disc 0x15) — the BTC txid + sweep vout + commitment + amount, so anyone can independently screen the source
2. **Screener registry + attestation primitive** — so registered screeners can sign their decisions on-chain
3. **Cryptographic enforcement** that without a valid attestation, certain exits will be refused by integrating CEXes
4. **Selective disclosure tools** so when AML investigators have legal grounds, they get actual evidence (the user's transaction history), not just plausible-deniability denials

What the protocol explicitly does **not** do:

- Maintain its own sanctions list
- Block deposits based on guessed-bad origins (this would be acting as a regulated financial-service provider, which the protocol's legal framing avoids)
- Surveil users in the absence of warrant or voluntary disclosure
- Provide any backdoor read access to operator, ourselves, or any single party

---

## 4. Asset coverage

UTXOpia supports three asset categories, all sharing one shielded pool and one anonymity set:

### 4.1 Solana-native tokens (live)

Any SPL token or Token-2022 token can be shielded via the `shield` instruction (disc 12) and withdrawn via `unshield` (disc 14). Includes USDC, USDT, SOL, BONK, and any token an operator registers in the on-chain token registry.

### 4.2 UTXO assets — Bitcoin (live)

BTC enters via a Taproot deposit address derived from the user's stealth meta-address and the pool's group public key. The deposit is verified on-chain via SPV against the BTC light-client program. Custody is held by an Ika dWallet (2PC-MPC) whose authority is a PDA owned by the UTXOpia program — there is no off-chain signing committee. Outflow is via `redeem` (disc 15) which gates the dWallet's Schnorr signature behind an on-chain policy check (destination, amount caps, paused state).

### 4.3 UTXO assets — other (roadmap)

DOGE, LTC, and BCH share the BTC architecture (PoW UTXO chains, Bitcoin-derived consensus rules). Each requires its own light-client program, its own Ika dWallet DKG, and a per-chain origin attestation event. The protocol-level work (shielded pool, transact circuit, DVK, sender memos) is asset-agnostic and requires no per-chain changes.

---

## 5. On-chain primitives (instruction surface)

This section is the canonical reference for integrating teams.

### 5.1 User-facing instructions

| Disc | Name | Purpose |
|---|---|---|
| 11 | `verify_stealth_deposit` | SPV-verify a confirmed BTC deposit and insert the commitment into the JoinSplit tree |
| 12 | `shield` | Deposit any SPL/Token-2022 token into the shielded pool |
| 13 | `transact` | Private N-to-M JoinSplit transfer (the core privacy primitive) |
| 14 | `unshield` | Withdraw shielded tokens back to a public Solana token account |
| 15 | `redeem` | Atomic JoinSplit + BTC withdrawal (triggers Ika signature via on-chain policy) |

### 5.2 Compliance instructions

| Disc | Name | Purpose |
|---|---|---|
| *27 (planned)* | `register_screener` | Admin: register a screener pubkey in the on-chain registry |
| *28 (planned)* | `revoke_screener` | Admin: revoke a screener |
| *29 (planned)* | `attest_origin` | Anyone (signed by registered screener): submit a per-commitment passive attestation |

Discriminators 21–23 (clear / hidden PoI + association-root admin) and 26 (`transact_with_poi`) were previously reserved for on-chain Proof of Innocence variants. They have been removed in favor of passive attestation, which addresses the same compliance need without per-variant trusted-setup overhead or browser-side proving cost.

### 5.3 Event surface (consumed by indexers, CEXes, auditors)

| Disc | Name | Carries |
|---|---|---|
| 0x03 | `EVENT_STEALTH_ANNOUNCEMENT` | Stealth deposit / transfer announcements (encrypted to recipient viewing key) |
| 0x0D | `EVENT_DEPOSIT_VERIFIED` | BTC deposit SPV-verified |
| 0x12 | `EVENT_SENDER_MEMO` | Outgoing audit memo (Phase 2; encrypted under sender's ovk) |
| 0x15 | `EVENT_BTC_ORIGIN_ATTESTATION` | **Critical for compliance**: BTC origin data published on every deposit |
| *0x18 (planned)* | `EVENT_ORIGIN_SCREENED` | Passive attestation event (verdict + screener pubkey) |

Discriminators 0x13, 0x14, and 0x16 were previously reserved for `EVENT_ASSOCIATION_ROOT_UPDATED` and the two `EVENT_POI_*` events. They are no longer emitted; see §5.2.

---

## 6. Threat model — what each role can see

| Role | Can see | Cannot see |
|---|---|---|
| Public chain observer | All events, all nullifiers, all commitments (encrypted) | Linkage of commitments to user identities |
| Screener (registered) | Same as observer + their own attestation decisions; the deposit-to-commitment map via public event 0x15 | Internal transfer graph; user-to-commitment ownership beyond first hop |
| Auditor (with DelegatedViewKey) | The specific user's IN/OUT history over the scoped slot range | Anyone else's history; this user's history outside scope; ability to spend |
| CEX (queries attestation status) | "Is commitment X attested?" yes/no; the user's deposit address (it's public when they unshield) | The user's transaction graph; balance |
| Protocol operator | Same as public chain observer; admin authority over screener registry, pool params (via 48h timelock), association root | User balances; ability to read decrypt notes; ability to forge attestations |
| Auditor without DelegatedViewKey | Public chain only | Specific user's activity |

The cryptography enforces these boundaries. None of them can be relaxed by the operator alone.

---

## 7. What dirty money cannot do

A user with funds from a sanctioned origin **can** deposit them into the shielded pool — the protocol does not enforce origin restrictions at entry (intentional: the protocol is not a financial-service provider). However:

1. **The deposit emits an origin attestation publicly.** Any screener watching can flag the resulting commitment.
2. **Without a valid screener attestation, exits to compliant CEXes will be refused** by the CEX's integration kit.
3. **The shielded pool's `nullifier` set prevents double-spending.** Once the dirty funds are spent in a transact, the resulting output commitments inherit the same compliance status: an unscreened or flagged origin remains unscreened or flagged for every downstream commitment that traces back to it.

**Net effect**: dirty money can enter the pool but cannot leave it through a compliant exit. It can be used for internal private transfers among users who accept it, but the protocol-mediated exit path is gated.

This is structurally similar to how regulated financial systems handle suspicious cash deposits: the cash physically enters the bank's till but cannot be moved into the regulated banking ledger without satisfying source-of-funds requirements.

---

## 8. Travel Rule, FATF, and cross-jurisdiction considerations

The Financial Action Task Force's Travel Rule requires Virtual Asset Service Providers (VASPs) to transmit originator/beneficiary information for transactions above defined thresholds. UTXOpia itself is not a VASP — it is non-custodial infrastructure. However, integrating CEXes (which are VASPs) must satisfy Travel Rule obligations for the exit transaction.

The protocol's design supports this:

- The user's unshield destination address (public Solana / BTC address) is visible to the CEX
- The CEX collects user KYC under their own program
- The screener attestation provides the source-of-funds documentation
- For VASP-to-VASP transactions, the CEX can use existing Travel Rule networks (TRP, Notabene, etc.) — the protocol does not need to be Travel Rule–native

Jurisdictional notes:

- **United States**: protocol operator likely needs to register as an MSB or operate from a non-US jurisdiction; integrating CEXes are responsible for their own BSA/AML compliance
- **EU (MiCA)**: protocol's non-custodial nature places it in the unregulated zone; integrating CEXes operate under MiCA's CASP regime
- **Asia**: jurisdiction-dependent; Singapore (MAS PSA) and Hong Kong (SFC) regimes are most directly relevant

This document does not constitute legal advice. Integrating venues should obtain their own legal opinion before launching.

---

## 9. How to integrate

### 9.1 For a CEX accepting UTXOpia exits

1. **Subscribe to the chain event stream** — index `EVENT_BTC_ORIGIN_ATTESTATION` (live) and `EVENT_ORIGIN_SCREENED` (planned, the passive-attestation verdict event).
2. **Maintain a local map** `commitment → attestation_status`.
3. **Configure your accepted screener set** — list of screener pubkeys you trust (e.g. `[chainalysis, trm-labs]`).
4. **On unshield request**: check the commitment's attestation status against your accepted set. If attested clean by an acceptable screener within the freshness window, credit. Otherwise queue for review or reject.
5. **For deeper investigations**: request a `DelegatedViewKey` from the user (your KYC paper trail makes this enforceable).

SDK helper (planned):
```typescript
const status = await utxopiaSDK.checkAttestation({
  commitment: '0x...',
  acceptedScreeners: ['chainalysis', 'trm-labs'],
  maxAgeSecs: 86400 * 7,
});
// status === 'attested-clean' | 'flagged' | 'pending' | 'not-screened'
```

### 9.2 For a screener (e.g. Chainalysis, TRM Labs, in-house compliance)

1. **Register your pubkey** with the protocol's compliance authority (one-time admin tx).
2. **Run a daemon** that:
   - Subscribes to `EVENT_BTC_ORIGIN_ATTESTATION` and `EVENT_SHIELD_META`
   - Runs your screening API on each origin
   - Submits `attest_origin(commitment, verdict, signature)` (planned disc 29) with your signature
3. **Publish your screening policy** (what you flag, refresh cadence, dispute process) at your `metadata_uri` registered in the on-chain ScreenerRegistry.

### 9.3 For an auditor (tax / regulatory)

1. **Obtain a DelegatedViewKey** from the user — either voluntarily disclosed or warrant-compelled.
2. **Use the `/audit` web page** (or `scripts/auditor/scan.ts`) to decrypt and scan.
3. **Receive a CSV** with IN/OUT records over the scoped slot range. Cross-reference with the user's other financial records.

### 9.4 For an institutional user (corporate treasury, fund)

1. **Register an SNS subdomain** (`.btcpro.sol`) for your entity.
2. **Set the `AUDITOR_DISCLOSABLE` compliance flag** + your designated auditor's Solana pubkey on the SNS record (Settings page).
3. **Issue a slot-scoped DelegatedViewKey** to your auditor for ongoing reporting (e.g. monthly).
4. **Document your internal compliance policy** referencing the screener attestations and the audit trail your wallet maintains.

---

## 10. Known limitations & roadmap

We are committed to honest disclosure of what the system does *not* yet do:

- **Multi-hop lineage** is not shipped. Passive attestations cover direct deposit origins, not transitively through private transfers. If multi-hop is required for your use case, contact us — we have an internal design sketch but are not building it speculatively.
- **Multi-screener attestation** (N-of-M trust) is on the roadmap; the planned registry supports multiple screeners but CEXes will integrate against individual ones at launch.
- **Solana-native shield origin attestation** — analogous to `EVENT_BTC_ORIGIN_ATTESTATION` but for `shield` instead of BTC deposits — is on the roadmap. Today shield events carry amount/token/recipient but not the funder identity in a screener-friendly format.
- **Live mainnet** — the protocol has been deployed to Solana devnet (program ID `G1bj9Vw9ipZ2Z7zKa9HrcHHPNqeWjg7uu51TsDr3ixUy`); mainnet deployment is pending security audit completion.

---

## 11. Documents you may also want

- `docs/TECHNICAL.md` — Full protocol cryptographic specification
- `docs/ARCHITECTURE.md` — System architecture, including the Layer-3 (off-chain audit service) abstraction
- `docs/RUNNING.md` — Operational guide for running the protocol stack
- `sdk/docs/SDK.md` — SDK API reference for integrating teams

---

## Contact

- For CEX integration discussions: [tbd@utxopia.example]
- For screener partnership inquiries: [tbd@utxopia.example]
- For regulatory engagement: [tbd@utxopia.example]
- For security disclosures: [security@utxopia.example]

This document is maintained under version control; the latest authoritative version lives in this repository.
