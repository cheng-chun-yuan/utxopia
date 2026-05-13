/**
 * Sender memo channel (Phase 2 — regulator-grade tamper detection)
 *
 * Outputs of a `transact` call are encrypted to the *recipient's* viewing
 * key, so the sender can't recover their own outgoing history from chain
 * data alone. Sender memos close that gap: an opt-in second event per
 * output, encrypted with a derived **outgoing viewing key** (`ovk`) so the
 * sender (or an auditor holding the right key material) can later
 * reconstruct what was sent.
 *
 * ## Cipher: XChaCha20-Poly1305 AEAD
 *
 * Chosen over plain XOR for **regulator-grade tamper detection**: the
 * Poly1305 tag fails crisply on any bit flip in the ciphertext, the nonce,
 * the key, or the AAD. With 24-byte random nonces collisions are
 * astronomically unlikely, so callers don't have to coordinate uniqueness.
 * Same family as Railgun / Zcash Sapling note encryption.
 *
 * `ovk = SHA-256(viewingPrivKey || "utxopia.ovk.v1")` — Sapling-style
 * outgoing viewing key. Currently a one-way derivation from
 * `viewingPrivKey`; a v2 refactor will derive both `ivk` and `ovk` from a
 * master `mvk` so the two can be granted independently for true
 * incoming/outgoing privilege separation.
 *
 * ## Wire format (matches `emit_sender_memo` in `events.rs`)
 *
 *   nonce              :: 24 bytes (random, fresh per memo — XChaCha extended)
 *   ciphertext_and_tag :: 56 bytes (encrypted tokenId(32) || amount(8) + Poly1305 tag(16))
 *   commitment         :: 32 bytes (plaintext — join key, also AAD)
 *   leaf_index_le      ::  4 bytes (plaintext — same)
 *   ─────────────────────────────────
 *   total              :: 116 bytes
 *
 * The AAD `commitment || leafIndex_LE` binds the seal to the memo's tree
 * leaf. An attacker who lifts a memo onto a different output → AAD
 * mismatch → tag fails → decryption returns null. Crisp move-the-memo
 * protection, unlike the probabilistic version we had with XOR.
 */

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { sha256 } from "@noble/hashes/sha2.js";

/** Bytes of the XChaCha20 24-byte nonce. */
export const SENDER_MEMO_NONCE_BYTES = 24;
/** Bytes of the encrypted ciphertext + Poly1305 tag (token(32) + amount(8) + tag(16)). */
export const SENDER_MEMO_CIPHERTEXT_BYTES = 56;
/** Plaintext token-id bytes inside the ciphertext. */
export const SENDER_MEMO_TOKEN_BYTES = 32;
/** Plaintext amount bytes inside the ciphertext. */
export const SENDER_MEMO_AMOUNT_BYTES = 8;
/** Bytes of the Poly1305 tag. */
export const SENDER_MEMO_TAG_BYTES = 16;
/** Bytes of the commitment field (plaintext, AAD). */
export const SENDER_MEMO_COMMITMENT_BYTES = 32;
/** Bytes of the leaf-index field (plaintext LE u32, AAD). */
export const SENDER_MEMO_LEAF_INDEX_BYTES = 4;
/** Total bytes of a packed sender memo. */
export const SENDER_MEMO_PACKED_BYTES =
  SENDER_MEMO_NONCE_BYTES +
  SENDER_MEMO_CIPHERTEXT_BYTES +
  SENDER_MEMO_COMMITMENT_BYTES +
  SENDER_MEMO_LEAF_INDEX_BYTES;

/** Domain separator for ovk derivation. */
const OVK_DOMAIN = new TextEncoder().encode("utxopia.ovk.v1");

/** Plaintext memo. */
export interface SenderMemoPlain {
  tokenId: bigint;
  amount: bigint;
}

/** Encrypted memo with associated chain context. */
export interface SenderMemoCiphertext {
  /** 24-byte XChaCha20 nonce. */
  nonce: Uint8Array;
  /** 56-byte ChaCha20-encrypted (tokenId(32) || amount(8)) + Poly1305 tag(16). */
  ciphertextWithTag: Uint8Array;
  /** 32-byte commitment of the output this memo covers (plaintext + AAD). */
  commitment: Uint8Array;
  /** Leaf index of the covered output (plaintext + AAD). */
  leafIndex: number;
}

/**
 * Derive the outgoing viewing key (`ovk`) from a viewing private key.
 *
 *   ovk = SHA-256(viewingPrivKey || "utxopia.ovk.v1")
 *
 * Currently derivable from `viewingPrivKey`, so possession of the viewing
 * key implies possession of `ovk`. A future v2 refactor will derive `ivk`
 * and `ovk` independently from a master `mvk`, allowing true incoming-only
 * vs outgoing-only audit delegation.
 */
export function deriveOutgoingViewingKey(viewingPrivKey: Uint8Array): Uint8Array {
  if (viewingPrivKey.length !== 32) {
    throw new Error(`viewingPrivKey must be 32 bytes; got ${viewingPrivKey.length}`);
  }
  const buf = new Uint8Array(viewingPrivKey.length + OVK_DOMAIN.length);
  buf.set(viewingPrivKey, 0);
  buf.set(OVK_DOMAIN, viewingPrivKey.length);
  return sha256(buf);
}

/**
 * Generate a fresh 24-byte XChaCha20 nonce. Exposed so callers can
 * pre-allocate nonces if they need deterministic ordering across outputs.
 */
export function generateSenderMemoNonce(): Uint8Array {
  const nonce = new Uint8Array(SENDER_MEMO_NONCE_BYTES);
  crypto.getRandomValues(nonce);
  return nonce;
}

/**
 * Encrypt a sender memo. The returned ciphertext is meant to be embedded
 * in the program's instruction data alongside the recipient announcement,
 * then emitted on-chain via `emit_sender_memo`.
 */
export function encryptSenderMemo(
  viewingPrivKey: Uint8Array,
  plain: SenderMemoPlain,
  ctx: { commitment: Uint8Array; leafIndex: number },
  nonce: Uint8Array = generateSenderMemoNonce(),
): SenderMemoCiphertext {
  if (nonce.length !== SENDER_MEMO_NONCE_BYTES) {
    throw new Error(`nonce must be ${SENDER_MEMO_NONCE_BYTES} bytes`);
  }
  if (ctx.commitment.length !== SENDER_MEMO_COMMITMENT_BYTES) {
    throw new Error(`commitment must be ${SENDER_MEMO_COMMITMENT_BYTES} bytes`);
  }

  const ovk = deriveOutgoingViewingKey(viewingPrivKey);
  const aad = buildAAD(ctx.commitment, ctx.leafIndex);
  const plaintext = packPlaintext(plain);

  const aead = xchacha20poly1305(ovk, nonce, aad);
  const ciphertextWithTag = aead.encrypt(plaintext);

  if (ciphertextWithTag.length !== SENDER_MEMO_CIPHERTEXT_BYTES) {
    throw new Error(
      `internal error: AEAD produced ${ciphertextWithTag.length} bytes, expected ${SENDER_MEMO_CIPHERTEXT_BYTES}`,
    );
  }

  return {
    nonce: new Uint8Array(nonce),
    ciphertextWithTag,
    commitment: new Uint8Array(ctx.commitment),
    leafIndex: ctx.leafIndex,
  };
}

/**
 * Decrypt a sender memo. Returns `null` when the Poly1305 tag fails
 * (wrong key, tampered ciphertext, swapped AAD) or the ciphertext is
 * structurally malformed. Callers should treat both as "not for me / corrupt"
 * rather than fatal — this is the crisp tamper-detection signal AEAD provides.
 */
export function decryptSenderMemo(
  viewingPrivKey: Uint8Array,
  memo: SenderMemoCiphertext,
): SenderMemoPlain | null {
  if (
    memo.nonce.length !== SENDER_MEMO_NONCE_BYTES ||
    memo.ciphertextWithTag.length !== SENDER_MEMO_CIPHERTEXT_BYTES ||
    memo.commitment.length !== SENDER_MEMO_COMMITMENT_BYTES
  ) {
    return null;
  }

  const ovk = deriveOutgoingViewingKey(viewingPrivKey);
  const aad = buildAAD(memo.commitment, memo.leafIndex);

  let plaintext: Uint8Array;
  try {
    const aead = xchacha20poly1305(ovk, memo.nonce, aad);
    plaintext = aead.decrypt(memo.ciphertextWithTag);
  } catch {
    return null; // tag failure → wrong key, corrupted ciphertext, or AAD mismatch
  }
  return unpackPlaintext(plaintext);
}

/**
 * Serialize a memo as its 116-byte on-chain payload.
 *
 * Layout: nonce(24) ‖ ciphertextWithTag(56) ‖ commitment(32) ‖ leafIndex(4)
 */
export function packSenderMemo(memo: SenderMemoCiphertext): Uint8Array {
  const out = new Uint8Array(SENDER_MEMO_PACKED_BYTES);
  let off = 0;
  out.set(memo.nonce, off);
  off += SENDER_MEMO_NONCE_BYTES;
  out.set(memo.ciphertextWithTag, off);
  off += SENDER_MEMO_CIPHERTEXT_BYTES;
  out.set(memo.commitment, off);
  off += SENDER_MEMO_COMMITMENT_BYTES;
  new DataView(out.buffer, out.byteOffset + off, SENDER_MEMO_LEAF_INDEX_BYTES).setUint32(
    0,
    memo.leafIndex,
    true,
  );
  return out;
}

/**
 * Pack a memo into the 80-byte instruction-data layout that `transact` reads:
 * `nonce(24) || ciphertext_and_tag(56)`. `commitment` and `leafIndex` are
 * filled in by the program from the public commitments + tree insertion
 * result, so they're omitted from the instruction-data form.
 */
export function packSenderMemoForInstruction(memo: SenderMemoCiphertext): Uint8Array {
  const out = new Uint8Array(SENDER_MEMO_NONCE_BYTES + SENDER_MEMO_CIPHERTEXT_BYTES);
  out.set(memo.nonce, 0);
  out.set(memo.ciphertextWithTag, SENDER_MEMO_NONCE_BYTES);
  return out;
}

/**
 * Per-output input for {@link buildSenderMemosForTransact}.
 *
 * - `tokenId` / `amount` are the plaintext payload that lands in the memo.
 * - `commitment` is the 32-byte output commitment for this leaf — must match
 *   exactly what the program inserts (it's AAD).
 * - `leafIndex` is the predicted on-chain leaf index for this output. Get it
 *   by reading the commitment tree's `next_leaf_index` before signing and
 *   incrementing for each output in order. If the tx races with another
 *   `transact` that inserts first, decryption will fail (the AAD won't
 *   match) — callers should be prepared to skip the failed memo on read
 *   rather than treat it as fatal.
 */
export interface SenderMemoOutput {
  tokenId: bigint;
  amount: bigint;
  commitment: Uint8Array;
  leafIndex: number;
}

/**
 * Build the per-output 80-byte sender-memo slices for a `transact` call.
 *
 * Returns one `Uint8Array` per output, each containing
 * `nonce(24) || ciphertext_and_tag(56)`. Pass the result directly to
 * {@link buildTransactInstructionData} as `senderMemos`.
 *
 * The program emits the commitment + leaf index back as part of
 * `emit_sender_memo`, so they're omitted from the instruction-data form —
 * but they remain bound via AAD, so a relayer can't lift a memo onto a
 * different output.
 */
export function buildSenderMemosForTransact(
  viewingPrivKey: Uint8Array,
  outputs: ReadonlyArray<SenderMemoOutput>,
): Uint8Array[] {
  const out: Uint8Array[] = new Array(outputs.length);
  for (let i = 0; i < outputs.length; i++) {
    const o = outputs[i];
    if (o.commitment.length !== SENDER_MEMO_COMMITMENT_BYTES) {
      throw new Error(
        `output ${i} commitment must be ${SENDER_MEMO_COMMITMENT_BYTES} bytes; got ${o.commitment.length}`,
      );
    }
    if (!Number.isInteger(o.leafIndex) || o.leafIndex < 0 || o.leafIndex > 0xffffffff) {
      throw new RangeError(`output ${i} leafIndex must be a u32; got ${o.leafIndex}`);
    }
    const memo = encryptSenderMemo(
      viewingPrivKey,
      { tokenId: o.tokenId, amount: o.amount },
      { commitment: o.commitment, leafIndex: o.leafIndex },
    );
    out[i] = packSenderMemoForInstruction(memo);
  }
  return out;
}

/** Deserialize a 116-byte packed memo. */
export function unpackSenderMemo(bytes: Uint8Array): SenderMemoCiphertext {
  if (bytes.length !== SENDER_MEMO_PACKED_BYTES) {
    throw new Error(
      `packed sender memo must be ${SENDER_MEMO_PACKED_BYTES} bytes; got ${bytes.length}`,
    );
  }
  let off = 0;
  const nonce = bytes.slice(off, off + SENDER_MEMO_NONCE_BYTES);
  off += SENDER_MEMO_NONCE_BYTES;
  const ciphertextWithTag = bytes.slice(off, off + SENDER_MEMO_CIPHERTEXT_BYTES);
  off += SENDER_MEMO_CIPHERTEXT_BYTES;
  const commitment = bytes.slice(off, off + SENDER_MEMO_COMMITMENT_BYTES);
  off += SENDER_MEMO_COMMITMENT_BYTES;
  const leafIndex = new DataView(
    bytes.buffer,
    bytes.byteOffset + off,
    SENDER_MEMO_LEAF_INDEX_BYTES,
  ).getUint32(0, true);
  return { nonce, ciphertextWithTag, commitment, leafIndex };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildAAD(commitment: Uint8Array, leafIndex: number): Uint8Array {
  const aad = new Uint8Array(
    SENDER_MEMO_COMMITMENT_BYTES + SENDER_MEMO_LEAF_INDEX_BYTES,
  );
  aad.set(commitment, 0);
  new DataView(
    aad.buffer,
    aad.byteOffset + SENDER_MEMO_COMMITMENT_BYTES,
    SENDER_MEMO_LEAF_INDEX_BYTES,
  ).setUint32(0, leafIndex, true);
  return aad;
}

function packPlaintext(plain: SenderMemoPlain): Uint8Array {
  const out = new Uint8Array(SENDER_MEMO_TOKEN_BYTES + SENDER_MEMO_AMOUNT_BYTES);
  // tokenId big-endian in first 32 bytes
  let t = plain.tokenId;
  for (let i = SENDER_MEMO_TOKEN_BYTES - 1; i >= 0; i--) {
    out[i] = Number(t & 0xffn);
    t >>= 8n;
  }
  if (t !== 0n) throw new RangeError("tokenId exceeds 256 bits");
  // amount little-endian u64 in last 8 bytes
  let a = plain.amount;
  for (let i = 0; i < SENDER_MEMO_AMOUNT_BYTES; i++) {
    out[SENDER_MEMO_TOKEN_BYTES + i] = Number(a & 0xffn);
    a >>= 8n;
  }
  if (a !== 0n) throw new RangeError("amount exceeds 64 bits");
  return out;
}

function unpackPlaintext(bytes: Uint8Array): SenderMemoPlain {
  let tokenId = 0n;
  for (let i = 0; i < SENDER_MEMO_TOKEN_BYTES; i++) tokenId = (tokenId << 8n) | BigInt(bytes[i]);
  let amount = 0n;
  for (let i = SENDER_MEMO_AMOUNT_BYTES - 1; i >= 0; i--) {
    amount = (amount << 8n) | BigInt(bytes[SENDER_MEMO_TOKEN_BYTES + i]);
  }
  return { tokenId, amount };
}
