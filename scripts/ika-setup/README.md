# Ika dWallet Setup (one-shot)

This directory holds the script that runs the **DKG ceremony** against Ika devnet to create a dWallet, then writes the resulting `dwallet`, `dwalletXOnlyPubkey`, and `cpiAuthorityBump` into the appropriate state JSON.

You run this **once per pool deployment**. The values it produces feed `scripts/sync-env.sh`, which propagates them to `backend/.env.{network}` and `web/src/lib/networks.json`.

## Prerequisites

- A funded Solana keypair (devnet airdrop; localnet faucet)
- `bun` installed
- The upstream Ika repo cloned at `/tmp/ika-pre-alpha-scratch/ika-pre-alpha/` (this script's runbook references its `_shared/ika-setup.ts` helpers)

## Runbook

```bash
# 1. Install deps
cd scripts/ika-setup
bun install

# 2. Run the upstream voting e2e to materialize a real dWallet on Ika devnet.
#    (This burns some SUI/IKA testnet tokens for gas + Ika network fees.)
cd /tmp/ika-pre-alpha-scratch/ika-pre-alpha
cd chains/solana/examples/voting/e2e && bun install
bun main.ts $IKA_PROGRAM_ID $VOTING_EXAMPLE_PROGRAM_ID 2>&1 | tee /tmp/ika-dkg.log

# 3. From /tmp/ika-dkg.log, capture:
#      - dWallet PDA      → IKA_DWALLET_ID
#      - compressed pubkey (33 bytes hex, prefix 0x02/0x03 + x) → IKA_DWALLET_PUBKEY_HEX

# 4. Run this script to compute the CPI authority bump and write the state JSON.
cd /Users/chengchunyuan/project/hackathon/private_coin/scripts/ika-setup
UTXOPIA_PROGRAM_ID=<your_program_id> \
PAYER_KEYPAIR_PATH=/path/to/keypair.json \
IKA_DWALLET_ID=<from-step-3> \
IKA_DWALLET_PUBKEY_HEX=<from-step-3> \
bun run setup --network devnet

# 5. Transfer dWallet authority to our CPI PDA (the script prints the
#    instruction details; you submit it manually via solana CLI or a small
#    one-off ix wrapper).

# 6. Re-sync env files.
UTXOPIA_NETWORK=devnet ../sync-env.sh

# 7. Restart the backend; it now picks up Ika via UTXOPIA_SIGNING_MODE=ika
#    + the UTXOPIA_IKA_* env vars in backend/.env.
```

## Devnet wipe note

Ika's pre-alpha devnet **wipes periodically** (per the upstream README). Plan for re-running this script before any demo. The state JSON should be considered ephemeral on devnet.

## Imported-key status

Do not use the placeholder Solana gRPC DKG/import payloads for BTC custody. The
pre-alpha Solana examples accept zero-filled fields because the network signer is
mocked, but the resulting dWallet key is not bound to the private key we intend
to import, and signatures may not verify for the advertised dWallet public key.

A real imported-key setup needs the same artifacts the upstream Ika TypeScript
SDK generates in `prepareImportedKeyDWalletVerification`:

- `protocolPublicParameters`, derived from the full network DKG public output
- `userPublicOutput`
- `userMessage`
- `encryptedUserShareAndProof`
- the retained user secret share needed later to build the imported-key sign
  message

The Solana pre-alpha docs expose the 164-byte `NetworkEncryptionKey` PDA, but
that account is only the network encryption key metadata. It does not contain
the full network DKG public output required to derive protocol public
parameters. Until that output is available from the Solana pre-alpha surface or
Ika ships a Solana SDK helper equivalent to the Sui TypeScript SDK flow, imported
BTC pool custody cannot be made cryptographically sound through this script.

Use `imported-key-probe.ts` only as a guardrail/probe: it intentionally refuses
to accept an attested dWallet unless the attested compressed secp256k1 public key
matches `IMPORT_PRIV`.

For the Solana pre-alpha mock path, use `bun run imported:verify` to prove the
mock imported dWallet can sign and verify. The returned public key is the mock
dWallet key; it is expected not to match `IMPORT_PRIV`. `ImportedKeySign` with
`TaprootSha256` verifies against `sha256(Sign.message)`, not the raw message.

For BTC Taproot key-spend tests, approve/sign the BIP-341 TapSighash preimage,
not the final 32-byte sighash. `sha256(preimage)` must equal the BTC sighash that
Bitcoin verifies. `sign-approved-redemption.ts` now prints and sends that
preimage to Ika, then verifies the returned Schnorr signature against the final
BTC sighash before broadcasting.

## Why this isn't fully automated

The upstream gRPC schema (`SignedRequestData` + `TransactionResponseData`) and the on-chain dWallet-creation tx call sequence are still in flux at pre-alpha. Vendoring that flow today means tracking upstream churn. We deliberately keep this as a runbook-driven script that delegates to the upstream voting example for the actual DKG, then takes its outputs and finishes the wiring locally.

When Ika's Solana coordinator program stabilizes, the entire ceremony collapses into a single Rust call (probably via `ika-dwallet-pinocchio`'s helpers or a successor crate); at that point this script becomes a one-liner.
