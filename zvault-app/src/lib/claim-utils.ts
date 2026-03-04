"use client";

import { PublicKey } from "@solana/web3.js";
import {
  initPoseidon,
  deriveMasterKey,
  eddsaGetPubKey,
  deriveNote,
  getCommitmentIndex,
  computeJoinSplitCommitmentSync,
  computeJoinSplitNullifierSync,
  PDA_SEEDS,
  DEVNET_CONFIG,
} from "@zvault/sdk";

/** ZBTC token ID used in Poseidon commitment */
const ZBTC_TOKEN_ID = BigInt(0x7a627463);

export interface ScannedSecretNote {
  amount: number;
  leafIndex: bigint;
  commitment: string;
  nullifierHash: string;
  eddsaSeed: Uint8Array;
  nullifyingKey: bigint;
  pubKeyX: bigint;
  pubKeyY: bigint;
  random: bigint;
}

/**
 * Scan a secret phrase to find the corresponding on-chain note.
 * Derives keys from the phrase, looks up the commitment in the index,
 * and checks if the nullifier has already been spent.
 */
export async function scanSecretPhrase(
  phrase: string,
  connection?: { getAccountInfo: (pk: PublicKey) => Promise<{ data: Buffer } | null> },
): Promise<ScannedSecretNote> {
  if (phrase.trim().length < 8) {
    throw new Error("Secret phrase must be at least 8 characters");
  }

  await initPoseidon();

  // Derive EdDSA seed and public key from secret phrase
  const masterKey = deriveMasterKey(phrase.trim());
  const pubKeyPoint = await eddsaGetPubKey(masterKey);
  const pubKeyX = pubKeyPoint.x;
  const pubKeyY = pubKeyPoint.y;

  // Also derive note for nullifyingKey and random
  const note = deriveNote(phrase.trim(), 0, BigInt(0));

  // Find commitment in index by trying common amounts
  const commitmentIndex = getCommitmentIndex();
  let foundAmount: number | null = null;
  let foundLeafIndex: bigint = 0n;

  const tryAmounts = [1000, 2000, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000];
  for (const amt of tryAmounts) {
    const testCommitment = computeJoinSplitCommitmentSync(pubKeyX, ZBTC_TOKEN_ID, BigInt(amt));
    const testHex = testCommitment.toString(16).padStart(64, "0");
    const entry = commitmentIndex.getCommitment(testHex);
    if (entry) {
      foundAmount = amt;
      foundLeafIndex = entry.index;
      break;
    }
  }

  if (foundAmount === null) {
    throw new Error(
      "Commitment not found. Please ensure your deposit has been confirmed on-chain."
    );
  }

  // Compute actual nullifier hash: Poseidon(nullifyingKey, leafIndex)
  const nullifierValue = computeJoinSplitNullifierSync(note.nullifier, foundLeafIndex);
  const nullifierHex = nullifierValue.toString(16).padStart(64, "0");

  // Check if nullifier already spent via backend indexer
  try {
    const nullifierResp = await fetch(`/api/tracker/nullifier/${nullifierHex}`);
    if (nullifierResp.ok) {
      const nullifierData = await nullifierResp.json();
      if (nullifierData.found) {
        throw new Error("This note has already been claimed.");
      }
    }
  } catch (checkErr) {
    if (checkErr instanceof Error && checkErr.message.includes("already been claimed")) {
      throw checkErr;
    }
    // Fall back to on-chain check if connection available
    if (connection) {
      const nullifierBytesCheck = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        nullifierBytesCheck[i] = parseInt(nullifierHex.slice(i * 2, i * 2 + 2), 16);
      }
      const [nullifierPda] = PublicKey.findProgramAddressSync(
        [Buffer.from(PDA_SEEDS.NULLIFIER), nullifierBytesCheck],
        new PublicKey(DEVNET_CONFIG.zvaultProgramId)
      );
      const nullifierAccount = await connection.getAccountInfo(nullifierPda);
      if (nullifierAccount !== null) {
        throw new Error("This note has already been claimed.");
      }
    }
  }

  const commitment = computeJoinSplitCommitmentSync(pubKeyX, ZBTC_TOKEN_ID, BigInt(foundAmount));
  const commitmentHex = commitment.toString(16).padStart(64, "0");

  return {
    amount: foundAmount,
    leafIndex: foundLeafIndex,
    commitment: commitmentHex,
    nullifierHash: nullifierHex,
    eddsaSeed: masterKey,
    nullifyingKey: note.nullifier,
    pubKeyX,
    pubKeyY,
    random: note.secret ?? 0n,
  };
}
