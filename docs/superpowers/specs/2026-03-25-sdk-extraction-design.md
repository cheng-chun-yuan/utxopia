# SDK Extraction: Move Contract Logic from Frontend to SDK

**Date:** 2026-03-25
**Status:** APPROVED
**Branch:** main

## Problem

Contract interaction logic (PDA derivation, instruction building, transaction assembly, account parsing) is scattered across ~8 frontend files totaling ~400 lines. This causes:
- Discriminator bugs (disc=29 vs disc=12 shipped to production today)
- Duplicated PDA derivation in 4 files
- Raw byte offset parsing in components (offset 66 for TokenConfig vault)
- Frontend knowing too much about on-chain data layout

## Solution

Move ALL contract interaction logic to `@aegis/sdk`. Frontend imports high-level functions and focuses on UI/UX.

## Architecture

```
aegis-app (UI only)              @aegis/sdk (all on-chain logic)
┌──────────────────┐             ┌──────────────────────────────┐
│ shield-flow.tsx  │──imports──▶ │ buildShieldSOLTransaction()  │
│ pay-flow.tsx     │──imports──▶ │ buildShieldSPLTransaction()  │
│ api/relay/       │──imports──▶ │ buildChadBufferUpload()      │
│ api/verify/      │──imports──▶ │ buildVerifyDepositTx()       │
│                  │             │ deriveAllPDAs()               │
│ DELETE:          │             │ parseTokenConfig()            │
│ lib/solana/      │             │ INSTRUCTION_DISCRIMINATORS    │
│  instructions.ts │             └──────────────────────────────┘
└──────────────────┘
```

## New SDK Exports

### PDA Derivation (move from `lib/solana/instructions.ts`)
- `deriveNullifierPDA(programId, nullifierHash)`
- `deriveTokenConfigPDA(programId, mint)`
- `deriveVkRegistryPDA(programId, nInputs, nOutputs)`
- `deriveRedemptionRequestPDA(programId, user, nonce)`
- `deriveVerifiedTransactionPDA(programId, blockHash, txid)`
- `deriveDepositReceiptPDA(programId, depositTxid)`
- `deriveLightClientPDA(btcLcProgramId)`
- `deriveBlockHeaderPDA(btcLcProgramId, blockHash)`
- `deriveHeightIndexPDA(btcLcProgramId, height)`

Note: `poolStatePda`, `commitmentTreePda`, `poolVault` already derived in `initConfig()`.

### Transaction Composers (new)
- `buildShieldSOLTransaction(amount, npk, ephemeralPub, user, vault, config)` — wrap SOL + sync + shield + close wSOL
- `buildShieldSPLTransaction(amount, npk, ephemeralPub, user, userAta, vault, config)` — shield Token-2022
- `buildChadBufferUpload(data, bufferKeypair, payer, config)` — create + write chunks + close
- `buildVerifyDepositTransaction(...)` — SPV verification instruction assembly

### Account Parsers (new)
- `parseTokenConfig(data)` — returns `{ bump, mint, tokenId, vault, decimals, enabled, ... }`

### Instruction Builders (move from `lib/solana/instructions.ts`)
- `buildVerifyTransactionInstructionData(...)` — disc=2 (BTC LC)
- `buildVerifyStealthDepositInstructionData(...)` — disc=11

### Already exists (keep)
- `buildShieldInstruction()` — disc=12
- `buildTransactInstruction()` — disc=13
- `buildUnshieldInstruction()` — disc=14
- `buildRedemptionRequestInstructionData()` — disc=16

## Frontend Changes

### Delete
- `aegis-app/src/lib/solana/instructions.ts` (466 lines) — all functions move to SDK

### Slim down
- `shield-flow.tsx` — replace ~80 lines of manual TX assembly with `buildShieldSOLTransaction()` / `buildShieldSPLTransaction()`
- `api/relay/route.ts` — replace ChadBuffer logic with `buildChadBufferUpload()`
- `api/verify/route.ts` — replace ChadBuffer + SPV logic with SDK helpers
- `lib/spv/verify.ts` — replace PDA derivation with SDK imports

## Testing

- Unit tests for all PDA derivations (compare against known addresses)
- Unit tests for instruction data builders (verify byte layout)
- Unit tests for transaction composers (verify instruction list without sending)
- Unit tests for account parsers (verify field extraction)

## NOT in Scope

- **SNS registration** (`use-sns-name.tsx`) — external program, not Aegis SDK
- **UI component splitting** — large files stay large, just slimmer
- **Backend Rust code** — has its own builders, no cross-language sync
