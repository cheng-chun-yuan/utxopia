import { NextRequest, NextResponse } from "next/server";
import {
  Connection,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { deriveParentDomainKey, getConfig, sha256Hash } from "@utxopia/sdk";
import { getHeliusRpcUrl } from "@/lib/helius-server";
import { getRelayerKeypair } from "@/lib/server/relayer";
import { checkRateLimit, getClientIp } from "@/lib/server/rate-limit";

export const dynamic = "force-dynamic";

const HASH_PREFIX = "SPL Name Service";
const SNS_DISC_REALLOC = 4;
const SNS_DISC_UPDATE = 1;
const STEALTH_DATA_SIZE = 65;
const BONFIDA_FEE_OWNER = new PublicKey("5D2zKog251d6KPCyFyLMt3KroWwXXPWSgTPyhV22K2gR");
const WSOL_WRAP_AMOUNT = 10_000_000;

type PrepareRequest = {
  action: "prepare";
  name: string;
  owner: string;
  stealthData: string;
};

type SubmitRequest = {
  action: "submit";
  signedTransaction: string;
};

function jsonError(message: string, status: number) {
  return NextResponse.json({ success: false, error: message }, { status });
}

function parseHexBytes(value: string, expectedLength: number, field: string): Uint8Array {
  if (!/^[0-9a-fA-F]+$/.test(value) || value.length !== expectedLength * 2) {
    throw new Error(`${field} must be ${expectedLength} bytes of hex`);
  }
  return Uint8Array.from(Buffer.from(value, "hex"));
}

function normalizeSubdomain(name: string) {
  const subdomain = name.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(subdomain)) {
    throw new Error("Invalid subdomain name");
  }
  if (subdomain.includes(".")) {
    throw new Error("Subdomain must not include dots");
  }
  return subdomain;
}

async function buildSponsoredRegistrationTx(input: PrepareRequest) {
  const relayer = getRelayerKeypair();
  if (!relayer) {
    return { relayerUnavailable: true as const };
  }

  const owner = new PublicKey(input.owner);
  const subdomain = normalizeSubdomain(input.name);
  const stealthData = parseHexBytes(input.stealthData, STEALTH_DATA_SIZE, "stealthData");
  if (stealthData[0] !== 2) {
    throw new Error("Unsupported stealth data version");
  }

  const config = getConfig();
  if (
    !config.snsSubRegistrarProgramId ||
    !config.snsNameServiceProgramId ||
    !config.snsRegistrarProgramId ||
    !config.snsRootDomain ||
    !config.snsReverseLookupClass ||
    !config.snsParentDomain
  ) {
    throw new Error("SNS not configured for this network");
  }

  const connection = new Connection(getHeliusRpcUrl(), "confirmed");
  const nameServiceProgramId = new PublicKey(config.snsNameServiceProgramId);
  const subRegistrarProgramId = new PublicKey(config.snsSubRegistrarProgramId);
  const snsRegistrarProgramId = new PublicKey(config.snsRegistrarProgramId);
  const rootDomain = new PublicKey(config.snsRootDomain);
  const reverseLookupClass = new PublicKey(config.snsReverseLookupClass);
  const parentKey = await deriveParentDomainKey(config.snsParentDomain);
  const parentPubkey = new PublicKey(parentKey);

  const hashedSub = sha256Hash(new TextEncoder().encode(HASH_PREFIX + "\0" + subdomain));
  const [subdomainKey] = PublicKey.findProgramAddressSync(
    [hashedSub, new Uint8Array(32), parentPubkey.toBytes()],
    nameServiceProgramId,
  );
  if (await connection.getAccountInfo(subdomainKey)) {
    throw new Error(`"${subdomain}.${config.snsParentDomain}.sol" is already registered`);
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
  if (!registrarAcct) {
    throw new Error("Sub-registrar not initialized for this domain");
  }
  const feeAccount = new PublicKey(registrarAcct.data.slice(34, 66));
  const mint = new PublicKey(registrarAcct.data.slice(66, 98));
  const feeSource = getAssociatedTokenAddressSync(mint, owner, true);
  const bonfidaFee = getAssociatedTokenAddressSync(mint, BONFIDA_FEE_OWNER, true);

  const ixs: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(
      relayer.publicKey,
      feeSource,
      owner,
      NATIVE_MINT,
    ),
    SystemProgram.transfer({
      fromPubkey: relayer.publicKey,
      toPubkey: feeSource,
      lamports: WSOL_WRAP_AMOUNT,
    }),
    createSyncNativeInstruction(feeSource),
    createAssociatedTokenAccountIdempotentInstruction(
      relayer.publicKey,
      bonfidaFee,
      BONFIDA_FEE_OWNER,
      mint,
    ),
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
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: bonfidaFee, isSigner: false, isWritable: true },
      { pubkey: subRecord, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(registerData),
  }));

  ixs.push(createCloseAccountInstruction(feeSource, relayer.publicKey, owner));

  const reallocData = new Uint8Array(5);
  reallocData[0] = SNS_DISC_REALLOC;
  new DataView(reallocData.buffer).setUint32(1, STEALTH_DATA_SIZE, true);
  ixs.push(new TransactionInstruction({
    programId: nameServiceProgramId,
    keys: [
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
      { pubkey: subdomainKey, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(reallocData),
  }));

  const updateData = new Uint8Array(1 + 4 + 4 + stealthData.length);
  updateData[0] = SNS_DISC_UPDATE;
  new DataView(updateData.buffer).setUint32(1, 0, true);
  new DataView(updateData.buffer).setUint32(5, stealthData.length, true);
  updateData.set(stealthData, 9);
  ixs.push(new TransactionInstruction({
    programId: nameServiceProgramId,
    keys: [
      { pubkey: subdomainKey, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(updateData),
  }));

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = new Transaction({ feePayer: relayer.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
  tx.partialSign(relayer);

  return {
    transaction: tx.serialize({ requireAllSignatures: false }).toString("base64"),
    relayer: relayer.publicKey.toBase58(),
    lastValidBlockHeight,
  };
}

export async function POST(request: NextRequest) {
  const ip = getClientIp(request.headers);
  const rl = checkRateLimit(ip, "sns-register", { maxTokens: 5, windowMs: 60_000 });
  if (rl.limited) {
    return jsonError("Too many SNS registration requests", 429);
  }

  try {
    const body = await request.json() as PrepareRequest | SubmitRequest;
    if (body.action === "prepare") {
      const result = await buildSponsoredRegistrationTx(body);
      if ("relayerUnavailable" in result) {
        return NextResponse.json({ success: false, relayerUnavailable: true }, { status: 503 });
      }
      return NextResponse.json({ success: true, ...result });
    }

    if (body.action === "submit") {
      const raw = Buffer.from(body.signedTransaction, "base64");
      if (raw.length > 32_000) return jsonError("Transaction too large", 400);
      const connection = new Connection(getHeliusRpcUrl(), "confirmed");
      const signature = await connection.sendRawTransaction(raw, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });
      return NextResponse.json({ success: true, signature });
    }

    return jsonError("Invalid action", 400);
  } catch (err) {
    const message = err instanceof Error ? err.message : "SNS registration failed";
    return jsonError(message, 400);
  }
}
