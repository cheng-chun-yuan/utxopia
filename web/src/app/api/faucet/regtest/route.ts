/**
 * Regtest BTC faucet.
 *
 * Talks to the `utxopia-esplora-regtest` container via `docker exec`, calling
 * bitcoin-cli the same way `scripts/hybrid/send-to.ts` does. It supports:
 *   - legacy raw `bcrt1...` drips
 *   - `utxo:...` stealth-address airdrops, where the route builds the actual
 *     UTXOpia deposit tx with the required 64-byte OP_RETURN.
 *
 * Guard rails:
 *   - regtest-only: refuses unless the active network config uses regtest BTC
 *   - optional `X-API-Key` check (set REGTEST_FAUCET_API_KEY to enable)
 *   - daily quota (default 3 successful sends/day per recipient and IP)
 *   - amount capped at 0.001 BTC (100_000 sats) by default
 *   - auto-bootstraps spendable balance: if the regtest wallet has zero
 *     spendable BTC, runs `generatetoaddress 101 <miner>` once before the
 *     first drip so users don't have to manually mine after `docker compose up`
 *   - returns 429 (with `retryAfterSec`) when in cooldown
 *
 * Override knobs (env):
 *   REGTEST_FAUCET_DOCKER_CONTAINER  default "utxopia-esplora-regtest"
 *   REGTEST_FAUCET_BITCOIN_CLI       default "/srv/explorer/bitcoin/bin/bitcoin-cli"
 *   REGTEST_FAUCET_BCLI_ARGS         default "-regtest -datadir=/data/bitcoin -rpcwallet=test"
 *   REGTEST_FAUCET_DAILY_LIMIT       default "3"
 *   REGTEST_FAUCET_MAX_SATS          default "100000"
 *   REGTEST_FAUCET_DEFAULT_SATS      default "100000"
 *   REGTEST_FAUCET_CONFIRMATIONS     default "6" (blocks mined right after the send)
 *   REGTEST_FAUCET_API_KEY           optional shared secret; required in X-API-Key header when set
 *   REGTEST_FAUCET_AUTOMINE          default "1" — set to "0" to disable initial-fund bootstrap
 */

import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import networks from "@/lib/networks.json";
import {
  detectNetworkFromRequest,
  getNetworkConfig,
  type NetworkConfig,
  type NetworkId,
} from "@/lib/network-config";
import { getBackendUrl } from "@/lib/api/constants";
import {
  createNonInteractiveDeposit,
  createDirectVaultDeposit,
  decodeStealthMetaAddress,
} from "@utxopia/sdk";

const exec = promisify(execFile);

const CONTAINER = process.env.REGTEST_FAUCET_DOCKER_CONTAINER || "utxopia-esplora-regtest";
const DOCKER_BIN_CANDIDATES = [
  process.env.REGTEST_FAUCET_DOCKER_BIN,
  process.env.DOCKER_BIN,
  "docker",
  "/usr/local/bin/docker",
  "/opt/homebrew/bin/docker",
].filter((candidate): candidate is string => Boolean(candidate));
const BCLI = process.env.REGTEST_FAUCET_BITCOIN_CLI || "/srv/explorer/bitcoin/bin/bitcoin-cli";
const BCLI_ARGS = (
  process.env.REGTEST_FAUCET_BCLI_ARGS || "-regtest -datadir=/data/bitcoin -rpcwallet=test"
).split(/\s+/).filter(Boolean);
const DAILY_LIMIT = Math.max(1, Number(process.env.REGTEST_FAUCET_DAILY_LIMIT || "3"));
const MAX_SATS = Math.max(1, Number(process.env.REGTEST_FAUCET_MAX_SATS || "100000"));
const DEFAULT_SATS = Math.min(
  MAX_SATS,
  Math.max(1, Number(process.env.REGTEST_FAUCET_DEFAULT_SATS || "100000")),
);
const CONFIRMATIONS = Math.max(1, Number(process.env.REGTEST_FAUCET_CONFIRMATIONS || "6"));
const API_KEY = process.env.REGTEST_FAUCET_API_KEY;
const BACKEND_API_KEY = process.env.BACKEND_API_KEY || "";
const REMOTE_FAUCET_MODE = process.env.REGTEST_FAUCET_MODE || (process.env.VERCEL ? "backend" : "local");
const AUTOMINE = process.env.REGTEST_FAUCET_AUTOMINE !== "0";
// Coinbase outputs need 100 confirmations before they're spendable, so mine
// 101 blocks on bootstrap (first block creates the coinbase reward, the next
// 100 make it spendable).
const BOOTSTRAP_BLOCKS = 101;

// File-backed daily quota. Survives Next.js process restarts so
// a hot-reload or redeploy doesn't reset everyone's allowance to zero. The
// map is loaded lazily on first access and written back after each drip.
//
// Path defaults to `.faucet-limits.json` in the web project root; override
// via REGTEST_FAUCET_LIMIT_PATH if the deployment has a writable mount.
const LIMIT_PATH = process.env.REGTEST_FAUCET_LIMIT_PATH
  || process.env.REGTEST_FAUCET_COOLDOWN_PATH
  || path.join(process.cwd(), ".faucet-limits.json");

interface LimitEntry {
  day: string;
  count: number;
  lastAt: number;
}

interface LimitStore {
  /** recipient/IP key → daily quota entry */
  entries: Map<string, LimitEntry>;
}

function todayKey(): string {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

function nextLocalDayStartMs(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
}

function loadLimitStore(): LimitStore {
  try {
    const raw = fs.readFileSync(LIMIT_PATH, "utf8");
    const obj = JSON.parse(raw) as Record<string, LimitEntry | number>;
    const day = todayKey();
    const entries = new Map<string, LimitEntry>();
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === "number") {
        entries.set(key, { day, count: 1, lastAt: value });
      } else if (value && typeof value.count === "number") {
        entries.set(key, value);
      }
    }
    return { entries };
  } catch {
    return { entries: new Map() };
  }
}

function saveLimitStore(store: LimitStore): void {
  const day = todayKey();
  const live: Record<string, LimitEntry> = {};
  for (const [key, entry] of store.entries) {
    if (entry.day === day) live[key] = entry;
  }
  try {
    fs.writeFileSync(LIMIT_PATH, JSON.stringify(live) + "\n", { mode: 0o600 });
  } catch (e) {
    // Disk failure → fall through; the in-memory map still works for this
    // process. Worst case: a restart resets the cooldown for affected
    // addresses.
    console.warn("[Faucet] Failed to persist limit store:", e);
  }
}

const limitStore: LimitStore = (() => {
  const g = globalThis as unknown as { __utxopiaFaucetLimit?: LimitStore };
  if (!g.__utxopiaFaucetLimit) g.__utxopiaFaucetLimit = loadLimitStore();
  return g.__utxopiaFaucetLimit;
})();

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
  stealthAddress?: string;
  amountSats?: number;
}

interface FaucetNetworkConfig {
  bitcoin?: {
    network?: string;
    groupPubkey?: string;
  };
  ika?: {
    dwalletXOnlyPubkey?: string;
  };
}

const DEFAULT_REGTEST_GROUP_PUBKEY =
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

async function callBackendFaucet(
  network: NetworkId,
  payload: {
    address: string;
    amountSats: number;
    opReturn?: string;
  },
): Promise<NextResponse | null> {
  const backendUrl = process.env.REGTEST_FAUCET_BACKEND_URL || getBackendUrl(network);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (BACKEND_API_KEY) headers["X-API-Key"] = BACKEND_API_KEY;

  let res: Response;
  try {
    res = await fetch(`${backendUrl}/api/faucet/regtest`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      cache: "no-store",
    });
  } catch (e) {
    if (REMOTE_FAUCET_MODE === "backend") {
      return NextResponse.json(
        {
          ok: false,
          error: `backend faucet unreachable: ${e instanceof Error ? e.message : String(e)}`,
        },
        { status: 502 },
      );
    }
    return null;
  }

  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = {
      ok: false,
      error: `backend faucet returned non-JSON response: ${truncate(text, 300)}`,
    };
  }

  return NextResponse.json(body, { status: res.status });
}

async function runBitcoinCli(args: string[]): Promise<string> {
  const fullArgs = ["exec", CONTAINER, BCLI, ...BCLI_ARGS, ...args];
  let dockerNotFound: Error | null = null;
  for (const dockerBin of DOCKER_BIN_CANDIDATES) {
    try {
      const { stdout } = await exec(dockerBin, fullArgs, { maxBuffer: 1024 * 1024 });
      return stdout.trim();
    } catch (e) {
      if (isEnoent(e)) {
        dockerNotFound = e;
        continue;
      }
      throw e;
    }
  }
  const tried = DOCKER_BIN_CANDIDATES.join(", ");
  throw new Error(
    `docker CLI not found (tried: ${tried}). Set REGTEST_FAUCET_DOCKER_BIN to the absolute docker path.`,
    { cause: dockerNotFound ?? undefined },
  );
}

function isEnoent(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT";
}

function isValidRegtestAddress(addr: string): boolean {
  // bech32: bcrt1q… (P2WPKH/P2WSH) or bcrt1p… (P2TR). Length 42–62 covers all variants.
  return /^bcrt1[a-z0-9]{38,90}$/.test(addr);
}

function getClientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("x-real-ip") || "unknown";
}

function satsToBtcDecimal(sats: number): string {
  // bitcoin-cli expects BTC, not sats. Print with 8 decimals to avoid
  // scientific notation tripping up the RPC parser for small amounts.
  const btc = sats / 1e8;
  return btc.toFixed(8);
}

function hex(buf: Uint8Array): string {
  return Buffer.from(buf).toString("hex");
}

function hexToBytes(value: string): Uint8Array {
  const normalized = value.trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]+$/.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error("invalid hex string");
  }
  return Uint8Array.from(Buffer.from(normalized, "hex"));
}

function getFallbackNetworkConfig(): FaucetNetworkConfig {
  const network = process.env.NEXT_PUBLIC_NETWORK || process.env.UTXOPIA_NETWORK || "devnet-regtest";
  const configs = networks as Record<string, FaucetNetworkConfig>;
  return configs[network] ?? configs["devnet-regtest"];
}

function getRequestNetwork(req: NextRequest): NetworkId {
  try {
    return detectNetworkFromRequest(req);
  } catch {
    const env = process.env.NEXT_PUBLIC_NETWORK || process.env.UTXOPIA_NETWORK;
    return env === "sui-regtest" ? "sui-regtest" : "devnet-regtest";
  }
}

function getRequestNetworkConfig(network: NetworkId): NetworkConfig | FaucetNetworkConfig {
  try {
    return getNetworkConfig(network, { applyEnvOverrides: false });
  } catch {
    return getFallbackNetworkConfig();
  }
}

async function createDepositForStealth(
  stealthAddress: string,
  cfg: NetworkConfig | FaucetNetworkConfig,
): Promise<{
  btcAddress: string;
  opReturnPayload: Uint8Array;
}> {
  const meta = decodeStealthMetaAddress(stealthAddress);
  const btcNetwork = cfg?.bitcoin?.network === "regtest" ? "regtest" : "testnet";
  const vaultKeyHex = cfg?.ika?.dwalletXOnlyPubkey;

  if (vaultKeyHex && !/^0+$/.test(vaultKeyHex)) {
    const vaultKey = Uint8Array.from(Buffer.from(vaultKeyHex, "hex"));
    const deposit = await createDirectVaultDeposit(meta, vaultKey, btcNetwork);
    return { btcAddress: deposit.btcAddress, opReturnPayload: deposit.opReturnPayload };
  }

  const groupPubkeyHex =
    process.env.REGTEST_FAUCET_GROUP_PUBKEY ||
    cfg?.bitcoin?.groupPubkey ||
    DEFAULT_REGTEST_GROUP_PUBKEY;
  const groupPubkey = hexToBytes(groupPubkeyHex);
  if (groupPubkey.length !== 32) {
    throw new Error("active network group pubkey must be 32 bytes");
  }
  const deposit = await createNonInteractiveDeposit(meta, groupPubkey, btcNetwork);
  return { btcAddress: deposit.btcAddress, opReturnPayload: deposit.opReturnPayload };
}

function limitKey(kind: "recipient" | "ip", value: string): string {
  return `${kind}:${value.toLowerCase()}`;
}

function getLimitStatus(keys: string[]): { ok: true } | { ok: false; remaining: number } {
  const day = todayKey();
  for (const key of keys) {
    const entry = limitStore.entries.get(key);
    if (entry?.day === day && entry.count >= DAILY_LIMIT) {
      return { ok: false, remaining: Math.max(1, Math.ceil((nextLocalDayStartMs() - Date.now()) / 1000)) };
    }
  }
  return { ok: true };
}

function recordLimitHit(keys: string[]): void {
  const day = todayKey();
  const now = Date.now();
  for (const key of keys) {
    const entry = limitStore.entries.get(key);
    if (entry?.day === day) {
      entry.count += 1;
      entry.lastAt = now;
    } else {
      limitStore.entries.set(key, { day, count: 1, lastAt: now });
    }
  }
  saveLimitStore(limitStore);
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
  const activeNetwork = getRequestNetwork(req);
  const activeConfig = getRequestNetworkConfig(activeNetwork);
  const btcNetwork = activeConfig?.bitcoin?.network || process.env.NEXT_PUBLIC_BTC_NETWORK || "";

  if (btcNetwork !== "regtest") {
    return NextResponse.json(
      {
        ok: false,
        error: `faucet only available on regtest; current network=${activeNetwork}, btcNetwork=${btcNetwork || "unknown"}`,
      },
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

  const requestedAddress = (body.stealthAddress ?? body.address ?? "").trim();
  const isStealthAirdrop = requestedAddress.startsWith("utxo:");
  const amountSats = Number(body.amountSats ?? DEFAULT_SATS);
  if (!isStealthAirdrop && !isValidRegtestAddress(requestedAddress)) {
    return NextResponse.json(
      { ok: false, error: "address must be a regtest bech32 (bcrt1…) or UTXOpia stealth address (utxo:…)" },
      { status: 400 },
    );
  }
  if (!Number.isInteger(amountSats) || amountSats <= 0 || amountSats > MAX_SATS) {
    return NextResponse.json(
      { ok: false, error: `amountSats must be an integer from 1..${MAX_SATS}` },
      { status: 400 },
    );
  }

  const clientIp = getClientIp(req);
  const quotaKeys = [
    limitKey("recipient", requestedAddress),
    limitKey("ip", clientIp),
  ];
  const quota = getLimitStatus(quotaKeys);
  if (!quota.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: `daily airdrop limit reached — max ${DAILY_LIMIT} request${DAILY_LIMIT === 1 ? "" : "s"} per day`,
        retryAfterSec: quota.remaining,
        dailyLimit: DAILY_LIMIT,
      },
      { status: 429, headers: { "Retry-After": String(quota.remaining) } },
    );
  }

  let btcAddress = requestedAddress;
  let opReturnHex: string | undefined;
  if (isStealthAirdrop) {
    try {
      const deposit = await createDepositForStealth(requestedAddress, activeConfig);
      btcAddress = deposit.btcAddress;
      opReturnHex = hex(deposit.opReturnPayload);
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: `invalid stealth address or deposit config: ${truncate(e instanceof Error ? e.message : String(e), 300)}` },
        { status: 400 },
      );
    }
  }

  if (REMOTE_FAUCET_MODE === "backend") {
    const remote = await callBackendFaucet(activeNetwork, {
      address: btcAddress,
      amountSats,
      opReturn: opReturnHex,
    });
    if (remote) {
      if (remote.ok) recordLimitHit(quotaKeys);
      return remote;
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

  // 1. Send the BTC. For `utxo:` airdrops this is a full UTXOpia deposit tx:
  // payment output to the pool/vault plus OP_RETURN(ephemeralPub || npk).
  let txid: string;
  try {
    if (opReturnHex) {
      const outputs = JSON.stringify([
        { [btcAddress]: Number(satsToBtcDecimal(amountSats)) },
        { data: opReturnHex },
      ]);
      const rawHex = await runBitcoinCli(["createrawtransaction", "[]", outputs]);
      const fundedJson = await runBitcoinCli(["fundrawtransaction", rawHex]);
      const fundedHex = JSON.parse(fundedJson).hex;
      const signedJson = await runBitcoinCli(["signrawtransactionwithwallet", fundedHex]);
      const signed = JSON.parse(signedJson);
      if (!signed.complete) throw new Error(`sign failed: ${JSON.stringify(signed.errors ?? [])}`);
      txid = await runBitcoinCli(["sendrawtransaction", signed.hex]);
    } else {
      txid = await runBitcoinCli(["sendtoaddress", btcAddress, satsToBtcDecimal(amountSats)]);
    }
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

  // Record quota only on full success — if it failed before mining, the user
  // can retry without burning one of the daily attempts.
  recordLimitHit(quotaKeys);

  return NextResponse.json({
    ok: true,
    txid,
    mode: isStealthAirdrop ? "utxo_airdrop" : "btc_drip",
    depositAddress: isStealthAirdrop ? btcAddress : undefined,
    opReturn: opReturnHex,
    amountSats,
    dailyLimit: DAILY_LIMIT,
    blocksMined,
    minerAddress: minerAddr,
  });
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}
