# TODOS

## SDK Migration — Route Refactoring

### P1: Replace inline instruction building in API routes with SDK calls
- **`/api/relay`**: Replace `buildTransactIx()` (~90 lines) with `buildTransactInstructionData({ proofSource: 1, ... })`
- **`/api/unshield`**: Replace inline data packing (~60 lines) with `buildUnshieldInstructionData()`
- **`/api/redeem`**: Migrate from deprecated disc=16 (REDEEM) to disc=5 (REQUEST_REDEMPTION) using SDK's `buildRedemptionRequestInstructionData()`
- **Context**: SDK `buildTransactInstructionData()` now supports `proofSource: 1` (buffer mode). Route refactors are mechanical replacements.
- **Leave `/api/verify` as-is** — SPV logic is frontend-specific, not covered by core SDK.
