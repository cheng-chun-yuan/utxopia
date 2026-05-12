# Ika Solana Pre-Alpha Recon Brief — 2026-05-09

> Source: `dwallet-labs/ika-pre-alpha` @ `3bd7945e012950e54fb4d0057b72a7d466556fc1` (HEAD as of recon).
> Repo cloned at `/tmp/ika-pre-alpha-scratch/ika-pre-alpha/`.

## Confirmed essentials

| Item | Value |
|---|---|
| Devnet Solana program ID | `87W54kGYFQ1rgWqMeu4XTPHWXWmXSQCcjm8vCTfiq1oY` |
| Devnet gRPC | `pre-alpha-dev-1.ika.ika-network.net:443` |
| Solana RPC for devnet | `https://api.devnet.solana.com` |
| Pinocchio CPI crate | `chains/solana/program-sdk/pinocchio/` published as `ika-dwallet-pinocchio` |
| Pre-built program SBF | `bin/ika_dwallet_program.so` (we use this for LiteSVM tests) |
| Workspace toolchain | Rust 1.94 (per `rust-toolchain.toml`) |

## Cargo dependency for our program

```toml
[dependencies]
ika-dwallet-pinocchio = { git = "https://github.com/dwallet-labs/ika-pre-alpha", rev = "3bd7945e012950e54fb4d0057b72a7d466556fc1" }
```

(Pin to the SHA above. The repo's README says "all interfaces … subject to change without notice" and the devnet "will be wiped periodically." A rev pin protects us from churn.)

## CPI surface — `DWalletContext::approve_message`

Source: `chains/solana/program-sdk/pinocchio/src/cpi.rs`.

| Field | Value |
|---|---|
| Instruction discriminator | `8` (constant `IX_APPROVE_MESSAGE`) |
| Instruction data length | 100 bytes |
| Instruction data layout | `[u8 disc, u8 bump, [u8;32] message_digest, [u8;32] message_metadata_digest, [u8;32] user_pubkey, u16 signature_scheme]` (LE) |
| CPI authority PDA seed | `b"__ika_cpi_authority"` (constant `CPI_AUTHORITY_SEED`) |

Account ordering (in the CPI invocation):

| # | Account | Mode |
|---|---|---|
| 0 | coordinator | readonly |
| 1 | message_approval (PDA, to be created) | writable |
| 2 | dwallet | readonly |
| 3 | caller_program (our program account, executable) | readonly |
| 4 | cpi_authority (our PDA derived from `[CPI_AUTHORITY_SEED]`) | readonly + signer |
| 5 | payer | writable + signer |
| 6 | system_program | readonly |
| 7 | dwallet_program (the Ika program itself) | passed in `accounts` slice for `invoke_signed` |

## Signature scheme values (`u16` LE in instruction data)

Source: `crates/ika-dwallet-types/src/lib.rs` lines 163–180.

| Variant | u16 value | Use case |
|---|---|---|
| `EcdsaKeccak256` | `0` | Ethereum |
| `EcdsaSha256` | `1` | Generic Bitcoin (legacy), WebAuthn |
| `EcdsaDoubleSha256` | `2` | Bitcoin BIP143 (segwit non-Taproot) |
| `TaprootSha256` | `3` | **Bitcoin Taproot — our value (P2TR uses Schnorr)** |
| `EcdsaBlake2b256` | `4` | Zcash |
| `EddsaSha512` | `5` | Ed25519 (Solana, Sui) |
| `SchnorrkelMerlin` | `6` | Substrate |

For UTXOpia v2 BTC redemptions: **`signature_scheme = 3` (TaprootSha256)** with the dWallet curve set to `Secp256k1`.

## Account discriminators (Ika program)

Source: `chains/solana/examples/voting/pinocchio/tests/litesvm.rs` lines 60–75.

| Discriminator | Account | Total len (incl. 2-byte disc+version) |
|---|---|---|
| `1` | DWalletCoordinator | 2 + 114 = 116 |
| `2` | DWallet | 2 + 690 = 692 |
| `3` | NetworkEncryptionKey (NEK) | 2 + 162 = 164 |
| `14` | MessageApproval | 2 + 285 = 287 |

## DWallet account internal layout (excerpt)

Offsets after the 2-byte disc+version prefix:

| Offset | Field | Bytes |
|---|---|---|
| 2 | authority | 32 (Solana pubkey controlling this dWallet) |
| 37 | public_key | varies (33 bytes for compressed secp256k1) |
| 102 | created_epoch | 8 |
| 110 | noa_public_key | 32 |
| 142 | is_imported | 1 |
| 659 | bump | 1 |

The UTXOpia watcher reads `public_key` at offset 37 to populate `pool_config.ika_dwallet_pubkey`.

## DKG flow (one-shot setup)

Source: `chains/solana/examples/_shared/ika-setup.ts` `setupDWallet(...)`.

Sequence:
1. **Wait for the coordinator PDA**: poll `[b"dwallet_coordinator"]` until `data[0] == 1` (DISC_COORDINATOR) and len ≥ 116.
2. **Find the NEK**: `getProgramAccounts(dwalletProgramId)` filtered by `data[0] == 3`. Take the first one.
3. **Build a `SignedRequestData` BCS payload** with `chain_id: { Solana: true }`, `intended_chain_sender: payer.publicKey`, `request: { DKG: { ... curve, … } }`. For UTXOpia we use `curve: { Secp256k1: true }` (TS index — observe at runtime).
4. **Submit via gRPC** to `pre-alpha-dev-1.ika.ika-network.net:443`. Returns a `TransactionResponseData::Attestation` payload.
5. **Use the attestation to send the on-chain Solana tx** that creates the dWallet account.
6. **Transfer authority** of the dWallet to our UTXOpia's CPI authority PDA via `IX_TRANSFER_OWNERSHIP = 24` (`DWalletContext::transfer_dwallet`).

For our pivot: this one-shot flow lives in `scripts/ika-setup/` (TypeScript — we copy the `_shared/ika-setup.ts` patterns). It runs once per pool deployment and writes the resulting dWallet address + pubkey into `localnet-state.json` / `devnet-state.json` so `sync-env.sh` propagates them.

## Sign session readback (the off-chain watcher's job)

After CPI'd `approve_message`, the Ika program creates a `MessageApproval` PDA. The pre-alpha mock signer asynchronously fills a corresponding `Sign` account (or attaches the signature into the MessageApproval — exact location to be confirmed at first live run; the BCS types in `_shared/ika-setup.ts` show `Signature` and `Attestation` response variants, so the readback path goes through the same gRPC client used for DKG).

The `requestSign(...)` helper at `chains/solana/examples/_shared/ika-setup.ts:536` is the canonical readback pattern; we port it to the backend watcher in Task 5.

## Local test harness pattern

`chains/solana/examples/voting/pinocchio/tests/litesvm.rs` shows the canonical pattern:
- Load `bin/ika_dwallet_program.so` into a LiteSVM instance via `add_program_from_file`.
- Load our SBF binary similarly.
- Construct CPI authority PDA via `find_program_address(&[CPI_AUTHORITY_SEED], &our_program_id)`.
- Pre-create the dWallet account in LiteSVM with `data[0] = DISC_DWALLET` and `authority = our_cpi_authority_pda` (mocks the post-DKG state).
- Send our program's instruction; assert the resulting `MessageApproval` PDA exists and contains the right `message_digest`.

We adopt this pattern verbatim for `contracts/programs/utxopia/tests/complete_redemption_ika_cpi.rs` in Task 4.

## Latency observed

Devnet roundtrip not yet measured (would require Sui-style funded keypair + first DKG). Will update this section after the one-shot DKG runs in Task 6 or first E2E. Expectation per repo's "mock signer" disclaimer: low latency (no real MPC).

## Voting example test status

- `cargo build --workspace`: in progress on Rust 1.94 (still running at recon time; large dep tree). Build status is **not** the gate — the gate is whether `ika-dwallet-pinocchio` compiles when added to *our* program (verified in Task 4).
- `cargo test --workspace`: not yet attempted; deferred to Task 0 follow-up if there is time.

## Gotchas

- Devnet wipes periodically. Our `scripts/ika-setup/` must be idempotent and runnable on demo day.
- The pre-alpha disclaimer ("mock signer, not real MPC") is non-negotiable for hackathon judging — we surface this prominently in README and demo.
- `DWalletCurve::Secp256k1` BCS index: must be confirmed at runtime (the TS example uses `Curve25519`; for BTC we need Secp256k1). The Rust enum order in `crates/ika-dwallet-types/src/lib.rs:119` is the source of truth.
- The CPI authority PDA bump is computed once and stored in `pool_config.cpi_authority_bump` to avoid recomputing on every redemption.
- `message_metadata_digest` parameter is a 32-byte field. For TaprootSha256 it is unused; we pass `[0u8; 32]`.

## Reproducible artifacts

- Pinocchio CPI source: `/tmp/ika-pre-alpha-scratch/ika-pre-alpha/chains/solana/program-sdk/pinocchio/src/cpi.rs`
- Voting example (LiteSVM harness to copy): `/tmp/ika-pre-alpha-scratch/ika-pre-alpha/chains/solana/examples/voting/pinocchio/tests/litesvm.rs`
- TS DKG flow to port: `/tmp/ika-pre-alpha-scratch/ika-pre-alpha/chains/solana/examples/_shared/ika-setup.ts`
- Signature scheme enum: `/tmp/ika-pre-alpha-scratch/ika-pre-alpha/crates/ika-dwallet-types/src/lib.rs:163`

## What's deferred to live exercise

These items can't be fully nailed down without a funded Sui-style + Solana devnet payer running through the actual DKG:
- Exact DWalletCurve BCS index for Secp256k1 (Curve25519 is TS index 2; Secp256k1 likely 0).
- Precise location of the final signature in the MessageApproval/Sign PDA after the mock signer completes.
- Devnet latency (DKG, sign).
- Whether the gRPC service requires any auth header / IKA token.

Tasks 4–7 reference this brief; if any of these deferred items become blocking during execution, halt and append the answer here before continuing.
