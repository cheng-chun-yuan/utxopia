/**
 * Note module tests (pure functions only, no Poseidon)
 *
 * Tests serialization, formatting, seed strength, and hash checks.
 */

import { describe, test, expect } from "bun:test";
import {
  serializeNote,
  deserializeNote,
  formatBtc,
  parseBtc,
  estimateSeedStrength,
  noteHasComputedHashes,
  createNoteFromSecrets,
  type Note,
  type SerializedNote,
} from "../../src/note";

// ---------------------------------------------------------------------------
// serializeNote / deserializeNote
// ---------------------------------------------------------------------------

describe("serializeNote / deserializeNote", () => {
  test("roundtrip preserves amount, nullifier, secret", () => {
    const note = createNoteFromSecrets(123456789n, 987654321n, 50000n);
    const serialized = serializeNote(note);
    const restored = deserializeNote(serialized);

    expect(restored.amount).toBe(note.amount);
    expect(restored.nullifier).toBe(note.nullifier);
    expect(restored.secret).toBe(note.secret);
  });

  test("roundtrip preserves commitment when set", () => {
    const note = createNoteFromSecrets(11n, 22n, 100n, 999n, 888n);
    const serialized = serializeNote(note);
    const restored = deserializeNote(serialized);

    expect(restored.commitment).toBe(999n);
    expect(restored.nullifierHash).toBe(888n);
  });

  test("commitment/nullifierHash omitted from serialized when 0n", () => {
    const note = createNoteFromSecrets(11n, 22n, 100n);
    const serialized = serializeNote(note);

    expect(serialized.commitment).toBeUndefined();
    expect(serialized.nullifierHash).toBeUndefined();
  });

  test("serialized note has string fields", () => {
    const note = createNoteFromSecrets(42n, 43n, 100000n);
    const serialized = serializeNote(note);

    expect(typeof serialized.amount).toBe("string");
    expect(typeof serialized.nullifier).toBe("string");
    expect(typeof serialized.secret).toBe("string");
    expect(serialized.amount).toBe("100000");
    expect(serialized.nullifier).toBe("42");
    expect(serialized.secret).toBe("43");
  });

  test("deserialize from raw JSON object", () => {
    const raw: SerializedNote = {
      amount: "1000000",
      nullifier: "555",
      secret: "666",
      commitment: "777",
    };
    const note = deserializeNote(raw);

    expect(note.amount).toBe(1000000n);
    expect(note.nullifier).toBe(555n);
    expect(note.secret).toBe(666n);
    expect(note.commitment).toBe(777n);
    expect(note.nullifierHash).toBe(0n); // not provided
  });

  test("roundtrip with large bigint values", () => {
    const bigVal = 2n ** 200n + 42n;
    const note = createNoteFromSecrets(bigVal, bigVal - 1n, bigVal - 2n);
    const serialized = serializeNote(note);
    const restored = deserializeNote(serialized);

    expect(restored.nullifier).toBe(bigVal);
    expect(restored.secret).toBe(bigVal - 1n);
    expect(restored.amount).toBe(bigVal - 2n);
  });
});

// ---------------------------------------------------------------------------
// formatBtc / parseBtc
// ---------------------------------------------------------------------------

describe("formatBtc / parseBtc", () => {
  test("1 BTC = 100_000_000 sats", () => {
    expect(formatBtc(100_000_000n)).toBe("1.00000000 BTC");
  });

  test("0 sats formats correctly", () => {
    expect(formatBtc(0n)).toBe("0.00000000 BTC");
  });

  test("1 sat formats correctly", () => {
    expect(formatBtc(1n)).toBe("0.00000001 BTC");
  });

  test("0.5 BTC formats correctly", () => {
    expect(formatBtc(50_000_000n)).toBe("0.50000000 BTC");
  });

  test("21 million BTC formats correctly", () => {
    expect(formatBtc(2_100_000_000_000_000n)).toBe("21000000.00000000 BTC");
  });

  test("parseBtc reverses formatBtc for whole BTC", () => {
    expect(parseBtc("1.00000000 BTC")).toBe(100_000_000n);
  });

  test("parseBtc handles 0", () => {
    expect(parseBtc("0.00000000 BTC")).toBe(0n);
  });

  test("parseBtc handles 1 sat", () => {
    expect(parseBtc("0.00000001 BTC")).toBe(1n);
  });

  test("roundtrip formatBtc -> parseBtc", () => {
    const values = [0n, 1n, 12345n, 100_000_000n, 50_000_000n, 999_999_999n];
    for (const sats of values) {
      const formatted = formatBtc(sats);
      const parsed = parseBtc(formatted);
      expect(parsed).toBe(sats);
    }
  });

  test("parseBtc handles string without ' BTC' suffix", () => {
    // parseFloat("1.5") works even without " BTC" suffix
    expect(parseBtc("1.5")).toBe(150_000_000n);
  });
});

// ---------------------------------------------------------------------------
// estimateSeedStrength
// ---------------------------------------------------------------------------

describe("estimateSeedStrength", () => {
  test("short lowercase seed is weak", () => {
    const result = estimateSeedStrength("abc");
    expect(result.strength).toBe("weak");
    expect(result.bits).toBeLessThan(40);
    expect(result.warning).toBeDefined();
  });

  test("empty seed is weak", () => {
    const result = estimateSeedStrength("");
    expect(result.strength).toBe("weak");
    expect(result.bits).toBe(0);
  });

  test("medium lowercase seed is moderate", () => {
    const result = estimateSeedStrength("albertgogogo");
    expect(result.strength).toBe("moderate");
    expect(result.bits).toBeGreaterThanOrEqual(40);
    expect(result.bits).toBeLessThan(80);
  });

  test("long mixed-case seed with digits is strong", () => {
    const result = estimateSeedStrength("MySecretPhrase123WithNumbers");
    expect(["strong", "very_strong"]).toContain(result.strength);
    expect(result.bits).toBeGreaterThanOrEqual(80);
  });

  test("very long seed with special chars is very strong", () => {
    const result = estimateSeedStrength("Th1s!Is@A#Very$Long%Passphrase^With&Special*Chars");
    expect(result.strength).toBe("very_strong");
    expect(result.bits).toBeGreaterThanOrEqual(128);
  });

  test("no warning for strong seeds", () => {
    const result = estimateSeedStrength("MySecretPhrase123WithSomeLength");
    if (result.bits >= 80) {
      expect(result.warning).toBeUndefined();
    }
  });

  test("bits increases with length", () => {
    const short = estimateSeedStrength("abc");
    const long = estimateSeedStrength("abcdefghijklmnop");
    expect(long.bits).toBeGreaterThan(short.bits);
  });

  test("mixed charset increases bits per character", () => {
    // Same length, but mixed case + digits has more entropy per char
    const lower = estimateSeedStrength("abcdefghij");
    const mixed = estimateSeedStrength("aBcDeFgHiJ");
    expect(mixed.bits).toBeGreaterThan(lower.bits);
  });
});

// ---------------------------------------------------------------------------
// noteHasComputedHashes
// ---------------------------------------------------------------------------

describe("noteHasComputedHashes", () => {
  test("returns false when both hashes are 0n", () => {
    const note = createNoteFromSecrets(1n, 2n, 100n);
    expect(noteHasComputedHashes(note)).toBe(false);
  });

  test("returns false when only commitment is set", () => {
    const note = createNoteFromSecrets(1n, 2n, 100n, 999n);
    expect(noteHasComputedHashes(note)).toBe(false);
  });

  test("returns false when only nullifierHash is set", () => {
    const note = createNoteFromSecrets(1n, 2n, 100n, undefined, 888n);
    expect(noteHasComputedHashes(note)).toBe(false);
  });

  test("returns true when both commitment and nullifierHash are set", () => {
    const note = createNoteFromSecrets(1n, 2n, 100n, 999n, 888n);
    expect(noteHasComputedHashes(note)).toBe(true);
  });

  test("returns true with large hash values", () => {
    const note = createNoteFromSecrets(1n, 2n, 100n, 2n ** 200n, 2n ** 253n);
    expect(noteHasComputedHashes(note)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createNoteFromSecrets
// ---------------------------------------------------------------------------

describe("createNoteFromSecrets", () => {
  test("sets byte arrays correctly", () => {
    const note = createNoteFromSecrets(10n, 20n, 500n);
    expect(note.nullifierBytes).toBeInstanceOf(Uint8Array);
    expect(note.secretBytes).toBeInstanceOf(Uint8Array);
    expect(note.commitmentBytes).toBeInstanceOf(Uint8Array);
    expect(note.nullifierHashBytes).toBeInstanceOf(Uint8Array);
  });

  test("defaults commitment and nullifierHash to 0n", () => {
    const note = createNoteFromSecrets(10n, 20n, 500n);
    expect(note.commitment).toBe(0n);
    expect(note.nullifierHash).toBe(0n);
    expect(note.note).toBe(0n);
  });

  test("accepts optional commitment and nullifierHash", () => {
    const note = createNoteFromSecrets(10n, 20n, 500n, 42n, 43n);
    expect(note.commitment).toBe(42n);
    expect(note.nullifierHash).toBe(43n);
  });
});
