# Sui Core POC

The first Sui proof-of-concept should verify three core members before broader
app wiring:

1. Bitcoin deposit evidence can be parsed and mapped to UTXOpia note metadata.
2. JoinSplit proof transfer can be built and verified through Sui Groth16.
3. BTC withdrawal can request redemption and pass the Ika signing policy gate.
4. Redemption can be marked complete after the signing policy approval.

## Local Mechanical POC

Run:

```bash
bun run poc:sui-core
```

Current checks:

- Parses a 64-byte Bitcoin OP_RETURN deposit payload into `ephemeralPubkey` and
  `npk`.
- Exports an existing snarkjs JoinSplit verification key into Sui/Arkworks
  Groth16 bytes.
- Builds a Sui PTB for `transact::transact`.
- Builds a Sui PTB for `redemption::request_redemption`.
- Builds a Sui PTB for `ika_policy::approve_signing`.
- Builds a Sui PTB for `redemption::complete_redemption`.

This is the compile/build POC that proves the core paths have concrete code
surfaces without mutating a live network.

## Next Live POC

Replace the demo object refs and bytes with:

- published Sui package ID
- `Pool` shared object ID and initial shared version
- `NullifierRegistry` shared object ID and initial shared version
- `VerifyingKeyRegistry` shared object ID and initial shared version
- `RedemptionQueue` shared object ID and initial shared version
- `AdminCap` object ref
- exported real `rawVerifyingKey` and `vkHash`
- real `proofPoints` and `publicInputs`
- real Ika dWallet package/object/capability calls when the Sui-side Ika package
  interface is finalized
- regtest/testnet Bitcoin transaction evidence

## Live Script Order

These commands are chain-mutating once run against testnet/devnet/localnet.
Confirm the active Sui environment and funded address first:

```bash
sui client active-env
sui client active-address
```

Publish the package:

```bash
bun run sui:poc:deploy
```

Initialize shared objects:

```bash
bun run sui:poc:init
```

Export and stage a JoinSplit verification key:

```bash
bun run sui:poc:register-vkey joinsplit_1x1
```

The scripts write state to:

```text
chains/sui/sui-poc-state.json
```

Override with:

```bash
UTXOPIA_SUI_STATE_FILE=/path/to/state.json
```

Run the already-published state through the full live POC:

```bash
bun run sui:poc:all
```

This executes:

- `joinsplit_1x1` proof generation with snarkjs
- Sui-native Groth16 proof/public-input export
- input commitment insert
- `transact::transact`
- `redemption::request_redemption`
- `ika_policy::approve_signing`
- `redemption::complete_redemption`

For a fresh package publish, shared-object initialization, VK registration, and
the live flow in one command:

```bash
bun run sui:poc:fresh-all
```

`ika_policy::approve_signing` is currently the on-chain policy gate and event
surface. The final production step is replacing that placeholder event with the
real Sui-side Ika dWallet signing package call once that package/object API is
stable.

## Validation Commands

```bash
bun run test:sui
bun run poc:sui-core
```
