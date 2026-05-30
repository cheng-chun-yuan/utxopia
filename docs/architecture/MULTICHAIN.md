# UTXOpia Multichain Architecture

UTXOpia should evolve into a protocol-level project with chain-specific
implementations behind a shared note, proof, indexer, and SDK model.

The current repository remains the staging monorepo while the Sui version is
designed and built. After the Sui implementation proves its boundaries, the
project can split into organization repositories without guessing too early.

## Target Organization

Recommended GitHub organization:

```text
utxopia-labs/
```

Recommended long-term repositories:

```text
utxopia-protocol   Protocol specs, cryptography docs, note model, proof model
utxopia-circuits   Circom circuits, proving keys, verifier exports
utxopia-solana     Pinocchio programs, Solana deploy scripts, Solana workers
utxopia-sui        Sui Move package, Ika integration, Sui deploy scripts
utxopia-sdk        Multichain TypeScript SDK
utxopia-indexer    Chain ingestion, normalized event store, API
utxopia-web        Frontend app with chain adapters
utxopia-infra      Docker, deployment, monitoring, RPC configuration
utxopia-docs       Public documentation
```

## Staging Monorepo Layout

During the transition, new multichain work should live in additive directories:

```text
chains/
  sui/
    contracts/
    indexer/
    scripts/

packages/
  sdk-core/
  shared-crypto/

docs/
  architecture/
  chains/
```

Existing Solana code should stay in place until the adapter boundary is stable.
Moving production code before the new interfaces settle creates unnecessary
merge risk.

## Shared Protocol Surface

These concepts are chain-independent and should be specified once:

| Area | Shared Contract |
| --- | --- |
| Notes | Note encoding, note keys, encrypted payload format |
| Commitments | `Poseidon(npk, token_id, amount)` |
| Nullifiers | `Poseidon(nullifying_key, leaf_index)` |
| Proofs | JoinSplit public/private inputs and verifier artifact metadata |
| Stealth | Spending, nullifying, viewing, and one-time note public keys |
| Tokens | Canonical token IDs and decimal metadata |
| Redemption | BTC destination, amount, fee, prevout, and sighash policy |
| Indexing | Normalized event names and cursor/checkpoint model |
| SDK | Chain adapter interface and common note wallet behavior |

## Chain-Specific Surface

These areas must remain chain-specific:

| Solana | Sui |
| --- | --- |
| Pinocchio programs | Sui Move package |
| PDA account model | Object, dynamic field, and event model |
| Solana transaction builder | Sui PTB transaction builder |
| Ika CPI approval path | Ika `DWalletCap`/Move approval path |
| RPC log/account ingestion | Sui event/checkpoint ingestion |
| BPF deployment | Sui package publish/upgrade |
| Signer/PDA authority checks | Capability-object authority checks |

Sui package design should follow Sui's object model rather than emulate Solana
accounts. Shared protocol state should be explicit shared objects, privileged
actions should require owned capability objects, and multi-step user actions
should be composed as programmable transaction blocks (PTBs).

## SDK Boundary

The web app and backend should depend on a protocol adapter, not directly on a
specific chain client.

```ts
export interface UTXOpiaChainAdapter {
  readonly chain: "solana" | "sui";

  getPoolState(): Promise<PoolState>;
  getLatestMerkleRoot(): Promise<MerkleRoot>;
  getNotes(input: NoteScanInput): Promise<Note[]>;

  buildShieldTransaction(input: ShieldInput): Promise<UnsignedTransaction>;
  buildTransactTransaction(input: TransactInput): Promise<UnsignedTransaction>;
  buildRedemptionTransaction(input: RedemptionInput): Promise<UnsignedTransaction>;

  submitTransaction(tx: SignedTransaction): Promise<TransactionResult>;
}
```

Adapters may return different transaction envelopes per chain. Solana builders
produce Solana transaction bytes or versioned transaction messages; Sui builders
produce PTB bytes plus the object IDs, package ID, and checkpoint/event cursor
metadata needed for confirmation and indexing. The shared interface should keep
those envelopes discriminated by `chain` instead of flattening them into one
opaque byte format.

## Migration Phases

1. Create additive Sui scaffolding in the current repository.
2. Define shared SDK interfaces and normalized indexer event types.
3. Build a minimal Sui Move package with pool, event, nullifier, and redemption
   modules.
4. Build a Sui indexer prototype that reads package events and stores normalized
   commitments, nullifiers, roots, and redemptions.
5. Model Sui user flows as PTBs, especially shield, transact, and redemption
   request flows that need atomic composition.
6. Build `sdk-sui` against the shared adapter interface.
7. Add a Sui adapter to the web app.
8. Run an end-to-end Sui flow on localnet/testnet.
9. Split repositories under `utxopia-labs` once the Sui implementation has
   stable contracts, SDK APIs, indexer schemas, and deployment scripts.

## Split Criteria

Do not split into multiple repositories until all of these are true:

- Sui contracts have a stable package layout.
- Sui SDK transaction builders are usable by the web app.
- Indexer event schemas are shared across Solana and Sui.
- CI can test protocol packages independently from chain packages.
- Deployment scripts are chain-specific and no longer share mutable state files.
