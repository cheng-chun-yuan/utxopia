# Solana Implementation Notes

The existing Solana implementation remains the reference implementation while
the Sui version is developed.

## Current Responsibilities

| Area | Location |
| --- | --- |
| Main program | `contracts/programs/utxopia` |
| BTC light client | `contracts/programs/btc-light-client` |
| SDK | `sdk` |
| Backend workers | `backend` |
| Web app | `web` |
| Circuits | `circuits` |

## Adapter Extraction Plan

The Solana code should be wrapped behind the shared multichain adapter before
large file moves happen.

First extraction targets:

1. Pool state reads.
2. Merkle root reads.
3. Note scanning.
4. Shield transaction builder.
5. JoinSplit transaction builder.
6. Redemption transaction builder.
7. Transaction submission.

## What Should Not Move Yet

Avoid moving these directories until the Sui adapter compiles and the web app
can select a chain through a single interface:

```text
contracts/
backend/
sdk/
web/
scripts/
```

Keeping the reference implementation stable is more valuable than a cosmetic
folder split during the first Sui milestone.

