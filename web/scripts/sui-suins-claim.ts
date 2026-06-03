import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ALLOWED_METADATA, SuinsClient, SuinsTransaction } from "@mysten/suins";
import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";

const UTXOPIA_CONTENT_HASH_PREFIX = "utxopia:v1";
const UTXOPIA_SUINS_PARENT = "utxopia.sui";
const LABEL_RE = /^[a-z0-9]{1,63}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_32_RE = /^[0-9a-fA-F]{64}$/;
const DEFAULT_GAS_BUDGET = 100_000_000n;
const DEFAULT_SUBNAME_DAYS = 365;
const CHILD_EXPIRY_BUFFER_MS = 60_000;

type ClaimInput = {
  handle?: string;
  name?: string;
  suiAddress: string;
  network?: string;
  viewingPubKey: string;
  mpk: string;
};

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
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

function suinsNetworkFromAppNetwork(network: string | undefined) {
  return network === "mainnet" ? "mainnet" : "testnet";
}

function encodeContentHash(input: ClaimInput) {
  return [
    UTXOPIA_CONTENT_HASH_PREFIX,
    input.network ?? "sui-testnet",
    input.viewingPubKey.toLowerCase(),
    input.mpk.toLowerCase(),
  ].join(":");
}

function loadSponsorKeypair() {
  const activeAddress = process.env.UTXOPIA_SUI_RELAYER_ADDRESS ?? process.env.UTXOPIA_SUI_SIGNER_ADDRESS;
  const keystorePath =
    process.env.UTXOPIA_SUI_RELAYER_KEYPAIR_PATH ??
    process.env.UTXOPIA_SUI_KEYPAIR_PATH ??
    path.join(os.homedir(), ".sui/sui_config/sui.keystore");

  if (!existsSync(keystorePath)) {
    throw new Error(`Sui sponsor keystore not found at ${keystorePath}`);
  }

  const keys = JSON.parse(readFileSync(keystorePath, "utf8")) as string[];
  for (const encoded of keys) {
    const decoded = Uint8Array.from(Buffer.from(encoded, "base64"));
    if (decoded[0] !== 0) continue;
    const keypair = Ed25519Keypair.fromSecretKey(decoded.slice(1));
    if (!activeAddress || keypair.toSuiAddress() === activeAddress) return keypair;
  }

  throw new Error(`No Ed25519 sponsor key found in ${keystorePath}`);
}

function isMissingSuiNsRecordError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("does not exist") || message.includes("not found");
}

async function executeSponsorTransaction(client: SuiClient, signer: Ed25519Keypair, tx: Transaction) {
  tx.setSender(signer.toSuiAddress());
  tx.setGasBudget(BigInt(process.env.UTXOPIA_SUINS_GAS_BUDGET ?? DEFAULT_GAS_BUDGET.toString()));
  const result = await client.signAndExecuteTransaction({
    signer,
    transaction: tx,
    options: { showEffects: true, showObjectChanges: true },
  });
  await client.waitForTransaction({ digest: result.digest, options: { showEffects: true } });
  const status = result.effects?.status;
  if (status?.status === "failure") {
    throw new Error(status.error || "SuiNS claim transaction failed");
  }
  return result.digest;
}

async function main() {
  const input = JSON.parse(await readStdin()) as ClaimInput;
  const normalizedName = normalizeName(input.handle ?? input.name ?? "");
  if (!ADDRESS_RE.test(input.suiAddress)) throw new Error("Invalid Sui address.");
  if (!HEX_32_RE.test(input.viewingPubKey)) throw new Error("viewingPubKey must be 32 bytes of hex.");
  if (!HEX_32_RE.test(input.mpk)) throw new Error("mpk must be 32 bytes of hex.");

  const parentNftId = process.env.UTXOPIA_SUINS_PARENT_NFT_ID || process.env.NEXT_PUBLIC_UTXOPIA_SUINS_PARENT_NFT_ID;
  if (!parentNftId) throw new Error("UTXOPIA_SUINS_PARENT_NFT_ID is required for sponsored SuiNS claims.");

  const rpcUrl =
    process.env.UTXOPIA_SUI_RPC_URL ||
    process.env.NEXT_PUBLIC_SUI_RPC_URL ||
    "https://fullnode.testnet.sui.io:443";
  const client = new SuiClient({ url: rpcUrl });
  const suinsClient = new SuinsClient({ client, network: suinsNetworkFromAppNetwork(input.network) });
  const existing = await suinsClient.getNameRecord(normalizedName).catch((error) => {
    if (isMissingSuiNsRecordError(error)) return null;
    throw error;
  });
  if (existing) throw new Error(`${normalizedName} is already claimed.`);
  const parentRecord = await suinsClient.getNameRecord(UTXOPIA_SUINS_PARENT);
  if (!parentRecord?.expirationTimestampMs) {
    throw new Error(`${UTXOPIA_SUINS_PARENT} parent expiration was not discoverable.`);
  }
  const desiredExpirationMs = Date.now() + DEFAULT_SUBNAME_DAYS * 24 * 60 * 60 * 1000;
  const expirationTimestampMs = Math.min(
    desiredExpirationMs,
    parentRecord.expirationTimestampMs - CHILD_EXPIRY_BUFFER_MS,
  );
  if (expirationTimestampMs <= Date.now()) {
    throw new Error(`${UTXOPIA_SUINS_PARENT} is expired or too close to expiry.`);
  }

  const signer = loadSponsorKeypair();
  const tx = new Transaction();
  const suinsTx = new SuinsTransaction(suinsClient, tx);
  const subNft = suinsTx.createSubName({
    parentNft: parentNftId,
    name: normalizedName,
    expirationTimestampMs,
    allowChildCreation: false,
    allowTimeExtension: false,
  });
  suinsTx.setTargetAddress({ nft: subNft, address: input.suiAddress, isSubname: true });
  suinsTx.setUserData({
    nft: subNft,
    key: ALLOWED_METADATA.contentHash,
    value: encodeContentHash(input),
    isSubname: true,
  });
  tx.transferObjects([subNft], signer.toSuiAddress());

  const createDigest = await executeSponsorTransaction(client, signer, tx);
  const record = await suinsClient.getNameRecord(normalizedName);
  console.log(JSON.stringify({
    success: true,
    normalizedName,
    nftId: record?.nftId ?? null,
    createDigest,
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
