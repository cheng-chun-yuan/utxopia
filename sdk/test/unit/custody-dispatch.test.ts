import { describe, it, expect } from "bun:test";
import { pickCustodyInternalKey } from "../../src/stealth";
import { hexToBytes } from "../../src/crypto";

const ALL_ZEROS_HEX =
  "0000000000000000000000000000000000000000000000000000000000000000";
const FROST_HEX =
  "29485d031f6ad1ab0c4ca7183bef6cb9ce2d914d0bec8dc842a6962f0fcc3362";
const IKA_HEX =
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

describe("pickCustodyInternalKey (Ika-first dispatch)", () => {
  it("returns Ika pubkey when set", () => {
    const key = pickCustodyInternalKey({
      ikaDwalletXOnlyPubkey: IKA_HEX,
      groupPubKey: FROST_HEX,
    });
    expect(Array.from(key)).toEqual(Array.from(hexToBytes(IKA_HEX)));
  });

  it("falls back to FROST groupPubKey when Ika is all-zero", () => {
    const key = pickCustodyInternalKey({
      ikaDwalletXOnlyPubkey: ALL_ZEROS_HEX,
      groupPubKey: FROST_HEX,
    });
    expect(Array.from(key)).toEqual(Array.from(hexToBytes(FROST_HEX)));
  });

  it("falls back to FROST when ikaDwalletXOnlyPubkey is undefined", () => {
    const key = pickCustodyInternalKey({
      groupPubKey: FROST_HEX,
    });
    expect(Array.from(key)).toEqual(Array.from(hexToBytes(FROST_HEX)));
  });

  it("falls back to FROST when ikaDwalletXOnlyPubkey is empty string", () => {
    const key = pickCustodyInternalKey({
      ikaDwalletXOnlyPubkey: "",
      groupPubKey: FROST_HEX,
    });
    expect(Array.from(key)).toEqual(Array.from(hexToBytes(FROST_HEX)));
  });

  it("Ika pubkey of all-f's still counts as set (any non-zero hex digit)", () => {
    const allF =
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    const key = pickCustodyInternalKey({
      ikaDwalletXOnlyPubkey: allF,
      groupPubKey: FROST_HEX,
    });
    expect(Array.from(key)).toEqual(Array.from(hexToBytes(allF)));
  });
});
