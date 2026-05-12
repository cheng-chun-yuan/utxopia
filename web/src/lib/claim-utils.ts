"use client";

import {
  initPoseidon,
  deriveMasterKey,
  deriveKeysFromSeedCircuit,
  computeJoinSplitNullifierSync,
  scanUnifiedNotes,
  parseAnnouncementsFromHex,
  type UTXOpiaKeys,
} from "@utxopia/sdk";
import { fetchSpentNullifierPDAs, nullifierHashToPDA } from "@/lib/nullifier-utils";
import { getBackendUrl } from "@/lib/api/constants";

export interface ScannedSecretNote {
  amount: number;
  leafIndex: bigint;
  commitment: string;
  nullifierHash: string;
  isSpent: boolean;
  /** Full UTXOpiaKeys derived from phrase — use for scanning, signing, and proof generation */
  keys: UTXOpiaKeys;
}

/**
 * Scan a secret phrase to find ALL matching on-chain notes (spent and unspent).
 * Derives full UTXOpiaKeys from the phrase, scans stealth announcements
 * using the viewing key (same as normal inbox scanning), and checks nullifiers.
 */
export async function scanSecretPhrase(
  phrase: string,
): Promise<ScannedSecretNote[]> {
  if (phrase.trim().length < 8) {
    throw new Error("Secret phrase must be at least 8 characters");
  }

  await initPoseidon();

  // Derive UTXOpiaKeys from phrase with circomlibjs-compatible spending keys.
  const masterKey = deriveMasterKey(phrase.trim());
  const keys = await deriveKeysFromSeedCircuit(masterKey);

  // Fetch all stealth announcements and scan with phrase-derived viewing key
  const announcementsResp = await fetch("/api/announcements");
  if (!announcementsResp.ok) {
    throw new Error("Failed to fetch stealth announcements");
  }
  const announcementsData = await announcementsResp.json();

  // Parse announcements into the format scanUnifiedNotes expects
  const announcements = parseAnnouncementsFromHex(announcementsData.announcements || []);

  const { getActiveTokenId } = await import("@/lib/token-context");
  const scannedNotes = await scanUnifiedNotes(keys, announcements, getActiveTokenId());

  if (scannedNotes.length === 0) {
    throw new Error(
      "Commitment not found. Please ensure your deposit has been confirmed on-chain."
    );
  }

  // Fetch spent nullifier PDAs, match client-side (privacy: backend never learns which notes we own)
  const backendUrl = getBackendUrl();
  const spentPdas = await fetchSpentNullifierPDAs(backendUrl);

  const results: ScannedSecretNote[] = [];
  for (const note of scannedNotes) {
    const commitmentHex = Buffer.from(note.commitment).toString("hex").padStart(64, "0");
    const leafIndexBigint = BigInt(note.leafIndex);
    const nullifierValue = computeJoinSplitNullifierSync(keys.nullifyingKey, leafIndexBigint);
    const nullifierHex = nullifierValue.toString(16).padStart(64, "0");

    results.push({
      amount: Number(note.amount),
      leafIndex: leafIndexBigint,
      commitment: commitmentHex,
      nullifierHash: nullifierHex,
      isSpent: spentPdas.has(nullifierHashToPDA(nullifierHex)),
      keys,
    });
  }

  // Sort: unspent first, then by leafIndex descending
  results.sort((a, b) => {
    if (a.isSpent !== b.isSpent) return a.isSpent ? 1 : -1;
    return Number(b.leafIndex - a.leafIndex);
  });

  const unspent = results.filter(n => !n.isSpent);
  if (unspent.length === 0) {
    throw new Error("All notes for this phrase have been spent.");
  }

  return results;
}

/**
 * Re-check nullifier status for a list of imported notes.
 * Returns updated notes with fresh isSpent values.
 */
export async function refreshNullifierStatus(
  notes: ScannedSecretNote[],
): Promise<ScannedSecretNote[]> {
  const backendUrl = getBackendUrl();
  const spentPdas = await fetchSpentNullifierPDAs(backendUrl);

  return notes.map((n) => ({
    ...n,
    isSpent: spentPdas.has(nullifierHashToPDA(n.nullifierHash)),
  }));
}