#!/usr/bin/env bun
/**
 * Step 4: Second BTC Deposit (for JoinSplit)
 *
 * Same flow as step 3 but reads the EXACT on-chain commitment and amount
 * from the stealth announcement event logs. This produces a spendable note.
 */

import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as crypto from "crypto";
import { execSync } from "child_process";

import {
  connection,
  loadAuthority,
  loadState,
  updateState,
  trackCommitments,
  stepHeader,
  log,
  Disc,
  ESPLORA_URL,
  bigintToBytes32BE,
  bytes32ToBigintBE,
  dsha256,
  sendIx,
  randomFieldElement,
  parseCommitmentTree,
  parseTokenConfig,
  derivePoolStatePDA,
  deriveCommitmentTreePDA,
  deriveLightClientPDA,
  deriveBlockHeaderPDA,
  deriveHeightIndexPDA,
  deriveTokenConfigPDA,
  parseStealthAnnouncementFromLogs,
} from "./shared.js";

import {
  createOpReturnTx,
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

stepHeader(4, "BTC Deposit 2 (for JoinSplit)");

function btc(cmd: string): string {
  return bitcoinCli(cmd);
}

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
    data[0] = 1; data[1] = 1;
    Buffer.from(headerBuf).copy(data, 2);
    const ix = new TransactionInstruction({
      programId: btcLc, data,
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

async function main() {
  const state = loadState();
  const authority = loadAuthority();
  const PRIVACY_COIN = new PublicKey(state.privacyCoinProgramId);
  const BTC_LC = new PublicKey(state.btcLightClientId);
  const CHADBUFFER_ID = new PublicKey(state.chadbufferId);
  const zkbtcMint = new PublicKey(state.zkbtcMint);
  const poolVault = new PublicKey(state.poolVault);
  const [poolState] = derivePoolStatePDA(PRIVACY_COIN);
  const [commitmentTree] = deriveCommitmentTreePDA(PRIVACY_COIN);
  const [zkbtcTokenConfig] = deriveTokenConfigPDA(PRIVACY_COIN, zkbtcMint);

  const { initPoseidon, computeNPKSync } = await import("../../sdk/dist/index.js");
  await initPoseidon();

  const mpk = BigInt("0x" + state.mpk!);
  const depositAmount = 30_000n;

  const random0 = randomFieldElement();
  const npk0 = computeNPKSync(mpk, random0);
  const npk0Bytes = bigintToBytes32BE(npk0);
  const ephPub = crypto.randomBytes(32);

  const treeInfo = await connection.getAccountInfo(commitmentTree);
  const treeData = parseCommitmentTree(Buffer.from(treeInfo!.data));
  const leafIndex0 = Number(treeData!.nextIndex);
  log(`Tree next_index: ${leafIndex0}`);

  // 1. Create deposit TX with OP_RETURN
  log("Creating deposit TX...");
  const payloadHex = ephPub.toString("hex") + Buffer.from(npk0Bytes).toString("hex");
  const depositAddr = getNewAddress("bech32m");
  const depositTxid = createOpReturnTx(depositAddr, Number(depositAmount), payloadHex);
  log(`Deposit txid: ${depositTxid}`);

  const minerAddr = getNewAddress("bech32m");
  mineBlocks(1, minerAddr);
  log("Deposit mined");

  // 2. Sweep
  log("Creating sweep TX...");
  const poolAddr = state.poolBtcAddress || getNewAddress("bech32m");
  const depositTxInfo = JSON.parse(btc(`gettransaction ${depositTxid} true true`));
  const depositTxDetails = depositTxInfo.decoded || JSON.parse(btc(`decoderawtransaction ${depositTxInfo.hex}`));
  let depositVout = -1, btcDepositAmount = 0;
  for (const out of depositTxDetails.vout) {
    if (out.scriptPubKey?.type === "witness_v1_taproot" && out.value > 0) {
      depositVout = out.n; btcDepositAmount = out.value; break;
    }
  }
  if (depositVout === -1) throw new Error("Could not find deposit output");
  log(`Deposit output: vout=${depositVout}, amount=${btcDepositAmount} BTC`);

  const sweepFee = 0.00001;
  const sweepAmount = (btcDepositAmount - sweepFee).toFixed(8);
  const sweepRaw = btc(`-named createrawtransaction inputs='[{"txid":"${depositTxid}","vout":${depositVout}}]' outputs='[{"${poolAddr}":${sweepAmount}}]'`);
  const sweepSigned = JSON.parse(btc(`signrawtransactionwithwallet ${sweepRaw}`));
  if (!sweepSigned.complete) throw new Error("Failed to sign sweep tx");
  const sweepTxid = btc(`sendrawtransaction ${sweepSigned.hex}`);
  log(`Sweep txid: ${sweepTxid}`);

  mineBlocks(6, minerAddr);
  log("6 blocks mined");

  await waitForTxIndexed(sweepTxid, ESPLORA_URL);
  await new Promise(r => setTimeout(r, 3000));

  const sweepStatus = await fetchTxStatus(sweepTxid, ESPLORA_URL);
  if (!sweepStatus.confirmed) throw new Error("Sweep TX not confirmed");
  const sweepBlockHeight = sweepStatus.block_height!;
  const sweepBlockHash = sweepStatus.block_hash!;
  log(`Sweep confirmed at height ${sweepBlockHeight}`);

  // 3. Headers
  const [lightClientPda] = deriveLightClientPDA(BTC_LC);
  const lcInfo = await connection.getAccountInfo(lightClientPda);
  const onChainTip = lcInfo ? Number(Buffer.from(lcInfo.data).readBigUInt64LE(136)) : sweepBlockHeight - 1;
  log(`On-chain LC tip: ${onChainTip}`);

  const btcTipHeight = parseInt(execSync(`curl -sf ${ESPLORA_URL}/blocks/tip/height`, { encoding: "utf8" }).trim());
  const targetHeight = Math.min(btcTipHeight, sweepBlockHeight + 6);
  if (onChainTip < targetHeight) {
    await submitHeaders(authority, BTC_LC, onChainTip, targetHeight);
    log(`Headers synced: ${onChainTip}..${targetHeight}`);
  }

  // 4. verify_transaction
  log("Uploading sweep TX to ChadBuffer...");
  const sweepRawBuf = await fetchRawTx(sweepTxid, ESPLORA_URL);
  const strippedSweep = stripWitnessData(sweepRawBuf);
  const sweepBuffer = await createTxBufferAccount(connection, authority, new Uint8Array(strippedSweep), CHADBUFFER_ID);

  const sweepTxidBytes = Buffer.from(sweepTxid, "hex"); sweepTxidBytes.reverse();
  const sweepTxHash = new Uint8Array(sweepTxidBytes);
  const sweepHeaderBuf = await fetchBlockHeader(sweepBlockHash, ESPLORA_URL);
  const sweepBlockHashInternal = dsha256(sweepHeaderBuf);

  const [verifiedTxPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("verified_tx"), sweepBlockHashInternal, sweepTxHash], BTC_LC);
  const [sweepBlockHeaderPda] = deriveBlockHeaderPDA(BTC_LC, sweepBlockHashInternal);
  const [lightClient] = deriveLightClientPDA(BTC_LC);

  const esploraProof = await fetchMerkleProof(sweepTxid, ESPLORA_URL);
  const merkleProofSerialized = serializeMerkleProof(sweepTxid, esploraProof);

  const vtData = Buffer.alloc(1 + 32 + 32 + 4 + merkleProofSerialized.length);
  let off = 0;
  vtData[off++] = 2;
  Buffer.from(sweepTxHash).copy(vtData, off); off += 32;
  sweepBlockHashInternal.copy(vtData, off); off += 32;
  vtData.writeUInt32LE(strippedSweep.length, off); off += 4;
  merkleProofSerialized.copy(vtData, off);

  await sendIx([new TransactionInstruction({
    programId: BTC_LC, data: vtData,
    keys: [
      { pubkey: verifiedTxPda, isSigner: false, isWritable: true },
      { pubkey: lightClient, isSigner: false, isWritable: false },
      { pubkey: sweepBlockHeaderPda, isSigner: false, isWritable: false },
      { pubkey: sweepBuffer.publicKey, isSigner: false, isWritable: false },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  })], [authority], 600_000);

  // 5. verify_stealth_deposit
  log("Uploading deposit TX to ChadBuffer...");
  const depositRawBuf = await fetchRawTx(depositTxid, ESPLORA_URL);
  const strippedDeposit = stripWitnessData(depositRawBuf);
  const depositBuffer = await createTxBufferAccount(connection, authority, new Uint8Array(strippedDeposit), CHADBUFFER_ID);

  const depositTxidBytes = Buffer.from(depositTxid, "hex"); depositTxidBytes.reverse();
  const depositTxHash = new Uint8Array(depositTxidBytes);
  const [depositReceipt] = PublicKey.findProgramAddressSync([Buffer.from("deposit_receipt"), depositTxHash], PRIVACY_COIN);
  const voutBuf = Buffer.alloc(4); voutBuf.writeUInt32LE(0);
  const [utxoRecord] = PublicKey.findProgramAddressSync([Buffer.from("utxo"), sweepTxHash, voutBuf], PRIVACY_COIN);

  const vsdData = Buffer.alloc(1 + 80);
  off = 0;
  vsdData[off++] = Disc.VERIFY_STEALTH_DEPOSIT;
  Buffer.from(sweepTxHash).copy(vsdData, off); off += 32;
  vsdData.writeBigUInt64LE(BigInt(sweepBlockHeight), off); off += 8;
  vsdData.writeUInt32LE(strippedSweep.length, off); off += 4;
  vsdData.writeUInt32LE(strippedDeposit.length, off); off += 4;
  Buffer.from(depositTxHash).copy(vsdData, off);

  const vsdSig = await sendIx([new TransactionInstruction({
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },
      { pubkey: verifiedTxPda, isSigner: false, isWritable: false },
      { pubkey: lightClient, isSigner: false, isWritable: false },
      { pubkey: commitmentTree, isSigner: false, isWritable: true },
      { pubkey: sweepBuffer.publicKey, isSigner: false, isWritable: false },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: zkbtcMint, isSigner: false, isWritable: true },
      { pubkey: poolVault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: depositBuffer.publicKey, isSigner: false, isWritable: false },
      { pubkey: depositReceipt, isSigner: false, isWritable: true },
      { pubkey: utxoRecord, isSigner: false, isWritable: true },
      { pubkey: zkbtcTokenConfig, isSigner: false, isWritable: true },
    ],
    programId: PRIVACY_COIN, data: vsdData,
  })], [authority], 600_000);
  log(`verify_stealth_deposit: ${vsdSig.slice(0, 20)}...`);

  // 6. Read EXACT commitment + amount from on-chain tx logs
  const txResult = await connection.getTransaction(vsdSig, { maxSupportedTransactionVersion: 0 });
  if (!txResult?.meta?.logMessages) throw new Error("Could not fetch tx logs");

  const announcement = parseStealthAnnouncementFromLogs(txResult.meta.logMessages);
  if (!announcement) throw new Error("Stealth announcement not found in tx logs");

  log(`On-chain: leaf=${announcement.leafIndex}, amount=${announcement.amount} sats`);
  log(`Commitment: ${announcement.commitment.slice(0, 16)}...`);

  // Read token_id
  const tcInfo = await connection.getAccountInfo(zkbtcTokenConfig);
  const tc = parseTokenConfig(Buffer.from(tcInfo!.data))!;
  const tokenId = BigInt("0x" + Buffer.from(tc.tokenId).toString("hex"));

  // Save note with EXACT on-chain data (commitment + amount from logs)
  updateState({
    btcNote2: {
      npk: npk0.toString(16),
      random: random0.toString(16),
      amount: announcement.amount,
      leafIndex: announcement.leafIndex,
      commitment: announcement.commitment,
      tokenId: tokenId.toString(16),
      sweepTxid: sweepTxid, // display-order hex for UTXO PDA derivation
      sweepVout: 0,
    },
  });
  trackCommitments(announcement.commitment);

  console.log("\nStep 4: BTC Deposit 2 ........... PASS");
}

main().catch(err => {
  console.error("FAIL:", err.message);
  if (err.logs) err.logs.forEach((l: string) => console.error("  ", l));
  process.exit(1);
});
