#!/usr/bin/env bun
/**
 * UTXOpia auditor CLI (Phase 1)
 *
 * Loads a password-encrypted DelegatedViewKey JSON and produces a CSV audit
 * report of every announcement that decrypts cleanly under that key, within
 * the key's slot range and optional CLI-supplied overrides.
 *
 * Usage:
 *   bun run scripts/auditor/scan.ts <key.json> [--network devnet|localnet|devnet-regtest]
 *       [--from-slot N] [--to-slot N] [--out report.csv]
 *       [--token-id <decimal-or-0xhex>] [--password <password>]
 *
 * Environment:
 *   AUDITOR_PASSWORD     password for the encrypted key (overrides --password)
 *   UTXOPIA_NETWORK      default network when --network is omitted
 *   BACKEND_URL          override backend API base URL
 *   SOLANA_RPC_URL       override Solana RPC URL
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";

import {
  AnnouncementClient,
  auditScan,
  auditRecordsToCsv,
  deserializeDelegatedViewKey,
  fingerprintDelegatedKey,
  type AuditScanAnnouncement,
} from "../../sdk/dist/index.js";

const ZKBTC_TOKEN_ID = BigInt(0x7a627463); // "zkbtc"

interface CliArgs {
  keyPath: string;
  network: string;
  fromSlot?: number;
  toSlot?: number;
  out?: string;
  tokenIds: bigint[];
  password?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    keyPath: "",
    network: process.env.UTXOPIA_NETWORK ?? "devnet",
    tokenIds: [],
  };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--network") out.network = argv[++i];
    else if (a === "--from-slot") out.fromSlot = Number(argv[++i]);
    else if (a === "--to-slot") out.toSlot = Number(argv[++i]);
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--password") out.password = argv[++i];
    else if (a === "--token-id") {
      const raw = argv[++i];
      out.tokenIds.push(raw.startsWith("0x") ? BigInt(raw) : BigInt(raw));
    } else if (a === "-h" || a === "--help") {
      printUsage();
      process.exit(0);
    } else if (a.startsWith("--")) {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      positional.push(a);
    }
  }

  if (positional.length !== 1) {
    printUsage();
    throw new Error("expected exactly one positional argument (key.json)");
  }
  out.keyPath = positional[0];
  if (out.tokenIds.length === 0) out.tokenIds = [ZKBTC_TOKEN_ID];
  return out;
}

function printUsage(): void {
  console.error(
    [
      "Usage:",
      "  bun run scripts/auditor/scan.ts <key.json> [flags]",
      "",
      "Flags:",
      "  --network <name>      devnet (default) | devnet-regtest | localnet | testnet | mainnet",
      "  --from-slot <N>       override key's lower slot bound",
      "  --to-slot <N>         override key's upper slot bound",
      "  --token-id <id>       decimal or 0x-prefixed hex (default zkBTC = 0x7a627463)",
      "  --out <path>          write CSV to file (default stdout)",
      "  --password <pw>       inline password (env AUDITOR_PASSWORD preferred)",
    ].join("\n"),
  );
}

interface NetworkRow {
  solana: { rpcUrl: string; utxopiaProgramId: string };
  backend?: { url?: string };
}

function loadNetwork(name: string): NetworkRow {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, "..", "..");
  const cfgPath = path.join(root, "web", "src", "lib", "networks.json");
  if (!fs.existsSync(cfgPath)) throw new Error(`networks.json missing at ${cfgPath}`);
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8")) as Record<string, NetworkRow>;
  const row = cfg[name];
  if (!row) throw new Error(`Unknown network ${name}. Known: ${Object.keys(cfg).join(", ")}`);
  return row;
}

async function promptPassword(): Promise<string> {
  // Bun has process.stdin support; readline.question echoes input, which is fine
  // for local CLI use. The encrypted JSON's PBKDF2 cost makes shoulder-surfing the
  // weakest link, not the prompt itself.
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question("Password: ", (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const password = process.env.AUDITOR_PASSWORD ?? args.password ?? (await promptPassword());

  const blob = fs.readFileSync(args.keyPath, "utf-8");
  const delegated = await deserializeDelegatedViewKey(blob, password);

  const network = loadNetwork(args.network);
  const backendUrl =
    process.env.BACKEND_URL ?? network.backend?.url ?? "http://localhost:8080";
  const rpcUrl = process.env.SOLANA_RPC_URL ?? network.solana.rpcUrl;

  const fingerprint = fingerprintDelegatedKey(delegated);
  process.stderr.write(`[auditor] key=${fingerprint} label=${delegated.label ?? "-"}\n`);
  process.stderr.write(
    `[auditor] scope: slot=[${delegated.fromSlot ?? "*"}, ${delegated.toSlot ?? "*"}] expiresAt=${
      delegated.expiresAt ? new Date(delegated.expiresAt).toISOString() : "never"
    }\n`,
  );
  process.stderr.write(`[auditor] backend=${backendUrl} rpc=${rpcUrl} network=${args.network}\n`);

  const client = new AnnouncementClient({
    backendUrl,
    solanaRpcUrl: rpcUrl,
    programId: network.solana.utxopiaProgramId,
  });
  const raw = await client.fetchAll();
  client.close();
  process.stderr.write(`[auditor] fetched ${raw.length} announcement(s)\n`);

  // AnnouncementClient strips tokenId, so the CLI defaults every announcement
  // to the requested tokens — `auditScan` will commitment-match against each.
  const annotated: AuditScanAnnouncement[] = raw.map((a) => ({ ...a }));

  const summary = await auditScan(delegated, annotated, {
    tokenIds: args.tokenIds,
    fromSlot: args.fromSlot,
    toSlot: args.toSlot,
  });

  process.stderr.write(
    `[auditor] matched=${summary.records.length} oor=${summary.outOfRangeSkipped} unscoped=${summary.unscopedSkipped} not-for-viewer=${summary.notForViewerSkipped}\n`,
  );

  const csv = auditRecordsToCsv(summary.records);
  if (args.out) {
    fs.writeFileSync(args.out, csv);
    process.stderr.write(`[auditor] wrote ${args.out}\n`);
  } else {
    process.stdout.write(csv);
  }
}

main().catch((err) => {
  console.error(`[auditor] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
