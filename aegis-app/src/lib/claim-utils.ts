"use client";

import { PublicKey } from "@solana/web3.js";
import {
  initPoseidon,
  deriveMasterKey,
  deriveKeysFromSeedCircuit,
  getCommitmentIndex,
  computeJoinSplitNullifierSync,
  scanUnifiedNotes,
  PDA_SEEDS,
  DEVNET_CONFIG,
  type AegisKeys,
} from "@aegis/sdk";

export interface ScannedSecretNote {
  amount: number;
  leafIndex: bigint;
  commitment: string;
  nullifierHash: string;
  isSpent: boolean;
  /** Full AegisKeys derived from phrase — use for scanning, signing, and proof generation */
  keys: AegisKeys;
}

/**
 * Scan a secret phrase to find ALL matching on-chain notes (spent and unspent).
 * Derives full AegisKeys from the phrase, scans stealth announcements
 * using the viewing key (same as normal inbox scanning), and checks nullifiers.
 */
export async function scanSecretPhrase(
  phrase: string,
  connection?: { getAccountInfo: (pk: PublicKey) => Promise<{ data: Buffer } | null> },
): Promise<ScannedSecretNote[]> {
  if (phrase.trim().length < 8) {
    throw new Error("Secret phrase must be at least 8 characters");
  }

  await initPoseidon();

  // Derive AegisKeys from phrase with circomlibjs-compatible spending keys.
  const masterKey = deriveMasterKey(phrase.trim());
  const keys = await deriveKeysFromSeedCircuit(masterKey);

  // Fetch all stealth announcements and scan with phrase-derived viewing key
  const announcementsResp = await fetch("/api/stealth/announcements");
  if (!announcementsResp.ok) {
    throw new Error("Failed to fetch stealth announcements");
  }
  const announcementsData = await announcementsResp.json();

  // Parse announcements into the format scanUnifiedNotes expects
  const announcements = (announcementsData.announcements || []).map((ann: {
    announcementType: number;
    ephemeralPub: string;
    encryptedAmount: string;
    commitment: string;
    leafIndex: number;
  }) => ({
    announcementType: ann.announcementType,
    ephemeralPub: hexToBytes(ann.ephemeralPub),
    encryptedAmount: hexToBytes(ann.encryptedAmount),
    commitment: hexToBytes(ann.commitment),
    leafIndex: ann.leafIndex,
  }));

  const scannedNotes = await scanUnifiedNotes(keys, announcements);

  if (scannedNotes.length === 0) {
    throw new Error(
      "Commitment not found. Please ensure your deposit has been confirmed on-chain."
    );
  }

  // Build all notes with nullifier status
  const rpcUrl = process.env.NEXT_PUBLIC_HELIUS_RPC_URL || "https://api.devnet.solana.com";

  const results: ScannedSecretNote[] = [];
  for (const note of scannedNotes) {
    const commitmentHex = Buffer.from(note.commitment).toString("hex").padStart(64, "0");
    const leafIndexBigint = BigInt(note.leafIndex);
    const nullifierValue = computeJoinSplitNullifierSync(keys.nullifyingKey, leafIndexBigint);
    const nullifierHex = nullifierValue.toString(16).padStart(64, "0");

    let isSpent = false;
    try {
      isSpent = await checkNullifierExists(nullifierHex, rpcUrl, connection);
    } catch {
      // Assume unspent on error
    }

    results.push({
      amount: Number(note.amount),
      leafIndex: leafIndexBigint,
      commitment: commitmentHex,
      nullifierHash: nullifierHex,
      isSpent,
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
  const rpcUrl = process.env.NEXT_PUBLIC_HELIUS_RPC_URL || "https://api.devnet.solana.com";

  // Batch: compute all nullifier PDAs
  const pdas = notes.map((n) => {
    const nullifierBytes = hexToBytes(n.nullifierHash);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from(PDA_SEEDS.NULLIFIER), nullifierBytes],
      new PublicKey(DEVNET_CONFIG.aegisProgramId)
    );
    return pda.toBase58();
  });

  // Single batched RPC call
  try {
    const resp = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getMultipleAccounts",
        params: [pdas, { encoding: "base64" }],
      }),
    });
    const result = await resp.json();
    const accountValues: (null | object)[] = result?.result?.value || [];

    return notes.map((n, i) => ({
      ...n,
      isSpent: accountValues[i] !== null,
    }));
  } catch {
    return notes; // keep existing status on error
  }
}

/** Check if a nullifier exists on-chain (returns true = spent) */
async function checkNullifierExists(
  nullifierHex: string,
  rpcUrl: string,
  connection?: { getAccountInfo: (pk: PublicKey) => Promise<{ data: Buffer } | null> },
): Promise<boolean> {
  // Try API first
  try {
    const nullifierResp = await fetch(`/api/tracker/nullifier/${nullifierHex}`);
    if (nullifierResp.ok) {
      const nullifierData = await nullifierResp.json();
      if (nullifierData.found) return true;
    }
  } catch {
    // Fall through to on-chain check
  }

  // On-chain PDA check
  const nullifierBytes = hexToBytes(nullifierHex);
  const [nullifierPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.NULLIFIER), nullifierBytes],
    new PublicKey(DEVNET_CONFIG.aegisProgramId)
  );

  if (connection) {
    const account = await connection.getAccountInfo(nullifierPda);
    return account !== null;
  }

  // Fallback: RPC call
  try {
    const resp = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getAccountInfo",
        params: [nullifierPda.toBase58(), { encoding: "base64" }],
      }),
    });
    const result = await resp.json();
    return result?.result?.value !== null;
  } catch {
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
