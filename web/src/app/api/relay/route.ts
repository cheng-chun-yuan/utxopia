/**
 * Unified Proof Relay API
 *
 * Single endpoint for all JoinSplit modes:
 * - mode="transfer" → TRANSACT (disc=13) — private transfer
 * - mode="unshield" → UNSHIELD (disc=14) — public withdrawal to SPL token (multi-output)
 * - mode="redeem"   → REDEEM (disc=15)   — atomic JoinSplit + BTC withdrawal (multi-output)
 *
 * Flow:
 * 1. Client generates JoinSplit proof locally
 * 2. Client sends proof + params + mode to this API
 * 3. Backend uploads proof to ChadBuffer
 * 4. Backend builds instruction data via SDK (per mode)
 * 5. Backend submits transaction and closes buffer
 *
 * @module api/relay
 */

import { NextRequest, NextResponse } from "next/server";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
const getPrivacyCoinSDK = () => import("@privacy-coin/sdk");

import {
  getPrivacyCoinProgramId,
  getChadbufferProgramId,
  getToken2022ProgramId,
  getZkbtcMint,
  derivePoolStatePDA,
  deriveCommitmentTreePDA,
  deriveNullifierPDA,
  deriveVkRegistryPDA,
  derivePoolVaultATA,
  deriveTokenConfigPDA,
  deriveRedemptionRequestPDA as deriveSyncRedemptionRequestPDA,
} from "@/lib/solana/pdas";

import { getRelayerKeypair as getRelayerKeypairShared } from "@/lib/server/relayer";
import { getHeliusRpcUrl } from "@/lib/helius-server";
import { checkRateLimit, getClientIp } from "@/lib/server/rate-limit";
export const dynamic = "force-dynamic";

// =============================================================================
// Configuration
// =============================================================================

const RELAYER_FEE_SATS = parseInt(process.env.RELAYER_FEE_SATS || "2000", 10);

const CHADBUFFER = { INIT: 0, WRITE: 2, CLOSE: 3 } as const;
const AUTHORITY_SIZE = 32;
const MAX_CHUNK_SIZE = 950;
const FIRST_CHUNK_SIZE = 800;

// =============================================================================
// Types
// =============================================================================

interface RelayRequest {
  /** "transfer" | "unshield" | "redeem" */
  mode: "transfer" | "unshield" | "redeem";
  nInputs: number;
  nOutputs: number;
  proof: string;
  merkleRoot: string;
  boundParamsHash: string;
  nullifiers: string[];
  commitmentsOut: string[];
  stealthData: string[];
  /** Transfer: index of relayer fee output */
  relayerFeeOutputIndex?: number;
  /** Unshield: amounts in satoshis (one per public output) */
  unshieldAmounts?: string[];
  /** Unshield: recipient Solana addresses (base58, one per public output) */
  recipientAddresses?: string[];
  /** Unshield: recipient token accounts (base58, one per public output) */
  recipientTokenAccounts?: string[];
  /** Redeem: amounts in satoshis (one per public output) */
  redeemAmounts?: string[];
  /** Redeem: Bitcoin scriptPubKeys (hex, one per public output) */
  btcScripts?: string[];
  /** Redeem: unique request nonces (one per public output) */
  requestNonces?: string[];
}

// =============================================================================
// Helpers
// =============================================================================

function getRelayerKeypair(): Keypair {
  // Try shared helper first (used by unshield/redeem), fall back to env parsing
  const shared = getRelayerKeypairShared();
  if (shared) return shared;
  const keypairJson = process.env.RELAYER_KEYPAIR;
  if (!keypairJson) throw new Error("RELAYER_KEYPAIR not configured");
  const secretKey = JSON.parse(keypairJson);
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

function validateHexField(
  hexToBytes: (hex: string) => Uint8Array,
  value: string | undefined,
  name: string,
  expectedBytes: number,
): Uint8Array {
  if (!value) throw new Error(`Missing required field: ${name}`);
  const bytes = hexToBytes(value);
  if (bytes.length !== expectedBytes) {
    throw new Error(`Invalid ${name}: expected ${expectedBytes} bytes, got ${bytes.length}`);
  }
  return bytes;
}

function deriveRedemptionRequestPDA(
  user: PublicKey, nonce: bigint, programId: PublicKey = getPrivacyCoinProgramId()
): [PublicKey, number] {
  return deriveSyncRedemptionRequestPDA(user, nonce, programId);
}

// =============================================================================
// ChadBuffer Operations
// =============================================================================

async function uploadProofToBuffer(
  connection: Connection, relayer: Keypair, proof: Uint8Array
): Promise<{ bufferPubkey: PublicKey; bufferKeypair: Keypair }> {
  const bufferKeypair = Keypair.generate();
  const bufferSize = AUTHORITY_SIZE + proof.length;
  const rentExemption = await connection.getMinimumBalanceForRentExemption(bufferSize);

  const firstChunkSize = Math.min(FIRST_CHUNK_SIZE, proof.length);
  const firstChunk = proof.slice(0, firstChunkSize);

  const createAccountIx = SystemProgram.createAccount({
    fromPubkey: relayer.publicKey,
    newAccountPubkey: bufferKeypair.publicKey,
    lamports: rentExemption,
    space: bufferSize,
    programId: getChadbufferProgramId(),
  });

  const initData = Buffer.alloc(1 + firstChunk.length);
  initData[0] = CHADBUFFER.INIT;
  Buffer.from(firstChunk).copy(initData, 1);

  const initIx = new TransactionInstruction({
    programId: getChadbufferProgramId(),
    keys: [
      { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
      { pubkey: bufferKeypair.publicKey, isSigner: true, isWritable: true },
    ],
    data: initData,
  });

  const { blockhash } = await connection.getLatestBlockhash();
  const tx = new Transaction().add(createAccountIx, initIx);
  tx.feePayer = relayer.publicKey;
  tx.recentBlockhash = blockhash;
  await sendAndConfirmTransaction(connection, tx, [relayer, bufferKeypair], { commitment: "confirmed" });

  let dataOffset = firstChunkSize;
  while (dataOffset < proof.length) {
    const chunkSize = Math.min(MAX_CHUNK_SIZE, proof.length - dataOffset);
    const chunk = proof.slice(dataOffset, dataOffset + chunkSize);
    const bufferOffset = AUTHORITY_SIZE + dataOffset;

    const writeData = Buffer.alloc(4 + chunk.length);
    writeData[0] = CHADBUFFER.WRITE;
    writeData[1] = bufferOffset & 0xff;
    writeData[2] = (bufferOffset >> 8) & 0xff;
    writeData[3] = (bufferOffset >> 16) & 0xff;
    Buffer.from(chunk).copy(writeData, 4);

    const writeIx = new TransactionInstruction({
      programId: getChadbufferProgramId(),
      keys: [
        { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
        { pubkey: bufferKeypair.publicKey, isSigner: false, isWritable: true },
      ],
      data: writeData,
    });

    const { blockhash: wbh } = await connection.getLatestBlockhash();
    const writeTx = new Transaction().add(writeIx);
    writeTx.feePayer = relayer.publicKey;
    writeTx.recentBlockhash = wbh;
    await sendAndConfirmTransaction(connection, writeTx, [relayer], { commitment: "confirmed" });
    dataOffset += chunkSize;
  }

  console.log(`[Relay] Uploaded proof to buffer (${proof.length} bytes)`);
  return { bufferPubkey: bufferKeypair.publicKey, bufferKeypair };
}

async function closeBuffer(
  connection: Connection, relayer: Keypair, bufferPubkey: PublicKey
): Promise<void> {
  const closeIx = new TransactionInstruction({
    programId: getChadbufferProgramId(),
    keys: [
      { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
      { pubkey: bufferPubkey, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([CHADBUFFER.CLOSE]),
  });
  const { blockhash } = await connection.getLatestBlockhash();
  const closeTx = new Transaction().add(closeIx);
  closeTx.feePayer = relayer.publicKey;
  closeTx.recentBlockhash = blockhash;
  await sendAndConfirmTransaction(connection, closeTx, [relayer], { commitment: "confirmed" });
  console.log("[Relay] Buffer closed, rent reclaimed");
}

// =============================================================================
// Main Handler
// =============================================================================

export async function POST(request: NextRequest) {
  // Rate limit: 10 relay requests per minute per IP
  const ip = getClientIp(request.headers);
  const rl = checkRateLimit(ip, "relay", { maxTokens: 10, windowMs: 60_000 });
  if (rl.limited) {
    return NextResponse.json(
      { success: false, error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(Math.ceil((rl.retryAfterMs ?? 6000) / 1000)) } }
    );
  }

  const startTime = Date.now();

  try {
    const {
      hexToBytes,
      buildTransactInstructionData,
      buildUnshieldInstructionData,
      buildRedeemInstructionData,
    } = await getPrivacyCoinSDK();

    const body: RelayRequest = await request.json();
    const { mode = "transfer" } = body;
    const { nInputs, nOutputs, proof, merkleRoot, boundParamsHash, nullifiers, commitmentsOut, stealthData } = body;

    // ── Common validation ──────────────────────────────────────────────
    if (
      nInputs == null || nOutputs == null || !proof || !merkleRoot ||
      !boundParamsHash || !nullifiers || !commitmentsOut || !stealthData
    ) {
      return NextResponse.json({ success: false, error: "Missing required fields" }, { status: 400 });
    }
    if (!Number.isInteger(nInputs) || !Number.isInteger(nOutputs) || nInputs < 1 || nOutputs < 1 || nInputs > 14 || nOutputs > 14) {
      return NextResponse.json({ success: false, error: "Invalid circuit dimensions" }, { status: 400 });
    }
    if (nullifiers.length !== nInputs) {
      return NextResponse.json({ success: false, error: `Expected ${nInputs} nullifiers, got ${nullifiers.length}` }, { status: 400 });
    }

    // Stealth data count: nOutputs for transfer, nOutputs-1 for unshield/redeem
    const expectedStealthCount = mode === "transfer" ? nOutputs : nOutputs - 1;
    if (stealthData.length !== expectedStealthCount) {
      return NextResponse.json({ success: false, error: `Expected ${expectedStealthCount} stealth data entries, got ${stealthData.length}` }, { status: 400 });
    }
    if (commitmentsOut.length !== nOutputs) {
      return NextResponse.json({ success: false, error: `Expected ${nOutputs} commitments, got ${commitmentsOut.length}` }, { status: 400 });
    }

    console.log(`[Relay] Processing ${mode} JoinSplit(${nInputs}x${nOutputs})...`);

    const relayer = getRelayerKeypair();
    const connection = new Connection(
      getHeliusRpcUrl(),
      "confirmed"
    );

    // ── Parse common hex fields ────────────────────────────────────────
    const proofBytes = validateHexField(hexToBytes, proof, "proof", 256);
    const merkleRootBytes = validateHexField(hexToBytes, merkleRoot, "merkleRoot", 32);
    const boundParamsHashBytes = validateHexField(hexToBytes, boundParamsHash, "boundParamsHash", 32);
    const nullifierBytes = nullifiers.map((n, i) => validateHexField(hexToBytes, n, `nullifiers[${i}]`, 32));
    const commitmentBytes = commitmentsOut.map((c, i) => validateHexField(hexToBytes, c, `commitmentsOut[${i}]`, 32));

    // Stealth data: accept >= 40 bytes per entry (72 for transact/unshield, 40+ for redeem)
    const stealthDataBytes = stealthData.map((s, i) => {
      const bytes = hexToBytes(s);
      if (bytes.length < 40) throw new Error(`stealthData[${i}]: expected >= 40 bytes, got ${bytes.length}`);
      return bytes;
    });

    // ── Derive common PDAs ─────────────────────────────────────────────
    const nullifierPDAs = nullifierBytes.map((n) => deriveNullifierPDA(n)[0]);
    const [vkRegistryPDA] = deriveVkRegistryPDA(nInputs, nOutputs);
    const [poolState] = derivePoolStatePDA();
    const [commitmentTree] = deriveCommitmentTreePDA();

    // ── Relayer fee check (transfer mode only) ─────────────────────────
    if (mode === "transfer" && RELAYER_FEE_SATS > 0) {
      const feeIdx = body.relayerFeeOutputIndex;
      if (feeIdx == null || feeIdx < 0 || feeIdx >= nOutputs) {
        return NextResponse.json(
          { success: false, error: `Relayer fee output index required (RELAYER_FEE_SATS=${RELAYER_FEE_SATS})` },
          { status: 400 }
        );
      }
      const ephemeralPub = stealthDataBytes[feeIdx].slice(0, 32);
      if (ephemeralPub.every((b: number) => b === 0)) {
        return NextResponse.json({ success: false, error: "Relayer fee output has invalid ephemeral public key" }, { status: 400 });
      }
    }

    // ── Upload proof to ChadBuffer ─────────────────────────────────────
    const { bufferPubkey } = await uploadProofToBuffer(connection, relayer, proofBytes);

    // ── Build instruction data + accounts (per mode) ───────────────────
    let ixData: Uint8Array;
    const keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];

    if (mode === "unshield") {
      // ── UNSHIELD (disc=14, multi-output) ─────────────────────────────
      const { unshieldAmounts, recipientAddresses, recipientTokenAccounts } = body;
      if (!unshieldAmounts?.length || !recipientAddresses?.length || !recipientTokenAccounts?.length) {
        return NextResponse.json({ success: false, error: "Unshield requires: unshieldAmounts[], recipientAddresses[], recipientTokenAccounts[]" }, { status: 400 });
      }
      const nPublicOutputs = unshieldAmounts.length;
      if (recipientAddresses.length !== nPublicOutputs || recipientTokenAccounts.length !== nPublicOutputs) {
        return NextResponse.json({ success: false, error: "Unshield arrays must have equal length" }, { status: 400 });
      }

      const recipientPubkeys = recipientAddresses.map(a => new PublicKey(a));
      const recipientTokenPubkeys = recipientTokenAccounts.map(a => new PublicKey(a));
      const poolVault = derivePoolVaultATA();

      ixData = buildUnshieldInstructionData({
        nInputs, nOutputs,
        nPublicOutputs,
        merkleRoot: merkleRootBytes,
        boundParamsHash: boundParamsHashBytes,
        nullifiers: nullifierBytes,
        commitmentsOut: commitmentBytes,
        stealthData: stealthDataBytes,
        unshieldAmounts: unshieldAmounts.map(a => BigInt(a)),
        proofSource: 1,
      });

      // Accounts: pool_state, tree, vk, user, system, token_config, vault, token_program, recipients..., nullifiers...
      const [tokenConfigPDA] = deriveTokenConfigPDA(getZkbtcMint());
      keys.push(
        { pubkey: poolState, isSigner: false, isWritable: true },
        { pubkey: commitmentTree, isSigner: false, isWritable: true },
        { pubkey: vkRegistryPDA, isSigner: false, isWritable: false },
        { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: tokenConfigPDA, isSigner: false, isWritable: true },
        { pubkey: poolVault, isSigner: false, isWritable: true },
        { pubkey: getToken2022ProgramId(), isSigner: false, isWritable: false },
      );
      for (const rta of recipientTokenPubkeys) keys.push({ pubkey: rta, isSigner: false, isWritable: true });
      for (const pda of nullifierPDAs) keys.push({ pubkey: pda, isSigner: false, isWritable: true });
      keys.push({ pubkey: bufferPubkey, isSigner: false, isWritable: false });

      // Ensure recipient ATAs exist
      for (let k = 0; k < nPublicOutputs; k++) {
        const ataInfo = await connection.getAccountInfo(recipientTokenPubkeys[k]);
        if (!ataInfo) {
          const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
            relayer.publicKey, recipientTokenPubkeys[k], recipientPubkeys[k], getZkbtcMint(), getToken2022ProgramId()
          );
          const ataTx = new Transaction().add(createAtaIx);
          const { blockhash: ataBlockhash } = await connection.getLatestBlockhash();
          ataTx.feePayer = relayer.publicKey;
          ataTx.recentBlockhash = ataBlockhash;
          await sendAndConfirmTransaction(connection, ataTx, [relayer], { commitment: "confirmed" });
        }
      }

    } else if (mode === "redeem") {
      // ── REDEEM (disc=15, multi-output) ───────────────────────────────
      const { redeemAmounts, btcScripts, requestNonces } = body;
      if (!redeemAmounts?.length || !btcScripts?.length || !requestNonces?.length) {
        return NextResponse.json({ success: false, error: "Redeem requires: redeemAmounts[], btcScripts[], requestNonces[]" }, { status: 400 });
      }
      const nPublicOutputs = redeemAmounts.length;
      if (btcScripts.length !== nPublicOutputs || requestNonces.length !== nPublicOutputs) {
        return NextResponse.json({ success: false, error: "Redeem arrays must have equal length" }, { status: 400 });
      }

      const btcScriptBytesArr = btcScripts.map((s, i) => {
        const bytes = hexToBytes(s);
        if (bytes.length === 0 || bytes.length > 62) {
          throw new Error(`BTC script[${i}] must be 1-62 bytes, got ${bytes.length}`);
        }
        return bytes;
      });
      const requestNonceBigints = requestNonces.map(n => BigInt(n));

      const redemptionRequestPDAs = requestNonceBigints.map(n =>
        deriveRedemptionRequestPDA(relayer.publicKey, n)[0]
      );
      const [tokenConfigPDA] = deriveTokenConfigPDA(getZkbtcMint());

      ixData = buildRedeemInstructionData({
        nInputs, nOutputs,
        nPublicOutputs,
        merkleRoot: merkleRootBytes,
        boundParamsHash: boundParamsHashBytes,
        nullifiers: nullifierBytes,
        commitmentsOut: commitmentBytes,
        stealthData: stealthDataBytes,
        redeemAmounts: redeemAmounts.map(a => BigInt(a)),
        btcScripts: btcScriptBytesArr,
        requestNonces: requestNonceBigints,
        proofSource: 1,
      });

      keys.push(
        { pubkey: poolState, isSigner: false, isWritable: true },
        { pubkey: commitmentTree, isSigner: false, isWritable: true },
        { pubkey: vkRegistryPDA, isSigner: false, isWritable: false },
        { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: tokenConfigPDA, isSigner: false, isWritable: false },
      );
      for (const pda of nullifierPDAs) keys.push({ pubkey: pda, isSigner: false, isWritable: true });
      for (const rpda of redemptionRequestPDAs) keys.push({ pubkey: rpda, isSigner: false, isWritable: true });
      keys.push({ pubkey: bufferPubkey, isSigner: false, isWritable: false });

    } else {
      // ── TRANSFER (disc=13) ─────────────────────────────────────────
      ixData = buildTransactInstructionData({
        nInputs, nOutputs,
        merkleRoot: merkleRootBytes,
        boundParamsHash: boundParamsHashBytes,
        nullifiers: nullifierBytes,
        commitmentsOut: commitmentBytes,
        stealthData: stealthDataBytes,
        proofSource: 1,
      });

      keys.push(
        { pubkey: poolState, isSigner: false, isWritable: true },
        { pubkey: commitmentTree, isSigner: false, isWritable: true },
        { pubkey: vkRegistryPDA, isSigner: false, isWritable: false },
        { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      );
      for (const pda of nullifierPDAs) keys.push({ pubkey: pda, isSigner: false, isWritable: true });
      keys.push({ pubkey: bufferPubkey, isSigner: false, isWritable: false });
    }

    // ── Submit transaction ─────────────────────────────────────────────
    const mainIx = new TransactionInstruction({
      programId: getPrivacyCoinProgramId(),
      keys,
      data: Buffer.from(ixData),
    });

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      mainIx
    );

    console.log(`[Relay] Submitting ${mode} transaction...`);
    const { blockhash } = await connection.getLatestBlockhash();
    tx.feePayer = relayer.publicKey;
    tx.recentBlockhash = blockhash;

    const signature = await sendAndConfirmTransaction(connection, tx, [relayer], { commitment: "confirmed" });
    console.log(`[Relay] Transaction confirmed: ${signature}`);

    // Close buffer and reclaim rent
    try {
      await closeBuffer(connection, relayer, bufferPubkey);
    } catch (closeErr) {
      console.warn("[Relay] Failed to close buffer (non-critical):", closeErr);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[Relay] ${mode} complete in ${duration}s`);

    return NextResponse.json({ success: true, signature, bufferAddress: bufferPubkey.toBase58() });
  } catch (error) {
    console.error("[Relay] Error:", error);
    const errObj = error as Record<string, unknown> | null;
    const logs = (errObj && 'logs' in errObj ? errObj.logs : null)
      ?? (errObj && 'transactionError' in errObj ? (errObj.transactionError as Record<string, unknown>)?.logs : null)
      ?? null;
    return NextResponse.json(
      {
        success: false,
        error: process.env.NODE_ENV === "development" ? (error instanceof Error ? error.message : "Unknown error") : "Transaction failed",
        logs: process.env.NODE_ENV === "development" ? logs : undefined,
      },
      { status: 500 }
    );
  }
}
