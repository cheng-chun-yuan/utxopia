//! Mollusk integration test stub: `complete_redemption` issues the
//! `approve_message` CPI against the real Ika dWallet program SBF binary.
//!
//! This test is intentionally `#[ignore]`-d as a placeholder. The full
//! Mollusk fixture requires byte-correct setup of ~10 account types
//! (PoolState, RedemptionRequest, VerifiedTransaction, LightClient, ChadBuffer
//! containing a real BTC tx whose hash matches our claimed txid, Token-2022
//! mint and pool vault, PoolConfig with all Ika fields set, and the upstream
//! Ika program's DWalletCoordinator + dWallet accounts pre-populated with
//! the right discriminators and authority bytes).
//!
//! See `docs/plans/2026-05-09-task-4b-complete-redemption-cpi-plan.md` Step
//! 4b.5 for the full fixture spec, including byte offsets for each upstream
//! account type and the recommended construction order.
//!
//! Until the fixture is built, runtime validation of the CPI happens in:
//!   1. The `cpi::ika::tests` module (byte-layout assertions for the ix data).
//!   2. Task 7 — full E2E against Solana devnet + Ika devnet (the canonical
//!      acceptance gate for Phase 1).

#![cfg(not(target_os = "solana"))]

#[test]
#[ignore = "Mollusk fixture builder is large and depends on byte-correct \
            setup of upstream Ika accounts; deferred until Task 7 E2E reveals \
            specific shapes that need test-side validation. See plan §4b.5."]
fn complete_redemption_dispatches_approve_message_cpi() {
    // Pre-conditions for a real run (when un-ignored):
    //
    //   - upstream binary present at /tmp/ika-pre-alpha-scratch/ika-pre-alpha/bin/ika_dwallet_program.so
    //   - privacy_coin SBF built at target/deploy/privacy_coin.so
    //
    // Test plan (verbatim from §4b.5.2):
    //
    //   1. Spin up Mollusk with both programs loaded.
    //   2. Derive: cpi_authority PDA, dwallet PDA (seeds: ["dwallet", curve, pubkey]),
    //      coordinator PDA, NEK PDA, message_approval PDA (seeds: ["message_approval",
    //      dwallet, sighash]).
    //   3. Build a redemption fixture (PoolState, RedemptionRequest, VerifiedTransaction,
    //      LightClient, ChadBuffer-with-real-tx, zkBTC mint+vault, completion receipt PDA,
    //      PoolConfig with set_cpi_authority_bump + set_ika_dwallet + set_ika_dwallet_xonly_pubkey).
    //   4. Construct the COMPLETE_REDEMPTION instruction with a 32-byte sighash trailer
    //      and the 7 Ika-tail accounts after the existing 13 base accounts.
    //   5. mollusk.process_instruction(...) — assert program_result.is_ok().
    //   6. Assert the resulting MessageApproval PDA has discriminator 14 and its
    //      `message_hash` field equals the sighash we passed.
    //
    // Per the plan: this test is "the long pole" of Task 4b. When the Phase 1 E2E
    // runs, it exercises this same path end-to-end against live devnet — that's
    // the actual production validation. This unit test is for fast inner-loop
    // iteration, valuable later but not blocking now.

    panic!("fixture builder not implemented — see plan §4b.5.2");
}
