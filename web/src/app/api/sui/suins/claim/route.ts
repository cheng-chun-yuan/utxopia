import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/server/rate-limit";
import type { NetworkId } from "@/lib/network-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UTXOPIA_SUINS_PARENT = "utxopia.sui";
const LABEL_RE = /^[a-z0-9]{1,63}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_32_RE = /^[0-9a-fA-F]{64}$/;

type ClaimRequest = {
  handle?: string;
  name?: string;
  suiAddress?: string;
  loginId?: string;
  network?: NetworkId;
  viewingPubKey?: string;
  mpk?: string;
};

type ClaimRecord = {
  loginId: string;
  suiAddress: string;
  normalizedName: string;
  network: string;
  nftId: string | null;
  createDigest: string;
  claimedAt: string;
};

type ClaimLedger = {
  version: 1;
  claims: ClaimRecord[];
};

function jsonError(message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ success: false, error: message, ...extra }, { status });
}

function getLedgerPath() {
  return process.env.UTXOPIA_SUINS_CLAIMS_PATH || path.join(process.cwd(), ".data", "sui-suins-claims.json");
}

function readLedger(): ClaimLedger {
  const file = getLedgerPath();
  if (!existsSync(file)) return { version: 1, claims: [] };
  return JSON.parse(readFileSync(file, "utf8")) as ClaimLedger;
}

function writeLedger(ledger: ClaimLedger) {
  const file = getLedgerPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(ledger, null, 2));
}

function normalizeName(input: string) {
  const trimmed = input.trim().toLowerCase();
  const label = trimmed.startsWith("@")
    ? trimmed.slice(1)
    : trimmed.endsWith(`.${UTXOPIA_SUINS_PARENT}`)
      ? trimmed.slice(0, -1 * (`.${UTXOPIA_SUINS_PARENT}`).length)
      : trimmed;
  if (!LABEL_RE.test(label)) {
    throw new Error("Choose a lowercase handle with letters and numbers only.");
  }
  return `${label}.${UTXOPIA_SUINS_PARENT}`;
}

function claimName(input: Required<Pick<ClaimRequest, "suiAddress" | "viewingPubKey" | "mpk">> & ClaimRequest) {
  normalizeName(input.handle ?? input.name ?? "");
  if (!ADDRESS_RE.test(input.suiAddress)) throw new Error("Invalid Sui address.");
  if (!HEX_32_RE.test(input.viewingPubKey)) throw new Error("viewingPubKey must be 32 bytes of hex.");
  if (!HEX_32_RE.test(input.mpk)) throw new Error("mpk must be 32 bytes of hex.");
  const scriptPath = path.join(process.cwd(), "scripts", "sui-suins-claim.ts");
  const result = spawnSync(process.env.BUN_BIN || "bun", [scriptPath], {
    cwd: process.cwd(),
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: Number(process.env.UTXOPIA_SUINS_CLAIM_TIMEOUT_MS ?? "120000"),
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Could not claim SuiNS name.");
  }
  const output = JSON.parse(result.stdout) as {
    normalizedName: string;
    nftId: string | null;
    createDigest: string;
  };
  return output;
}

export async function POST(request: NextRequest) {
  const ip = getClientIp(request.headers);
  const rl = checkRateLimit(ip, "sui-suins-claim", { maxTokens: 3, windowMs: 60_000 });
  if (rl.limited) {
    return jsonError("Too many SuiNS claim requests. Try again shortly.", 429, {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  let body: ClaimRequest;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  if (!body.suiAddress || !body.viewingPubKey || !body.mpk) {
    return jsonError("suiAddress, viewingPubKey, and mpk are required.", 400);
  }

  let normalizedName: string;
  try {
    normalizedName = normalizeName(body.handle ?? body.name ?? "");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid SuiNS name.", 400);
  }

  const loginId = (body.loginId || body.suiAddress).trim().toLowerCase();
  const ledger = readLedger();
  const existingByLogin = ledger.claims.find((claim) => claim.loginId === loginId);
  if (existingByLogin) {
    return jsonError("This login already claimed a free SuiNS name.", 409, { claim: existingByLogin });
  }
  const existingByAddress = ledger.claims.find((claim) => claim.suiAddress.toLowerCase() === body.suiAddress!.toLowerCase());
  if (existingByAddress) {
    return jsonError("This Sui address already claimed a free SuiNS name.", 409, { claim: existingByAddress });
  }
  const existingByName = ledger.claims.find((claim) => claim.normalizedName === normalizedName);
  if (existingByName) {
    return jsonError("This SuiNS name has already been claimed.", 409, { claim: existingByName });
  }
  if (!process.env.UTXOPIA_SUINS_PARENT_NFT_ID && !process.env.NEXT_PUBLIC_UTXOPIA_SUINS_PARENT_NFT_ID) {
    return jsonError("UTXOPIA_SUINS_PARENT_NFT_ID is required for sponsored SuiNS claims.", 503);
  }

  try {
    const claimed = claimName(body as Required<Pick<ClaimRequest, "suiAddress" | "viewingPubKey" | "mpk">> & ClaimRequest);
    const claim: ClaimRecord = {
      loginId,
      suiAddress: body.suiAddress,
      normalizedName: claimed.normalizedName,
      network: body.network ?? "sui-testnet",
      nftId: claimed.nftId,
      createDigest: claimed.createDigest,
      claimedAt: new Date().toISOString(),
    };
    ledger.claims.push(claim);
    writeLedger(ledger);

    return NextResponse.json({ success: true, claim });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not claim SuiNS name.";
    const status = /already claimed|already registered|already exists/i.test(message) ? 409 : 500;
    return jsonError(message, status);
  }
}
