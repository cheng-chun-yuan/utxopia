import { describe, expect, it } from "bun:test";
import { formatPrivateReceiveName, normalizePrivateNameHandle } from "./private-name-claim";

describe("private receive name normalization", () => {
  it("normalizes Solana handles and full names", () => {
    expect(normalizePrivateNameHandle("@alice", "solana")).toBe("alice");
    expect(normalizePrivateNameHandle("alice.utxopia.sol", "solana")).toBe("alice");
    expect(formatPrivateReceiveName("@alice", "solana")).toBe("alice.utxopia.sol");
  });

  it("normalizes Sui handles and full names", () => {
    expect(normalizePrivateNameHandle("@alice", "sui")).toBe("alice");
    expect(normalizePrivateNameHandle("alice.utxopia.sui", "sui")).toBe("alice");
    expect(formatPrivateReceiveName("@alice", "sui")).toBe("alice.utxopia.sui");
  });

  it("keeps Sui stricter than Solana for now", () => {
    expect(normalizePrivateNameHandle("alice-1", "solana")).toBe("alice-1");
    expect(() => normalizePrivateNameHandle("alice-1", "sui")).toThrow();
  });
});
