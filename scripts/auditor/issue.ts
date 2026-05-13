#!/usr/bin/env bun
/**
 * UTXOpia auditor key issuance CLI (Phase 1)
 *
 * Derives keys from a seed (or wallet keypair), creates a DelegatedViewKey
 * with the requested scope, password-encrypts it, and writes both the
 * exported JSON and a public-only DelegationRecord stub to the local audit
 * trail at `~/.utxopia/delegations.json`.
 *
 * Usage:
 *   bun run scripts/auditor/issue.ts --seed <hex> --out <path>
 *       [--label <label>] [--recipient <name>]
 *       [--from-slot N] [--to-slot N] [--expires-in <hours>]
 *       [--permissions FULL|SCAN|INCOMING_ONLY]
 *       [--password <password>]
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

import {
  createDelegatedViewKey,
  deriveKeysFromSeed,
  fingerprintDelegatedKey,
  makeDelegationRecord,
  serializeDelegatedViewKey,
  ViewPermissions,
  type DelegationRecord,
} from "../../sdk/dist/index.js";

interface CliArgs {
  seedHex: string;
  out: string;
  label?: string;
  recipient?: string;
  fromSlot?: number;
  toSlot?: number;
  expiresInHours?: number;
  permissions: ViewPermissions;
  password?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    seedHex: "",
    out: "",
    permissions: ViewPermissions.FULL,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--seed") out.seedHex = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--label") out.label = argv[++i];
    else if (a === "--recipient") out.recipient = argv[++i];
    else if (a === "--from-slot") out.fromSlot = Number(argv[++i]);
    else if (a === "--to-slot") out.toSlot = Number(argv[++i]);
    else if (a === "--expires-in") out.expiresInHours = Number(argv[++i]);
    else if (a === "--password") out.password = argv[++i];
    else if (a === "--permissions") {
      const v = argv[++i];
      if (v === "FULL") out.permissions = ViewPermissions.FULL;
      else if (v === "SCAN") out.permissions = ViewPermissions.SCAN;
      else if (v === "INCOMING_ONLY")
        out.permissions = ViewPermissions.SCAN | ViewPermissions.INCOMING_ONLY;
      else throw new Error(`Unknown --permissions value: ${v}`);
    } else if (a === "-h" || a === "--help") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown arg: ${a}`);
    }
  }
  if (!out.seedHex || !out.out) {
    printUsage();
    throw new Error("--seed and --out are required");
  }
  return out;
}

function printUsage(): void {
  console.error(
    [
      "Usage:",
      "  bun run scripts/auditor/issue.ts --seed <hex> --out <path> [flags]",
      "",
      "Required:",
      "  --seed <hex>          32-byte seed as hex (64 chars)",
      "  --out <path>          path to write encrypted key JSON",
      "",
      "Optional:",
      "  --label <label>       human-readable label",
      "  --recipient <name>    who's receiving this delegation (saved in audit trail only)",
      "  --from-slot N         lower slot bound (inclusive)",
      "  --to-slot N           upper slot bound (inclusive)",
      "  --expires-in <hours>  expire wall-clock after N hours",
      "  --permissions FULL|SCAN|INCOMING_ONLY (default FULL)",
      "  --password <pw>       inline password (env AUDITOR_PASSWORD preferred)",
    ].join("\n"),
  );
}

function trailPath(): string {
  return path.join(os.homedir(), ".utxopia", "delegations.json");
}

function appendTrail(record: DelegationRecord): void {
  const p = trailPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const existing: DelegationRecord[] = fs.existsSync(p)
    ? JSON.parse(fs.readFileSync(p, "utf-8"))
    : [];
  existing.push(record);
  fs.writeFileSync(p, JSON.stringify(existing, null, 2) + "\n");
  process.stderr.write(`[auditor] audit trail: ${p}\n`);
}

async function promptPassword(confirm: boolean): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, (a) => resolve(a)));
  try {
    const a = await ask("New password: ");
    if (confirm) {
      const b = await ask("Confirm password: ");
      if (a !== b) throw new Error("passwords do not match");
    }
    return a;
  } finally {
    rl.close();
  }
}

function decodeHex(s: string): Uint8Array {
  if (s.length !== 64) throw new Error(`seed must be 64 hex chars; got ${s.length}`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(s.substring(2 * i, 2 * i + 2), 16);
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const password = process.env.AUDITOR_PASSWORD ?? args.password ?? (await promptPassword(true));

  const seed = decodeHex(args.seedHex);
  const keys = deriveKeysFromSeed(seed);

  const expiresAt = args.expiresInHours ? Date.now() + args.expiresInHours * 3_600_000 : undefined;

  const delegated = createDelegatedViewKey(keys, args.permissions, {
    label: args.label,
    fromSlot: args.fromSlot,
    toSlot: args.toSlot,
    expiresAt,
  });

  const blob = await serializeDelegatedViewKey(delegated, password);
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, blob);

  const record = makeDelegationRecord(delegated, { recipient: args.recipient });
  appendTrail(record);

  const fp = fingerprintDelegatedKey(delegated);
  process.stderr.write(`[auditor] issued key fingerprint=${fp}\n`);
  process.stderr.write(`[auditor] wrote ${args.out}\n`);
}

main().catch((err) => {
  console.error(`[auditor] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
