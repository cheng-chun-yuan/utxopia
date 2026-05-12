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

## Why this isn't fully automated

The upstream gRPC schema (`SignedRequestData` + `TransactionResponseData`) and the on-chain dWallet-creation tx call sequence are still in flux at pre-alpha. Vendoring that flow today means tracking upstream churn. We deliberately keep this as a runbook-driven script that delegates to the upstream voting example for the actual DKG, then takes its outputs and finishes the wiring locally.

When Ika's Solana coordinator program stabilizes, the entire ceremony collapses into a single Rust call (probably via `ika-dwallet-pinocchio`'s helpers or a successor crate); at that point this script becomes a one-liner.
