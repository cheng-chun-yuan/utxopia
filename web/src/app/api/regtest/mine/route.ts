/**
 * Regtest block miner.
 *
 * Hybrid/local-only helper for forcing Bitcoin regtest progress from the UI or
 * scripts. Mining a block also pushes Esplora's block notification path, which
 * wakes the backend deposit tracker/header relayer during demos.
 */

import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const BTC_NETWORK = process.env.NEXT_PUBLIC_BTC_NETWORK ?? "";
const CONTAINER = process.env.REGTEST_MINE_DOCKER_CONTAINER
  || process.env.REGTEST_FAUCET_DOCKER_CONTAINER
  || "utxopia-esplora-regtest";
const BCLI = process.env.REGTEST_MINE_BITCOIN_CLI
  || process.env.REGTEST_FAUCET_BITCOIN_CLI
  || "/srv/explorer/bitcoin/bin/bitcoin-cli";
const BCLI_ARGS = (
  process.env.REGTEST_MINE_BCLI_ARGS
  || process.env.REGTEST_FAUCET_BCLI_ARGS
  || "-regtest -datadir=/data/bitcoin -rpcwallet=test"
).split(/\s+/).filter(Boolean);
const API_KEY = process.env.REGTEST_MINE_API_KEY || process.env.REGTEST_FAUCET_API_KEY;
const MAX_BLOCKS = Math.max(1, Number(process.env.REGTEST_MINE_MAX_BLOCKS || "144"));

interface MineBody {
  blocks?: number;
  address?: string;
}

async function runBitcoinCli(args: string[]): Promise<string> {
  const fullArgs = ["exec", CONTAINER, BCLI, ...BCLI_ARGS, ...args];
  const { stdout } = await exec("docker", fullArgs, { maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

function isValidRegtestAddress(addr: string): boolean {
  return /^bcrt1[a-z0-9]{38,90}$/.test(addr);
}

function parseHashes(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return raw.split(/\s+/).filter(Boolean);
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "...";
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (BTC_NETWORK !== "regtest") {
    return NextResponse.json(
      { ok: false, error: `regtest miner only available on regtest; current network=${BTC_NETWORK || "unknown"}` },
      { status: 400 },
    );
  }

  if (API_KEY) {
    const provided = req.headers.get("x-api-key") || req.headers.get("X-API-Key");
    if (provided !== API_KEY) {
      return NextResponse.json(
        { ok: false, error: "missing or invalid X-API-Key" },
        { status: 401 },
      );
    }
  }

  let body: MineBody = {};
  try {
    const text = await req.text();
    body = text ? JSON.parse(text) as MineBody : {};
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const blocks = Number(body.blocks ?? 1);
  if (!Number.isInteger(blocks) || blocks < 1 || blocks > MAX_BLOCKS) {
    return NextResponse.json(
      { ok: false, error: `blocks must be an integer from 1..${MAX_BLOCKS}` },
      { status: 400 },
    );
  }

  let minerAddress = (body.address ?? "").trim();
  if (minerAddress && !isValidRegtestAddress(minerAddress)) {
    return NextResponse.json(
      { ok: false, error: "address must be a regtest bech32 (bcrt1...)" },
      { status: 400 },
    );
  }

  try {
    const tipBefore = Number(await runBitcoinCli(["getblockcount"]));
    if (!minerAddress) minerAddress = await runBitcoinCli(["getnewaddress"]);
    const rawHashes = await runBitcoinCli(["generatetoaddress", String(blocks), minerAddress]);
    const tipAfter = Number(await runBitcoinCli(["getblockcount"]));

    return NextResponse.json({
      ok: true,
      blocksMined: blocks,
      minerAddress,
      tipBefore,
      tipAfter,
      blockHashes: parseHashes(rawHashes),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      {
        ok: false,
        error: `regtest mining failed: ${truncate(msg, 500)}. Check that the regtest container is running.`,
      },
      { status: 502 },
    );
  }
}
