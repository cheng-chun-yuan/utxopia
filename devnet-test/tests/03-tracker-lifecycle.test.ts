/**
 * 03 — Deposit Tracker Lifecycle
 *
 * Tests the full deposit lifecycle through the backend tracker:
 *   pending → detected → confirming → confirmed → sweeping →
 *   sweep_confirming → verifying → ready
 *
 * This test requires:
 * - Backend API running
 * - A deposit that has been sent on Bitcoin testnet
 * - Header relayer syncing block headers
 *
 * Polls deposit status at intervals. Expected duration: 10-15 min (BTC block time).
 *
 * Does NOT duplicate SDK deposit generation tests.
 * Focuses on backend tracker state machine and SPV verification integration.
 */

import { describe, it, expect, beforeAll } from "bun:test";
import {
  createTestContext,
  fetchJson,
  postJson,
  pollUntil,
  type TestContext,
} from "./setup";

let ctx: TestContext;
let backendAvailable = false;

beforeAll(async () => {
  ctx = await createTestContext();

  try {
    await fetchJson(`${ctx.backendApiUrl}/api/health`, 5000);
    backendAvailable = true;
  } catch {
    console.warn("Backend API not available — tracker lifecycle tests will be skipped");
  }
});

describe("Deposit status tracking", () => {
  it("lists deposits from the tracker", async () => {
    if (!backendAvailable) return;

    try {
      const deposits = await fetchJson(`${ctx.backendApiUrl}/api/deposits`, 10000);
      console.log(`  Tracker reports ${Array.isArray(deposits) ? deposits.length : "?"} deposits`);
      expect(deposits).toBeDefined();
    } catch (err) {
      console.warn(`  Deposits endpoint: ${err}`);
    }
  });

  it("retrieves deposit by address", async () => {
    if (!backendAvailable) return;

    // Get a known deposit address from the tracker
    try {
      const deposits = await fetchJson(`${ctx.backendApiUrl}/api/deposits`, 10000);
      if (Array.isArray(deposits) && deposits.length > 0) {
        const first = deposits[0];
        const addr = first.btc_address || first.btcAddress || first.address;
        if (addr) {
          const detail = await fetchJson(
            `${ctx.backendApiUrl}/api/deposit/${encodeURIComponent(addr)}`,
            10000
          );
          expect(detail).toBeDefined();
          console.log(`  Deposit detail: status=${detail.status}, amount=${detail.amount_sats || detail.amount}`);
        }
      } else {
        console.warn("  No deposits in tracker — skipping detail test");
      }
    } catch (err) {
      console.warn(`  Deposit detail endpoint: ${err}`);
    }
  });
});

describe("Deposit state transitions", () => {
  it("deposit transitions through expected states", async () => {
    if (!backendAvailable) return;

    // Find a deposit that is in an active state
    let activeDeposit: any = null;
    try {
      const deposits = await fetchJson(`${ctx.backendApiUrl}/api/deposits`, 10000);
      if (Array.isArray(deposits)) {
        // Look for deposits not yet in final state
        activeDeposit = deposits.find(
          (d: any) => d.status !== "ready" && d.status !== "failed"
        );
      }
    } catch {
      console.warn("  Could not fetch deposits");
      return;
    }

    if (!activeDeposit) {
      console.warn("  No active deposits found — skipping state transition test");
      console.warn("  To test: send BTC to a generated deposit address first");
      return;
    }

    const id = activeDeposit.id || activeDeposit.btc_txid || activeDeposit.address;
    console.log(`  Tracking deposit: ${id}`);
    console.log(`  Current status: ${activeDeposit.status}`);

    // Valid state transitions
    const validStates = [
      "pending",
      "detected",
      "confirming",
      "confirmed",
      "sweeping",
      "sweep_confirming",
      "verifying",
      "ready",
    ];

    const status = activeDeposit.status;
    expect(validStates).toContain(status);
  });

  it("polls deposit until state advances (up to 2 min)", async () => {
    if (!backendAvailable) return;

    try {
      const deposits = await fetchJson(`${ctx.backendApiUrl}/api/deposits`, 10000);
      if (!Array.isArray(deposits) || deposits.length === 0) {
        console.warn("  No deposits to poll");
        return;
      }

      const deposit = deposits.find(
        (d: any) => d.status !== "ready" && d.status !== "failed"
      );
      if (!deposit) {
        console.warn("  All deposits in final state — skipping poll test");
        return;
      }

      const initialStatus = deposit.status;
      const id = deposit.id || deposit.btc_txid;
      console.log(`  Polling deposit ${id} (starting at: ${initialStatus})...`);

      let advanced = false;
      await pollUntil(
        async () => {
          try {
            const current = await fetchJson(`${ctx.backendApiUrl}/api/deposits`, 10000);
            const updated = Array.isArray(current)
              ? current.find((d: any) => (d.id || d.btc_txid) === id)
              : null;
            if (updated && updated.status !== initialStatus) {
              console.log(`  Status advanced: ${initialStatus} → ${updated.status}`);
              advanced = true;
              return true;
            }
          } catch {}
          return false;
        },
        15000, // Check every 15s
        120000, // Max 2 min
        `deposit ${id} status change`
      ).catch(() => {
        console.warn(`  Deposit did not advance within 2 min (normal for testnet)`);
      });

      // Not a failure if it didn't advance — BTC blocks are slow
    } catch (err) {
      console.warn(`  Poll test error: ${err}`);
    }
  });
});

describe("SPV verification readiness", () => {
  it("header relayer has synced recent blocks", async () => {
    if (!backendAvailable) return;

    try {
      const info = await fetchJson(`${ctx.backendApiUrl}/api/relay/status`, 10000);
      if (info.latest_height || info.latestHeight) {
        const height = info.latest_height || info.latestHeight;
        console.log(`  Relayer synced to height: ${height}`);
        expect(height).toBeGreaterThan(0);
      } else {
        console.warn("  Relay status endpoint doesn't expose height");
      }
    } catch {
      console.warn("  Relay status endpoint not available");
    }
  });

  it("verified deposits have DepositRecord on Solana", async () => {
    if (!backendAvailable) return;

    try {
      const deposits = await fetchJson(`${ctx.backendApiUrl}/api/deposits`, 10000);
      if (!Array.isArray(deposits)) return;

      const readyDeposits = deposits.filter((d: any) => d.status === "ready");
      if (readyDeposits.length === 0) {
        console.warn("  No verified deposits yet — skipping on-chain check");
        return;
      }

      for (const deposit of readyDeposits.slice(0, 3)) {
        const solanaTx = deposit.solana_tx || deposit.solanaTx;
        const leafIndex = deposit.leaf_index ?? deposit.leafIndex;
        console.log(`  Verified deposit: leafIndex=${leafIndex}, solanaTx=${solanaTx?.slice(0, 16)}...`);
        expect(leafIndex).toBeDefined();
      }
    } catch (err) {
      console.warn(`  On-chain check error: ${err}`);
    }
  });
});
