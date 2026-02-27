## Testing Overview

This project has tests at four main layers:

- **Contracts** (Rust + TypeScript helpers)
- **SDK** (TypeScript, Bun test)
- **Devnet / Backend** (integration against running services)
- **zVault App** (frontend, Vitest)

The goal is to keep each test file focused, small, and clearly scoped (unit, integration, or E2E).

### Contracts (`contracts`)

- **Rust unit / integration tests** live next to program code and are run with `cargo test`.
- **TypeScript contract helpers and integration tests** live under:
  - `contracts/tests/helpers/` — shared program IDs, PDA helpers, Poseidon Merkle tree, Groth16 helpers.
  - `contracts/tests/integration/` — Bun tests for:
    - `instruction-encoding.test.ts`
    - `zk-merkle.test.ts`
    - `e2e-flow.test.ts`
    - `claim-groth16-demo.test.ts`
- **How to run**:
  - `cd contracts && bun test tests/integration`
  - `cd contracts && cargo test` for Rust-side logic.
- **When to add tests**:
  - Changing instruction layouts or PDAs → add/extend `instruction-encoding.test.ts`.
  - Touching ZK/Merkle helpers used by contracts → add/extend `zk-merkle.test.ts` or `e2e-flow.test.ts`.

### Devnet / Backend (`devnet-test`)

- Devnet E2E tests live in `devnet-test/tests/*.test.ts`.
- Files are already split by flow (health, FROST DKG, deposit, joinsplit, redemption, full-flow, real-deposit-verify).
- **How to run**:
  - `cd devnet-test && bun test` (after services are up as described in `docs/RUNNING.md`).
- **When to add tests**:
  - New end-to-end flow spanning Bitcoin + Solana + backend → add a new `NN-description.test.ts`.
  - Keep each file focused on a single flow and reuse shared setup from `setup.ts` (or a future `helpers/` folder if you add shared utilities).

### SDK (`sdk`)

- Uses Bun test with Vitest-style assertions.
- Test layout:
  - `sdk/test/unit/` — fast, pure unit tests:
    - `commitment.test.ts`
    - `priority-fee.test.ts`
    - `mempool.test.ts`
    - `connection.test.ts`
  - `sdk/test/integration/` — higher-level, SDK focused tests:
    - `commitment-onchain.test.ts`
    - `deposit-flow.test.ts`
    - `chadbuffer-e2e.test.ts` (legacy, mostly skipped)
  - `sdk/test/e2e/` — full E2E tests against localnet/devnet:
    - `full-flow.test.ts`
    - `nullifier.test.ts`
    - `tree-consistency.test.ts`
    - `groth16-claim.test.ts`
    - plus shared helpers in `sdk/test/e2e/helpers.ts`, `sdk/test/e2e/setup.ts`, etc.
- **How to run**:
  - `cd sdk && bun test` (all tests).
  - `cd sdk && bun test test/unit` (unit only).
  - `cd sdk && bun test test/integration` (integration only).
  - `cd sdk && bun test test/e2e` (E2E only; requires environment and circuits, see SDK docs).
- **When to add tests**:
  - Pure helper or utility logic (Poseidon, PDAs, fees, mempool, connection) → `test/unit`.
  - New SDK flows that stay within the SDK (no external services) → `test/integration`.
  - New flows that require a running validator / circuits / backend → `test/e2e`.

### zVault App (`zvault-app`)

- Frontend tests are co-located with code using Vitest:
  - Stores: `src/stores/__tests__/zvault-store.test.ts`, `src/stores/__tests__/notes-store.test.ts`.
  - Hooks: `src/hooks/__tests__/use-pool-stats.test.tsx`, `src/hooks/__tests__/use-copy-to-clipboard.test.ts`.
  - Utils: `src/lib/utils/__tests__/formatting.test.ts`, `src/lib/utils/__tests__/validation.test.ts`.
  - API: `src/lib/api/__tests__/client.test.ts`, `src/lib/api/__tests__/errors.test.ts`.
  - Components: `src/components/btc-widget/__tests__/widget.test.tsx`.
- **How to run**:
  - `cd zvault-app && bun test` (Vitest).
- **Conventions**:
  - Keep tests close to the code they cover in `__tests__` folders.
  - Use descriptive file names, e.g. `use-pool-stats.test.tsx`, `widget.test.tsx`.
  - Small, focused tests per concern (one hook or one component per file).

### General Guidelines

- Prefer **unit tests** for pure logic; reserve E2E tests for a small, high-value set of flows.
- Keep each test file under ~500 lines; if a test file grows large, split by concern (e.g. multiple `*.test.ts` files).
- Use existing helpers where possible instead of inlining setup:
  - Contracts: `contracts/tests/helpers/*`.
  - SDK: `sdk/test/e2e/helpers.ts`, `sdk/test/e2e/setup.ts`, and new `test/unit`/`test/integration` helpers if you add them.
- When adding a new feature, try to:
  - Add/extend a **unit test** close to the logic.
  - Add/extend an **integration/E2E test** only if the behavior crosses boundaries (Solana, backend, Bitcoin).

