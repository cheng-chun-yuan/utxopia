#!/usr/bin/env bun
/**
 * Set / clear the compliance flag byte on a `.utxopia.sol` SNS subdomain.
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
 *     → sets bit 0 (AUDITOR_DISCLOSABLE) on `alice.utxopia.sol`
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
const AUDITOR_OFFSET_IN_PAYLOAD = 66;
const AUDITOR_BYTES = 32;
const FLAG_OFFSET_IN_ACCOUNT = SNS_HEADER_SIZE + FLAG_OFFSET_IN_PAYLOAD;
/** Payload size when both flag + auditor pubkey are present. */
const TARGET_PAYLOAD_SIZE_WITH_AUDITOR = STEALTH_PAYLOAD_SIZE + 1 + AUDITOR_BYTES;
/** Payload size when only the flag byte is present. */
const TARGET_PAYLOAD_SIZE_FLAG_ONLY = STEALTH_PAYLOAD_SIZE + 1;

type NetworkKey = keyof typeof networks;

interface Args {
  subdomain: string;
  network: NetworkKey;
  keypairPath: string;
  flagValue: number;
  /** When set, write a 32-byte auditor pubkey at offset 66 of the payload. */
  auditorPubkey?: PublicKey;
  /** When true, clear the auditor pubkey (write 32 zero bytes). */
  clearAuditor: boolean;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  let subdomain: string | undefined;
  let network: NetworkKey = "devnet";
  let keypairPath = path.join(process.env.HOME ?? "", ".config/solana/id.json");
  let flagValue: number | undefined;
  let auditorPubkey: PublicKey | undefined;
  let clearAuditor = false;

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
    } else if (a === "--auditor") {
      const next = args[++i];
      try {
        auditorPubkey = new PublicKey(next);
      } catch {
        throw new Error(`--auditor must be a base58 Solana pubkey; got "${next}"`);
      }
    } else if (a === "--clear-auditor") {
      clearAuditor = true;
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
  if (flagValue === undefined && auditorPubkey === undefined && !clearAuditor) {
    printUsage();
    throw new Error(
      "one of --enable / --disable / --raw <N> / --auditor <pubkey> / --clear-auditor is required",
    );
  }
  return { subdomain, network, keypairPath, flagValue: flagValue ?? -1, auditorPubkey, clearAuditor };
}

function printUsage(): void {
  console.error(
    [
      "Usage: bun run scripts/sns-set-compliance.ts <subdomain> [flag op] [auditor op]",
      "",
      "Required:",
      "  <subdomain>            The subdomain name (e.g., \"alice\" for alice.utxopia.sol)",
      "  At least one of:",
      "    --enable             Set AUDITOR_DISCLOSABLE (bit 0)",
      "    --disable            Clear all flag bits",
      "    --raw <u8>           Write an arbitrary flag byte (decimal or 0x-hex)",
      "    --auditor <base58>   Write a 32-byte auditor pubkey at offset 66",
      "    --clear-auditor      Zero out the auditor pubkey",
      "",
      "Optional:",
      "  --network <name>       Network from networks.json (default: devnet)",
      "  --keypair <path>       Owner keypair (default: ~/.config/solana/id.json)",
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
  const parentDomain = (cfg as any).sns?.parentDomain ?? "utxopia";

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
  if (args.flagValue >= 0) {
    console.log(`Flag byte: 0x${args.flagValue.toString(16).padStart(2, "0")}`);
  }
  if (args.auditorPubkey) {
    console.log(`Auditor: ${args.auditorPubkey.toBase58()}`);
  } else if (args.clearAuditor) {
    console.log(`Auditor: <cleared>`);
  }

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

  // Target size depends on whether we're writing the auditor pubkey too.
  const needsAuditorSlot = args.auditorPubkey != null || args.clearAuditor;
  const targetPayloadSize = needsAuditorSlot
    ? TARGET_PAYLOAD_SIZE_WITH_AUDITOR
    : TARGET_PAYLOAD_SIZE_FLAG_ONLY;
  const targetAccountSize = SNS_HEADER_SIZE + targetPayloadSize;

  if (info.data.length < targetAccountSize) {
    console.log(`Reallocating ${info.data.length} → ${targetAccountSize} bytes`);
    const reallocData = Buffer.alloc(5);
    reallocData[0] = SNS_DISC_REALLOC;
    reallocData.writeUInt32LE(targetPayloadSize, 1); // u32: new payload size
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

  // Write the flag byte at offset 65 if the caller asked to.
  if (args.flagValue >= 0) {
    const updateData = Buffer.alloc(1 + 4 + 4 + 1);
    updateData[0] = SNS_DISC_UPDATE;
    updateData.writeUInt32LE(FLAG_OFFSET_IN_PAYLOAD, 1);
    updateData.writeUInt32LE(1, 5);
    updateData[9] = args.flagValue;
    ixs.push(new TransactionInstruction({
      programId,
      keys: [
        { pubkey: subdomainKey, isSigner: false, isWritable: true },
        { pubkey: keypair.publicKey, isSigner: true, isWritable: false },
      ],
      data: updateData,
    }));
  }

  // Write the auditor pubkey at offset 66 if the caller provided one.
  // `--clear-auditor` writes 32 zero bytes (the parser treats all-zero as
  // "not set"). When neither was requested, leave whatever's there alone.
  if (args.auditorPubkey || args.clearAuditor) {
    const payload = args.auditorPubkey ? args.auditorPubkey.toBuffer() : Buffer.alloc(AUDITOR_BYTES);
    const updateData = Buffer.alloc(1 + 4 + 4 + AUDITOR_BYTES);
    updateData[0] = SNS_DISC_UPDATE;
    updateData.writeUInt32LE(AUDITOR_OFFSET_IN_PAYLOAD, 1);
    updateData.writeUInt32LE(AUDITOR_BYTES, 5);
    payload.copy(updateData, 9);
    ixs.push(new TransactionInstruction({
      programId,
      keys: [
        { pubkey: subdomainKey, isSigner: false, isWritable: true },
        { pubkey: keypair.publicKey, isSigner: true, isWritable: false },
      ],
      data: updateData,
    }));
  }

  if (ixs.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const tx = new Transaction().add(...ixs);
  console.log(`Submitting ${ixs.length}-instruction transaction…`);
  const sig = await sendAndConfirmTransaction(connection, tx, [keypair], {
    commitment: "confirmed",
  });
  console.log(`✓ tx: ${sig}`);
  console.log(
    `Verify via SDK: resolveSnsName(rpc, "${args.subdomain}")` +
      (args.flagValue >= 0
        ? ` → .complianceFlags === 0x${args.flagValue.toString(16).padStart(2, "0")}`
        : "") +
      (args.auditorPubkey
        ? ` → .auditorPubkey === ${args.auditorPubkey.toBase58()}`
        : ""),
  );
}

main().catch((e) => {
  console.error(`[sns-set-compliance] FAIL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
