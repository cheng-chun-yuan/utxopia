import { expect, test } from "bun:test";
import { extractUtxopiaDepositOpReturn, parseOpReturnPayload } from "../src/op-return";
import type { BitcoinTransaction } from "../src/types";

test("parses 64-byte UTXOpia OP_RETURN payload", () => {
  const payload = "11".repeat(32) + "22".repeat(32);
  const parsed = parseOpReturnPayload(`6a40${payload}`);

  expect(parsed).toBeDefined();
  expect(parsed?.length).toBe(64);
});

test("extracts deposit OP_RETURN into ephemeral pubkey and npk", () => {
  const tx: BitcoinTransaction = {
    txid: "tx",
    version: 2,
    locktime: 0,
    vin: [],
    size: 0,
    weight: 0,
    fee: 0,
    status: { confirmed: true, block_height: 1 },
    vout: [
      {
        scriptpubkey: `6a40${"11".repeat(32)}${"22".repeat(32)}`,
        scriptpubkey_asm: "",
        scriptpubkey_type: "op_return",
        value: 0,
      },
    ],
  };

  const opReturn = extractUtxopiaDepositOpReturn(tx);

  expect(opReturn?.ephemeralPubkey.length).toBe(32);
  expect(opReturn?.npk.length).toBe(32);
  expect(opReturn?.ephemeralPubkey[0]).toBe(0x11);
  expect(opReturn?.npk[0]).toBe(0x22);
});

