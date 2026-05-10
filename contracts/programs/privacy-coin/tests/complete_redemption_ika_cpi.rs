//! LiteSVM integration test for byte-correct CPI from a Pinocchio program
//! into the upstream Ika dWallet program (`bin/ika_dwallet_program.so`).
//!
//! ## Status: deferred (toolchain blocker + .so opaqueness)
//!
//! This test was scaffolded against `programs/ika-cpi-shim/`, a minimal
//! Pinocchio crate that wraps `privacy_coin::cpi::ika::approve_message`
//! so the LiteSVM transaction's program_id chain matches what production
//! `complete_redemption` does (CPI from a real program, not a raw tx).
//! The shim crate is committed and builds cleanly.
//!
//! Two blockers prevent shipping a green assertion in this session:
//!
//! 1. **`cargo build-sbf` toolchain is Rust 1.84.** Adding the granular
//!    Solana crates LiteSVM 0.11 needs (`solana-account`, `solana-address`,
//!    `solana-pubkey`, `solana-keypair`, `solana-signer`, `solana-instruction`,
//!    `solana-transaction`) to dev-deps transitively pulls in
//!    `wincode-derive`, whose manifest requires Cargo's `edition2024`
//!    feature (Rust 1.85+). Even pinning each crate exactly fails because
//!    `solana-account ^3.x` requires `solana-pubkey ^4.x`, and 4.x's
//!    `wincode` opt-in cascades into the resolution graph.
//!
//! 2. **Ika `.so` is shipped without source.** During an attempted run with
//!    the granular deps in place, the simplest possible call —
//!    `transfer_dwallet` ix sent directly to the Ika program with both a
//!    valid signer authority and a dWallet account whose `owner` byte-equals
//!    `DWALLET_PROGRAM_ID` — failed with `InstructionError(0,
//!    InvalidAccountOwner)` after only 127 CU. The error originates inside
//!    the Ika program; without source we can't pinpoint the precondition
//!    that's failing. The upstream voting LiteSVM test (the only working
//!    reference) cannot be built with our toolchain (its workspace requires
//!    Cargo 1.85+ for `edition2024`).
//!
//! ## What's still here
//!
//! - **`programs/ika-cpi-shim/`**: a tiny Pinocchio program with a single
//!   instruction wrapping `privacy_coin::cpi::ika::approve_message`.
//!   Builds cleanly via `cargo build-sbf --manifest-path
//!   programs/ika-cpi-shim/Cargo.toml`. Future test runners against the
//!   real Solana devnet (or a Rust 1.85+ SBF toolchain + LiteSVM) can
//!   load this `.so` plus `bin/ika_dwallet_program.so` and exercise the
//!   exact byte-layout CPI surface that production uses.
//!
//! - **`programs/privacy-coin/Cargo.toml` `no-entrypoint` feature**: lets
//!   privacy-coin be consumed as a pure library (so two cdylibs in the
//!   workspace don't both define `#[global_allocator]`). The shim depends
//!   with `default-features = false, features = ["no-entrypoint"]`.
//!
//! ## How to revive (in order of effort)
//!
//! 1. **Wait for Task 7's real devnet run.** The CPI surface is exercised
//!    end-to-end there against the live Ika program. Failures during that
//!    run will surface the actual `InvalidAccountOwner` precondition and
//!    inform any test-side validation we want to add later.
//!
//! 2. **Upgrade the SBF toolchain.** Once Solana ships an SBF cargo with
//!    `edition2024` (Rust 1.85+), restore the granular Solana crate deps
//!    in `Cargo.toml` (see commit history for the exact set), uncomment
//!    the body of this test, run `cargo build-sbf --manifest-path
//!    programs/ika-cpi-shim/Cargo.toml` to produce
//!    `target/deploy/ika_cpi_shim.so`, then `cargo test
//!    -p privacy-coin --test complete_redemption_ika_cpi`.
//!
//! 3. **Read upstream Ika source.** When `dwallet-labs/ika-pre-alpha`
//!    publishes program source, grep for `InvalidAccountOwner` in the
//!    `transfer_dwallet`/`approve_message` handlers and tune the test
//!    fixture's pre-state to match.

#![cfg(not(target_os = "solana"))]

#[test]
#[ignore = "Toolchain blocker (cargo build-sbf is Rust 1.84; adding granular \
            Solana crates pulls wincode-derive which needs edition2024). \
            See file docstring for full rationale and revival path. The \
            shim crate at programs/ika-cpi-shim/ remains as concrete \
            infrastructure for the eventual integration test."]
fn complete_redemption_dispatches_approve_message_cpi() {
    panic!("see docstring — deferred behind two independent blockers");
}
