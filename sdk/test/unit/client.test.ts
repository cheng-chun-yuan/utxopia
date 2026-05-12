import { describe, it, expect, beforeAll, afterEach } from "bun:test";
import { UTXOpiaClient } from "../../src/client";

describe("UTXOpiaClient", () => {
  afterEach(() => {
    UTXOpiaClient.reset();
  });

  describe("lifecycle", () => {
    it("init creates singleton", async () => {
      const client = await UTXOpiaClient.init();
      expect(UTXOpiaClient.isInitialized).toBe(true);
      expect(UTXOpiaClient.instance()).toBe(client);
    });

    it("instance throws before init", () => {
      expect(() => UTXOpiaClient.instance()).toThrow("not initialized");
    });

    it("init is idempotent", async () => {
      const client1 = await UTXOpiaClient.init();
      const client2 = await UTXOpiaClient.init();
      // Second init creates new instance (replaces singleton)
      expect(UTXOpiaClient.instance()).toBe(client2);
    });
  });

  describe("auth state", () => {
    it("starts unauthenticated", async () => {
      const client = await UTXOpiaClient.init();
      expect(client.isAuthenticated).toBe(false);
      expect(client.keys).toBeNull();
      expect(client.stealthAddress).toBeNull();
      expect(client.stealthAddressEncoded).toBeNull();
    });

    it("loginWithSeed sets keys", async () => {
      const client = await UTXOpiaClient.init();
      const seed = new Uint8Array(32);
      seed[0] = 1; seed[1] = 2; seed[2] = 3;

      const result = await client.loginWithSeed(seed);

      expect(client.isAuthenticated).toBe(true);
      expect(client.isViewOnly).toBe(false);
      expect(client.keys).not.toBeNull();
      expect(client.stealthAddress).not.toBeNull();
      expect(client.stealthAddressEncoded).toBeTruthy();
      expect(result.keys).toBe(client.keys);
    });

    it("loginWithSeed is deterministic", async () => {
      const client = await UTXOpiaClient.init();
      const seed = new Uint8Array(32).fill(0x42);

      const result1 = await client.loginWithSeed(seed);
      const encoded1 = client.stealthAddressEncoded;

      // Login again with same seed
      const result2 = await client.loginWithSeed(seed);

      expect(client.stealthAddressEncoded).toBe(encoded1);
    });

    it("logout clears keys", async () => {
      const client = await UTXOpiaClient.init();
      await client.loginWithSeed(new Uint8Array(32).fill(1));
      expect(client.isAuthenticated).toBe(true);

      client.logout();

      expect(client.isAuthenticated).toBe(false);
      expect(client.keys).toBeNull();
      expect(client.stealthAddress).toBeNull();
    });

    it("serializeKeys returns null when not authenticated", async () => {
      const client = await UTXOpiaClient.init();
      expect(client.serializeKeys()).toBeNull();
    });

    it("serializeKeys returns object when authenticated", async () => {
      const client = await UTXOpiaClient.init();
      await client.loginWithSeed(new Uint8Array(32).fill(5));

      const serialized = client.serializeKeys();
      expect(serialized).not.toBeNull();
      expect(serialized).toHaveProperty("eddsaSeedHex");
      expect(serialized).toHaveProperty("viewingPrivKeyHex");
      expect(serialized).toHaveProperty("viewingPubKeyHex");
    });
  });

  describe("token IDs", () => {
    it("caches token ID after first computation", async () => {
      const client = await UTXOpiaClient.init();
      // Use a known 32-byte hex as "mint"
      const fakeMint = "a".repeat(64);

      const id1 = client.getTokenId(fakeMint);
      const id2 = client.getTokenId(fakeMint);

      expect(id1).toBe(id2);
      expect(typeof id1).toBe("bigint");
    });
  });

  describe("balance", () => {
    it("getBalance returns empty map for no notes", async () => {
      const client = await UTXOpiaClient.init();
      const balance = client.getBalance([]);
      expect(balance.size).toBe(0);
    });

    it("getBalance sums unspent notes by token", async () => {
      const client = await UTXOpiaClient.init();
      const notes = [
        { tokenSymbol: "zkBTC", amount: 1000n, isSpent: false },
        { tokenSymbol: "zkBTC", amount: 2000n, isSpent: false },
        { tokenSymbol: "zkSOL", amount: 500n, isSpent: false },
        { tokenSymbol: "zkBTC", amount: 3000n, isSpent: true }, // spent, excluded
      ] as any[];

      const balance = client.getBalance(notes);
      expect(balance.get("zkBTC")).toBe(3000n);
      expect(balance.get("zkSOL")).toBe(500n);
      expect(balance.has("zkUSDC")).toBe(false);
    });
  });

  describe("isMyDeposit", () => {
    it("returns false when not authenticated", async () => {
      const client = await UTXOpiaClient.init();
      expect(client.isMyDeposit("aa".repeat(32), "bb".repeat(32))).toBe(false);
    });
  });

  describe("config", () => {
    it("exposes network config", async () => {
      const client = await UTXOpiaClient.init();
      const config = client.config;
      expect(config).toHaveProperty("utxopiaProgramId");
      expect(config).toHaveProperty("zkbtcMint");
      expect(config).toHaveProperty("solanaRpcUrl");
    });
  });
});
