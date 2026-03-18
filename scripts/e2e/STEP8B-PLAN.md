# Step 8b: Complete BTC Redemption — Implementation Plan

## Goal
After Step 8 creates a RedemptionRequest PDA, complete the full withdrawal:
send real BTC on regtest → SPV verify → burn zkBTC on-chain.

## Flow
```
1. mark_processing (disc=17)
   - Accounts: poolState, redemptionPDA, authority, utxoPDAs...
   - Data: utxo_count(1)
   - Selects pool UTXOs, sets status=Processing

2. Build BTC withdrawal tx
   - Input: pool UTXO from Step 3 (sweep tx output)
   - Output: user's P2WPKH address (from redemption btcScript)
   - Output: pool change (if any)
   - Sign with pool private key (from localnet-state.json)

3. Broadcast to regtest
   - POST /regtest/api/tx (raw hex)
   - Mine 6 blocks for confirmations

4. Relay headers
   - Reuse submitHeaders() from Step 3
   - extend_blockchain instruction

5. Upload BTC tx to ChadBuffer + verify_transaction
   - Reuse createTxBufferAccount() from test-helpers
   - Call btc-light-client verify_transaction

6. complete_redemption (disc=6)
   - Data: btc_txid(32) + tx_size(4) + pool_script_len(1) + pool_script(34) + consumed_utxo_count(1)
   - Accounts (14+): poolState, redemptionPDA, authority, rentRecipient,
     verifiedTx, lightClient, txBuffer, zkbtcMint, poolVault,
     token2022, completionReceipt, system, poolConfig, changeUtxo, consumedUtxos...
   - Burns zkBTC, closes redemption PDA, emits RedemptionCompleted event

7. Verify
   - Pool state: pending_redemptions=0, total_shielded reduced
   - Redemption PDA closed (account gone)
   - zkBTC supply reduced
```

## Reusable from existing code
- `shared.ts`: deriveRedemptionPDA, derivePoolStatePDA, parsePoolState, sendIx, loadState
- `regtest-helpers.js`: mineBlocks, fetchRawTx, fetchBlockHeader, fetchMerkleProof, etc.
- `test-helpers.js`: createTxBufferAccount
- `step3-btc-deposit.ts`: submitHeaders() pattern, verify_transaction pattern
- SDK: buildCompleteRedemptionInstructionData (needs extending for pool_script + utxo_count)

## New helpers needed in shared.ts
- `deriveUtxoPDA(programId, txid, vout)` — UTXO record PDA
- `deriveCompletionReceiptPDA(programId, btcTxid)` — prevents double-complete
- `derivePoolConfigPDA(programId)` — pool config with on-chain pool_script
- `buildBtcWithdrawalTx(poolKey, utxo, recipientScript, amount, changeScript)` — build raw BTC tx

## Missing Disc values in shared.ts
```
MARK_PROCESSING: 17,
COMPLETE_REDEMPTION: 6,
```
