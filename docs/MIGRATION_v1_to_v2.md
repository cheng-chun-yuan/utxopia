# Migration v1 → v2: FROST → Ika dWallet

> **Status (2026-05):** in-flight pivot to Solana-native Ika pre-alpha. The on-chain CPI surface is wired; backend call-site rewiring + full FROST decommission are deferred follow-ups. See [docs/plans/2026-05-09-ika-phase1-implementation-plan.md](plans/2026-05-09-ika-phase1-implementation-plan.md) for the canonical plan.

## What changed

| Concern | v1 (FROST) | v2 (Ika) |
|---|---|---|
| BTC custody | 2-of-3 FROST signers (`frost_server/`), HTTP RPC, off-chain DKG ceremony | Ika dWallet on Solana (`87W54kGYFQ1rgWqMeu4XTPHWXWmXSQCcjm8vCTfiq1oY`), 2PC-MPC, authority pinned to a Solana PDA |
| Where signing policy lives | `frost_server/src/policy.rs` (off-chain Rust) | `contracts/programs/privacy-coin/src/utils/policy.rs` (on-chain Pinocchio) |
| Withdrawal flow | `complete_redemption` → backend dispatches FROST round → broadcast | `complete_redemption` (now carries 32-byte sighash) → CPI `approve_message` → off-chain watcher polls Sign PDA → broadcast |
| `pool_config` PDA | 96 bytes; stores FROST `group_pub_key` | 161 bytes; adds `ika_dwallet`, `ika_dwallet_xonly_pubkey`, `cpi_authority_bump`. `group_pub_key` retained zero for new pools |
| SDK custody hint | `config.groupPubKey` (FROST) | `config.ikaDwalletXOnlyPubkey` (Ika); `pickCustodyInternalKey` falls back to FROST when zero |
| Operator burden | Run 2-of-3 FROST signer cluster + DKG ceremony | Run a single backend that polls Solana RPC for Sign PDAs |
| Trust model | Threshold of 2-of-3 FROST signer operators | User + Ika network (2PC-MPC); pre-alpha = single mock signer until Ika mainnet |

## What did NOT change

- JoinSplit ZK circuits (Groth16, BN254). Same `1x2`, `2x2`, `2x1`, `1x1` variants.
- Stealth address protocol (Baby Jubjub + Ed25519 ECDH; EIP-5564/DKSAP).
- `verify_stealth_deposit` SPV path (still uses `btc-light-client`).
- OP_RETURN payload format (`ephemeralPub(32) || npk(32) = 64 bytes`).
- Commitment derivation (`Poseidon(npk, ZKBTC_TOKEN_ID, amount)`).
- SDK public API surface (`PrivacyCoinClient`, `createNonInteractiveDeposit`, `createDepositFromConfig`). Same names; the *value* of the custody pubkey passed through changes.

## For pool operators

1. **Set up the dWallet** (one-shot, before pool deployment).
   Run the DKG flow against Ika devnet at `pre-alpha-dev-1.ika.ika-network.net:443` to create a SECP256K1 dWallet. (The setup script `scripts/ika-setup/` is on the roadmap; for the hackathon we follow `dwallet-labs/ika-pre-alpha`'s `chains/solana/examples/_shared/ika-setup.ts:setupDWallet` pattern manually.) Capture the dWallet account address and its compressed-x x-only pubkey.

2. **Transfer authority.**
   Use the Ika `transfer_dwallet` instruction (discriminator 24) to transfer the dWallet's authority from your Sui-side payer to your Privacy Coin program's CPI authority PDA: `find_program_address(&[b"__ika_cpi_authority"], &privacy_coin_program_id)`.

3. **Update the state JSON.**
   Edit `scripts/devnet-state.json` (or `localnet-state.json` after re-running the e2e setup) to set `ika.dwallet` and `ika.dwalletXOnlyPubkey` to the values from Step 1, and `ika.cpiAuthorityBump` to the bump from Step 2.

4. **Re-sync env files.**
   ```bash
   PRIVACY_COIN_NETWORK=devnet ./scripts/sync-env.sh
   ```
   This propagates the Ika fields to `backend/.env.devnet` and `web/src/lib/networks.json`.

5. **Call `set_pool_config`** (instruction discriminator 27). Pass the Ika fields:
   `pool_script || group_pub_key(zeroed) || ika_dwallet(32) || ika_dwallet_xonly_pubkey(32) || cpi_authority_bump(1)`.

6. **Existing FROST-controlled deposits stay redeemable** through the legacy code path until you sweep them. Cut over by setting `group_pub_key = [0; 32]` in `set_pool_config` once that's done.

## What's not yet migrated

These are tracked as Task 5/8 follow-ups in the implementation plan:

- `backend/src/main.rs` and `config.rs` still construct `MpcSigner` (FROST). The new `IkaSigner` struct is implemented (`backend/src/redemption/signer.rs`) but not yet wired into the redemption pipeline's dispatch.
- `backend/src/deposit_tracker/sweeper.rs` still uses FROST for *deposit* sweep-tx signing. Migration of that path follows the same pattern as redemption signing.
- `frost_server/` is retained for the migration window. Decommission once Task 7 E2E is green three times.

## Pre-alpha caveats

- **Ika devnet wipes periodically.** Quote from the upstream README: *"The Solana program and all on-chain data will be wiped periodically and everything will be deleted when we transition to Ika Alpha 1."* Plan for re-running the dWallet setup on demo day.
- **Mock signer.** Until Ika mainnet, signatures come from a single mock signer, not real distributed MPC. The CPI integration and developer flow are real; the cryptographic backend is a placeholder. Surface this in any production conversation.
- **Pinocchio version mismatch.** Upstream `ika-dwallet-pinocchio` uses Pinocchio 0.10; we're on 0.9. Our `src/cpi/ika.rs` hand-builds the CPI to avoid the dep. If we upgrade, the hand-built helper can be replaced with the upstream crate without API changes to its callers.
