#!/usr/bin/env bun
/**
 * Step 3: Real BTC Deposit
 *
 * Full flow:
 *   1. Create deposit TX (BTC + OP_RETURN with ephemeral_pub + npk)
 *   2. Mine 1 block
 *   3. Create sweep TX (spend deposit UTXO → pool wallet)
 *   4. Mine 1 block + 5 more (6 confirmations on sweep)
 *   5. Init light client, submit headers
 *   6. Upload sweep TX to ChadBuffer → call verify_transaction (creates VerifiedTransaction PDA)
 *   7. Upload deposit TX to ChadBuffer
 *   8. Call verify_stealth_deposit (14 accounts)
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
import { buildPoseidon } from "circomlibjs";

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

stepHeader(3, "BTC Deposit (real)");

// =============================================================================
// BTC CLI helper
// =============================================================================

function btc(cmd: string): string {
  return bitcoinCli(cmd);
}

// =============================================================================
// Light client helpers
// =============================================================================

async function initLightClient(
  authority: Keypair, btcLc: PublicKey, startHeight: number,
): Promise<void> {
  const [lightClient] = deriveLightClientPDA(btcLc);
  const existing = await connection.getAccountInfo(lightClient);
  if (existing) {
    log("Light client already initialized");
    return;
  }

  const blockHashHex = await fetchBlockHash(startHeight, ESPLORA_URL);
  const genesisHeaderHex = await fetchBlockHeader(blockHashHex, ESPLORA_URL);
  const hashBytes = dsha256(genesisHeaderHex);

  const heightBuf = Buffer.alloc(8);
  heightBuf.writeBigUInt64LE(BigInt(startHeight));

  const [heightIndex] = deriveHeightIndexPDA(btcLc, BigInt(startHeight));
  const [blockHeader] = deriveBlockHeaderPDA(btcLc, hashBytes);

  // disc(0) + start_height(8) + block_hash(32) + network(1=regtest=3) + bits(4) + epoch_time(4)
  const data = Buffer.alloc(50);
  data[0] = 0;
  heightBuf.copy(data, 1);
  hashBytes.copy(data, 9);
  data[41] = 3; // regtest
  data.writeUInt32LE(0x207fffff, 42); // regtest bits
  data.writeUInt32LE(0, 46);

  const ix = new TransactionInstruction({
    programId: btcLc,
    data,
    keys: [
      { pubkey: lightClient, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: heightIndex, isSigner: false, isWritable: true },
      { pubkey: blockHeader, isSigner: false, isWritable: true },
    ],
  });

  await sendIx([ix], [authority]);
  log(`Light client initialized at height ${startHeight}`);
}

async function submitHeaders(
  authority: Keypair, btcLc: PublicKey, fromHeight: number, toHeight: number,
): Promise<void> {
  const [lightClient] = deriveLightClientPDA(btcLc);

  for (let h = fromHeight + 1; h <= toHeight; h++) {
    const hashHex = await fetchBlockHash(h, ESPLORA_URL);
    const headerBuf = await fetchBlockHeader(hashHex, ESPLORA_URL);

    const newBlockHash = dsha256(headerBuf);
    const parentHash = Buffer.from(headerBuf).subarray(4, 36); // prev_hash in header

    const [parentPda] = deriveBlockHeaderPDA(btcLc, parentHash);
    const [newBlockPda] = deriveBlockHeaderPDA(btcLc, newBlockHash);
    const [heightIndexPda] = deriveHeightIndexPDA(btcLc, BigInt(h));

    // extend_blockchain: disc(1) + n(1) + header(80)
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
  const poolVault = new PublicKey(state.poolVault);
  const [poolState] = derivePoolStatePDA(AEGIS);
  const [commitmentTree] = deriveCommitmentTreePDA(AEGIS);
  const [zkbtcTokenConfig] = deriveTokenConfigPDA(AEGIS, zkbtcMint);

  // Initialize Poseidon
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const poseidonHash = (inputs: bigint[]) => F.toObject(poseidon(inputs)) as bigint;

  // Load keys from state
  const mpk = BigInt("0x" + state.mpk!);
  const amount = 25_000n;

  // Generate note keys
  const random0 = randomFieldElement();
  const npk0 = poseidonHash([mpk, random0]);
  const npk0Bytes = bigintToBytes32BE(npk0);
  const ephPub = crypto.randomBytes(32);

  // Read tree state
  const treeInfo = await connection.getAccountInfo(commitmentTree);
  const treeData = parseCommitmentTree(Buffer.from(treeInfo!.data));
  const leafIndex0 = Number(treeData!.nextIndex);
  log(`Tree next_index: ${leafIndex0}`);

  // =========================================================================
  // 1. Create deposit TX with OP_RETURN(ephemeralPub || npk)
  // =========================================================================
  log("Creating deposit TX...");
  const payloadHex = ephPub.toString("hex") + Buffer.from(npk0Bytes).toString("hex");
  const depositAddr = getNewAddress("bech32m");
  const depositTxid = createOpReturnTx(depositAddr, Number(amount), payloadHex);
  log(`Deposit txid: ${depositTxid}`);

  // 2. Mine 1 block (deposit confirmed)
  const minerAddr = getNewAddress("bech32m");
  mineBlocks(1, minerAddr);
  log("Deposit mined");

  // =========================================================================
  // 3. Create sweep TX (spend deposit → pool wallet)
  // =========================================================================
  log("Creating sweep TX...");
  const poolAddr = getNewAddress("bech32m");

  // Get deposit output details
  const depositTxInfo = JSON.parse(btc(`gettransaction ${depositTxid} true true`));
  const depositTxDetails = depositTxInfo.decoded || JSON.parse(btc(`decoderawtransaction ${depositTxInfo.hex}`));
  let depositVout = -1;
  let depositAmount = 0;
  for (const out of depositTxDetails.vout) {
    if (out.scriptPubKey?.type === "witness_v1_taproot" && out.value > 0) {
      depositVout = out.n;
      depositAmount = out.value;
      break;
    }
  }
  if (depositVout === -1) throw new Error("Could not find deposit output");
  log(`Deposit output: vout=${depositVout}, amount=${depositAmount} BTC`);

  const sweepFee = 0.00001;
  const sweepAmount = (depositAmount - sweepFee).toFixed(8);
  const sweepRaw = btc(`-named createrawtransaction inputs='[{"txid":"${depositTxid}","vout":${depositVout}}]' outputs='[{"${poolAddr}":${sweepAmount}}]'`);
  const sweepSigned = JSON.parse(btc(`signrawtransactionwithwallet ${sweepRaw}`));
  if (!sweepSigned.complete) throw new Error("Failed to sign sweep tx");

  const sweepTxid = btc(`sendrawtransaction ${sweepSigned.hex}`);
  log(`Sweep txid: ${sweepTxid}`);

  // 4. Mine 1 + 5 more blocks (6 confirmations on sweep)
  mineBlocks(6, minerAddr);
  log("6 blocks mined (sweep has 6 confirmations)");

  // Wait for Esplora indexing
  await waitForTxIndexed(sweepTxid, ESPLORA_URL);
  await new Promise(r => setTimeout(r, 3000));

  const sweepStatus = await fetchTxStatus(sweepTxid, ESPLORA_URL);
  if (!sweepStatus.confirmed) throw new Error("Sweep TX not confirmed");
  const sweepBlockHeight = sweepStatus.block_height!;
  const sweepBlockHash = sweepStatus.block_hash!;
  log(`Sweep confirmed at height ${sweepBlockHeight}`);

  const depositStatus = await fetchTxStatus(depositTxid, ESPLORA_URL);
  const depositBlockHash = depositStatus.block_hash!;
  const depositBlockHeight = depositStatus.block_height!;

  // =========================================================================
  // 5. Init light client + submit headers
  // =========================================================================
  const initHeight = sweepBlockHeight - 1;
  await initLightClient(authority, BTC_LC, initHeight);

  // Read on-chain tip to know where to extend from
  const [lightClientPda] = deriveLightClientPDA(BTC_LC);
  const lcInfo = await connection.getAccountInfo(lightClientPda);
  // tip_height at offset 136: disc(1)+bump(1)+paused(1)+network(1)+pad(4)+auth(32)+genesis(32)+tip_hash(32)+chainwork(32)
  const onChainTip = lcInfo ? Number(Buffer.from(lcInfo.data).readBigUInt64LE(136)) : initHeight;
  log(`On-chain LC tip: ${onChainTip}`);

  const btcTipHeight = parseInt(
    execSync(`curl -sf ${ESPLORA_URL}/blocks/tip/height`, { encoding: "utf8" }).trim()
  );
  const targetHeight = Math.min(btcTipHeight, sweepBlockHeight + 6);
  if (onChainTip < targetHeight) {
    await submitHeaders(authority, BTC_LC, onChainTip, targetHeight);
    log(`Headers synced: ${onChainTip}..${targetHeight}`);
  } else {
    log(`Headers already synced to ${onChainTip} (target: ${targetHeight})`);
  }

  // =========================================================================
  // 6. Upload sweep TX → verify_transaction (creates VerifiedTransaction PDA)
  // =========================================================================
  log("Uploading sweep TX to ChadBuffer...");
  const sweepRawBuf = await fetchRawTx(sweepTxid, ESPLORA_URL);
  const strippedSweep = stripWitnessData(sweepRawBuf);
  const sweepBuffer = await createTxBufferAccount(connection, authority, new Uint8Array(strippedSweep), CHADBUFFER_ID);
  log(`Sweep ChadBuffer: ${sweepBuffer.publicKey.toBase58().slice(0, 16)}...`);

  // Compute internal-order sweep txid
  const sweepTxidBytes = Buffer.from(sweepTxid, "hex");
  sweepTxidBytes.reverse(); // display → internal
  const sweepTxHash = new Uint8Array(sweepTxidBytes);

  // Compute sweep block hash in internal order
  const sweepHeaderBuf = await fetchBlockHeader(sweepBlockHash, ESPLORA_URL);
  const sweepBlockHashInternal = dsha256(sweepHeaderBuf);

  // Derive VerifiedTransaction PDA: ["verified_tx", block_hash, txid]
  const [verifiedTxPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("verified_tx"), sweepBlockHashInternal, sweepTxHash],
    BTC_LC,
  );
  const [sweepBlockHeaderPda] = deriveBlockHeaderPDA(BTC_LC, sweepBlockHashInternal);
  const [lightClient] = deriveLightClientPDA(BTC_LC);

  // Build verify_transaction instruction
  const esploraProof = await fetchMerkleProof(sweepTxid, ESPLORA_URL);
  const merkleProofSerialized = serializeMerkleProof(sweepTxid, esploraProof);

  // Data: disc(2) + txid(32) + block_hash(32) + tx_size(4) + merkle_proof(var)
  const vtDataLen = 1 + 32 + 32 + 4 + merkleProofSerialized.length;
  const vtData = Buffer.alloc(vtDataLen);
  let off = 0;
  vtData[off++] = 2; // VERIFY_TRANSACTION disc
  Buffer.from(sweepTxHash).copy(vtData, off); off += 32;
  sweepBlockHashInternal.copy(vtData, off); off += 32;
  vtData.writeUInt32LE(strippedSweep.length, off); off += 4;
  merkleProofSerialized.copy(vtData, off);

  const verifyTxIx = new TransactionInstruction({
    programId: BTC_LC,
    data: vtData,
    keys: [
      { pubkey: verifiedTxPda, isSigner: false, isWritable: true },
      { pubkey: lightClient, isSigner: false, isWritable: false },
      { pubkey: sweepBlockHeaderPda, isSigner: false, isWritable: false },
      { pubkey: sweepBuffer.publicKey, isSigner: false, isWritable: false },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });

  const vtSig = await sendIx([verifyTxIx], [authority], 600_000);
  log(`verify_transaction: ${vtSig.slice(0, 20)}...`);

  // =========================================================================
  // 7. Upload deposit TX to ChadBuffer
  // =========================================================================
  log("Uploading deposit TX to ChadBuffer...");
  const depositRawBuf = await fetchRawTx(depositTxid, ESPLORA_URL);
  const strippedDeposit = stripWitnessData(depositRawBuf);
  const depositBuffer = await createTxBufferAccount(connection, authority, new Uint8Array(strippedDeposit), CHADBUFFER_ID);
  log(`Deposit ChadBuffer: ${depositBuffer.publicKey.toBase58().slice(0, 16)}...`);

  // =========================================================================
  // 8. Call verify_stealth_deposit (14 accounts)
  // =========================================================================
  log("Calling verify_stealth_deposit...");

  // Compute deposit txid in internal order
  const depositTxidBytes = Buffer.from(depositTxid, "hex");
  depositTxidBytes.reverse();
  const depositTxHash = new Uint8Array(depositTxidBytes);

  // Derive deposit receipt PDA: ["deposit", deposit_txid]
  const [depositReceipt] = PublicKey.findProgramAddressSync(
    [Buffer.from("deposit_receipt"), depositTxHash],
    AEGIS,
  );

  // Derive UTXO record PDA: ["utxo", sweep_txid, vout(LE)]
  // The sweep TX has 1 output at vout=0
  const voutBuf = Buffer.alloc(4);
  voutBuf.writeUInt32LE(0);
  const [utxoRecord] = PublicKey.findProgramAddressSync(
    [Buffer.from("utxo"), sweepTxHash, voutBuf],
    AEGIS,
  );

  // Instruction data: sweep_txid(32) + block_height(8) + sweep_tx_size(4) + deposit_tx_size(4) + deposit_txid(32) = 80 bytes
  const vsdData = Buffer.alloc(1 + 80);
  off = 0;
  vsdData[off++] = Disc.VERIFY_STEALTH_DEPOSIT;
  Buffer.from(sweepTxHash).copy(vsdData, off); off += 32;
  vsdData.writeBigUInt64LE(BigInt(sweepBlockHeight), off); off += 8;
  vsdData.writeUInt32LE(strippedSweep.length, off); off += 4;
  vsdData.writeUInt32LE(strippedDeposit.length, off); off += 4;
  Buffer.from(depositTxHash).copy(vsdData, off); off += 32;

  const vsdIx = new TransactionInstruction({
    keys: [
      { pubkey: poolState, isSigner: false, isWritable: true },                    // 0
      { pubkey: verifiedTxPda, isSigner: false, isWritable: false },               // 1
      { pubkey: lightClient, isSigner: false, isWritable: false },                 // 2
      { pubkey: commitmentTree, isSigner: false, isWritable: true },               // 3
      { pubkey: sweepBuffer.publicKey, isSigner: false, isWritable: false },       // 4
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },           // 5
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },     // 6
      { pubkey: zkbtcMint, isSigner: false, isWritable: true },                    // 7
      { pubkey: poolVault, isSigner: false, isWritable: true },                    // 8
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },       // 9
      { pubkey: depositBuffer.publicKey, isSigner: false, isWritable: false },     // 10
      { pubkey: depositReceipt, isSigner: false, isWritable: true },               // 11
      { pubkey: utxoRecord, isSigner: false, isWritable: true },                   // 12
      { pubkey: zkbtcTokenConfig, isSigner: false, isWritable: true },             // 13
    ],
    programId: AEGIS,
    data: vsdData,
  });

  const vsdSig = await sendIx([vsdIx], [authority], 600_000);
  log(`verify_stealth_deposit: ${vsdSig.slice(0, 20)}...`);

  // Verify tree updated
  const treeAfter = await connection.getAccountInfo(commitmentTree);
  const treeDataAfter = parseCommitmentTree(Buffer.from(treeAfter!.data));
  if (Number(treeDataAfter!.nextIndex) !== leafIndex0 + 1) {
    throw new Error(`next_index expected ${leafIndex0 + 1}, got ${treeDataAfter!.nextIndex}`);
  }
  log(`Commitment at leaf ${leafIndex0}`);

  // Read actual token_id from on-chain TokenConfig
  const tcInfo = await connection.getAccountInfo(zkbtcTokenConfig);
  const tc = parseTokenConfig(Buffer.from(tcInfo!.data))!;
  const tokenId = BigInt("0x" + Buffer.from(tc.tokenId).toString("hex"));

  // Read the actual on-chain commitment from the frontier (frontier[0] = last inserted leaf)
  const onChainCommitment = bytes32ToBigintBE(new Uint8Array(treeDataAfter!.frontier.subarray(0, 32)));
  log(`On-chain commitment: ${onChainCommitment.toString(16).slice(0, 16)}...`);

  // The on-chain amount may differ from our `amount` due to sweep fee + deposit fees
  // We can't know the exact shielded amount, so we store the on-chain commitment directly
  // Note: this note may not be spendable in JoinSplit without knowing the exact shielded amount
  updateState({
    btcNote: {
      npk: npk0.toString(16),
      random: random0.toString(16),
      amount: Number(amount), // may not match on-chain shielded amount
      leafIndex: leafIndex0,
      commitment: onChainCommitment.toString(16),
      tokenId: tokenId.toString(16),
    },
  });
  trackCommitments(onChainCommitment.toString(16));

  console.log("\nStep 3: BTC Deposit (real) ...... PASS");
}

main().catch(err => {
  console.error("FAIL:", err.message);
  if (err.logs) err.logs.forEach((l: string) => console.error("  ", l));
  process.exit(1);
});
