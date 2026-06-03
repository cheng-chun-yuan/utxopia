"use client";

import { ALLOWED_METADATA, SuinsClient } from "@mysten/suins";
import { bytesToHex, hexToBytes, type StealthMetaAddress } from "@utxopia/sdk";
import { networkForChain } from "@/lib/chain-registry";
import { detectNetwork, type NetworkId } from "@/lib/network-config";
import { getSuiClient } from "@/lib/sui/client";

const UTXOPIA_CONTENT_HASH_PREFIX = "utxopia:v1";
export const UTXOPIA_SUINS_PARENT = "utxopia.sui";
const UTXOPIA_SUINS_LABEL_RE = /^[a-z0-9]{1,63}$/;

export interface SuiNsUtxopiaRecord {
  name: string;
  normalizedName: string;
  nftId: string | null;
  targetAddress: string | null;
  contentHash: string | null;
  metadata: {
    viewingPubKey: Uint8Array;
    mpk: Uint8Array;
    network?: string;
  } | null;
}

export function normalizeSuiNsName(input: string): string {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return "";
  if (trimmed.startsWith("@") && UTXOPIA_SUINS_LABEL_RE.test(trimmed.slice(1))) {
    return `${trimmed.slice(1)}.${UTXOPIA_SUINS_PARENT}`;
  }
  if (UTXOPIA_SUINS_LABEL_RE.test(trimmed)) return `${trimmed}.${UTXOPIA_SUINS_PARENT}`;
  if (trimmed.endsWith(".utxopia")) return `${trimmed}.sui`;
  if (trimmed.endsWith(".sui")) return trimmed;
  return `${trimmed}.sui`;
}

export function isUtxopiaSuiNsName(input: string): boolean {
  return /^[a-z0-9]{1,63}\.utxopia\.sui$/.test(normalizeSuiNsName(input));
}

export function suinsNetworkFromAppNetwork(network: NetworkId = networkForChain(detectNetwork(), "sui")) {
  return network === "mainnet" ? "mainnet" : "testnet";
}

export function encodeUtxopiaSuiNsContentHash(
  meta: Pick<StealthMetaAddress, "viewingPubKey" | "mpk">,
  network: NetworkId,
): string {
  return [
    UTXOPIA_CONTENT_HASH_PREFIX,
    network,
    bytesToHex(meta.viewingPubKey),
    bytesToHex(meta.mpk),
  ].join(":");
}

export function parseUtxopiaSuiNsContentHash(value: string | null | undefined) {
  if (!value) return null;
  const parts = value.split(":");
  if (parts.length !== 5 || `${parts[0]}:${parts[1]}` !== UTXOPIA_CONTENT_HASH_PREFIX) {
    return null;
  }

  const [, , network, viewingHex, mpkHex] = parts;
  if (!/^[0-9a-f]{64}$/i.test(viewingHex) || !/^[0-9a-f]{64}$/i.test(mpkHex)) {
    return null;
  }

  return {
    network,
    viewingPubKey: hexToBytes(viewingHex),
    mpk: hexToBytes(mpkHex),
  };
}

function isMissingSuiNsRecordError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("does not exist") || message.includes("not found");
}

export async function resolveSuiNsUtxopiaRecord(
  input: string,
  network?: NetworkId,
): Promise<SuiNsUtxopiaRecord | null> {
  const normalizedName = normalizeSuiNsName(input);
  if (!normalizedName) return null;
  if (!isUtxopiaSuiNsName(normalizedName)) {
    throw new Error("Use a UTXOpia SuiNS name like alice.utxopia.sui");
  }

  const client = new SuinsClient({
    client: getSuiClient(),
    network: suinsNetworkFromAppNetwork(network),
  });
  const record = await client.getNameRecord(normalizedName).catch((error) => {
    if (isMissingSuiNsRecordError(error)) return null;
    throw error;
  });
  if (!record) return null;

  const contentHash = record.contentHash ?? record.data?.[ALLOWED_METADATA.contentHash] ?? null;
  return {
    name: input,
    normalizedName,
    nftId: record.nftId ?? null,
    targetAddress: record.targetAddress || null,
    contentHash,
    metadata: parseUtxopiaSuiNsContentHash(contentHash),
  };
}
