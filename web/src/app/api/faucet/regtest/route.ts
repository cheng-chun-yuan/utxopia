/**
 * Regtest BTC faucet.
 *
 * Talks to the `utxopia-esplora-regtest` container via `docker exec`, calling
 * bitcoin-cli the same way `scripts/hybrid/send-to.ts` does. Drips a single
 * BTC payment to the requested address and mines exactly one regtest block
 * so the recipient sees a confirmed UTXO immediately.
 *
 * Guard rails:
 *   - regtest-only: refuses if `NEXT_PUBLIC_BTC_NETWORK !== "regtest"`
 *   - optional `X-API-Key` check (set REGTEST_FAUCET_API_KEY to enable)
 *   - per-address cooldown (default 60s) to avoid accidental drain
 *   - amount capped at 1 BTC (100_000_000 sats)
 *   - auto-bootstraps spendable balance: if the regtest wallet has zero
 *     spendable BTC, runs `generatetoaddress 101 <miner>` once before the
 *     first drip so users don't have to manually mine after `docker compose up`
 *   - returns 429 (with `retryAfterSec`) when in cooldown
 *
 * Override knobs (env):
 *   REGTEST_FAUCET_DOCKER_CONTAINER  default "utxopia-esplora-regtest"
 *   REGTEST_FAUCET_BITCOIN_CLI       default "/srv/explorer/bitcoin/bin/bitcoin-cli"
 *   REGTEST_FAUCET_BCLI_ARGS         default "-regtest -datadir=/data/bitcoin -rpcwallet=test"
 *   REGTEST_FAUCET_COOLDOWN_SECS     default "60"
 *   REGTEST_FAUCET_CONFIRMATIONS     default "1" (blocks mined right after the send)
 *   REGTEST_FAUCET_API_KEY           optional shared secret; required in X-API-Key header when set
 *   REGTEST_FAUCET_AUTOMINE          default "1" — set to "0" to disable initial-fund bootstrap
 */

import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";

const exec = promisify(execFile);

const BTC_NETWORK = process.env.NEXT_PUBLIC_BTC_NETWORK ?? "";
const CONTAINER = process.env.REGTEST_FAUCET_DOCKER_CONTAINER || "utxopia-esplora-regtest";
const BCLI = process.env.REGTEST_FAUCET_BITCOIN_CLI || "/srv/explorer/bitcoin/bin/bitcoin-cli";
const BCLI_ARGS = (
  process.env.REGTEST_FAUCET_BCLI_ARGS || "-regtest -datadir=/data/bitcoin -rpcwallet=test"
).split(/\s+/).filter(Boolean);
const COOLDOWN_SECS = Number(process.env.REGTEST_FAUCET_COOLDOWN_SECS || "60");
const CONFIRMATIONS = Math.max(1, Number(process.env.REGTEST_FAUCET_CONFIRMATIONS || "1"));
const API_KEY = process.env.REGTEST_FAUCET_API_KEY;
const AUTOMINE = process.env.REGTEST_FAUCET_AUTOMINE !== "0";
// Coinbase outputs need 100 confirmations before they're spendable, so mine
// 101 blocks on bootstrap (first block creates the coinbase reward, the next
// 100 make it spendable).
const BOOTSTRAP_BLOCKS = 101;

// File-backed per-address cooldown. Survives Next.js process restarts so
// a hot-reload or redeploy doesn't reset everyone's cooldown to zero. The
// map is loaded lazily on first access and written back after each drip.
//
// Path defaults to `.faucet-cooldown.json` in the web project root; override
// via REGTEST_FAUCET_COOLDOWN_PATH if the deployment has a writable mount.
const COOLDOWN_PATH = process.env.REGTEST_FAUCET_COOLDOWN_PATH
  || path.join(process.cwd(), ".faucet-cooldown.json");

interface CooldownStore {
  /** address → unix ms of last drip */
  entries: Map<string, number>;
}

function loadCooldownStore(): CooldownStore {
  try {
    const raw = fs.readFileSync(COOLDOWN_PATH, "utf8");
    const obj = JSON.parse(raw) as Record<string, number>;
    return { entries: new Map(Object.entries(obj)) };
  } catch {
    return { entries: new Map() };
  }
}

function saveCooldownStore(store: CooldownStore): void {
  // Prune stale entries — anything older than 2× the cooldown window is
  // useless and keeps the file bounded under load.
  const cutoffMs = Date.now() - COOLDOWN_SECS * 2_000;
  const live: Record<string, number> = {};
  for (const [addr, ts] of store.entries) {
    if (ts > cutoffMs) live[addr] = ts;
  }
  try {
    fs.writeFileSync(COOLDOWN_PATH, JSON.stringify(live) + "\n", { mode: 0o600 });
  } catch (e) {
    // Disk failure → fall through; the in-memory map still works for this
    // process. Worst case: a restart resets the cooldown for affected
    // addresses.
    console.warn("[Faucet] Failed to persist cooldown store:", e);
  }
}

const cooldownStore: CooldownStore = (() => {
  const g = globalThis as unknown as { __utxopiaFaucetCooldown?: CooldownStore };
  if (!g.__utxopiaFaucetCooldown) g.__utxopiaFaucetCooldown = loadCooldownStore();
  return g.__utxopiaFaucetCooldown;
})();
const lastDripMs = cooldownStore.entries;

// Once we've confirmed the wallet has spendable balance (either it always
// did, or we just bootstrapped it), skip the balance check on future drips.
// Held on globalThis so Next.js hot-reload doesn't clear it.
const bootstrapState: { confirmed: boolean } = (() => {
  const g = globalThis as unknown as { __utxopiaFaucetBootstrap?: { confirmed: boolean } };
  if (!g.__utxopiaFaucetBootstrap) g.__utxopiaFaucetBootstrap = { confirmed: false };
  return g.__utxopiaFaucetBootstrap;
})();

interface DripBody {
  address?: string;
  amountSats?: number;
}

async function runBitcoinCli(args: string[]): Promise<string> {
  const fullArgs = ["exec", CONTAINER, BCLI, ...BCLI_ARGS, ...args];
  const { stdout } = await exec("docker", fullArgs, { maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

function isValidRegtestAddress(addr: string): boolean {
  // bech32: bcrt1q… (P2WPKH/P2WSH) or bcrt1p… (P2TR). Length 42–62 covers all variants.
  return /^bcrt1[a-z0-9]{38,90}$/.test(addr);
}

function satsToBtcDecimal(sats: number): string {
  // bitcoin-cli expects BTC, not sats. Print with 8 decimals to avoid
  // scientific notation tripping up the RPC parser for small amounts.
  const btc = sats / 1e8;
  return btc.toFixed(8);
}

/**
 * Ensure the regtest wallet has spendable balance. If `getbalance` returns 0
 * and AUTOMINE is enabled, mine `BOOTSTRAP_BLOCKS` to a fresh address so the
 * coinbase reward is spendable. Idempotent — flips `bootstrapState.confirmed`
 * on first success so subsequent drips skip the RPC roundtrip.
 *
 * Returns `null` on success; an error string on failure (caller decides
 * whether to surface or proceed).
 */
async function ensureWalletFunded(): Promise<string | null> {
  if (bootstrapState.confirmed) return null;
  let balanceStr: string;
  try {
    balanceStr = await runBitcoinCli(["getbalance"]);
  } catch (e) {
    return `getbalance failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  // bitcoin-cli emits balance as a decimal BTC string, e.g. "0.00000000".
  const balanceBtc = Number(balanceStr);
  if (Number.isFinite(balanceBtc) && balanceBtc > 0) {
    bootstrapState.confirmed = true;
    return null;
  }
  if (!AUTOMINE) {
    return (
      `wallet has zero spendable balance; bootstrap disabled (REGTEST_FAUCET_AUTOMINE=0). ` +
      `Run \`docker exec ${CONTAINER} ${BCLI} ${BCLI_ARGS.join(" ")} generatetoaddress ${BOOTSTRAP_BLOCKS} <addr>\` manually.`
    );
  }
  try {
    const miner = await runBitcoinCli(["getnewaddress"]);
    console.log(`[Faucet] Bootstrapping: mining ${BOOTSTRAP_BLOCKS} blocks to ${miner}`);
    await runBitcoinCli(["generatetoaddress", String(BOOTSTRAP_BLOCKS), miner]);
    bootstrapState.confirmed = true;
    return null;
  } catch (e) {
    return `bootstrap mining failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (BTC_NETWORK !== "regtest") {
    return NextResponse.json(
      { ok: false, error: `faucet only available on regtest; current network=${BTC_NETWORK || "unknown"}` },
      { status: 400 },
    );
  }

  // Optional auth: only enforced when REGTEST_FAUCET_API_KEY is set.
  if (API_KEY) {
    const provided = req.headers.get("x-api-key") || req.headers.get("X-API-Key");
    if (provided !== API_KEY) {
      return NextResponse.json(
        { ok: false, error: "missing or invalid X-API-Key" },
        { status: 401 },
      );
    }
  }

  let body: DripBody;
  try {
    body = (await req.json()) as DripBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const address = (body.address ?? "").trim();
  const amountSats = Number(body.amountSats ?? 0);
  if (!isValidRegtestAddress(address)) {
    return NextResponse.json(
      { ok: false, error: "address must be a regtest bech32 (bcrt1…)" },
      { status: 400 },
    );
  }
  if (!Number.isFinite(amountSats) || amountSats <= 0 || amountSats > 100_000_000) {
    return NextResponse.json(
      { ok: false, error: "amountSats must be 1..100_000_000" },
      { status: 400 },
    );
  }

  // Cooldown check
  const last = lastDripMs.get(address);
  if (last !== undefined) {
    const elapsedMs = Date.now() - last;
    const remainingSec = Math.ceil((COOLDOWN_SECS * 1000 - elapsedMs) / 1000);
    if (remainingSec > 0) {
      return NextResponse.json(
        {
          ok: false,
          error: `cooldown active — try again in ${remainingSec}s`,
          retryAfterSec: remainingSec,
        },
        { status: 429, headers: { "Retry-After": String(remainingSec) } },
      );
    }
  }

  // 0. Bootstrap: on first call after `docker compose up`, mine 101 blocks
  // if the wallet has nothing spendable yet. No-ops on subsequent calls.
  const bootstrapErr = await ensureWalletFunded();
  if (bootstrapErr) {
    return NextResponse.json(
      {
        ok: false,
        error:
          `${bootstrapErr}. Check that the regtest container is running ` +
          `(docker compose -f docker-compose.regtest.yml up -d).`,
      },
      { status: 502 },
    );
  }

  // 1. Send the BTC
  let txid: string;
  try {
    txid = await runBitcoinCli(["sendtoaddress", address, satsToBtcDecimal(amountSats)]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      {
        ok: false,
        error: `sendtoaddress failed: ${truncate(msg, 400)}. ` +
          "Check that the regtest container is running (docker compose -f docker-compose.regtest.yml up -d).",
      },
      { status: 502 },
    );
  }

  // 2. Mine N blocks to a fresh miner address so the recipient sees a confirmed UTXO
  let minerAddr = "";
  let blocksMined = 0;
  try {
    minerAddr = await runBitcoinCli(["getnewaddress"]);
    await runBitcoinCli(["generatetoaddress", String(CONFIRMATIONS), minerAddr]);
    blocksMined = CONFIRMATIONS;
  } catch (e) {
    // Send succeeded but the mine failed — surface that explicitly so the
    // caller knows the tx is still in the mempool, just not confirmed.
    return NextResponse.json(
      {
        ok: true,
        txid,
        warning: `sent but failed to mine confirmation block: ${truncate(e instanceof Error ? e.message : String(e), 200)}`,
      },
      { status: 200 },
    );
  }

  // Record cooldown only on full success — if it failed before mining, the
  // user can retry without waiting (their address didn't actually get funds).
  lastDripMs.set(address, Date.now());
  saveCooldownStore(cooldownStore);

  return NextResponse.json({
    ok: true,
    txid,
    blocksMined,
    minerAddress: minerAddr,
  });
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}
