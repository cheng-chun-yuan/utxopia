# Sui Ika dWallet Setup

This guide sets up the native Sui Ika path used for real BTC withdrawal signing.

`sui-regtest` means Bitcoin regtest plus Sui testnet. Ika is also testnet in this mode.

## What This Enables

Without Ika, the Sui flow can still test:

- zkLogin and passkey login
- `utxo:` private vault key derivation
- Sui vault UI
- Sui explorer indexing
- deposit, transfer, and redemption queue POC transactions

With Ika, the relayer can use a Sui-owned dWallet capability to request the real cross-chain signing path for BTC withdrawal transactions.

## Current Relayer

The current relayer configured in `chains/sui/sui-poc-state.json` is:

```text
0x0517834683ffa77da332b1f1f7a79d17e419d007f71e0fc68595704d6edda4d1
```

The IKA coin type discovered for Ika testnet is:

```text
0x1f26bb2f711ff82dcda4d02c77d5123089cb7f8418751474b9fb744ce031526a::ika::IKA
```

## Required Env Values

These values are written by `scripts/sync-env.sh` after discovery succeeds:

```bash
UTXOPIA_SUI_IKA_DWALLET_ID=
UTXOPIA_SUI_IKA_DWALLET_CAP_ID=
UTXOPIA_SUI_IKA_COIN_ID=
UTXOPIA_SUI_IKA_SUI_COIN_ID=
UTXOPIA_SUI_IKA_NETWORK_ENCRYPTION_KEY_ID=
```

The current local state already has:

```bash
UTXOPIA_SUI_IKA_NETWORK_ENCRYPTION_KEY_ID=0xe7c79a60931299e110297554fc02e0a0e095e96778775092c97f07a1bd1337cc
UTXOPIA_SUI_IKA_SUI_COIN_ID=0x5221537fd86d7ac924cf19d25d35dfd3238b685ad038f603e98c1bd365939ec8
```

The current blockers are:

```bash
UTXOPIA_SUI_IKA_DWALLET_ID=
UTXOPIA_SUI_IKA_DWALLET_CAP_ID=
UTXOPIA_SUI_IKA_COIN_ID=
```

## Step 1: Fund Relayer With Testnet IKA

The relayer must own at least one `Coin<IKA>` object on Sui testnet. The import and signing calls consume IKA as the Ika network payment coin.

Send testnet IKA to:

```text
0x0517834683ffa77da332b1f1f7a79d17e419d007f71e0fc68595704d6edda4d1
```

If you do not already have testnet IKA, request it from the Ika testnet faucet or Ika team/community. A Sui faucet only gives `Coin<SUI>`, not `Coin<IKA>`.

After funding, verify discovery sees it:

```bash
UTXOPIA_SUI_IKA_AUTO_SELECT=1 bun run sui:ika:discover
```

Expected result:

```json
"ikaCoins": [
  {
    "coinObjectId": "0x...",
    "balance": "..."
  }
]
```

## Step 2: Import a BTC Signing Key Into Ika

Use a test-only 32-byte secp256k1 private key. Do not import a mainnet key or any key that controls real funds.

Generate a test key:

```bash
openssl rand -hex 32
```

Run the import:

```bash
UTXOPIA_SUI_IKA_IMPORT_PRIVATE_KEY_HEX=<32-byte hex key> \
  bun run sui:ika:import-key
```

The script will:

1. Read the active Sui relayer key from `~/.sui/sui_config/sui.keystore`.
2. Use `UTXOPIA_SUI_IKA_COIN_ID` as the `Coin<IKA>` payment.
3. Use `UTXOPIA_SUI_IKA_SUI_COIN_ID` as the `Coin<SUI>` payment.
4. Request imported-key dWallet verification.
5. Save the imported dWallet capability into `chains/sui/sui-poc-state.json`.

It also creates or reuses:

```text
chains/sui/.secrets/ika-user-share-keys.hex
```

Keep that file private. It is part of the imported-key signing setup.

## Step 3: Discover dWallet IDs

After import:

```bash
UTXOPIA_SUI_IKA_AUTO_SELECT=1 bun run sui:ika:discover
```

Expected result:

```json
"suggestedEnv": {
  "UTXOPIA_SUI_IKA_DWALLET_ID": "0x...",
  "UTXOPIA_SUI_IKA_DWALLET_CAP_ID": "0x...",
  "UTXOPIA_SUI_IKA_COIN_ID": "0x...",
  "UTXOPIA_SUI_IKA_SUI_COIN_ID": "0x..."
}
```

## Step 4: Sync Env Files

```bash
UTXOPIA_NETWORK=sui-regtest ./scripts/sync-env.sh
```

This regenerates:

- `backend/.env.sui-regtest`
- `web/.env.sui-regtest`
- `web/src/lib/networks.json`

Check the result:

```bash
rg 'UTXOPIA_SUI_IKA_(DWALLET_ID|DWALLET_CAP_ID|COIN_ID|SUI_COIN_ID|NETWORK_ENCRYPTION_KEY_ID)' backend/.env.sui-regtest
```

All five values should be non-empty.

## Step 5: Deploy Runtime Env

For Vercel, only frontend-safe values belong in Vercel. dWallet capability and Ika payment coins are backend/relayer config, not browser secrets.

Backend/relayer env needs:

```bash
UTXOPIA_SUI_IKA_DWALLET_ID=<discovered>
UTXOPIA_SUI_IKA_DWALLET_CAP_ID=<discovered>
UTXOPIA_SUI_IKA_COIN_ID=<discovered>
UTXOPIA_SUI_IKA_SUI_COIN_ID=<discovered>
UTXOPIA_SUI_IKA_NETWORK_ENCRYPTION_KEY_ID=<discovered>
```

Frontend Vercel env still needs zkLogin values:

```bash
NEXT_PUBLIC_GOOGLE_CLIENT_ID=<Google Web OAuth client id>
NEXT_PUBLIC_ZKLOGIN_REDIRECT_URI=https://app.utxopia.com/vault?chain=sui
ZKLOGIN_SALT_SECRET=<stable random server secret>
```

## Troubleshooting

### `UTXOPIA_SUI_IKA_COIN_ID missing`

The relayer does not own a testnet `Coin<IKA>`. Fund the relayer with testnet IKA, then rerun:

```bash
UTXOPIA_SUI_IKA_AUTO_SELECT=1 bun run sui:ika:discover
```

### `UTXOPIA_SUI_IKA_IMPORT_PRIVATE_KEY_HEX is required`

Set a 32-byte secp256k1 private key hex for test import:

```bash
UTXOPIA_SUI_IKA_IMPORT_PRIVATE_KEY_HEX=$(openssl rand -hex 32) bun run sui:ika:import-key
```

Use a stable test key if you need the resulting BTC address to remain stable across runs.

### No `dWalletCap` after import

Wait for the transaction to finalize, then rerun:

```bash
UTXOPIA_SUI_IKA_AUTO_SELECT=1 bun run sui:ika:discover
```

If it is still empty, inspect the import transaction digest printed by `sui:ika:import-key`.
