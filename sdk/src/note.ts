/**
 * Note (shielded commitment) utilities for UTXOpia
 *
 * A Note represents a shielded deposit with:
 * - nullifier: Random secret for spending
 * - secret: Additional entropy
 * - amount: Value in satoshis
 *
 * Hash values (commitment, nullifierHash) are computed by circom circuits
 * using Poseidon. This SDK stores the raw secrets and optionally
 * accepts pre-computed hash values.
 */

import { randomFieldElement, bigintToBytes, sha256Hash, bytesToBigint, BN254_FIELD_PRIME, babyJubMul, BABYJUB_BASE8 } from "./crypto";
import { computeUnifiedCommitmentSync, computeNullifierSync, hashNullifierSync, computeJoinSplitCommitmentSync, computeNPKSync, computeMPKSync, computeJoinSplitNullifierSync } from "./poseidon";

/**
 * Note structure for shielded amounts
 *
 * Core secrets (always required):
 * - amount, nullifier, secret
 *
 * Computed values (from circom circuits):
 * - note, commitment, nullifierHash
 * These are 0n until computed by circuits
 */
export interface Note {
  // Amount in satoshis
  amount: bigint;
  // Random nullifier (field element)
  nullifier: bigint;
  // Random secret (field element)
  secret: bigint;
  // note = Poseidon(nullifier, secret) - computed by circuit
  note: bigint;
  // commitment = Poseidon(note, amount) - computed by circuit
  commitment: bigint;
  // nullifierHash = Poseidon(nullifier) - computed by circuit
  nullifierHash: bigint;
  // 32-byte representations
  nullifierBytes: Uint8Array;
  secretBytes: Uint8Array;
  commitmentBytes: Uint8Array;
  nullifierHashBytes: Uint8Array;
}

/**
 * Serializable note data (for storage/transmission)
 * Only stores essential secrets - hashes recomputed by circuits
 */
export interface SerializedNote {
  amount: string;
  nullifier: string;
  secret: string;
  // Optional pre-computed values
  commitment?: string;
  nullifierHash?: string;
}

/**
 * Generate a new note with random nullifier and secret
 *
 * Note: Hash values are NOT computed here. They will be computed
 * by the circom circuits during proof generation.
 *
 * @param amountSats - Amount in satoshis
 * @returns Note with secrets (hashes are 0n until circuit execution)
 */
export function generateNote(amountSats: bigint): Note {
  const nullifier = randomFieldElement();
  const secret = randomFieldElement();

  return createNoteFromSecrets(nullifier, secret, amountSats);
}

/**
 * Create a note from known secrets
 *
 * @param nullifier - Nullifier field element
 * @param secret - Secret field element
 * @param amountSats - Amount in satoshis
 * @param commitment - Optional pre-computed commitment (from circuit)
 * @param nullifierHash - Optional pre-computed nullifier hash (from circuit)
 * @returns Note structure
 */
export function createNoteFromSecrets(
  nullifier: bigint,
  secret: bigint,
  amountSats: bigint,
  commitment?: bigint,
  nullifierHash?: bigint
): Note {
  // Computed values are 0n until provided from circuit outputs
  const comm = commitment ?? 0n;
  const nullHash = nullifierHash ?? 0n;
  const noteHash = 0n; // Intermediate hash not typically exposed

  return {
    amount: amountSats,
    nullifier,
    secret,
    note: noteHash,
    commitment: comm,
    nullifierHash: nullHash,
    nullifierBytes: bigintToBytes(nullifier),
    secretBytes: bigintToBytes(secret),
    commitmentBytes: bigintToBytes(comm),
    nullifierHashBytes: bigintToBytes(nullHash),
  };
}

/**
 * Update note with computed hash values from circom circuit execution
 *
 * @param note - Note to update
 * @param commitment - Commitment from circuit output
 * @param nullifierHash - Nullifier hash from circuit output
 * @returns Updated note
 */
export function updateNoteWithHashes(
  note: Note,
  commitment: bigint,
  nullifierHash: bigint
): Note {
  return {
    ...note,
    commitment,
    nullifierHash,
    commitmentBytes: bigintToBytes(commitment),
    nullifierHashBytes: bigintToBytes(nullifierHash),
  };
}

/**
 * Serialize a note for storage or transmission
 *
 * Only stores the essential data (amount, nullifier, secret).
 * Optionally includes pre-computed hash values.
 */
export function serializeNote(note: Note): SerializedNote {
  const serialized: SerializedNote = {
    amount: note.amount.toString(),
    nullifier: note.nullifier.toString(),
    secret: note.secret.toString(),
  };

  // Include computed values if available
  if (note.commitment !== 0n) {
    serialized.commitment = note.commitment.toString();
  }
  if (note.nullifierHash !== 0n) {
    serialized.nullifierHash = note.nullifierHash.toString();
  }

  return serialized;
}

/**
 * Deserialize and restore a note from stored data
 */
export function deserializeNote(data: SerializedNote): Note {
  const amount = BigInt(data.amount);
  const nullifier = BigInt(data.nullifier);
  const secret = BigInt(data.secret);
  const commitment = data.commitment ? BigInt(data.commitment) : undefined;
  const nullifierHash = data.nullifierHash
    ? BigInt(data.nullifierHash)
    : undefined;

  return createNoteFromSecrets(
    nullifier,
    secret,
    amount,
    commitment,
    nullifierHash
  );
}

/**
 * Format satoshis as BTC string
 */
export function formatBtc(sats: bigint): string {
  const btc = Number(sats) / 100_000_000;
  return btc.toFixed(8) + " BTC";
}

/**
 * Parse BTC string to satoshis
 */
export function parseBtc(btcString: string): bigint {
  const btc = parseFloat(btcString.replace(" BTC", ""));
  return BigInt(Math.round(btc * 100_000_000));
}

/**
 * Check if a note has computed hash values
 */
export function noteHasComputedHashes(note: Note): boolean {
  return note.commitment !== 0n && note.nullifierHash !== 0n;
}

// ============================================================================
// Note Commitment/Nullifier Helpers
// ============================================================================

/**
 * Get the public key X coordinate from a note's nullifier (used as private key)
 *
 * In the unified model: pubKey = nullifier * BASE8 (on Baby Jubjub curve)
 * Returns pubKey.x for commitment computation
 */
export function getNotePublicKeyX(note: Note): bigint {
  const pubKey = babyJubMul(note.nullifier, BABYJUB_BASE8);
  return pubKey.x;
}

/**
 * Compute the commitment for a note
 *
 * commitment = Poseidon(pubKeyX, amount)
 * where pubKeyX = (nullifier * G).x
 *
 * Returns the note with commitment fields populated
 */
export function computeNoteCommitment(note: Note): Note {
  const pubKeyX = getNotePublicKeyX(note);
  const commitment = computeUnifiedCommitmentSync(pubKeyX, note.amount);
  const commitmentBytes = bigintToBytes(commitment);

  return {
    ...note,
    commitment,
    commitmentBytes,
  };
}

/**
 * Compute the nullifier and nullifier hash for a note at a given leaf index
 *
 * nullifier = Poseidon(privKey, leafIndex)
 * nullifierHash = Poseidon(nullifier)
 *
 * @returns Object with computed nullifier values
 */
export function computeNoteNullifier(
  note: Note,
  leafIndex: bigint
): {
  nullifier: bigint;
  nullifierHash: bigint;
  nullifierHashBytes: Uint8Array;
} {
  const nullifier = computeNullifierSync(note.nullifier, leafIndex);
  const nullifierHash = hashNullifierSync(nullifier);
  const nullifierHashBytes = bigintToBytes(nullifierHash);

  return {
    nullifier,
    nullifierHash,
    nullifierHashBytes,
  };
}

// ============================================================================
// Deterministic Note Derivation (HD-style)
// ============================================================================

/**
 * Derive a note deterministically from a seed phrase/name and index.
 *
 * This allows recovery of all notes from just the seed + index.
 * Similar to HD wallets in Bitcoin.
 *
 * The seed is first hashed to create a 32-byte master key, then
 * nullifier and secret are derived from that master key.
 *
 * @param seed - Seed phrase, name, or password (any string)
 * @param index - Note index (0, 1, 2, ...)
 * @param amountSats - Amount in satoshis
 * @returns Note with deterministically derived secrets
 *
 * @example
 * ```typescript
 * // Derive notes from a name
 * const note0 = deriveNote("albertgogogo", 0, 100_000n);
 * const note1 = deriveNote("albertgogogo", 1, 50_000n);
 *
 * // Later: recover the same notes
 * const recovered = deriveNote("albertgogogo", 0, 100_000n);
 * // recovered.nullifier === note0.nullifier ✓
 * ```
 */
export function deriveNote(
  seed: string,
  index: number,
  amountSats: bigint
): Note {
  // Step 1: Hash seed to get 32-byte master key (normalizes any input)
  const master = deriveMasterKey(seed);

  // Step 2: Derive nullifier and secret from master + index
  const nullifier = deriveFromMaster(master, index, 0); // 0 = nullifier domain
  const secret = deriveFromMaster(master, index, 1);    // 1 = secret domain

  return createNoteFromSecrets(nullifier, secret, amountSats);
}

/**
 * Derive master key from seed (32 bytes)
 *
 * master = SHA256(seed)
 *
 * You can cache this and use deriveNoteFromMaster() for efficiency.
 */
export function deriveMasterKey(seed: string): Uint8Array {
  const encoder = new TextEncoder();
  const seedBytes = encoder.encode(seed);
  return sha256Hash(seedBytes);
}

/**
 * Derive a note from a pre-computed master key
 *
 * More efficient if deriving many notes from the same seed.
 *
 * @example
 * ```typescript
 * const master = deriveMasterKey("albertgogogo");
 * const note0 = deriveNoteFromMaster(master, 0, 100_000n);
 * const note1 = deriveNoteFromMaster(master, 1, 50_000n);
 * ```
 */
export function deriveNoteFromMaster(
  master: Uint8Array,
  index: number,
  amountSats: bigint
): Note {
  const nullifier = deriveFromMaster(master, index, 0);
  const secret = deriveFromMaster(master, index, 1);
  return createNoteFromSecrets(nullifier, secret, amountSats);
}

/**
 * Derive field element from master key + index + domain
 *
 * result = SHA256(master || index || domain) mod BN254_PRIME
 *
 * @param master - 32-byte master key
 * @param index - Note index
 * @param domain - 0 for nullifier, 1 for secret
 */
function deriveFromMaster(
  master: Uint8Array,
  index: number,
  domain: number
): bigint {
  // Build input: master (32) || index (4) || domain (1) = 37 bytes
  const input = new Uint8Array(37);
  input.set(master, 0);

  // Index as 4 bytes little-endian
  const view = new DataView(input.buffer);
  view.setUint32(32, index, true);

  // Domain as 1 byte
  input[36] = domain;

  // Hash and reduce to field
  const hash = sha256Hash(input);
  return bytesToBigint(hash) % BN254_FIELD_PRIME;
}

/**
 * Derive multiple notes at once from a seed
 *
 * More efficient than calling deriveNote() multiple times
 * because master key is computed only once.
 *
 * @param seed - Seed phrase
 * @param amounts - Array of amounts for each note
 * @param startIndex - Starting index (default 0)
 * @returns Array of derived notes
 *
 * @example
 * ```typescript
 * // Create a wallet with 3 notes
 * const notes = deriveNotes("albertgogogo", [100_000n, 50_000n, 25_000n]);
 * ```
 */
export function deriveNotes(
  seed: string,
  amounts: bigint[],
  startIndex: number = 0
): Note[] {
  // Compute master once, derive all notes from it
  const master = deriveMasterKey(seed);
  return amounts.map((amount, i) => deriveNoteFromMaster(master, startIndex + i, amount));
}

/**
 * Check the strength of a seed phrase
 *
 * Returns estimated bits of entropy.
 * Recommended: >= 80 bits for moderate security, >= 128 bits for high security
 */
export function estimateSeedStrength(seed: string): {
  bits: number;
  strength: "weak" | "moderate" | "strong" | "very_strong";
  warning?: string;
} {
  // Very rough entropy estimation
  const length = seed.length;
  const hasLower = /[a-z]/.test(seed);
  const hasUpper = /[A-Z]/.test(seed);
  const hasDigit = /[0-9]/.test(seed);
  const hasSpecial = /[^a-zA-Z0-9]/.test(seed);

  let charsetSize = 0;
  if (hasLower) charsetSize += 26;
  if (hasUpper) charsetSize += 26;
  if (hasDigit) charsetSize += 10;
  if (hasSpecial) charsetSize += 32;

  // Entropy = length * log2(charsetSize)
  const bits = Math.floor(length * Math.log2(charsetSize || 1));

  let strength: "weak" | "moderate" | "strong" | "very_strong";
  let warning: string | undefined;

  if (bits < 40) {
    strength = "weak";
    warning = "DANGER: This seed can be easily brute-forced. Use a longer passphrase!";
  } else if (bits < 80) {
    strength = "moderate";
    warning = "Consider using a longer passphrase for better security.";
  } else if (bits < 128) {
    strength = "strong";
  } else {
    strength = "very_strong";
  }

  return { bits, strength, warning };
}

// ============================================================================
// Circom-Compatible Note Helpers
// ============================================================================

/**
 * Simple note data structure (for circom circuit inputs)
 *
 * NOTE: When using circom circuits, the commitment is computed INSIDE the circuit
 * using Poseidon. The SDK just provides the raw note data.
 */
export interface NoteData {
  nullifier: bigint;
  secret: bigint;
  amount: bigint;
}

// Poseidon initialization state (for API compatibility)
let poseidonInitialized = false;

/**
 * Create a simple note (alias for generateNote but returns NoteData)
 *
 * Use this to generate note data for circom circuit inputs.
 *
 * @param amount - Amount in satoshis
 * @returns NoteData with nullifier, secret, and amount
 */
export function createNote(amount: bigint): NoteData {
  const note = generateNote(amount);
  return {
    nullifier: note.nullifier,
    secret: note.secret,
    amount: note.amount,
  };
}

/**
 * Initialize Poseidon (no-op for circom - hashing is done in circuit)
 *
 * Kept for API compatibility. In circom mode, this is a no-op.
 */
export async function initPoseidon(): Promise<void> {
  poseidonInitialized = true;
  // No actual initialization needed - circom circuit handles Poseidon
}

/**
 * Check if Poseidon is ready
 *
 * Always returns true after initPoseidon() is called (for API compatibility).
 */
export function isPoseidonReady(): boolean {
  return poseidonInitialized;
}

/**
 * Prepare withdrawal - creates change note for remaining balance
 *
 * PRIVACY: All withdrawals are indistinguishable on-chain.
 * Change amount can be >= 0, and the commitment always looks random.
 *
 * @param inputNote - Note being spent
 * @param withdrawAmount - Amount to withdraw
 * @returns Change note with remaining balance (can be 0)
 */
export function prepareWithdrawal(
  inputNote: NoteData,
  withdrawAmount: bigint
): { changeNote: NoteData; changeAmount: bigint } {
  if (withdrawAmount <= 0n) {
    throw new Error("Withdraw amount must be positive");
  }
  if (withdrawAmount > inputNote.amount) {
    throw new Error("Withdraw amount exceeds note balance");
  }

  const changeAmount = inputNote.amount - withdrawAmount;
  const changeNote = createNote(changeAmount);

  return { changeNote, changeAmount };
}

// ============================================================================
// Stealth Note Types (Dual-Key ECDH Support)
// ============================================================================

/**
 * Stealth note structure for dual-key ECDH system
 *
 * Key differences from basic Note:
 * - Uses random value instead of nullifier/secret for commitment
 * - Stores ephemeral spending pubkey for proof generation
 * - Nullifier derived from (spendingPrivKey, leafIndex) in circuit
 */
export interface StealthNote {
  /** Amount in satoshis */
  amount: bigint;

  /** Random value for commitment */
  random: bigint;

  /** Ephemeral spending public key (from sender) */
  ephemeralSpendPubX: bigint;
  ephemeralSpendPubY: bigint;

  /** Leaf index in Merkle tree (set when commitment added on-chain) */
  leafIndex: number;

  /** Note public key = Poseidon(ECDHShared.x, ECDHShared.y) */
  notePubKey: bigint;

  /** Commitment = Poseidon(notePubKey, amount, random) */
  commitment: bigint;

  /** Byte representations */
  randomBytes: Uint8Array;
  commitmentBytes: Uint8Array;
}

/**
 * Serializable stealth note data
 */
export interface SerializedStealthNote {
  amount: string;
  random: string;
  ephemeralSpendPubX: string;
  ephemeralSpendPubY: string;
  leafIndex: number;
  notePubKey?: string;
  commitment?: string;
}

/**
 * Create a stealth note from scanned announcement data
 *
 * @param amount - Decrypted amount
 * @param random - Decrypted random value
 * @param ephemeralSpendPub - Sender's ephemeral pubkey
 * @param leafIndex - Merkle tree leaf index
 * @returns StealthNote structure
 */
export function createStealthNote(
  amount: bigint,
  random: bigint,
  ephemeralSpendPub: { x: bigint; y: bigint },
  leafIndex: number
): StealthNote {
  return {
    amount,
    random,
    ephemeralSpendPubX: ephemeralSpendPub.x,
    ephemeralSpendPubY: ephemeralSpendPub.y,
    leafIndex,
    notePubKey: 0n, // Computed in circuit
    commitment: 0n, // Computed in circuit
    randomBytes: bigintToBytes(random),
    commitmentBytes: new Uint8Array(32),
  };
}

/**
 * Update stealth note with computed values from circuit
 */
export function updateStealthNoteWithHashes(
  note: StealthNote,
  notePubKey: bigint,
  commitment: bigint
): StealthNote {
  return {
    ...note,
    notePubKey,
    commitment,
    commitmentBytes: bigintToBytes(commitment),
  };
}

/**
 * Serialize stealth note for storage
 */
export function serializeStealthNote(note: StealthNote): SerializedStealthNote {
  const serialized: SerializedStealthNote = {
    amount: note.amount.toString(),
    random: note.random.toString(),
    ephemeralSpendPubX: note.ephemeralSpendPubX.toString(),
    ephemeralSpendPubY: note.ephemeralSpendPubY.toString(),
    leafIndex: note.leafIndex,
  };

  if (note.notePubKey !== 0n) {
    serialized.notePubKey = note.notePubKey.toString();
  }
  if (note.commitment !== 0n) {
    serialized.commitment = note.commitment.toString();
  }

  return serialized;
}

/**
 * Deserialize stealth note from storage
 */
export function deserializeStealthNote(data: SerializedStealthNote): StealthNote {
  const note = createStealthNote(
    BigInt(data.amount),
    BigInt(data.random),
    {
      x: BigInt(data.ephemeralSpendPubX),
      y: BigInt(data.ephemeralSpendPubY),
    },
    data.leafIndex
  );

  if (data.notePubKey && data.commitment) {
    return updateStealthNoteWithHashes(
      note,
      BigInt(data.notePubKey),
      BigInt(data.commitment)
    );
  }

  return note;
}

/**
 * Check if stealth note has computed hashes
 */
export function stealthNoteHasComputedHashes(note: StealthNote): boolean {
  return note.notePubKey !== 0n && note.commitment !== 0n;
}

// ============================================================================
// JoinSplit Note (Railgun-aligned 3-key model)
// ============================================================================

/**
 * JoinSplit note structure
 *
 * Commitment = Poseidon(npk, token, amount)
 * where npk = Poseidon(MPK, random)
 * and MPK = Poseidon(pkX, pkY, nullifyingKey)
 */
export interface JoinSplitNote {
  /** Note public key: Poseidon(MPK, random) */
  npk: bigint;
  /** Token identifier: computeTokenId(mintBytes) */
  token: bigint;
  /** Amount in token's native units */
  amount: bigint;
  /** Blinding factor (used in NPK derivation) */
  random: bigint;
  /** Merkle tree leaf position (-1 if not yet inserted) */
  leafIndex: number;
  /** Commitment: Poseidon(npk, token, amount) */
  commitment: bigint;
}

/**
 * Create a JoinSplit note from key components
 *
 * @param tokenId - Token identifier from computeTokenId(mintBytes)
 */
export function createJoinSplitNote(
  mpk: bigint,
  random: bigint,
  amount: bigint,
  tokenId: bigint,
  leafIndex: number = -1,
): JoinSplitNote {
  const npk = computeNPKSync(mpk, random);
  const commitment = computeJoinSplitCommitmentSync(npk, tokenId, amount);

  return {
    npk,
    token: tokenId,
    amount,
    random,
    leafIndex,
    commitment,
  };
}

/**
 * Compute nullifier for a JoinSplit note
 */
export function computeJoinSplitNoteNullifier(
  nullifyingKey: bigint,
  leafIndex: number,
): bigint {
  return computeJoinSplitNullifierSync(nullifyingKey, BigInt(leafIndex));
}

/**
 * Serialize a JoinSplit note for storage
 */
export interface SerializedJoinSplitNote {
  npk: string;
  token: string;
  amount: string;
  random: string;
  leafIndex: number;
  commitment: string;
}

export function serializeJoinSplitNote(note: JoinSplitNote): SerializedJoinSplitNote {
  return {
    npk: note.npk.toString(),
    token: note.token.toString(),
    amount: note.amount.toString(),
    random: note.random.toString(),
    leafIndex: note.leafIndex,
    commitment: note.commitment.toString(),
  };
}

export function deserializeJoinSplitNote(data: SerializedJoinSplitNote): JoinSplitNote {
  return {
    npk: BigInt(data.npk),
    token: BigInt(data.token),
    amount: BigInt(data.amount),
    random: BigInt(data.random),
    leafIndex: data.leafIndex,
    commitment: BigInt(data.commitment),
  };
}

