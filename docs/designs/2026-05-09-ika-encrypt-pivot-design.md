# Privacy Coin v2 — Ika + Encrypt Pivot

**Status:** Draft
**Date:** 2026-05-09
**Branch:** `ika`
**Hackathon track:** Encrypt + Ika (Bridgeless + Encrypted Capital Markets)

## Problem

Solana already has one credible privacy player: Umbra Privacy (mainnet, zkSNARKs + Arcium MPC, Solana-SPL-only). What Solana does **not** have is confidential settlement for **native non-Solana assets** like Bitcoin: held without bridges, traded without leaking flow. Existing BTC-on-Solana paths require a custodial bridge or an off-chain signer committee (Privacy Coin v1 used FROST — a multi-party signer, but operationally heavy).

## Product

**Privacy Coin v2** — a confidential settlement layer on Solana for native Bitcoin, with an architecture that extends to any Ika-supported chain.

- Native BTC custodied directly by **Ika dWallets**, governed by Solana program logic. No bridge, no relayer, no FROST committee. The architecture is chain-agnostic — adding ETH/SUI later is a config change, not a redesign — but this hackathon submission ships BTC only.
- Once on-chain, BTC becomes a shielded commitment via the existing JoinSplit ZK system. Per-user transfers stay private with Groth16 proofs (already shipped).
- Cross-user activity — specifically, swaps between shielded zkBTC and shielded USDC — runs through an **Encrypt-powered sealed-bid batch auction**. Bids stay encrypted; only the per-user fill amounts decrypt.

One-line pitch: *"Umbra showed Solana wants confidential transfers. We extend it to native BTC — custodied by Ika, matched on encrypted state."*

## Why this wins the hackathon

1. **Hits both Ika and Encrypt tracks substantively, not superficially.** Ika replaces an entire production subsystem (FROST). Encrypt enables a feature ZK fundamentally cannot: cross-user matching on secret state.
2. **Defensible vs Umbra.** Umbra is Solana-SPL only. Native BTC custody via Ika is a category Umbra doesn't address — and the architecture is multi-chain-ready even though we ship BTC only for the hackathon.
3. **Production-feasible.** Phase 1 deletes more code than it writes (FROST → Ika). Phase 2 adds one new program (`confidential_swap`) using `encrypt-pinocchio`, which matches the project's existing Pinocchio stack — no Anchor migration.
4. **Graceful degradation.** Phase 1 alone is a complete demoable submission: BTC privacy bridge with Ika-custodied dWallets. If Encrypt's pre-alpha backend bites us, we still ship.
5. **Demo narrative is one screen.** Deposit BTC → custody by Ika dWallet (visibly, on-chain) → balance becomes a shielded commitment → swap to shielded USDC via sealed-bid batch → withdraw to BTC.

## Architecture (target)

```
┌──────────────────┐     ┌──────────────────────┐     ┌──────────────────────┐
│  Bitcoin         │     │   Ika dWallet        │     │  Solana program      │
│  (native chain)  │◄───►│   (2PC-MPC user +    │◄───►│  privacy-coin        │
│                  │     │    Ika network)      │     │  (Pinocchio)         │
└──────────────────┘     └──────────────────────┘     └─────────┬────────────┘
                                                                │
                                                                │ commitment
                                                                ▼
                                                      ┌──────────────────────┐
                                                      │  Shared Merkle Tree  │
                                                      │  (Poseidon, depth 16)│
                                                      └─────────┬────────────┘
                                                                │
                       ┌────────────────────────────────────────┴────────────┐
                       │                                                     │
              ┌────────▼─────────────┐                          ┌────────────▼─────────┐
              │ JoinSplit transact   │                          │ confidential_swap    │
              │ (Groth16, per-user)  │                          │ (Encrypt FHE matcher)│
              │ -- existing --       │                          │ -- new --            │
              └──────────────────────┘                          └──────────────────────┘
```

Privacy boundaries:
- **Per-user transfer privacy**: existing JoinSplit (Groth16). Unchanged.
- **Custody privacy + sovereignty**: Ika dWallets — no FROST committee operators to trust or run.
- **Cross-user matching privacy**: Encrypt FHE — the only piece truly impossible without FHE/MPC.

## Ika Solana integration — concrete

Ika's Solana-native pre-alpha exists at `dwallet-labs/ika-pre-alpha`. Devnet program ID: `87W54kGYFQ1rgWqMeu4XTPHWXWmXSQCcjm8vCTfiq1oY`. dWallet gRPC: `pre-alpha-dev-1.ika.ika-network.net:443` (pre-alpha mock signer; same shape as Encrypt's plaintext stub). The integration crate is `ika-dwallet-pinocchio` — direct CPI from our existing Pinocchio program. **No Node IPC bridge, no Sui sidecar, no off-chain orchestration of signing.** The Privacy Coin program CPIs `approve_message(...)` (discriminator 8) into the Ika program when redemption is fully validated; an off-chain watcher polls the resulting Sign session and broadcasts the assembled BTC tx.

## Component-by-component changes

| Component | Action | Notes |
|---|---|---|
| `frost_server/` | **Delete** | Ika dWallets supersede. Single biggest code deletion. |
| `contracts/programs/btc-light-client/` | **Keep** | Belt-and-suspenders. Solana still SPV-verifies BTC deposits even if Ika-custodied. Future: can be removed if Ika provides verified deposit attestation. |
| `circuits/` (JoinSplit) | **Keep, unchanged** | Ships as-is. |
| `contracts/programs/privacy-coin/` | **Modify** | Add `ika-dwallet-pinocchio` git dep. `complete_redemption` CPIs `DWalletContext::approve_message` with the BTC sighash. CPI authority PDA derives from `[CPI_AUTHORITY_SEED]`. The pool's Ika dWallet authority is set to this PDA at pool init time. Add `confidential_swap_settle` instruction in Phase 2. |
| `contracts/programs/confidential_swap/` | **NEW (Phase 2)** | Encrypt-powered sealed-bid batch auction. Uses `encrypt-pinocchio`. |
| `sdk/` | **Modify** | Add `deriveCustodyAddressFromIkaDWallet` (P2TR from dWallet pubkey). Add helpers for reading Ika `Sign` accounts. Remove FROST DKG client code. |
| `backend/` | **Slim** | Remove FROST orchestration + DKG ceremony. New thin watcher: poll Ika `Sign` PDAs for completed signatures, assemble + broadcast BTC tx. |
| `scripts/ika-setup/` | **NEW (one-shot)** | Standalone script that runs the dWallet DKG once on Ika devnet, transfers authority to our program's CPI authority PDA, and writes the dWallet ID into `localnet-state.json` / `devnet-state.json`. Run once per pool deployment. |
| `web/` | **Modify** | Deposit flow shows Ika-derived BTC address. "Custody: Ika dWallet" copy. Add swap UI in Phase 2. |
| `docs/` | **Add** | Migration guide, Ika integration doc, Encrypt swap design. Update `TECHNICAL.md`. |

Estimated diff: ~5k LOC deleted (FROST subsystem), ~1.5k LOC added (Ika CPI wiring, watcher, swap program, swap UI). Net negative — production health win.

## Phased plan

### Phase 1 — must ship (Ika core)

**Goal:** BTC privacy bridge works end-to-end with Ika dWallets in place of FROST.

1. **One-shot dWallet setup**: clone `dwallet-labs/ika-pre-alpha`, run their DKG flow once against Ika devnet (`pre-alpha-dev-1.ika.ika-network.net:443`) to create a SECP256K1 dWallet. Transfer its authority to the Privacy Coin CPI authority PDA. Save dWallet ID + pubkey in `localnet-state.json` / `devnet-state.json`.
2. Add `ika-dwallet-pinocchio` git dependency to `contracts/programs/privacy-coin/Cargo.toml`. Add `ika_dwallet_id` and `ika_dwallet_pubkey` fields to `pool_config`.
3. Update `createNonInteractiveDeposit` in SDK: deposit address derives from `pool_config.ika_dwallet_pubkey` (P2TR). OP_RETURN stealth-announcement payload unchanged.
4. `verify_stealth_deposit` stays as-is (still SPV-verifies via `btc-light-client`); only the *destination* address derivation upstream changes.
5. Modify `complete_redemption`: after validating the redemption, build the BTC tx → compute taproot sighash → CPI `DWalletContext::approve_message(message_digest = btc_sighash, signature_scheme = ECDSA_secp256k1)`. The Privacy Coin program enforces all signing policy on-chain (amount limits, destination whitelist, paused-state). FROST's `policy.rs` moves into the program.
6. Backend gets a slim Ika watcher: poll Ika `Sign` PDAs for completed signatures, assemble the witness on the unsigned BTC tx, broadcast to Bitcoin testnet. Replaces `frost_client.rs`.
7. Delete `frost_server/`, `backend/src/bitcoin/frost_client.rs`, and FROST-related Docker config.
8. Update web deposit/withdraw UX. No FROST DKG ceremony at startup.

**Phase 1 acceptance:** Run a full E2E (deposit BTC → see shielded note → transfer privately → withdraw to BTC) on Solana devnet + Bitcoin testnet, with all custody controlled by Ika.

### Phase 2 — stretch (Encrypt confidential swap)

**Goal:** Ship a sealed-bid batch swap between two shielded assets.

1. New Pinocchio program `confidential_swap`. Uses `encrypt-pinocchio` framework. Anchor-free, matches existing stack.
2. **Bid submission**: user submits an *encrypted* `(price, max_amount, side)` triple, signed against an existing shielded note's nullifier (so a bid commits a real note, no Sybil).
3. **Batch close**: after a fixed slot window, an `#[encrypt_fn]` closes the auction, computes uniform clearing price + per-bidder fill amounts on encrypted state. (Pre-alpha Encrypt: this runs as plaintext-on-chain stub today; production will be true FHE later — no API change.)
4. **Settlement**: program emits per-user settlement intents. Threshold decrypt reveals only the user's own fill (not others'). User finalizes by submitting a JoinSplit proof that consumes the bid's input note and creates the output note matching the fill amount. JoinSplit circuit unchanged.
5. **Refund path**: bidders whose fill is zero get their input note re-credited.

**Phase 2 acceptance:** Two test users submit encrypted bids on opposite sides of zkBTC ↔ shielded USDC; matcher clears them; both end up with the swapped shielded notes; on-chain observers see only commitments + nullifiers + ciphertexts.

### Demo polish (rolled into Phase 1/2, not its own phase)

1. UI: a single dashboard showing the shielded BTC balance, a deposit/withdraw flow, and a swap button.
2. Submission video: 2 minutes covering the full flow + 1 minute on architecture + 1 minute on why Ika+Encrypt specifically.

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Ika pre-alpha mock signer disclaimer is a non-starter for "core integration" judging | Low | Medium | Be transparent: README + demo explain Ika is pre-alpha (mock MPC signer, real CPI integration). Same disclaimer Ika ships with. The integration *architecture* is real; the cryptographic backend lights up when Ika exits pre-alpha. |
| Ika devnet wipe ("all on-chain data will be wiped periodically") destroys our dWallet mid-demo | Medium | High | Keep the one-shot setup script (`scripts/ika-setup/`) idempotent. Re-run on demo day to refresh dWallet ID. Pre-record the deposit-flow portion as backup. |
| Encrypt pre-alpha is too rough for the swap circuit | Medium | Medium | Phase 2 is stretch, not core. Ship Phase 1 alone if needed. Encrypt's plaintext-stub mode means functional integration is achievable even if real FHE isn't. |
| Bitcoin testnet flakiness on demo day | High | Low | Pre-record the BTC deposit confirmation portion of the demo. Live-demo only the Solana side. |
| `ika-dwallet-pinocchio` git dep changes API mid-build | Medium | Low | Pin to a specific commit, not `main`. |

## Explicitly out of scope

- Continuous order book (sealed-bid batches only)
- New ZK circuits (existing 1×2/2×2 JoinSplit is sufficient)
- Compliance / viewing-key disclosure features beyond what Privacy Coin v1 ships (Umbra has them; we don't compete on that axis for the hackathon)
- Mobile app
- Mainnet readiness (devnet only)
- **Multi-chain assets — BTC only for the hackathon submission.** Architecture is multi-chain-capable via Ika; ETH/SUI is roadmap, not build target.
- Custom token issuance / RWA integrations
- Decentralized indexer / scanner — keep the existing single backend scanner

## Demo / submission checklist

- [ ] Deployed program IDs (Solana devnet) for `privacy-coin` v2 and `confidential_swap`
- [ ] Ika dWallet ID(s) used in the demo recorded in README
- [ ] Public GitHub repo with this spec, an updated `TECHNICAL.md`, and a `MIGRATION_v1_to_v2.md`
- [ ] README sections: problem, target users (privacy-conscious BTC holders; institutions wanting confidential BTC settlement on Solana), Ika usage, Encrypt usage, build/test instructions, deployed IDs/URLs
- [ ] <5 min demo video
- [ ] Live web frontend deployed (existing Vercel deployment, just rewired)

## Open questions for implementation planning

1. ~~Does Ika's Solana coordinator program expose a CPI for signing requests?~~ **Resolved.** `ika-dwallet-pinocchio` exposes `DWalletContext::approve_message(...)` (discriminator 8). Direct CPI from `complete_redemption`.
2. What's the latency from `complete_redemption` (CPI approve) to a usable signature in the Ika `Sign` PDA? Affects UX. (Determined during recon.)
3. Does Encrypt's pre-alpha actually allow `#[encrypt_fn]` to compile and run in the current devnet, or is the integration paper-only right now?
4. Does the Ika program expose an instruction for raising the dWallet pubkey on-chain, or is the pubkey only available off-chain after DKG? (Affects whether `pool_config.ika_dwallet_pubkey` is filled at init or read lazily.)

These get answered during writing-plans, not now.
