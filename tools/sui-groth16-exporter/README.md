# Sui Groth16 Exporter

Converts `snarkjs` Groth16 artifacts into the Arkworks compressed byte format
accepted by Sui's native `sui::groth16` module.

References:

- Sui framework: `sui::groth16`
- `SoundnessLabs/sp1-sui`, which uses the same Arkworks-to-Sui byte path.

## Export A Verification Key

```bash
cargo run --manifest-path tools/sui-groth16-exporter/Cargo.toml -- \
  vkey --input circuits/build/joinsplit_2x2/joinsplit_2x2.vkey.json
```

Output:

```json
{
  "nPublic": 6,
  "rawVerifyingKey": "...",
  "vkHash": "..."
}
```

Use `rawVerifyingKey` with `verifier::register_raw_key`; the Sui contract calls
`sui::groth16::prepare_verifying_key` on-chain.

## Export A Proof

```bash
cargo run --manifest-path tools/sui-groth16-exporter/Cargo.toml -- \
  proof --proof proof.json --public public.json
```

`public.json` must be an array of decimal public signals from `snarkjs`.

