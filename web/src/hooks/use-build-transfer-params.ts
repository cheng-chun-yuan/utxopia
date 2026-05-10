"use client";

/**
 * buildTransferParams — pure function that translates user inputs into JoinSplitProofInputs.
 *
 * Single source of truth for all 3 simplified flows (transfer, unshield, withdraw).
 * Extracted from pay-flow.tsx to prevent logic drift between flows.
 */

import { PublicKey } from "@solana/web3.js";
import type { InboxNote } from "@/hooks/use-privacy-coin";
import type { JoinSplitProofInputs, PrivacyCoinKeys, StealthMetaAddress, ScannedNote } from "@privacy-coin/sdk";
import { ZKBTC_TOKEN_ID, reduceToFieldOnChain } from "@/components/send/_lifted/helpers";

export type TransferMode = "stealth" | "public" | "btc";

export interface TransferUserInputs {
  mode: TransferMode;
  amountSats: bigint;
  /** Selected notes from inbox */
  selectedNotes: InboxNote[];
  /** User's aegis keys */
  keys: PrivacyCoinKeys;
  /** User's stealth meta address (for change output) */
  selfMeta: StealthMetaAddress;
  /** Relayer stealth meta (for fee output) */
  relayerMeta?: StealthMetaAddress;
  relayerFee: number;
  /** Mode-specific recipient */
  recipient: {
    stealthMeta?: StealthMetaAddress; // stealth mode
    solanaAddress?: string;           // public/unshield mode
    btcScriptPubKey?: Uint8Array;     // btc withdraw mode
  };
}

export interface TransferParams {
  proofInputs: JoinSplitProofInputs;
  /** Stealth data arrays for relay submission (72 bytes each) */
  stealthDataArrays: Uint8Array[];
  /** Mode-specific relay submission config */
  relayMode: "transfer" | "unshield" | "redeem";
  /** For unshield: recipient address bytes */
  unshieldRecipientAddress?: Uint8Array;
  /** For redeem: BTC script pubkey */
  btcScriptPubKey?: Uint8Array;
  /** Relayer fee output index (for transfer mode) */
  relayerFeeOutputIndex?: number;
  /** Change amount in sats */
  changeSats: number;
}

export async function buildTransferParams(inputs: TransferUserInputs): Promise<TransferParams> {
  const {
    initPoseidon,
    prepareClaimInputs,
    parseMerkleProofResponse,
    computeJoinSplitCommitmentSync,
    createStealthDepositWithKeys,
    computeBoundParamsHash,
    createUnshieldBoundParams,
    createRedeemBoundParams,
    createTransferBoundParams,
    computeStealthDataHash,
    decodeStealthMetaAddress,
    PrivacyCoinClient,
    bytesToHex,
  } = await import("@privacy-coin/sdk");

  await initPoseidon();

  const { mode, amountSats, selectedNotes, keys, selfMeta, relayerMeta, relayerFee, recipient } = inputs;

  // 1. Fetch merkle proofs and prepare claim inputs for each note
  const aegisClient = PrivacyCoinClient.isInitialized
    ? PrivacyCoinClient.instance()
    : await PrivacyCoinClient.init();

  const merkleProofs = await aegisClient.fetchMerkleProofs(
    selectedNotes.map((n) => n.commitmentHex),
  );

  if (merkleProofs.length !== selectedNotes.length) {
    throw new Error(`Merkle proof count mismatch: got ${merkleProofs.length}, expected ${selectedNotes.length}`);
  }

  const inputsData = await Promise.all(
    selectedNotes.map(async (note, i) => {
      const scannedNote: ScannedNote = {
        amount: typeof note.amount === "bigint" ? note.amount : BigInt(note.amount || 0),
        ephemeralPub: note.ephemeralPub,
        stealthPub: {
          x: typeof note.stealthPub?.x === "bigint" ? note.stealthPub.x : BigInt(note.stealthPub?.x || 0),
          y: typeof note.stealthPub?.y === "bigint" ? note.stealthPub.y : BigInt(note.stealthPub?.y || 0),
        },
        leafIndex: note.leafIndex,
        commitment: note.commitment,
      };

      const merkle = {
        success: true,
        root: merkleProofs[i].root.toString(16).padStart(64, "0"),
        siblings: merkleProofs[i].pathElements.map((e) => e.toString(16).padStart(64, "0")),
        indices: merkleProofs[i].pathIndices,
      };

      const realMerkleProof = parseMerkleProofResponse(merkle);
      const claimInputs = await prepareClaimInputs(keys, scannedNote, realMerkleProof);

      return {
        note: { commitmentHex: note.commitmentHex, leafIndex: note.leafIndex, amount: scannedNote.amount },
        claimInputs,
      };
    }),
  );

  // 2. Build outputs
  const sendAmounts: bigint[] = [amountSats];
  const recipientNpks: bigint[] = [];
  const stealthResults: Awaited<ReturnType<typeof createStealthDepositWithKeys>>[] = [];
  const isSpecialOutput = mode === "public" || mode === "btc";

  if (mode === "btc") {
    const result = await createStealthDepositWithKeys(selfMeta, amountSats, ZKBTC_TOKEN_ID());
    recipientNpks.push(result.stealthPubKeyX);
    stealthResults.push({ ephemeralPub: new Uint8Array(32), encryptedAmount: new Uint8Array(8), stealthPubKeyX: result.stealthPubKeyX } as any);
  } else if (mode === "public") {
    const addrBytes = new PublicKey(recipient.solanaAddress!).toBytes();
    const addrReduced = reduceToFieldOnChain(addrBytes);
    recipientNpks.push(addrReduced);
    stealthResults.push({ ephemeralPub: new Uint8Array(32), encryptedAmount: new Uint8Array(8), stealthPubKeyX: addrReduced } as any);
  } else {
    // stealth transfer
    const result = await createStealthDepositWithKeys(recipient.stealthMeta!, amountSats, ZKBTC_TOKEN_ID());
    recipientNpks.push(result.stealthPubKeyX);
    stealthResults.push(result);
  }

  // 3. Add relayer fee output (before special output if applicable)
  let relayerFeeOutputIndex: number | undefined;
  if (relayerFee > 0) {
    const feeAmount = BigInt(relayerFee);
    const feeMeta = relayerMeta || selfMeta;
    const feeResult = await createStealthDepositWithKeys(feeMeta, feeAmount, ZKBTC_TOKEN_ID());

    if (isSpecialOutput) {
      const insertIdx = sendAmounts.length - 1;
      relayerFeeOutputIndex = insertIdx;
      sendAmounts.splice(insertIdx, 0, feeAmount);
      recipientNpks.splice(insertIdx, 0, feeResult.stealthPubKeyX);
      stealthResults.splice(insertIdx, 0, feeResult);
    } else {
      relayerFeeOutputIndex = sendAmounts.length;
      sendAmounts.push(feeAmount);
      recipientNpks.push(feeResult.stealthPubKeyX);
      stealthResults.push(feeResult);
    }
  }

  // 4. Add change output (use bigint to avoid precision loss)
  const totalInput = inputsData.reduce((sum, d) => sum + d.note.amount, 0n);
  const totalOutput = sendAmounts.reduce((sum, a) => sum + a, 0n);
  const changeSats = Number(totalInput - totalOutput);

  if (changeSats > 0) {
    const changeAmount = BigInt(changeSats);
    const changeResult = await createStealthDepositWithKeys(selfMeta, changeAmount, ZKBTC_TOKEN_ID());

    if (isSpecialOutput) {
      const insertIdx = sendAmounts.length - 1;
      sendAmounts.splice(insertIdx, 0, changeAmount);
      recipientNpks.splice(insertIdx, 0, changeResult.stealthPubKeyX);
      stealthResults.splice(insertIdx, 0, changeResult);
    } else {
      sendAmounts.push(changeAmount);
      recipientNpks.push(changeResult.stealthPubKeyX);
      stealthResults.push(changeResult);
    }
  }

  // 5. Compute commitments
  const outCommitments = recipientNpks.map((npk, i) =>
    computeJoinSplitCommitmentSync(npk, ZKBTC_TOKEN_ID(), sendAmounts[i]),
  );

  // 6. Compute bound params hash
  const merkleRoot = inputsData[0].claimInputs.merkleRoot;
  const treeStealthResults = isSpecialOutput ? stealthResults.slice(0, -1) : stealthResults;
  const stealthArraysForHash = treeStealthResults.map((result) => {
    const sd = new Uint8Array(72);
    sd.set(result.ephemeralPub, 0);
    sd.set(result.encryptedAmount, 32);
    return sd;
  });
  const stealthDataHash = computeStealthDataHash(stealthArraysForHash);

  let boundParamsHash: bigint;
  let unshieldRecipientAddress: Uint8Array | undefined;

  if (mode === "btc") {
    const redeemParams = createRedeemBoundParams(recipient.btcScriptPubKey!, stealthDataHash);
    boundParamsHash = computeBoundParamsHash(redeemParams);
  } else if (mode === "public") {
    unshieldRecipientAddress = new PublicKey(recipient.solanaAddress!).toBytes();
    const unshieldParams = createUnshieldBoundParams(unshieldRecipientAddress, stealthDataHash);
    boundParamsHash = computeBoundParamsHash(unshieldParams);
  } else {
    const transferParams = createTransferBoundParams(stealthDataHash);
    boundParamsHash = computeBoundParamsHash(transferParams);
  }

  // 7. Sign
  const allNullifiers = inputsData.map((d) => d.claimInputs.nullifier);
  const msgHashInputs = [merkleRoot, boundParamsHash, ...allNullifiers, ...outCommitments];
  const sig = await aegisClient.signTransaction(msgHashInputs, keys.eddsaSeed);

  // 8. Build JoinSplit proof inputs
  const nInputs = selectedNotes.length;
  const nOutputs = sendAmounts.length;

  const proofInputs: JoinSplitProofInputs = {
    nInputs,
    nOutputs,
    merkleRoot,
    boundParamsHash,
    token: ZKBTC_TOKEN_ID(),
    publicKey: [keys.spendingPubKey.x, keys.spendingPubKey.y],
    signature: [sig.sigR8x, sig.sigR8y, sig.sigS],
    nullifyingKey: inputsData[0].claimInputs.nullifyingKey,
    inputs: inputsData.map(({ note, claimInputs }) => ({
      random: claimInputs.random,
      value: note.amount,
      leafIndex: BigInt(note.leafIndex),
      merkleProof: {
        siblings: claimInputs.merklePath,
        indices: claimInputs.merkleIndices,
      },
    })),
    outputs: recipientNpks.map((npk, i) => ({
      npk,
      value: sendAmounts[i],
    })),
  };

  // 9. Build stealth data arrays for relay
  const stealthDataArrays = stealthResults.map((result) => {
    const sd = new Uint8Array(72);
    sd.set(result.ephemeralPub, 0);
    sd.set(result.encryptedAmount, 32);
    return sd;
  });

  const relayMode = mode === "btc" ? "redeem" as const : mode === "public" ? "unshield" as const : "transfer" as const;

  return {
    proofInputs,
    stealthDataArrays,
    relayMode,
    unshieldRecipientAddress,
    btcScriptPubKey: recipient.btcScriptPubKey,
    relayerFeeOutputIndex,
    changeSats,
  };
}
