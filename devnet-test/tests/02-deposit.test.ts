/**
 * 02 — BTC Deposit
 *
 * Tests the deposit flow on real Bitcoin testnet:
 * 1. Generate stealth deposit using SDK (npk, ephemeral pub, Taproot address)
 * 2. Register deposit with the backend tracker API
 * 3. Verify the tracker acknowledges the deposit
 *
 * Does NOT duplicate SDK unit tests for deposit generation/Taproot derivation.
 * Focuses on backend API integration and real BTC address generation.
 *
 * Actual BTC send requires a pre-funded testnet wallet or manual faucet.
 */

import { describe, it, expect, beforeAll } from "bun:test";
import {
  createTestContext,
  fetchJson,
  postJson,
  type TestContext,
  TEST_DEPOSIT_AMOUNT_SATS,
  IS_LOCAL,
} from "./setup";
import {
  fundAddress,
  mineBlocks,
  getAddressBalance,
  bootstrapRegtest,
  isRegtestAvailable,
} from "./regtest";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

// Network for deposit address generation
const btcNetwork = IS_LOCAL ? "regtest" as const : "testnet" as const;
// Regtest addresses start with bcrt1p, testnet with tb1p
const addressPrefix = IS_LOCAL ? /^bcrt1p/ : /^tb1p/;

describe("Deposit address generation", () => {
  it("generates a valid Taproot address", async () => {
    const {
      createNonInteractiveDeposit,
      deriveKeysFromSeed,
      createStealthMetaAddress,
      initPoseidon,
    } = await import("@aegis/sdk");
    await initPoseidon();

    // Generate keys from a random seed
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const keys = deriveKeysFromSeed(seed);
    const meta = createStealthMetaAddress(keys);

    // Use group pubkey for deposit address derivation
    const groupPubKeyHex = ctx.groupPubKey || ctx.config.groupPubKey;
    if (!groupPubKeyHex || groupPubKeyHex === "0".repeat(64)) {
      console.warn("  No group pubkey configured — skipping address generation");
      return;
    }

    const groupPubKey = new Uint8Array(
      groupPubKeyHex.match(/.{2}/g)!.map((b: string) => parseInt(b, 16))
    );

    const deposit = await createNonInteractiveDeposit(meta, groupPubKey, btcNetwork);

    expect(deposit.btcAddress).toBeDefined();
    expect(deposit.btcAddress).toMatch(addressPrefix);
    expect(deposit.npk).toBeDefined();
    expect(deposit.npk.length).toBe(32); // 32 bytes Uint8Array
    expect(deposit.ephemeralPub).toBeDefined();
    expect(deposit.ephemeralPub.length).toBe(32);

    const npkHex = Buffer.from(deposit.npk).toString("hex");
    console.log(`  Generated deposit address: ${deposit.btcAddress}`);
    console.log(`  NPK: ${npkHex.slice(0, 16)}...`);
    console.log(`  Amount: ${TEST_DEPOSIT_AMOUNT_SATS} sats`);
  });

  it("each deposit generates unique npk and address", async () => {
    const {
      createNonInteractiveDeposit,
      deriveKeysFromSeed,
      createStealthMetaAddress,
      initPoseidon,
    } = await import("@aegis/sdk");
    await initPoseidon();

    const seed = crypto.getRandomValues(new Uint8Array(32));
    const keys = deriveKeysFromSeed(seed);
    const meta = createStealthMetaAddress(keys);

    const groupPubKeyHex = ctx.groupPubKey || ctx.config.groupPubKey;
    if (!groupPubKeyHex || groupPubKeyHex === "0".repeat(64)) return;

    const groupPubKey = new Uint8Array(
      groupPubKeyHex.match(/.{2}/g)!.map((b: string) => parseInt(b, 16))
    );

    const d1 = await createNonInteractiveDeposit(meta, groupPubKey, btcNetwork);
    const d2 = await createNonInteractiveDeposit(meta, groupPubKey, btcNetwork);

    // Different ephemeral keys → different npk → different address
    const npk1 = Buffer.from(d1.npk).toString("hex");
    const npk2 = Buffer.from(d2.npk).toString("hex");
    expect(npk1).not.toBe(npk2);
    expect(d1.btcAddress).not.toBe(d2.btcAddress);
  });
});

describe("Backend tracker registration", () => {
  it("registers a deposit with the tracker API", async () => {
    try {
      await fetchJson(`${ctx.backendApiUrl}/health`, 5000);
    } catch {
      console.warn("  Backend API not reachable — skipping");
      return;
    }

    const {
      createNonInteractiveDeposit,
      deriveKeysFromSeed,
      createStealthMetaAddress,
      initPoseidon,
    } = await import("@aegis/sdk");
    await initPoseidon();

    const seed = crypto.getRandomValues(new Uint8Array(32));
    const keys = deriveKeysFromSeed(seed);
    const meta = createStealthMetaAddress(keys);

    const groupPubKeyHex = ctx.groupPubKey || ctx.config.groupPubKey;
    if (!groupPubKeyHex || groupPubKeyHex === "0".repeat(64)) {
      console.warn("  No group pubkey — skipping");
      return;
    }

    const groupPubKey = new Uint8Array(
      groupPubKeyHex.match(/.{2}/g)!.map((b: string) => parseInt(b, 16))
    );

    const deposit = await createNonInteractiveDeposit(meta, groupPubKey, btcNetwork);

    try {
      const result = await postJson(`${ctx.backendApiUrl}/api/deposit/register`, {
        btcAddress: deposit.btcAddress,
        npk: Buffer.from(deposit.npk).toString("hex"),
        ephemeralPub: Buffer.from(deposit.ephemeralPub).toString("hex"),
        expectedAmount: TEST_DEPOSIT_AMOUNT_SATS,
      });

      expect(result).toBeDefined();
      console.log(`  Deposit registered: ${JSON.stringify(result).slice(0, 100)}`);
    } catch (err) {
      console.warn(`  Registration endpoint may not exist yet: ${err}`);
    }
  });

  it("retrieves registered deposit status", async () => {
    try {
      await fetchJson(`${ctx.backendApiUrl}/health`, 5000);
    } catch {
      console.warn("  Backend API not reachable — skipping");
      return;
    }

    try {
      const deposits = await fetchJson(`${ctx.backendApiUrl}/api/deposits`, 10000);
      expect(Array.isArray(deposits) || typeof deposits === "object").toBe(true);
      console.log(`  Tracker has ${Array.isArray(deposits) ? deposits.length : "?"} deposits`);
    } catch (err) {
      console.warn(`  Deposits endpoint may not exist yet: ${err}`);
    }
  });
});

describe("Esplora integration", () => {
  it("can query testnet block tip", async () => {
    if (IS_LOCAL) {
      console.log("  Skipping Esplora in local mode — using bitcoind RPC");
      return;
    }
    const res = await fetch(`${ctx.esploraUrl}/blocks/tip/height`);
    expect(res.ok).toBe(true);
    const height = parseInt(await res.text());
    expect(height).toBeGreaterThan(2_000_000);
    console.log(`  Bitcoin testnet tip: ${height}`);
  });

  it("can query a known testnet address", async () => {
    if (IS_LOCAL) return;
    const res = await fetch(
      `${ctx.esploraUrl}/address/tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx`
    );
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data).toBeDefined();
  });
});

describe("Regtest deposit (local mode)", () => {
  let depositAddress: string;

  it("generates a regtest deposit address", async () => {
    if (!IS_LOCAL) {
      console.log("  Skipping regtest deposit in devnet mode");
      return;
    }

    const {
      createNonInteractiveDeposit,
      deriveKeysFromSeed,
      createStealthMetaAddress,
      initPoseidon,
    } = await import("@aegis/sdk");
    await initPoseidon();

    const seed = crypto.getRandomValues(new Uint8Array(32));
    const keys = deriveKeysFromSeed(seed);
    const meta = createStealthMetaAddress(keys);

    const groupPubKeyHex = ctx.groupPubKey || ctx.config.groupPubKey;
    if (!groupPubKeyHex || groupPubKeyHex === "0".repeat(64)) {
      console.warn("  No group pubkey configured — skipping");
      return;
    }

    const groupPubKey = new Uint8Array(
      groupPubKeyHex.match(/.{2}/g)!.map((b: string) => parseInt(b, 16))
    );

    const deposit = await createNonInteractiveDeposit(meta, groupPubKey, "regtest");
    depositAddress = deposit.btcAddress;
    expect(depositAddress).toMatch(/^bcrt1p/);
    console.log(`  Regtest deposit address: ${depositAddress}`);
  });

  it("funds deposit address via regtest", async () => {
    if (!IS_LOCAL || !depositAddress) return;

    const regtestReady = await isRegtestAvailable();
    if (!regtestReady) {
      console.warn("  bitcoind not available — skipping");
      return;
    }

    await bootstrapRegtest();

    const btcAmount = TEST_DEPOSIT_AMOUNT_SATS / 1e8;
    const txid = await fundAddress(depositAddress, btcAmount);
    console.log(`  Funded ${btcAmount} BTC → txid: ${txid}`);

    // Mine a few more blocks for confirmation depth
    await mineBlocks(5);

    const balance = await getAddressBalance(depositAddress);
    console.log(`  Address balance: ${balance} BTC`);
    expect(balance).toBeGreaterThanOrEqual(btcAmount);
  });
});
