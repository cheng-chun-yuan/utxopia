#!/usr/bin/env bun
/**
 * Set / clear the compliance flag byte on a `.btcpro.sol` SNS subdomain.
 *
 * Only the SNS owner can update the record. The script reads the current
 * stealth payload, reallocs to 66 bytes if needed, and writes a single
 * flag byte at offset 65 of the stealth payload (i.e. byte 161 of the
 * on-chain account, after the 96-byte SNS header).
 *
 * Usage:
 *   bun run scripts/sns-set-compliance.ts <subdomain> --enable [--keypair ~/.config/solana/id.json]
 *   bun run scripts/sns-set-compliance.ts <subdomain> --disable
 *   bun run scripts/sns-set-compliance.ts <subdomain> --raw 0x03
 *
 * Examples:
 *   bun run scripts/sns-set-compliance.ts alice --enable
 *     → sets bit 0 (AUDITOR_DISCLOSABLE) on `alice.btcpro.sol`
 *
 *   bun run scripts/sns-set-compliance.ts alice --disable
 *     → clears the flag byte
 *
 * Network: reads `--network` flag (default: devnet); maps to networks.json
 * for RPC URL + SNS program ID + parent domain.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  initConfig,
  resolveSnsName,
  SnsComplianceFlags,
  deriveParentDomainKey,
  sha256Hash,
} from "../sdk/src/index";
import networks from "../web/src/lib/networks.json";

const SNS_DISC_UPDATE = 1;
const SNS_DISC_REALLOC = 4;
const HASH_PREFIX = "SPL Name Service";
const SNS_HEADER_SIZE = 96;
const STEALTH_PAYLOAD_SIZE = 65;
const FLAG_OFFSET_IN_PAYLOAD = 65;
const FLAG_OFFSET_IN_ACCOUNT = SNS_HEADER_SIZE + FLAG_OFFSET_IN_PAYLOAD;
const TARGET_ACCOUNT_SIZE = SNS_HEADER_SIZE + STEALTH_PAYLOAD_SIZE + 1;

type NetworkKey = keyof typeof networks;

interface Args {
  subdomain: string;
  network: NetworkKey;
  keypairPath: string;
  flagValue: number;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  let subdomain: string | undefined;
  let network: NetworkKey = "devnet";
  let keypairPath = path.join(process.env.HOME ?? "", ".config/solana/id.json");
  let flagValue: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--enable") flagValue = (flagValue ?? 0) | SnsComplianceFlags.AUDITOR_DISCLOSABLE;
    else if (a === "--disable") flagValue = 0;
    else if (a === "--raw") {
      const next = args[++i];
      const v = next.startsWith("0x") ? parseInt(next.slice(2), 16) : parseInt(next, 10);
      if (!Number.isInteger(v) || v < 0 || v > 0xff) {
        throw new Error(`--raw must be a u8 in [0..255]; got ${next}`);
      }
      flagValue = v;
    } else if (a === "--network" || a === "-n") {
      const n = args[++i];
      if (!(n in networks)) throw new Error(`unknown network "${n}"`);
      network = n as NetworkKey;
    } else if (a === "--keypair" || a === "-k") {
      keypairPath = args[++i];
    } else if (a === "-h" || a === "--help") {
      printUsage();
      process.exit(0);
    } else if (!subdomain) {
      subdomain = a;
    } else {
      throw new Error(`unexpected arg: ${a}`);
    }
  }
  if (!subdomain) {
    printUsage();
    throw new Error("subdomain is required (first positional arg)");
  }
  if (flagValue === undefined) {
    printUsage();
    throw new Error("one of --enable / --disable / --raw <N> is required");
  }
  return { subdomain, network, keypairPath, flagValue };
}

function printUsage(): void {
  console.error(
    [
      "Usage: bun run scripts/sns-set-compliance.ts <subdomain> --enable|--disable|--raw <N>",
      "",
      "Required:",
      "  <subdomain>          The subdomain name (e.g., \"alice\" for alice.btcpro.sol)",
      "  --enable             Set AUDITOR_DISCLOSABLE (bit 0)",
      "  --disable            Clear all flag bits",
      "  --raw <u8>           Write an arbitrary flag byte (decimal or 0x-hex)",
      "",
      "Optional:",
      "  --network <name>     Network from networks.json (default: devnet)",
      "  --keypair <path>     Owner keypair (default: ~/.config/solana/id.json)",
    ].join("\n"),
  );
}

function loadKeypair(p: string): Keypair {
  const expanded = p.startsWith("~/") ? path.join(process.env.HOME ?? "", p.slice(2)) : p;
  const raw = JSON.parse(fs.readFileSync(expanded, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function deriveSubdomainPDA(
  subdomain: string,
  parentKey: PublicKey,
  programId: PublicKey,
): Promise<PublicKey> {
  // Mirrors `deriveSubdomainKey` in sdk/src/sns-resolver.ts: the seed is
  // hash("SPL Name Service" + "\0" + name).
  const hashedSub = sha256Hash(new TextEncoder().encode(HASH_PREFIX + "\0" + subdomain));
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(hashedSub), Buffer.alloc(32), parentKey.toBuffer()],
    programId,
  );
  return pda;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const cfg = networks[args.network];
  if (!cfg) throw new Error(`network "${args.network}" not found`);

  const snsProgramId = (cfg as any).sns?.nameServiceProgramId
    ?? "namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX"; // SPL Name Service canonical ID
  const parentDomain = (cfg as any).sns?.parentDomain ?? "btcpro";

  // SDK config (needed by resolveSnsName + deriveParentDomainKey).
  initConfig({
    solanaRpcUrl: cfg.solana.rpcUrl,
    utxopiaProgramId: cfg.solana.utxopiaProgramId,
    zkbtcMint: cfg.tokens.zkbtcMint,
    snsNameServiceProgramId: snsProgramId,
    snsParentDomain: parentDomain,
    snsRootDomain: (cfg as any).sns?.rootDomain ?? "sol",
  } as any);

  const keypair = loadKeypair(args.keypairPath);
  console.log(`Signer: ${keypair.publicKey.toBase58()}`);
  console.log(`Network: ${args.network} (${cfg.solana.rpcUrl})`);
  console.log(`Subdomain: ${args.subdomain}.${parentDomain}.sol`);
  console.log(`Flag byte: 0x${args.flagValue.toString(16).padStart(2, "0")}`);

  const connection = new Connection(cfg.solana.rpcUrl, "confirmed");
  const programId = new PublicKey(snsProgramId);
  const parentKeyStr = await deriveParentDomainKey(parentDomain);
  const parentKey = new PublicKey(parentKeyStr);
  const subdomainKey = await deriveSubdomainPDA(args.subdomain, parentKey, programId);
  console.log(`Subdomain PDA: ${subdomainKey.toBase58()}`);

  // Sanity-check: the subdomain must exist and the signer must be its owner.
  const info = await connection.getAccountInfo(subdomainKey);
  if (!info) {
    throw new Error(`subdomain account not found — register ${args.subdomain}.${parentDomain}.sol first`);
  }
  const owner = new PublicKey(info.data.slice(32, 64));
  if (!owner.equals(keypair.publicKey)) {
    throw new Error(
      `signer ${keypair.publicKey.toBase58()} is not the SNS owner ` +
        `(${owner.toBase58()}). Pass --keypair pointing at the owner's key.`,
    );
  }
  console.log(`Current account size: ${info.data.length} bytes`);

  const ixs: TransactionInstruction[] = [];

  // Realloc if the account isn't big enough to hold the flag byte yet.
  if (info.data.length < TARGET_ACCOUNT_SIZE) {
    console.log(`Reallocating ${info.data.length} → ${TARGET_ACCOUNT_SIZE} bytes`);
    const reallocData = Buffer.alloc(5);
    reallocData[0] = SNS_DISC_REALLOC;
    reallocData.writeUInt32LE(TARGET_ACCOUNT_SIZE - SNS_HEADER_SIZE, 1); // u32: new payload size
    ixs.push(new TransactionInstruction({
      programId,
      keys: [
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: keypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: subdomainKey, isSigner: false, isWritable: true },
        { pubkey: keypair.publicKey, isSigner: true, isWritable: false },
      ],
      data: reallocData,
    }));
  }

  // Write the flag byte at offset 65 of the stealth payload.
  const updateData = Buffer.alloc(1 + 4 + 4 + 1);
  updateData[0] = SNS_DISC_UPDATE;
  updateData.writeUInt32LE(FLAG_OFFSET_IN_PAYLOAD, 1); // offset within the stealth payload
  updateData.writeUInt32LE(1, 5);                      // length
  updateData[9] = args.flagValue;
  ixs.push(new TransactionInstruction({
    programId,
    keys: [
      { pubkey: subdomainKey, isSigner: false, isWritable: true },
      { pubkey: keypair.publicKey, isSigner: true, isWritable: false },
    ],
    data: updateData,
  }));

  const tx = new Transaction().add(...ixs);
  console.log(`Submitting ${ixs.length}-instruction transaction…`);
  const sig = await sendAndConfirmTransaction(connection, tx, [keypair], {
    commitment: "confirmed",
  });
  console.log(`✓ tx: ${sig}`);
  console.log(
    `Verify via SDK: resolveSnsName(rpc, "${args.subdomain}") ` +
      `→ .complianceFlags === 0x${args.flagValue.toString(16).padStart(2, "0")}`,
  );
}

main().catch((e) => {
  console.error(`[sns-set-compliance] FAIL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
