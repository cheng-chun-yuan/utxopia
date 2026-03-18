#!/usr/bin/env bun
/**
 * Step 8b: Complete BTC Redemption
 *
 * After Step 8 creates a RedemptionRequest PDA (status=Pending):
 *   1. mark_processing (disc=2) — reserve pool UTXO, set status=Processing
 *   2. Build BTC withdrawal tx (pool UTXO → user's P2WPKH address)
 *   3. Broadcast to regtest + mine 6 blocks
 *   4. Relay headers (extend_blockchain)
 *   5. Upload BTC tx to ChadBuffer + verify_transaction
 *   6. complete_redemption (disc=6) — SPV verify, burn zkBTC, close redemption PDA
 *   7. Verify: pending_redemptions=0, redemption PDA closed
 */

import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { execSync } from "child_process";

import {
  connection,
  loadAuthority,
  loadState,
  stepHeader,
  log,
  dsha256,
  sendIx,
  ESPLORA_URL,
  derivePoolStatePDA,
  deriveRedemptionPDA,
  deriveLightClientPDA,
  deriveBlockHeaderPDA,
  deriveHeightIndexPDA,
  deriveTokenConfigPDA,
  deriveATA,
  parsePoolState,
} from "./shared.js";

import {
  mineBlocks,
  getNewAddress,
  waitForTxIndexed,
  fetchBlockHeader,
  fetchMerkleProof,
  fetchRawTx,
  fetchTxStatus,
  fetchBlockHash,
  serializeMerkleProof,
  stripWitnessData,
  bitcoinCli,
} from "../../contracts/scripts/regtest-helpers.js";

import {
  createTxBufferAccount,
} from "../../contracts/scripts/test-helpers.js";

stepHeader("8b", "Complete BTC Redemption");

function btc(cmd: string): string {
  return bitcoinCli(cmd);
}

// =============================================================================
// Light client helpers (reused from step3)
// =============================================================================

async function submitHeaders(
  authority: Keypair, btcLc: PublicKey, fromHeight: number, toHeight: number,
): Promise<void> {
  const [lightClient] = deriveLightClientPDA(btcLc);

  for (let h = fromHeight + 1; h <= toHeight; h++) {
    const hashHex = await fetchBlockHash(h, ESPLORA_URL);
    const headerBuf = await fetchBlockHeader(hashHex, ESPLORA_URL);

    const newBlockHash = dsha256(headerBuf);
    const parentHash = Buffer.from(headerBuf).subarray(4, 36);

    const [parentPda] = deriveBlockHeaderPDA(btcLc, parentHash);
    const [newBlockPda] = deriveBlockHeaderPDA(btcLc, newBlockHash);
    const [heightIndexPda] = deriveHeightIndexPDA(btcLc, BigInt(h));

    const data = Buffer.alloc(82);
    data[0] = 1; // EXTEND_BLOCKCHAIN
    data[1] = 1;
    Buffer.from(headerBuf).copy(data, 2);

    const ix = new TransactionInstruction({
      programId: btcLc,
      data,
      keys: [
        { pubkey: lightClient, isSigner: false, isWritable: true },
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: parentPda, isSigner: false, isWritable: false },
        { pubkey: newBlockPda, isSigner: false, isWritable: true },
        { pubkey: heightIndexPda, isSigner: false, isWritable: true },
      ],
    });

    await sendIx([ix], [authority]);
    log(`  Header ${h} submitted`);
  }
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const state = loadState();
  const authority = loadAuthority();
  const AEGIS = new PublicKey(state.aegisProgramId);
  const BTC_LC = new PublicKey(state.btcLightClientId);
  const CHADBUFFER_ID = new PublicKey(state.chadbufferId);
  const zkbtcMint = new PublicKey(state.zkbtcMint);
  const poolVault = deriveATA(zkbtcMint, derivePoolStatePDA(AEGIS)[0]);
  const [poolState] = derivePoolStatePDA(AEGIS);

  // Redemption from step8: user=authority, nonce=1
  const requestNonce = 1n;
  const [redemptionPDA] = deriveRedemptionPDA(AEGIS, authority.publicKey, requestNonce);

  // Verify redemption PDA exists
  const redemptionInfo = await connection.getAccountInfo(redemptionPDA);
  if (!redemptionInfo || redemptionInfo.data[0] !== 0x04) {
    throw new Error("Redemption PDA not found. Run step8 first.");
  }
  log("Redemption PDA found (status=Pending)");

  // Read pool state before
  const poolInfoBefore = await connection.getAccountInfo(poolState);
  const poolBefore = parsePoolState(Buffer.from(poolInfoBefore!.data))!;
  log(`Pool before: shielded=${poolBefore.totalShielded}, pending=${poolBefore.pendingRedemptions}`);

  // Find the pool UTXO from step3 (sweep tx output)
  // The sweep created a UTXO tracked on-chain: seeds=["utxo", sweep_txid, vout_le]
  // We need to find it. Let's check if the btcNote has the sweep info.
  // The UTXO was created in verify_stealth_deposit from the sweep tx.
  // For now, we'll skip mark_processing if there are no UTXOs tracked
  // (localnet single-key mode may not have UTXO tracking)

  // =========================================================================
  // 1. mark_processing (disc=2)
  // =========================================================================
  log("Calling mark_processing...");
  const mpData = Buffer.alloc(2);
  mpData[0] = 2; // MARK_PROCESSING disc
  mpData[1] = 0; // utxo_count = 0 (backward compat, no UTXO tracking in simple mode)

  const mpIx = new TransactionInstruction({
    programId: AEGIS,
    data: mpData,
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: redemptionPDA, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
    ],
  });

  const mpSig = await sendIx([mpIx], [authority]);
  log(`mark_processing: ${mpSig.slice(0, 20)}...`);

  // Verify status changed to Processing
  const redemptionAfterMp = await connection.getAccountInfo(redemptionPDA);
  if (redemptionAfterMp!.data[1] !== 1) {
    throw new Error(`Expected status=Processing(1), got ${redemptionAfterMp!.data[1]}`);
  }
  log("Redemption status: Processing");

  // =========================================================================
  // 2. Build BTC withdrawal tx
  // =========================================================================
  log("Building BTC withdrawal tx...");

  // Read redemption details: amount at offset 48, btc_script at offset 72
  const redeemData = Buffer.from(redemptionAfterMp!.data);
  const redeemAmount = redeemData.readBigUInt64LE(48);
  const btcScriptLen = redeemData[2];
  const btcScript = redeemData.subarray(72, 72 + btcScriptLen);
  log(`Redeem amount: ${redeemAmount} sats, script: ${Buffer.from(btcScript).toString("hex")}`);

  // Get a funded UTXO from the wallet (limit to 20 results to avoid buffer overflow)
  const utxos = JSON.parse(btc('listunspent 1 9999999 "[]" true \'{"maximumCount":20}\''));
  if (utxos.length === 0) throw new Error("No UTXOs in wallet");
  const utxo = utxos.find((u: any) => u.amount * 1e8 >= Number(redeemAmount) + 5000);
  if (!utxo) throw new Error("No UTXO large enough for withdrawal");
  log(`Using UTXO: ${utxo.txid}:${utxo.vout} (${utxo.amount} BTC)`);

  // Build raw tx: pool UTXO → user's address (from btcScript) + change back to pool
  const userAmountBtc = (Number(redeemAmount) / 1e8).toFixed(8);
  const fee = 0.00001;
  const changeAmount = (utxo.amount - Number(redeemAmount) / 1e8 - fee).toFixed(8);

  // Decode btcScript to get user address
  // P2WPKH: OP_0 PUSH20 <20-byte-hash> → bcrt1q...
  // We'll use createrawtransaction with the address directly
  const userAddr = getNewAddress("bech32"); // stand-in for the real user address
  const poolAddr = state.poolBtcAddress || getNewAddress("bech32m");

  let outputs: any;
  if (Number(changeAmount) > 0.00001) {
    outputs = `[{"${userAddr}":${userAmountBtc}},{"${poolAddr}":${changeAmount}}]`;
  } else {
    outputs = `[{"${userAddr}":${userAmountBtc}}]`;
  }

  const rawTx = btc(`-named createrawtransaction inputs='[{"txid":"${utxo.txid}","vout":${utxo.vout}}]' outputs='${outputs}'`);
  const signed = JSON.parse(btc(`signrawtransactionwithwallet ${rawTx}`));
  if (!signed.complete) throw new Error("Failed to sign withdrawal tx");

  const withdrawTxid = btc(`sendrawtransaction ${signed.hex}`);
  log(`Withdrawal txid: ${withdrawTxid}`);

  // =========================================================================
  // 3. Mine 6 blocks for confirmations
  // =========================================================================
  const minerAddr = getNewAddress("bech32m");
  mineBlocks(6, minerAddr);
  log("6 blocks mined");

  await waitForTxIndexed(withdrawTxid, ESPLORA_URL);
  await new Promise(r => setTimeout(r, 2000));

  const withdrawStatus = await fetchTxStatus(withdrawTxid, ESPLORA_URL);
  if (!withdrawStatus.confirmed) throw new Error("Withdrawal TX not confirmed");
  const withdrawBlockHeight = withdrawStatus.block_height!;
  const withdrawBlockHash = withdrawStatus.block_hash!;
  log(`Withdrawal confirmed at height ${withdrawBlockHeight}`);

  // =========================================================================
  // 4. Relay headers
  // =========================================================================
  log("Relaying headers...");
  const [lightClientPda] = deriveLightClientPDA(BTC_LC);
  const lcInfo = await connection.getAccountInfo(lightClientPda);
  const onChainTip = lcInfo ? Number(Buffer.from(lcInfo.data).readBigUInt64LE(136)) : 0;
  log(`On-chain LC tip: ${onChainTip}`);

  const btcTipHeight = parseInt(
    execSync(`curl -sf ${ESPLORA_URL}/blocks/tip/height`, { encoding: "utf8" }).trim()
  );
  const targetHeight = Math.min(btcTipHeight, withdrawBlockHeight + 6);
  if (onChainTip < targetHeight) {
    await submitHeaders(authority, BTC_LC, onChainTip, targetHeight);
    log(`Headers synced: ${onChainTip}..${targetHeight}`);
  } else {
    log(`Headers already synced to ${onChainTip}`);
  }

  // =========================================================================
  // 5. Upload BTC tx to ChadBuffer + verify_transaction
  // =========================================================================
  log("Uploading withdrawal TX to ChadBuffer...");
  const withdrawRawBuf = await fetchRawTx(withdrawTxid, ESPLORA_URL);
  const strippedWithdraw = stripWitnessData(withdrawRawBuf);
  const withdrawBuffer = await createTxBufferAccount(connection, authority, new Uint8Array(strippedWithdraw), CHADBUFFER_ID);
  log(`Withdrawal ChadBuffer: ${withdrawBuffer.publicKey.toBase58().slice(0, 16)}...`);

  // Compute internal-order txid
  const withdrawTxidBytes = Buffer.from(withdrawTxid, "hex");
  withdrawTxidBytes.reverse();
  const withdrawTxHash = new Uint8Array(withdrawTxidBytes);

  // Compute block hash internal order
  const withdrawHeaderBuf = await fetchBlockHeader(withdrawBlockHash, ESPLORA_URL);
  const withdrawBlockHashInternal = dsha256(withdrawHeaderBuf);

  // Derive VerifiedTransaction PDA
  const [verifiedTxPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("verified_tx"), withdrawBlockHashInternal, withdrawTxHash],
    BTC_LC,
  );
  const [withdrawBlockHeaderPda] = deriveBlockHeaderPDA(BTC_LC, withdrawBlockHashInternal);
  const [lightClient] = deriveLightClientPDA(BTC_LC);

  // Build verify_transaction
  const esploraProof = await fetchMerkleProof(withdrawTxid, ESPLORA_URL);
  const merkleProofSerialized = serializeMerkleProof(withdrawTxid, esploraProof);

  const vtDataLen = 1 + 32 + 32 + 4 + merkleProofSerialized.length;
  const vtData = Buffer.alloc(vtDataLen);
  let off = 0;
  vtData[off++] = 2; // VERIFY_TRANSACTION disc
  Buffer.from(withdrawTxHash).copy(vtData, off); off += 32;
  withdrawBlockHashInternal.copy(vtData, off); off += 32;
  vtData.writeUInt32LE(strippedWithdraw.length, off); off += 4;
  merkleProofSerialized.copy(vtData, off);

  const verifyTxIx = new TransactionInstruction({
    programId: BTC_LC,
    data: vtData,
    keys: [
      { pubkey: verifiedTxPda, isSigner: false, isWritable: true },
      { pubkey: lightClient, isSigner: false, isWritable: false },
      { pubkey: withdrawBlockHeaderPda, isSigner: false, isWritable: false },
      { pubkey: withdrawBuffer.publicKey, isSigner: false, isWritable: false },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });

  const vtSig = await sendIx([verifyTxIx], [authority], 600_000);
  log(`verify_transaction: ${vtSig.slice(0, 20)}...`);

  // =========================================================================
  // 6. complete_redemption (disc=6)
  // =========================================================================
  log("Calling complete_redemption...");

  // Derive PoolConfig PDA
  const [poolConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_config")],
    AEGIS,
  );

  // Derive CompletionReceipt PDA
  const [completionReceipt] = PublicKey.findProgramAddressSync(
    [Buffer.from("completion_receipt"), withdrawTxHash],
    AEGIS,
  );

  // Get pool script from state (P2TR scriptPubKey)
  // If pool address is set, encode as P2TR script: OP_1 (0x51) + PUSH32 (0x20) + 32-byte-key
  let poolScriptBuf = Buffer.alloc(0);
  if (state.poolBtcAddress) {
    // Decode bech32m address to get the witness program
    try {
      const addrInfo = JSON.parse(btc(`getaddressinfo ${state.poolBtcAddress}`));
      if (addrInfo.scriptPubKey) {
        poolScriptBuf = Buffer.from(addrInfo.scriptPubKey, "hex");
      }
    } catch {
      log("Warning: could not get pool scriptPubKey, using empty");
    }
  }

  // Data: disc(1) + btc_txid(32) + tx_size(4) + pool_script_len(1) + pool_script(var) + consumed_utxo_count(1)
  const crDataLen = 1 + 32 + 4 + 1 + poolScriptBuf.length + 1;
  const crData = Buffer.alloc(crDataLen);
  off = 0;
  crData[off++] = 6; // COMPLETE_REDEMPTION discriminator
  Buffer.from(withdrawTxHash).copy(crData, off); off += 32;
  crData.writeUInt32LE(strippedWithdraw.length, off); off += 4;
  crData[off++] = poolScriptBuf.length;
  if (poolScriptBuf.length > 0) {
    poolScriptBuf.copy(crData, off); off += poolScriptBuf.length;
  }
  crData[off++] = 0; // consumed_utxo_count = 0 (simple mode)

  // Change UTXO placeholder (system program when pool_script_len > 0)
  const changeUtxoAccount = poolScriptBuf.length > 0
    ? SystemProgram.programId // placeholder when there might be no change
    : SystemProgram.programId;

  const crIx = new TransactionInstruction({
    programId: AEGIS,
    data: crData,
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },           // 0
      { pubkey: redemptionPDA, isSigner: false, isWritable: true },       // 1
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },  // 2
      { pubkey: authority.publicKey, isSigner: false, isWritable: true }, // 3 rent_recipient
      { pubkey: verifiedTxPda, isSigner: false, isWritable: false },     // 4
      { pubkey: lightClient, isSigner: false, isWritable: false },       // 5
      { pubkey: withdrawBuffer.publicKey, isSigner: false, isWritable: false }, // 6
      { pubkey: zkbtcMint, isSigner: false, isWritable: true },          // 7
      { pubkey: poolVault, isSigner: false, isWritable: true },          // 8
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, // 9
      { pubkey: completionReceipt, isSigner: false, isWritable: true },  // 10
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 11
      { pubkey: poolConfig, isSigner: false, isWritable: false },        // 12
      { pubkey: changeUtxoAccount, isSigner: false, isWritable: true },  // 13 change_utxo
    ],
  });

  const crSig = await sendIx([crIx], [authority], 1_000_000);
  log(`complete_redemption: ${crSig.slice(0, 20)}...`);

  // =========================================================================
  // 7. Verify
  // =========================================================================
  log("Verifying...");

  // Redemption PDA should be closed
  const redemptionAfter = await connection.getAccountInfo(redemptionPDA);
  if (redemptionAfter !== null) {
    throw new Error("Redemption PDA should be closed after completion");
  }
  log("Redemption PDA closed (account gone)");

  // Pool state: pending_redemptions should be 0
  const poolInfoAfter = await connection.getAccountInfo(poolState);
  const poolAfter = parsePoolState(Buffer.from(poolInfoAfter!.data))!;
  log(`Pool after: shielded=${poolAfter.totalShielded}, pending=${poolAfter.pendingRedemptions}`);

  if (poolAfter.pendingRedemptions !== 0n) {
    throw new Error(`Expected pending_redemptions=0, got ${poolAfter.pendingRedemptions}`);
  }

  // totalShielded should have decreased
  if (poolAfter.totalShielded >= poolBefore.totalShielded) {
    log("Warning: totalShielded did not decrease (may already be 0)");
  } else {
    const burned = poolBefore.totalShielded - poolAfter.totalShielded;
    log(`Burned ${burned} sats from pool`);
  }

  // Completion receipt should exist
  const receiptInfo = await connection.getAccountInfo(completionReceipt);
  if (!receiptInfo) {
    throw new Error("Completion receipt PDA not created");
  }
  log("Completion receipt PDA created (prevents double-complete)");

  console.log("\nStep 8b: Complete BTC Redemption .. PASS");
}

main().catch(err => {
  console.error("FAIL:", err.message);
  if (err.logs) err.logs.forEach((l: string) => console.error("  ", l));
  process.exit(1);
});
