/** @happy-dom */
import { describe, it, expect } from "bun:test";
import { buildSendIntent } from "./build-tx";

describe("buildSendIntent", () => {
  it("dispatches BTC recipient to redeem kind", () => {
    const intent = buildSendIntent({
      recipientType: "btc",
      recipientValue: "bc1q9d4ywgfnd8h70q4thlsclpw0ymmqfumzgxlhpe",
      sourceToken: "zkBTC",
      amount: "0.001",
    });
    expect(intent.kind).toBe("redeem");
  });

  it("dispatches stealth_sns to transact kind", () => {
    const intent = buildSendIntent({
      recipientType: "stealth_sns",
      recipientValue: "alice.utxopia.sol",
      sourceToken: "zkBTC",
      amount: "0.001",
    });
    expect(intent.kind).toBe("transact");
  });

  it("dispatches stealth_suins to transact kind", () => {
    const intent = buildSendIntent({
      recipientType: "stealth_suins",
      recipientValue: "alice.utxopia.sui",
      sourceToken: "zkBTC",
      amount: "0.001",
    });
    expect(intent.kind).toBe("transact");
  });

  it("dispatches stealth_meta to transact kind", () => {
    const intent = buildSendIntent({
      recipientType: "stealth_meta",
      recipientValue: "utxo:" + "01".repeat(32) + "02".repeat(32),
      sourceToken: "zkBTC",
      amount: "0.001",
    });
    expect(intent.kind).toBe("transact");
  });

  it("dispatches spl_wallet to unshield kind", () => {
    const intent = buildSendIntent({
      recipientType: "spl_wallet",
      recipientValue: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      sourceToken: "zkBTC",
      amount: "0.001",
    });
    expect(intent.kind).toBe("unshield");
  });

  it("rejects BTC source token mismatch", () => {
    expect(() =>
      buildSendIntent({
        recipientType: "btc",
        recipientValue: "bc1q9d4ywgfnd8h70q4thlsclpw0ymmqfumzgxlhpe",
        sourceToken: "tUSDC",
        amount: "0.001",
      }),
    ).toThrow(/zkBTC/i);
  });
});
