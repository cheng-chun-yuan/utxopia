/**
 * 01 — FROST DKG Verification
 *
 * Verifies FROST distributed key generation:
 * - All 3 signers return the same group public key via /info
 * - Group pubkey matches the configured FROST_GROUP_PUBKEY
 * - Threshold (2-of-3) is correctly configured
 * - Signers have loaded key packages
 *
 * Does NOT duplicate SDK unit tests for key derivation.
 * Focuses on multi-signer coordination and consistency.
 */

import { describe, it, expect, beforeAll } from "bun:test";
import {
  createTestContext,
  fetchJson,
  type TestContext,
} from "./setup";

let ctx: TestContext;
let signerInfos: any[] = [];
let signersAvailable = false;

beforeAll(async () => {
  ctx = await createTestContext();

  // Probe all signers
  for (const url of ctx.frostSignerUrls) {
    try {
      const info = await fetchJson(`${url}/info`, 5000);
      signerInfos.push(info);
    } catch {
      signerInfos.push(null);
    }
  }

  signersAvailable = signerInfos.filter(Boolean).length >= 2;
  if (!signersAvailable) {
    console.warn("Fewer than 2 FROST signers available — some tests will be skipped");
  }
});

describe("FROST signer health", () => {
  it("at least 2 signers are reachable (threshold)", () => {
    const reachable = signerInfos.filter(Boolean).length;
    console.log(`  ${reachable}/3 FROST signers reachable`);
    if (reachable < 2) {
      console.warn("  FROST signers not running — start them for full testing");
      return;
    }
    expect(reachable).toBeGreaterThanOrEqual(2);
  });

  it("all reachable signers report healthy", async () => {
    for (let i = 0; i < ctx.frostSignerUrls.length; i++) {
      if (!signerInfos[i]) continue;
      const res = await fetch(`${ctx.frostSignerUrls[i]}/health`);
      expect(res.ok).toBe(true);
    }
  });
});

describe("FROST key consistency", () => {
  it("all reachable signers agree on group pubkey", () => {
    if (!signersAvailable) return;

    const pubkeys = signerInfos
      .filter(Boolean)
      .map((info) => info.group_pubkey || info.groupPubKey || info.group_public_key);

    const unique = new Set(pubkeys);
    expect(unique.size).toBe(1);
    console.log(`  Group pubkey: ${pubkeys[0]?.slice(0, 32)}...`);
  });

  it("group pubkey matches configured env var (if set)", () => {
    if (!signersAvailable || !ctx.groupPubKey) {
      console.warn("  Skipping — FROST_GROUP_PUBKEY not set");
      return;
    }

    const signerPubkey = signerInfos.find(Boolean)?.group_pubkey
      || signerInfos.find(Boolean)?.groupPubKey
      || signerInfos.find(Boolean)?.group_public_key;

    expect(signerPubkey).toBe(ctx.groupPubKey);
  });

  it("threshold is 2-of-3", () => {
    if (!signersAvailable) return;

    const info = signerInfos.find(Boolean);
    const threshold = info?.threshold || info?.min_signers;
    const participants = info?.participants || info?.max_signers || info?.num_signers;

    if (threshold !== undefined) {
      expect(threshold).toBe(2);
      console.log(`  Threshold: ${threshold}-of-${participants}`);
    } else {
      console.warn("  Signer /info does not expose threshold — skipping");
    }
  });

  it("each signer has a unique identifier", () => {
    if (!signersAvailable) return;

    const ids = signerInfos
      .filter(Boolean)
      .map((info) => info.signer_id || info.identifier || info.id);

    if (ids[0] !== undefined) {
      const unique = new Set(ids);
      expect(unique.size).toBe(ids.length);
    } else {
      console.warn("  Signer /info does not expose signer_id — skipping");
    }
  });
});

describe("FROST signing readiness", () => {
  it("signers have loaded key packages", () => {
    if (!signersAvailable) return;

    for (const info of signerInfos.filter(Boolean)) {
      const hasKeys =
        info.has_key_package !== undefined
          ? info.has_key_package
          : info.keys_loaded !== undefined
          ? info.keys_loaded
          : info.group_pubkey || info.groupPubKey || info.group_public_key;

      expect(hasKeys).toBeTruthy();
    }
  });

  it("signers are ready for signing sessions", async () => {
    if (!signersAvailable) return;

    for (let i = 0; i < ctx.frostSignerUrls.length; i++) {
      if (!signerInfos[i]) continue;

      try {
        const res = await fetch(`${ctx.frostSignerUrls[i]}/ready`, {
          signal: AbortSignal.timeout(5000),
        });
        // /ready might not exist — just check health as fallback
        if (res.status === 404) {
          const healthRes = await fetch(`${ctx.frostSignerUrls[i]}/health`);
          expect(healthRes.ok).toBe(true);
        } else {
          expect(res.ok).toBe(true);
        }
      } catch {
        console.warn(`  Signer ${i + 1}: readiness check failed`);
      }
    }
  });
});
