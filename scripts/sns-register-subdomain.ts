#!/usr/bin/env bun
/**
 * Build and optionally submit a `.utxopia.sol` SNS subdomain registration.
 *
 * Default mode is a dry run: it derives accounts, builds the transaction, signs
 * with the provided owner/payer, and simulates without submitting. Use --submit
 * only with real stealth data from the user's vault.
 *
 * Usage:
 *   bun run scripts/sns-register-subdomain.ts test021 --dry-run
 *   bun run scripts/sns-register-subdomain.ts test021 --submit --stealth-data <65-byte-hex>
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  deriveParentDomainKey,
  getConfig,
  setConfig,
  sha256Hash,
} from "../sdk/src";
import {
  Numberu32,
  Numberu64,
  createInstruction,
  createReverseInstruction,
  transferInstruction,
} from "@bonfida/spl-name-service";

const HASH_PREFIX = "SPL Name Service";
const SNS_DISC_REALLOC = 4;
const SNS_DISC_UPDATE = 1;
const SNS_HEADER_SIZE = 96;
const STEALTH_DATA_SIZE = 65;
const STEALTH_DATA_VERSION = 2;
const WSOL_WRAP_AMOUNT = 10_000_000;
const BONFIDA_FEE_OWNER = new PublicKey("5D2zKog251d6KPCyFyLMt3KroWwXXPWSgTPyhV22K2gR");

type Args = {
  subdomain: string;
  submit: boolean;
  ownerPath: string;
  payerPath: string | null;
  rpcUrl: string | null;
  stealthData: string | null;
};

function usage(): never {
  console.error([
    "Usage:",
    "  bun run scripts/sns-register-subdomain.ts <subdomain> [--dry-run] [--submit]",
    "    [--owner-keypair ~/.config/solana/id.json]",
    "    [--payer-keypair ~/.config/solana/id.json]",
    "    [--rpc https://api.devnet.solana.com]",
    "    [--stealth-data <65-byte-hex>]",
  ].join("\n"));
  process.exit(1);
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let subdomain: string | undefined;
  let submit = false;
  let ownerPath = "~/.config/solana/id.json";
  let payerPath: string | null = null;
  let rpcUrl: string | null = null;
  let stealthData: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      submit = false;
    } else if (arg === "--submit") {
      submit = true;
    } else if (arg === "--owner-keypair") {
      ownerPath = argv[++i] ?? usage();
    } else if (arg === "--payer-keypair") {
      payerPath = argv[++i] ?? usage();
    } else if (arg === "--rpc") {
      rpcUrl = argv[++i] ?? usage();
    } else if (arg === "--stealth-data") {
      stealthData = argv[++i] ?? usage();
    } else if (arg.startsWith("--")) {
      usage();
    } else if (!subdomain) {
      subdomain = arg;
    } else {
      usage();
    }
  }

  if (!subdomain) usage();
  return { subdomain, submit, ownerPath, payerPath, rpcUrl, stealthData };
}

function expandPath(path: string): string {
  return path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
}

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(expandPath(path), "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function parseSubdomain(input: string): string {
  const clean = input
    .trim()
    .toLowerCase()
    .replace(/\.sol$/, "")
    .replace(/\.utxopia$/, "");
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(clean)) {
    throw new Error(`invalid subdomain: ${input}`);
  }
  return clean;
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== STEALTH_DATA_SIZE * 2) {
    throw new Error(`--stealth-data must be ${STEALTH_DATA_SIZE} bytes of hex`);
  }
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function dryRunStealthData(): Uint8Array {
  const bytes = new Uint8Array(STEALTH_DATA_SIZE);
  bytes[0] = STEALTH_DATA_VERSION;
  crypto.getRandomValues(bytes.subarray(1));
  return bytes;
}

async function main() {
  const args = parseArgs();
  const subdomain = parseSubdomain(args.subdomain);
  setConfig("devnet");
  const config = getConfig();
  const rpcUrl = args.rpcUrl || process.env.NEXT_PUBLIC_SOLANA_RPC_URL || config.solanaRpcUrl;
  const connection = new Connection(rpcUrl, "confirmed");
  const owner = loadKeypair(args.ownerPath);
  const payer = args.payerPath ? loadKeypair(args.payerPath) : owner;
  const stealthData = args.stealthData ? hexToBytes(args.stealthData) : dryRunStealthData();

  if (args.submit && !args.stealthData) {
    throw new Error("--submit requires real --stealth-data; refusing to register random test data");
  }

  const nameServiceProgramId = new PublicKey(config.snsNameServiceProgramId);
  const subRegistrarProgramId = new PublicKey(config.snsSubRegistrarProgramId);
  const snsRegistrarProgramId = new PublicKey(config.snsRegistrarProgramId);
  const rootDomain = new PublicKey(config.snsRootDomain);
  const reverseLookupClass = new PublicKey(config.snsReverseLookupClass);
  const parentKey = await deriveParentDomainKey(config.snsParentDomain);
  const parentPubkey = new PublicKey(parentKey);
  const parentInfo = await connection.getAccountInfo(parentPubkey);
  if (!parentInfo) {
    throw new Error(
      `${config.snsParentDomain}.sol parent domain account not found at ${parentPubkey.toBase58()} on ${rpcUrl}`,
    );
  }

  const hashedSub = sha256Hash(new TextEncoder().encode(HASH_PREFIX + "\0" + subdomain));
  const [subdomainKey] = PublicKey.findProgramAddressSync(
    [hashedSub, new Uint8Array(32), parentPubkey.toBytes()],
    nameServiceProgramId,
  );
  if (await connection.getAccountInfo(subdomainKey)) {
    throw new Error(`${subdomain}.${config.snsParentDomain}.sol is already registered`);
  }
  const reverseHash = sha256Hash(new TextEncoder().encode(HASH_PREFIX + subdomainKey.toBase58()));
  const [reverseKey] = PublicKey.findProgramAddressSync(
    [reverseHash, reverseLookupClass.toBytes(), parentPubkey.toBytes()],
    nameServiceProgramId,
  );
  const [registrar] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("registrar"), parentPubkey.toBytes()],
    subRegistrarProgramId,
  );
  const [subRecord] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("subrecord"), subdomainKey.toBytes()],
    subRegistrarProgramId,
  );

  const registrarAcct = await connection.getAccountInfo(registrar);
  let mode = "sub-registrar";
  let ixs: TransactionInstruction[];

  if (!registrarAcct) {
    if (!parentInfo.data.slice(32, 64).equals(payer.publicKey.toBuffer())) {
      throw new Error("sub-registrar is not initialized and payer does not own utxopia.sol");
    }
    mode = "parent-owner-direct";
    const rent = await connection.getMinimumBalanceForRentExemption(
      SNS_HEADER_SIZE + STEALTH_DATA_SIZE,
    );
    ixs = [
      createInstruction(
        nameServiceProgramId,
        SystemProgram.programId,
        subdomainKey,
        payer.publicKey,
        payer.publicKey,
        Buffer.from(hashedSub),
        new Numberu64(rent),
        new Numberu32(STEALTH_DATA_SIZE),
        undefined,
        parentPubkey,
        payer.publicKey,
      ),
      new createReverseInstruction({ name: "\0" + subdomain }).getInstruction(
        snsRegistrarProgramId,
        nameServiceProgramId,
        rootDomain,
        reverseKey,
        SystemProgram.programId,
        reverseLookupClass,
        payer.publicKey,
        SYSVAR_RENT_PUBKEY,
        parentPubkey,
        payer.publicKey,
      ),
      transferInstruction(
        nameServiceProgramId,
        subdomainKey,
        owner.publicKey,
        payer.publicKey,
        undefined,
        parentPubkey,
        payer.publicKey,
      ),
    ];
  } else {
    const feeAccount = new PublicKey(registrarAcct.data.slice(34, 66));
    const mint = new PublicKey(registrarAcct.data.slice(66, 98));
    const feeSource = getAssociatedTokenAddressSync(mint, owner.publicKey, true);
    const bonfidaFee = getAssociatedTokenAddressSync(mint, BONFIDA_FEE_OWNER, true);

    ixs = [
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, feeSource, owner.publicKey, NATIVE_MINT),
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: feeSource, lamports: WSOL_WRAP_AMOUNT }),
      createSyncNativeInstruction(feeSource),
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, bonfidaFee, BONFIDA_FEE_OWNER, mint),
    ];

    const domainBytes = new TextEncoder().encode("\0" + subdomain);
    const registerData = new Uint8Array(1 + 4 + domainBytes.length);
    registerData[0] = 2;
    new DataView(registerData.buffer).setUint32(1, domainBytes.length, true);
    registerData.set(domainBytes, 5);
    ixs.push(new TransactionInstruction({
      programId: subRegistrarProgramId,
      keys: [
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: nameServiceProgramId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: snsRegistrarProgramId, isSigner: false, isWritable: false },
        { pubkey: rootDomain, isSigner: false, isWritable: false },
        { pubkey: reverseLookupClass, isSigner: false, isWritable: false },
        { pubkey: feeAccount, isSigner: false, isWritable: true },
        { pubkey: feeSource, isSigner: false, isWritable: true },
        { pubkey: registrar, isSigner: false, isWritable: true },
        { pubkey: parentPubkey, isSigner: false, isWritable: true },
        { pubkey: subdomainKey, isSigner: false, isWritable: true },
        { pubkey: reverseKey, isSigner: false, isWritable: true },
        { pubkey: owner.publicKey, isSigner: true, isWritable: true },
        { pubkey: bonfidaFee, isSigner: false, isWritable: true },
        { pubkey: subRecord, isSigner: false, isWritable: true },
      ],
      data: Buffer.from(registerData),
    }));
    ixs.push(createCloseAccountInstruction(feeSource, payer.publicKey, owner.publicKey));

    const reallocData = new Uint8Array(5);
    reallocData[0] = SNS_DISC_REALLOC;
    new DataView(reallocData.buffer).setUint32(1, STEALTH_DATA_SIZE, true);
    ixs.push(new TransactionInstruction({
      programId: nameServiceProgramId,
      keys: [
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: subdomainKey, isSigner: false, isWritable: true },
        { pubkey: owner.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from(reallocData),
    }));
  }

  const updateData = new Uint8Array(1 + 4 + 4 + stealthData.length);
  updateData[0] = SNS_DISC_UPDATE;
  new DataView(updateData.buffer).setUint32(1, 0, true);
  new DataView(updateData.buffer).setUint32(5, stealthData.length, true);
  updateData.set(stealthData, 9);
  ixs.push(new TransactionInstruction({
    programId: nameServiceProgramId,
    keys: [
      { pubkey: subdomainKey, isSigner: false, isWritable: true },
      { pubkey: owner.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(updateData),
  }));

  const tx = new Transaction().add(...ixs);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const signers = payer.publicKey.equals(owner.publicKey) ? [payer] : [payer, owner];
  tx.sign(...signers);

  console.log(JSON.stringify({
    mode: args.submit ? `submit:${mode}` : `dry-run:${mode}`,
    name: `${subdomain}.${config.snsParentDomain}.sol`,
    rpcUrl,
    owner: owner.publicKey.toBase58(),
    payer: payer.publicKey.toBase58(),
    subdomainPda: subdomainKey.toBase58(),
    stealthDataIsDummy: !args.stealthData,
  }, null, 2));

  if (!args.submit) {
    const sim = await connection.simulateTransaction(tx);
    console.log(JSON.stringify({
      simulationErr: sim.value.err,
      logs: sim.value.logs?.slice(-12) ?? [],
    }, null, 2));
    return;
  }

  const sig = await sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
  console.log(`Registered: ${sig}`);
}

main().catch((err) => {
  console.error(`[sns-register-subdomain] FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
