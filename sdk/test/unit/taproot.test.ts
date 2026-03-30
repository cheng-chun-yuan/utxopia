import { describe, it, expect } from "bun:test";
import {
  isValidBitcoinAddress,
  createOpReturnScript,
  parseOpReturnCommitment,
  buildDepositOpReturn,
  parseDepositOpReturn,
  buildMockBtcTransaction,
  DEPOSIT_OP_RETURN_SIZE,
} from "../../src/taproot";

describe("DEPOSIT_OP_RETURN_SIZE", () => {
  it("should equal 64", () => {
    expect(DEPOSIT_OP_RETURN_SIZE).toBe(64);
  });
});

describe("isValidBitcoinAddress", () => {
  it("recognizes mainnet P2TR (bc1p)", () => {
    // Valid bc1p address (62 chars after bc1p, bech32m)
    const addr =
      "bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297";
    const result = isValidBitcoinAddress(addr);
    expect(result.valid).toBe(true);
    expect(result.type).toBe("p2tr");
    expect(result.network).toBe("mainnet");
  });

  it("recognizes testnet P2TR (tb1p)", () => {
    const addr =
      "tb1pksj664hdqkzvw2tlfvqshnevxt2qdutk47p9z964dkcsxazmf0vsjas4n4";
    const result = isValidBitcoinAddress(addr);
    expect(result.valid).toBe(true);
    expect(result.type).toBe("p2tr");
    expect(result.network).toBe("testnet");
  });

  it("recognizes mainnet P2PKH (1...)", () => {
    const result = isValidBitcoinAddress("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa");
    expect(result.valid).toBe(true);
    expect(result.type).toBe("p2pkh");
    expect(result.network).toBe("mainnet");
  });

  it("recognizes mainnet P2SH (3...)", () => {
    const result = isValidBitcoinAddress("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy");
    expect(result.valid).toBe(true);
    expect(result.type).toBe("p2sh");
    expect(result.network).toBe("mainnet");
  });

  it("recognizes testnet P2PKH (m/n...)", () => {
    const result = isValidBitcoinAddress("mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn");
    expect(result.valid).toBe(true);
    expect(result.type).toBe("p2pkh");
    expect(result.network).toBe("testnet");
  });

  it("recognizes testnet P2SH (2...)", () => {
    const result = isValidBitcoinAddress("2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc");
    expect(result.valid).toBe(true);
    expect(result.type).toBe("p2sh");
    expect(result.network).toBe("testnet");
  });

  it("rejects empty string", () => {
    const result = isValidBitcoinAddress("");
    expect(result.valid).toBe(false);
    expect(result.type).toBe("unknown");
    expect(result.network).toBe("unknown");
  });

  it("rejects random garbage", () => {
    const result = isValidBitcoinAddress("not_an_address");
    expect(result.valid).toBe(false);
  });

  it("rejects truncated bech32m", () => {
    const result = isValidBitcoinAddress("bc1p");
    expect(result.valid).toBe(false);
  });
});

describe("createOpReturnScript / parseOpReturnCommitment roundtrip", () => {
  it("creates correct OP_RETURN script from 32-byte commitment", () => {
    const commitment = new Uint8Array(32).fill(0xab);
    const script = createOpReturnScript(commitment);

    expect(script.length).toBe(34);
    expect(script[0]).toBe(0x6a); // OP_RETURN
    expect(script[1]).toBe(0x20); // push 32 bytes
    expect(script.slice(2)).toEqual(commitment);
  });

  it("roundtrips through parse", () => {
    const commitment = new Uint8Array(32);
    for (let i = 0; i < 32; i++) commitment[i] = i;

    const script = createOpReturnScript(commitment);
    const parsed = parseOpReturnCommitment(script);

    expect(parsed).not.toBeNull();
    expect(parsed!).toEqual(commitment);
  });

  it("rejects non-32-byte input in createOpReturnScript", () => {
    expect(() => createOpReturnScript(new Uint8Array(16))).toThrow(
      "Commitment must be 32 bytes",
    );
  });

  it("parseOpReturnCommitment returns null for wrong length", () => {
    expect(parseOpReturnCommitment(new Uint8Array(10))).toBeNull();
  });

  it("parseOpReturnCommitment returns null for wrong opcode", () => {
    const bad = new Uint8Array(34);
    bad[0] = 0x00; // not OP_RETURN
    bad[1] = 0x20;
    expect(parseOpReturnCommitment(bad)).toBeNull();
  });

  it("parseOpReturnCommitment returns null for wrong push byte", () => {
    const bad = new Uint8Array(34);
    bad[0] = 0x6a;
    bad[1] = 0x10; // not 0x20
    expect(parseOpReturnCommitment(bad)).toBeNull();
  });
});

describe("buildDepositOpReturn / parseDepositOpReturn roundtrip", () => {
  it("builds and parses a 64-byte payload", () => {
    const ephemeralPub = new Uint8Array(32).fill(0x11);
    const npk = new Uint8Array(32).fill(0x22);

    const payload = buildDepositOpReturn(ephemeralPub, npk);

    expect(payload.length).toBe(64);
    expect(payload.slice(0, 32)).toEqual(ephemeralPub);
    expect(payload.slice(32, 64)).toEqual(npk);

    const parsed = parseDepositOpReturn(payload);
    expect(parsed).not.toBeNull();
    expect(parsed!.ephemeralPub).toEqual(ephemeralPub);
    expect(parsed!.npk).toEqual(npk);
  });

  it("rejects wrong-size ephemeralPub", () => {
    expect(() =>
      buildDepositOpReturn(new Uint8Array(16), new Uint8Array(32)),
    ).toThrow("ephemeralPub must be 32 bytes");
  });

  it("rejects wrong-size npk", () => {
    expect(() =>
      buildDepositOpReturn(new Uint8Array(32), new Uint8Array(16)),
    ).toThrow("npk must be 32 bytes");
  });

  it("parseDepositOpReturn returns null for wrong length", () => {
    expect(parseDepositOpReturn(new Uint8Array(63))).toBeNull();
    expect(parseDepositOpReturn(new Uint8Array(65))).toBeNull();
  });
});

describe("buildMockBtcTransaction", () => {
  it("returns a Uint8Array with valid structure", () => {
    const amount = 100_000n;
    const outputKey = new Uint8Array(32).fill(0xaa);
    const commitment = new Uint8Array(32).fill(0xbb);

    const rawTx = buildMockBtcTransaction(amount, outputKey, commitment);

    expect(rawTx).toBeInstanceOf(Uint8Array);
    // Version bytes (little-endian 2)
    expect(rawTx[0]).toBe(0x02);
    expect(rawTx[1]).toBe(0x00);
    expect(rawTx[2]).toBe(0x00);
    expect(rawTx[3]).toBe(0x00);

    // Input count = 1
    expect(rawTx[4]).toBe(0x01);

    // Output count = 2 (at offset 4 + 1 + 45 = 50)
    expect(rawTx[50]).toBe(0x02);
  });

  it("embeds the amount in the first output (little-endian)", () => {
    const amount = 50000n; // 0xC350
    const outputKey = new Uint8Array(32).fill(0x01);
    const commitment = new Uint8Array(32).fill(0x02);

    const rawTx = buildMockBtcTransaction(amount, outputKey, commitment);

    // First output starts at offset 51 (after version + input_count + input + output_count)
    const view = new DataView(rawTx.buffer, rawTx.byteOffset, rawTx.byteLength);
    const readAmount = view.getBigUint64(51, true);
    expect(readAmount).toBe(50000n);
  });

  it("embeds the taproot output key in the first output", () => {
    const outputKey = new Uint8Array(32);
    for (let i = 0; i < 32; i++) outputKey[i] = i;
    const commitment = new Uint8Array(32).fill(0xff);

    const rawTx = buildMockBtcTransaction(10000n, outputKey, commitment);

    // P2TR script starts at offset 51+8+1 = 60, then OP_1(0x51) at 60, PUSH32(0x20) at 61, key at 62
    expect(rawTx[60]).toBe(0x51); // OP_1
    expect(rawTx[61]).toBe(0x20); // push 32
    const embeddedKey = rawTx.slice(62, 94);
    expect(embeddedKey).toEqual(outputKey);
  });

  it("embeds the commitment in the OP_RETURN output", () => {
    const outputKey = new Uint8Array(32).fill(0xaa);
    const commitment = new Uint8Array(32);
    for (let i = 0; i < 32; i++) commitment[i] = 0xff - i;

    const rawTx = buildMockBtcTransaction(10000n, outputKey, commitment);

    // Second output starts at offset 51 + 43 = 94
    // amount(8) + scriptLen(1) + OP_RETURN(1) + PUSH32(1) + commitment(32)
    // OP_RETURN at offset 94+8+1 = 103
    expect(rawTx[103]).toBe(0x6a); // OP_RETURN
    expect(rawTx[104]).toBe(0x20); // push 32
    const embeddedCommitment = rawTx.slice(105, 137);
    expect(embeddedCommitment).toEqual(commitment);
  });

  it("rejects wrong-size outputKey", () => {
    expect(() =>
      buildMockBtcTransaction(1000n, new Uint8Array(16), new Uint8Array(32)),
    ).toThrow("Taproot output key must be 32 bytes");
  });

  it("rejects wrong-size commitment", () => {
    expect(() =>
      buildMockBtcTransaction(1000n, new Uint8Array(32), new Uint8Array(16)),
    ).toThrow("Commitment must be 32 bytes");
  });

  it("ends with 4 zero locktime bytes", () => {
    const rawTx = buildMockBtcTransaction(
      1000n,
      new Uint8Array(32),
      new Uint8Array(32),
    );
    const len = rawTx.length;
    expect(rawTx[len - 4]).toBe(0x00);
    expect(rawTx[len - 3]).toBe(0x00);
    expect(rawTx[len - 2]).toBe(0x00);
    expect(rawTx[len - 1]).toBe(0x00);
  });
});
