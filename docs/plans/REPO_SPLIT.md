# UTXOpia Repository Split Plan

## Goal

Split `UTXOpia/utxopia` into focused repositories without breaking the current
demo path. Public repositories should expose cryptography, client SDKs, and
chain programs. Private repositories should keep backend operations, deployment
state, relayer code, and environment-specific scripts.

## Recommended Repositories

| Repository | Visibility | Contents | Notes |
| --- | --- | --- | --- |
| `utxopia-sdk` | Public | `sdk`, `packages/sdk-core`, `packages/sdk-sui`, `packages/btc-client` | Main client and cryptography SDK surface. Publish packages from here. |
| `utxopia-circuits` | Public | `circuits`, `tools/sui-groth16-exporter` | Public circuits and verification-key exporter. Do not commit generated toxic-waste artifacts. |
| `utxopia-solana-programs` | Public | `contracts` | Solana Pinocchio programs and program tests. |
| `utxopia-sui-programs` | Public | `chains/sui/contracts`, `chains/sui/scripts`, `chains/sui/indexer` | Sui Move package, Sui adapters/scripts, and Sui indexer. Can later split indexer private if needed. |
| `utxopia-web` | Private until launch, then optional public | `web` | Client app can be public once env assumptions are sanitized. Keep private while hackathon/demo flows are changing. |
| `utxopia-backend` | Private | `backend`, selected backend-only `scripts` | API server, deposit tracker, redemption processors, relayer logic. |
| `utxopia-ops` | Private | deployment scripts, runbooks, generated config templates, docs for operators | Never include deploy keys or local state. |
| `utxopia-docs` | Public | `docs`, selected diagrams | Optional. Keep docs in main repos until the split stabilizes if you want less maintenance. |

## Public/Private Decision

Keep public:

- Cryptography code and circuits.
- Solana and Sui programs.
- Client SDK packages and public client helpers.
- Public protocol docs, verification-key tooling, and examples that do not
  include deployment secrets.

Keep private:

- Backend API and tracker internals.
- Relayer, withdrawal, and custody operation code.
- Deployment automation and operational runbooks.
- Environment-specific state, generated config, keys, service tokens, and
  infrastructure notes.
- Demo-only operational scripts that encode private workflow assumptions.

## Keep Out Of Public Repos

These paths should not be copied into public repositories:

- `deploy-keys-hybrid*`
- `backend/data`
- `web/.data`
- `web/.next`
- `node_modules`
- `sdk/node_modules`
- `circuits/node_modules`
- `contracts/target`
- generated local state such as `chains/sui/sui-poc-state.json` unless it is a sanitized example
- any `.env`, wallet keypair, Sui key, Solana key, Bitcoin regtest wallet data, or Vercel/Railway config containing secrets

## Dependency Direction

Use this dependency graph:

```text
utxopia-circuits
        ↓
utxopia-sdk ← utxopia-solana-programs
        ↓              ↓
utxopia-web       utxopia-backend
        ↑              ↑
utxopia-sui-programs ──┘
```

Rules:

- `utxopia-sdk` should not import from app, backend, or program repos.
- `utxopia-web` should consume published SDK packages, not `file:../sdk`.
- `utxopia-sui-programs` can depend on `@utxopia/sdk-core`, `@utxopia/sdk-sui`,
  and `@utxopia/btc-client`.
- `utxopia-backend` can depend on SDK and program ID/config packages, but SDK
  should not depend on backend.
- Shared constants should move into SDK packages instead of being imported from
  app or scripts.

## Split Order

1. Create the public SDK repo first.
2. Publish or workspace-link SDK packages.
3. Split circuits and exporter.
4. Split Solana programs.
5. Split Sui programs and indexer.
6. Split web after replacing local package references with published packages.
7. Split backend and ops last, because they have the most environment coupling.

## Local Split Commands

Run from the current monorepo root.

```bash
git subtree split --prefix=sdk -b split/sdk-main
git subtree split --prefix=circuits -b split/circuits
git subtree split --prefix=contracts -b split/solana-programs
git subtree split --prefix=web -b split/web
git subtree split --prefix=backend -b split/backend
```

For grouped repos that need multiple directories, create a temporary worktree
and copy the selected paths with history-preserving follow-up only where history
matters. The SDK repo is a grouped repo, so either:

1. keep the old monorepo history only in `utxopia`, and create a clean
   `utxopia-sdk` repo from selected directories, or
2. create multiple subtree branches and merge them into a new orphan branch.

The clean-repo approach is simpler and usually better for this codebase:

```bash
mkdir -p /tmp/utxopia-split/utxopia-sdk
rsync -a --exclude=node_modules --exclude=dist sdk packages/sdk-core packages/sdk-sui packages/btc-client /tmp/utxopia-split/utxopia-sdk/
```

## Push Commands

After creating empty GitHub repositories:

```bash
git push git@github.com:UTXOpia/utxopia-sdk.git split/sdk-main:main
git push git@github.com:UTXOpia/utxopia-circuits.git split/circuits:main
git push git@github.com:UTXOpia/utxopia-solana-programs.git split/solana-programs:main
git push git@github.com:UTXOpia/utxopia-web.git split/web:main
git push git@github.com:UTXOpia/utxopia-backend.git split/backend:main
```

For grouped repos, initialize and push from `/tmp/utxopia-split/<repo>` after
reviewing copied files.

## Package Rewiring

After the SDK repo exists:

- Replace `@utxopia/sdk: "file:../sdk"` in `web/package.json` with a versioned
  package or GitHub package reference.
- Replace `workspace:*` references for `@utxopia/sdk-core`,
  `@utxopia/sdk-sui`, and `@utxopia/btc-client` with published versions.
- Move package build/test scripts from the root monorepo into each new repo.
- Keep `bun.lock` local to each repo after dependency boundaries are stable.

## Verification Per Repo

| Repository | Verification |
| --- | --- |
| `utxopia-sdk` | `bun install`, `bun run build`, `bun test` |
| `utxopia-circuits` | `bun install`, `bash scripts/compile.sh`, `bun test` |
| `utxopia-solana-programs` | `cargo test`, `bun run test`, `cargo build-sbf --features devnet` |
| `utxopia-sui-programs` | `sui move build`, `sui move test`, `bun test chains/sui/indexer/test` |
| `utxopia-web` | `bun install`, `bun run build`, `bun test src/` |
| `utxopia-backend` | `cargo test`, `cargo run --bin zkbtc-api -- --help` |

## Recommended First Execution

Start with these target repos:

```text
UTXOpia/utxopia-sdk
UTXOpia/utxopia-circuits
UTXOpia/utxopia-solana-programs
UTXOpia/utxopia-sui-programs
UTXOpia/utxopia-web
UTXOpia/utxopia-backend
UTXOpia/utxopia-ops
```

Once those repositories exist, run the subtree splits for single-directory repos
and use the clean grouped copy for SDK, Sui, and ops.
