# Sui Implementation Plan

The Sui version is a new chain implementation of the UTXOpia protocol, not a
line-by-line port of the Solana program. Sui Move uses objects, capability
objects, dynamic fields, programmable transaction blocks (PTBs), and events
where the Solana implementation uses PDAs, signer checks, accounts, CPIs, and
logs.

## Initial Package Scope

The first Sui Move package should implement:

| Module | Purpose |
| --- | --- |
| `pool` | Shared pool object, pause state, admin capability |
| `btc_light_client` | Verified BTC deposit object boundary; production SPV verifier should create these objects |
| `merkle` | Package-internal commitment insertion and root updates |
| `nullifier` | Nullifier registry using object storage/dynamic fields |
| `notes` | Commitment insertion and note events |
| `redemption` | BTC withdrawal request and completion state |
| `ika_policy` | Optional policy event before native Ika signing authorization |
| `verifier` | Groth16 BN254 prepared verification-key registry and proof gate |
| `transact` | JoinSplit verification, nullifier spend, output commitment insertion |
| `events` | Stable event structs for indexers |

## Object And Capability Model

The package should not model authority as plain address checks unless there is a
specific reason. Prefer capability objects because ownership is enforced by Sui
at the object layer.

Initial objects:

| Object | Ownership | Purpose |
| --- | --- | --- |
| `Pool` | Shared | Pool state, pause flag, config, current tree metadata |
| `MerkleTree` | Shared or owned by `Pool` | Commitment tree state |
| `AdminCap` | Address-owned | Pause/unpause and config updates |
| `UpgradeCap` | Address-owned | Package upgrade control |
| `RedemptionCap` | Address-owned or controlled object | Interim authority for redemption request/completion workers until proof-burning redemption lands |
| `DWalletPolicyCap` | Optional Ika-controlled/capability flow | Authorize Ika signing after policy checks |

Shared objects are publicly accessible, so every mutating entry function must
enforce protocol rules internally. Owned capability objects should gate admin,
upgrade, and privileged worker paths.

## MVP Instructions

1. `initialize_pool`
2. `complete_verified_deposit` consuming `VerifiedBtcDeposit`
3. `transact`
4. `request_redemption` with `RedemptionCap` until a proof-burning Sui path lands
5. `complete_redemption`
6. `set_paused`
7. `update_pool_config`
8. `register_prepared_key`
9. `verify_join_split`

## PTB Design

Client flows should be designed as PTBs instead of one-instruction equivalents:

| Flow | PTB Shape |
| --- | --- |
| BTC deposit | production BTC verifier creates `VerifiedBtcDeposit`, then `complete_verified_deposit` consumes it and emits commitment event |
| Private transfer | prepare proof inputs, spend nullifiers, insert output commitments |
| BTC redemption | interim path uses `RedemptionCap`; production path must spend a note/nullifier before creating the request |
| Completion | fetch redemption object/event state, have the relayer sign/broadcast BTC, complete request with `RedemptionCap` |

The SDK should expose PTB builders so the web app can compose wallet, coin, and
UTXOpia calls atomically where Sui allows it.

## Ika Integration

The default Sui regtest path uses a relayer/local signer so app and indexer
work can continue without testnet IKA. Native Ika signing remains the intended
production hardening path once testnet IKA and dWallet setup are available.

For the Ika path, the design should be based on Ika-controlled dWallet
objects/capabilities. The Sui package should own the redemption policy and
authorize signing only after these checks pass:

- pool is not paused
- redemption request exists and is uncompleted
- BTC sighash is bound to the redemption request
- destination script matches the requested BTC address
- input UTXOs match approved custody UTXOs
- amount and fee are within policy caps
- replay protection is enforced

## Proof Verification

Sui 1.73 includes `sui::groth16` with BN254 support. The current package has a
`verifier` module that stores prepared Groth16 verification keys and verifies
proof points against public inputs through `sui::groth16::verify_groth16_proof`.

Current constraints:

- Sui's Groth16 wrapper currently limits public inputs to 8.
- Existing JoinSplit variants with `nPublic <= 8` can fit the native interface.
- Existing variants with 9 public inputs need circuit public-input packing,
  arity limits on Sui, or a different verification backend.
- The registry expects Sui/Arkworks prepared verifying-key bytes, not the raw
  snarkjs JSON format.

Immediate follow-ups:

1. Use `tools/sui-groth16-exporter` to convert snarkjs verification keys and
   proofs into Arkworks compressed bytes accepted by `sui::groth16`.
2. Register exported `rawVerifyingKey` bytes with `verifier::register_raw_key`.
3. Keep `verify_join_split` on `transact`; add proof-burning redemption before production use.
4. Decide whether the Sui launch supports only `nPublic <= 8` circuits or
   repacks the circuit public inputs for larger JoinSplit arities.

Reference implementation checked: `SoundnessLabs/sp1-sui`, which uses the same
Arkworks BN254 serialization path before calling Sui's Groth16 verifier.

Current hardening note: public callers cannot directly insert commitments or set
arbitrary roots. BTC deposit no longer requires `AdminCap`; it consumes a
`VerifiedBtcDeposit` object created by the BTC verification boundary. That
mirrors the Solana split where the BTC light client creates a verified
transaction PDA and UTXOpia consumes it. The package does not expose a
cap-gated recorder for this object. Full production parity requires the Sui BTC
verifier module to create `VerifiedBtcDeposit` only after header/merkle SPV
validation and after binding the post-state root.

Exporter example:

```bash
cargo run --manifest-path tools/sui-groth16-exporter/Cargo.toml -- \
  vkey --input circuits/build/joinsplit_1x1/joinsplit_1x1.vkey.json
```

The output contains:

- `nPublic`
- `rawVerifyingKey`
- `vkHash`

## Event Model

The Sui indexer should consume stable events instead of inspecting private
object internals where possible:

```text
PoolCreated
CommitmentInserted
MerkleRootUpdated
NullifierSpent
RedemptionRequested
RedemptionCompleted
PoolPaused
PoolConfigUpdated
IkaSigningApproved
VerifyingKeyRegistered
JoinSplitVerified
```

Events should include enough IDs for object/event indexing:

- package ID
- pool object ID
- leaf index or nullifier key
- Merkle root index
- redemption ID
- transaction digest/checkpoint cursor from the indexer side

## Local Development Commands

Expected commands once the package is filled in:

```bash
cd chains/sui/contracts
sui move test
sui client publish
```
