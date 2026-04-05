#!/usr/bin/env bun
/**
 * Full-stack localnet smoke test.
 *
 * Runs the chain-level E2E suite (unless --skip-chain), then starts:
 * - Rust backend (`zkbtc-api`)
 * - Next frontend (`web`)
 *
 * Finally asserts that the backend API and the frontend's server-side `/api/*`
 * routes expose the expected post-E2E state.
 *
 * Usage:
 *   bun run scripts/e2e/full-stack-smoke.ts
 *   bun run scripts/e2e/full-stack-smoke.ts --skip-chain
 *   bun run scripts/e2e/full-stack-smoke.ts --keep-services
 */

import { spawn, spawnSync, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../..");
const STATE_FILE = path.join(__dirname, "localnet-state.json");

const BACKEND_URL = "http://127.0.0.1:3001";
const WEB_URL = "http://127.0.0.1:3000";
const SOLANA_RPC_URL = "http://127.0.0.1:8899";
const ESPLORA_URL = "http://localhost:3002/regtest/api";
const API_KEY = "localnet-dev-key";

const args = new Set(process.argv.slice(2));
const skipChain = args.has("--skip-chain");
const keepServices = args.has("--keep-services");

interface LocalnetState {
  privacyCoinProgramId: string;
  btcLightClientId: string;
  chadbufferId: string;
  zkbtcMint: string;
  poolState: string;
  commitmentTree: string;
  poolVault: string;
  frostVault: string;
  authority: string;
  poolBtcAddress?: string;
  tUsdcMint?: string;
  tUsdtMint?: string;
  tWsolMint?: string;
  jupUsdMint?: string;
}

interface StartedService {
  name: string;
  proc: ChildProcess;
  logPath: string;
}

function log(message: string) {
  console.log(`[full-stack] ${message}`);
}

function fail(message: string): never {
  throw new Error(message);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadState(): LocalnetState {
  if (!fs.existsSync(STATE_FILE)) {
    fail(`State file not found: ${STATE_FILE}. Run localnet E2E first.`);
  }
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as LocalnetState;
}

function readTail(filePath: string, lines = 80): string {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return content.split("\n").slice(-lines).join("\n");
  } catch {
    return "(log unavailable)";
  }
}

async function waitForLogPattern(
  label: string,
  filePath: string,
  pattern: RegExp,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf8");
        if (pattern.test(content)) return;
      }
    } catch {}

    await sleep(500);
  }

  fail(`Timed out waiting for ${label} in log ${filePath}`);
}

function runOrThrow(cmd: string, cmdArgs: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  const result = spawnSync(cmd, cmdArgs, {
    cwd,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    fail(`Command failed: ${cmd} ${cmdArgs.join(" ")}`);
  }
}

function startService(
  name: string,
  cmd: string,
  cmdArgs: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): StartedService {
  const logPath = path.join("/tmp", `privacy-coin-${name}-${Date.now()}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: "a" });
  const proc = spawn(cmd, cmdArgs, {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stdout?.pipe(logStream);
  proc.stderr?.pipe(logStream);

  proc.on("exit", (code, signal) => {
    fs.appendFileSync(
      logPath,
      `\n[${name}] exited code=${code ?? "null"} signal=${signal ?? "null"}\n`,
    );
  });

  return { name, proc, logPath };
}

function stopService(service: StartedService) {
  if (!service.proc.pid) return;
  try {
    process.kill(-service.proc.pid, "SIGTERM");
  } catch {}
}

async function waitForJson(
  label: string,
  url: string,
  validate: (json: any) => boolean,
  options?: {
    headers?: Record<string, string>;
    timeoutMs?: number;
    progressEveryMs?: number;
    describe?: (json: any) => string;
  },
): Promise<any> {
  const timeoutMs = options?.timeoutMs ?? 120_000;
  const progressEveryMs = options?.progressEveryMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  let lastError: string | null = null;
  let lastProgressAt = 0;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        headers: {
          "Cache-Control": "no-store",
          ...(options?.headers ?? {}),
        },
      });
      if (res.ok) {
        const json = await res.json();
        if (validate(json)) {
          log(`${label} ready`);
          return json;
        }
        lastError = `validation failed for ${label}`;
        if (Date.now() - lastProgressAt >= progressEveryMs) {
          const details = options?.describe?.(json);
          log(
            `${label} pending${details ? `: ${details}` : ""}`
          );
          lastProgressAt = Date.now();
        }
      } else {
        lastError = `HTTP ${res.status} for ${label}`;
        if (Date.now() - lastProgressAt >= progressEveryMs) {
          log(`${label} pending: HTTP ${res.status}`);
          lastProgressAt = Date.now();
        }
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (Date.now() - lastProgressAt >= progressEveryMs) {
        log(`${label} pending: ${lastError}`);
        lastProgressAt = Date.now();
      }
    }

    await sleep(1_000);
  }

  fail(`Timed out waiting for ${label}: ${lastError ?? "unknown error"}`);
}

async function waitForHttpOk(
  label: string,
  url: string,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: string | null = null;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { headers: { "Cache-Control": "no-store" } });
      if (res.ok) return;
      lastError = `HTTP ${res.status} for ${label}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(1_000);
  }

  fail(`Timed out waiting for ${label}: ${lastError ?? "unknown error"}`);
}

function makeBackendEnv(state: LocalnetState): NodeJS.ProcessEnv {
  const home = process.env.HOME ?? "";
  const keypairPath = path.join(home, ".config/solana/id.json");
  const timestamp = Date.now().toString();

  return {
    PRIVACY_COIN_NETWORK: "localnet",
    PRIVACY_COIN_PROGRAM_ID: state.privacyCoinProgramId,
    PRIVACY_COIN_SOLANA_RPC: SOLANA_RPC_URL,
    SOLANA_RPC_URL,
    BTC_LIGHT_CLIENT_PROGRAM_ID: state.btcLightClientId,
    PRIVACY_COIN_BITCOIN_NETWORK: "regtest",
    ESPLORA_URL,
    MEMPOOL_API_URL: ESPLORA_URL,
    MEMPOOL_WS_ENABLED: "false",
    SOLANA_WS_URL: "ws://127.0.0.1:8900",
    HEADER_RELAY_ENABLED: "false",
    POOL_RECEIVE_ADDRESS: state.poolBtcAddress ?? "",
    BACKEND_API_KEY: API_KEY,
    ALLOWED_ORIGIN: WEB_URL,
    TRACKER_API_PORT: "3001",
    DEPOSIT_DB_PATH: `/tmp/privacy-coin-deposits-${timestamp}.db`,
    INDEXER_DB_PATH: `/tmp/privacy-coin-events-${timestamp}.db`,
    RELAYER_FEE_SATS: "500",
    PRIVACY_COIN_SIGNING_MODE: "single",
    VERIFIER_KEYPAIR: keypairPath,
    RELAYER_KEYPAIR: keypairPath,
    RUST_LOG: "info,zkbtc=debug",
  };
}

function makeWebEnv(state: LocalnetState): NodeJS.ProcessEnv {
  return {
    NEXT_PUBLIC_NETWORK: "localnet",
    NEXT_PUBLIC_BTC_NETWORK: "regtest",
    NEXT_PUBLIC_SOLANA_RPC_URL: SOLANA_RPC_URL,
    BACKEND_API_URL: BACKEND_URL,
    BACKEND_API_KEY: API_KEY,
    NEXT_PUBLIC_BACKEND_API_URL: BACKEND_URL,
    NEXT_PUBLIC_USDC_MINT: state.tUsdcMint ?? "",
    NEXT_PUBLIC_USDT_MINT: state.tUsdtMint ?? "",
    NEXT_PUBLIC_WSOL_MINT: state.tWsolMint ?? "",
    NEXT_PUBLIC_JUPUSD_MINT: state.jupUsdMint ?? "",
    PORT: "3000",
    HOSTNAME: "127.0.0.1",
  };
}

async function main() {
  const services: StartedService[] = [];

  try {
    if (!skipChain) {
      log("Running chain E2E suite first...");
      runOrThrow("bun", ["run", "scripts/e2e/run-all.ts"], ROOT);
    } else {
      log("Skipping chain E2E suite; reusing existing localnet state");
    }

    const state = loadState();
    log(`Using program ${state.privacyCoinProgramId}`);

    log("Starting backend API/indexer service...");
    const backend = startService(
      "backend",
      "cargo",
      ["run", "--bin", "zkbtc-api"],
      path.join(ROOT, "backend"),
      makeBackendEnv(state),
    );
    services.push(backend);

    await waitForJson(
      "backend health",
      `${BACKEND_URL}/api/health`,
      (json) => json?.status === "ok",
    );
    log("Backend health check passed");

    log("Starting Next frontend dev server...");
    const web = startService(
      "web",
      "bun",
      ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", "3000"],
      path.join(ROOT, "web"),
      makeWebEnv(state),
    );
    services.push(web);

    await waitForLogPattern("frontend ready", web.logPath, /Ready in/i, 180_000);
    assert(web.proc.exitCode === null, "frontend dev server exited before becoming ready");
    log("Frontend server is ready");

    const backendPoolStats = await waitForJson(
      "backend pool stats",
      `${BACKEND_URL}/api/pool/stats`,
      (json) =>
        !!json?.onChain &&
        Number(json.onChain.treeNextIndex ?? 0) >= 6 &&
        Number(json.onChain.totalShielded ?? 0) > 0,
      {
        timeoutMs: 60_000,
        describe: (json) =>
          `treeNextIndex=${json?.onChain?.treeNextIndex ?? "?"}, totalShielded=${json?.onChain?.totalShielded ?? "?"}`,
      },
    );

    const backendExplorer = await waitForJson(
      "backend explorer transactions",
      `${BACKEND_URL}/api/explorer/transactions`,
      (json) => {
        const txs = json?.transactions ?? [];
        const types = new Set(txs.map((tx: any) => tx?.type));
        return txs.length >= 6 &&
          types.has("shield") &&
          types.has("transfer") &&
          types.has("unshield") &&
          types.has("withdraw");
      },
      {
        timeoutMs: 60_000,
        describe: (json) => {
          const txs = json?.transactions ?? [];
          const types = [...new Set(txs.map((tx: any) => tx?.type).filter(Boolean))];
          return `count=${txs.length}, types=${types.join(",") || "none"}`;
        },
      },
    );

    const backendRedemptions = await waitForJson(
      "backend redemption aggregate",
      `${BACKEND_URL}/api/redemption/all`,
      (json) =>
        Array.isArray(json?.completed) &&
        Array.isArray(json?.requested) &&
        json.completed.length >= 1 &&
        json.requested.length >= 1,
      {
        timeoutMs: 60_000,
        describe: (json) =>
          `completed=${json?.completed?.length ?? "?"}, requested=${json?.requested?.length ?? "?"}`,
      },
    );

    const relayerMeta = await waitForJson(
      "frontend relayer meta",
      `${WEB_URL}/api/relayer/meta`,
      (json) =>
        typeof json?.service_fee_base === "number" &&
        typeof json?.service_fee_bps === "number" &&
        typeof json?.min_withdrawal === "number",
      {
        timeoutMs: 30_000,
        describe: (json) =>
          `base=${json?.service_fee_base ?? "?"}, bps=${json?.service_fee_bps ?? "?"}, min=${json?.min_withdrawal ?? "?"}`,
      },
    );

    const webPoolStats = await waitForJson(
      "frontend pool stats",
      `${WEB_URL}/api/pool/stats`,
      (json) =>
        !!json?.onChain &&
        Number(json.onChain.treeNextIndex ?? 0) >= 6 &&
        Number(json.onChain.totalShielded ?? 0) > 0,
      {
        timeoutMs: 60_000,
        describe: (json) =>
          `treeNextIndex=${json?.onChain?.treeNextIndex ?? "?"}, totalShielded=${json?.onChain?.totalShielded ?? "?"}`,
      },
    );

    const webExplorer = await waitForJson(
      "frontend explorer transactions",
      `${WEB_URL}/api/explorer/transactions`,
      (json) => {
        const txs = json?.transactions ?? [];
        return txs.length >= 6 && txs.some((tx: any) => tx?.tokenSymbol);
      },
      {
        timeoutMs: 60_000,
        describe: (json) => {
          const txs = json?.transactions ?? [];
          const tokenized = txs.filter((tx: any) => tx?.tokenSymbol).length;
          return `count=${txs.length}, tokenized=${tokenized}`;
        },
      },
    );

    const webDeposits = await waitForJson(
      "frontend explorer deposits",
      `${WEB_URL}/api/explorer/deposits`,
      (json) => {
        const txs = json?.transactions ?? [];
        const hasBtc = txs.some((tx: any) => tx?.btcMeta?.depositTxid);
        const hasSpl = txs.some((tx: any) => !tx?.btcMeta && tx?.tokenSymbol && tx.tokenSymbol !== "BTC");
        return txs.length >= 3 && hasBtc && hasSpl;
      },
      {
        timeoutMs: 60_000,
        describe: (json) => {
          const txs = json?.transactions ?? [];
          const hasBtc = txs.some((tx: any) => tx?.btcMeta?.depositTxid);
          const hasSpl = txs.some((tx: any) => !tx?.btcMeta && tx?.tokenSymbol && tx.tokenSymbol !== "BTC");
          return `count=${txs.length}, hasBtc=${hasBtc}, hasSpl=${hasSpl}`;
        },
      },
    );

    const webRedemptions = await waitForJson(
      "frontend explorer redemptions",
      `${WEB_URL}/api/explorer/redemptions`,
      (json) => {
        const rows = json ?? [];
        return Array.isArray(rows) &&
          rows.some((row: any) => row?.status === "Completed") &&
          rows.some((row: any) => row?.status === "Pending");
      },
      {
        timeoutMs: 60_000,
        describe: (json) => {
          const rows = Array.isArray(json) ? json : [];
          const statuses = [...new Set(rows.map((row: any) => row?.status).filter(Boolean))];
          return `count=${rows.length}, statuses=${statuses.join(",") || "none"}`;
        },
      },
    );

    assert(
      Number(backendPoolStats.onChain.treeNextIndex) === Number(webPoolStats.onChain.treeNextIndex),
      "backend/web pool stats disagree on treeNextIndex",
    );
    assert(
      (backendExplorer.transactions ?? []).length === (webExplorer.transactions ?? []).length,
      "backend/web explorer transaction counts differ",
    );

    log("Full-stack smoke test passed");
    console.log("");
    console.log("Summary:");
    console.log(`  Backend pool stats: ${backendPoolStats.onChain.totalShielded} shielded, tree index ${backendPoolStats.onChain.treeNextIndex}`);
    console.log(`  Backend explorer txs: ${(backendExplorer.transactions ?? []).length}`);
    console.log(`  Backend completed redemptions: ${(backendRedemptions.completed ?? []).length}`);
    console.log(`  Frontend deposits feed: ${(webDeposits.transactions ?? []).length}`);
    console.log(`  Frontend redemptions feed: ${(webRedemptions ?? []).length}`);
    console.log(`  Relayer meta: base=${relayerMeta.service_fee_base}, bps=${relayerMeta.service_fee_bps}`);

    if (keepServices) {
      log("Leaving backend/web services running (--keep-services)");
      return;
    }
  } catch (err) {
    console.error("");
    console.error("Full-stack smoke test failed.");
    if (err instanceof Error) {
      console.error(err.message);
    } else {
      console.error(String(err));
    }

    for (const service of services) {
      console.error("");
      console.error(`--- ${service.name} log tail (${service.logPath}) ---`);
      console.error(readTail(service.logPath));
    }

    process.exitCode = 1;
  } finally {
    if (!keepServices) {
      for (const service of services.reverse()) {
        stopService(service);
      }
    }
  }
}

await main();
