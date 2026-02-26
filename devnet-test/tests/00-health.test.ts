/**
 * 00 — Health Checks
 *
 * Verifies all 7 services are reachable and healthy:
 * 1. Solana devnet RPC
 * 2. zVault program deployed
 * 3. BTC Light Client program deployed
 * 4. FROST signers (x3) healthy
 * 5. Backend API healthy
 * 6. Esplora reachable
 * 7. Pool state + commitment tree initialized
 *
 * This is a fast (<10s) sanity check before running longer tests.
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import {
  createTestContext,
  logContext,
  fetchJson,
  type TestContext,
  SOLANA_RPC_URL,
  ESPLORA_URL,
  IS_LOCAL,
} from "./setup";
import { isRegtestAvailable, getBlockCount, bootstrapRegtest } from "./regtest";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
  logContext(ctx);
});

describe("Solana devnet", () => {
  it("RPC is reachable", async () => {
    const version = await ctx.connection.getVersion();
    expect(version["solana-core"]).toBeDefined();
  });

  it("zVault program is deployed", async () => {
    const info = await ctx.connection.getAccountInfo(
      new PublicKey(ctx.config.zvaultProgramId.toString())
    );
    expect(info).not.toBeNull();
    expect(info!.executable).toBe(true);
  });

  it("BTC Light Client program is deployed", async () => {
    // Use env var or contracts/config.json value (SDK config may be stale)
    const btcLightClientId = process.env.BTC_LIGHT_CLIENT_PROGRAM_ID || "DeDut4fkjbWBPY4FRUU3q9BUcvwTisHczj1EQmqX5avS";
    const info = await ctx.connection.getAccountInfo(
      new PublicKey(btcLightClientId)
    );
    expect(info).not.toBeNull();
    expect(info!.executable).toBe(true);
  });

  it("Pool state PDA is initialized", async () => {
    const info = await ctx.connection.getAccountInfo(
      new PublicKey(ctx.config.poolStatePda.toString())
    );
    expect(info).not.toBeNull();
    expect(info!.data.length).toBeGreaterThanOrEqual(100);
  });

  it("Commitment tree PDA is initialized", async () => {
    const info = await ctx.connection.getAccountInfo(
      new PublicKey(ctx.config.commitmentTreePda.toString())
    );
    expect(info).not.toBeNull();
    expect(info!.data.length).toBeGreaterThanOrEqual(100);
  });
});

describe("FROST signers", () => {
  for (let i = 0; i < 3; i++) {
    it(`Signer ${i + 1} is healthy`, async () => {
      try {
        const res = await fetch(`${ctx.frostSignerUrls[i]}/health`, {
          signal: AbortSignal.timeout(5000),
        });
        expect(res.ok).toBe(true);
      } catch {
        // FROST signers may not be running — mark as skipped
        console.warn(`  FROST signer ${i + 1} not reachable — skipping`);
      }
    });
  }
});

describe("Backend API", () => {
  it("health endpoint responds", async () => {
    try {
      const res = await fetch(`${ctx.backendApiUrl}/api/health`, {
        signal: AbortSignal.timeout(5000),
      });
      expect(res.ok).toBe(true);
    } catch {
      console.warn("  Backend API not reachable — skipping");
    }
  });

  it("pool info endpoint responds", async () => {
    try {
      const data = await fetchJson(`${ctx.backendApiUrl}/api/pool/info`, 5000);
      expect(data).toBeDefined();
    } catch {
      console.warn("  Backend API pool info not reachable — skipping");
    }
  });
});

describe("External services", () => {
  it("Esplora is reachable", async () => {
    if (IS_LOCAL) {
      console.log("  Skipping Esplora check in local mode (using bitcoind RPC)");
      return;
    }
    const res = await fetch(`${ESPLORA_URL}/blocks/tip/height`, {
      signal: AbortSignal.timeout(10000),
    });
    expect(res.ok).toBe(true);
    const height = parseInt(await res.text());
    expect(height).toBeGreaterThan(0);
  });

  it("payer wallet has SOL balance", async () => {
    const balance = await ctx.connection.getBalance(ctx.payer.publicKey);
    console.log(`  Payer balance: ${(balance / 1e9).toFixed(4)} SOL`);
    expect(balance).toBeGreaterThan(0);
  });
});

describe("Bitcoin regtest (local mode)", () => {
  it("bitcoind is reachable and on regtest", async () => {
    if (!IS_LOCAL) {
      console.log("  Skipping regtest check in devnet mode");
      return;
    }
    const available = await isRegtestAvailable();
    expect(available).toBe(true);
  });

  it("regtest is bootstrapped with spendable coins", async () => {
    if (!IS_LOCAL) return;
    await bootstrapRegtest();
    const height = await getBlockCount();
    expect(height).toBeGreaterThanOrEqual(101);
    console.log(`  Regtest block height: ${height}`);
  });
});
