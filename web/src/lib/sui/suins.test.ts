/** @happy-dom */
import { describe, expect, it } from "bun:test";
import {
  encodeUtxopiaSuiNsContentHash,
  isUtxopiaSuiNsName,
  normalizeSuiNsName,
  parseUtxopiaSuiNsContentHash,
} from "./suins";

describe("SuiNS UTXOpia metadata", () => {
  it("normalizes UTXOpia shorthand names", () => {
    expect(normalizeSuiNsName("@alice")).toBe("alice.utxopia.sui");
    expect(normalizeSuiNsName("alice")).toBe("alice.utxopia.sui");
    expect(normalizeSuiNsName("alice.utxopia")).toBe("alice.utxopia.sui");
    expect(normalizeSuiNsName("alice.utxopia.sui")).toBe("alice.utxopia.sui");
  });

  it("keeps discovery inside the UTXOpia namespace", () => {
    expect(isUtxopiaSuiNsName("@alice")).toBe(true);
    expect(isUtxopiaSuiNsName("alice.utxopia.sui")).toBe(true);
    expect(isUtxopiaSuiNsName("alice.sui")).toBe(false);
  });

  it("round-trips receive metadata", () => {
    const contentHash = encodeUtxopiaSuiNsContentHash({
      viewingPubKey: new Uint8Array(32).fill(1),
      mpk: new Uint8Array(32).fill(2),
    }, "sui-testnet");
    const parsed = parseUtxopiaSuiNsContentHash(contentHash);
    expect(parsed?.network).toBe("sui-testnet");
    expect(parsed?.viewingPubKey[0]).toBe(1);
    expect(parsed?.mpk[0]).toBe(2);
  });

  it("rejects malformed metadata", () => {
    expect(parseUtxopiaSuiNsContentHash(null)).toBeNull();
    expect(parseUtxopiaSuiNsContentHash("walrus:blob")).toBeNull();
    expect(parseUtxopiaSuiNsContentHash("utxopia:v1:sui-testnet:bad:bad")).toBeNull();
  });
});
