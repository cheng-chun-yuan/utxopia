"use client";

import {
  EventClient,
  UTXOpiaClient,
  type OnChainStealthAnnouncement,
} from "@utxopia/sdk";
import { getChainAdapter } from "@/lib/chain-registry";
import { getBackendUrl, getSolanaRpcUrl } from "@/lib/api/constants";
import { getChainEnvironment, type ChainEnvironment } from "@/lib/chain-environment";
import type { NetworkConfig } from "@/lib/network-config";
import { VAULT_TOKENS } from "@/lib/supported-tokens";

export interface InboxSource {
  announcements: OnChainStealthAnnouncement[];
  spentNullifiers?: Set<string>;
}

export interface TokenScanTarget {
  symbol: string;
  tokenId: bigint;
}

const SUI_ZKBTC_TOKEN_ID = 0x7a627463n;

let eventClient: EventClient | null = null;
let eventClientNetwork: string | null = null;

export function getEventClient(): EventClient {
  const env = getChainEnvironment();
  if (eventClient && eventClientNetwork !== env.networkId) {
    eventClient.close();
    eventClient = null;
  }
  if (!eventClient) {
    const backendUrl = "";
    const wsBackendUrl = getBackendUrl(env.networkId);
    const wsUrl = wsBackendUrl.replace("http://", "ws://").replace("https://", "wss://");
    eventClient = new EventClient({
      backendUrl,
      backendWsUrl: wsUrl,
      solanaRpcUrl: getSolanaRpcUrl(),
      programId: UTXOpiaClient.instance().config.utxopiaProgramId,
      commitmentTreeAddress: UTXOpiaClient.instance().config.commitmentTreePda,
    });
    eventClientNetwork = env.networkId;
  }
  return eventClient;
}

export function resetEventClient(): void {
  eventClient = null;
  eventClientNetwork = null;
}

export async function fetchInboxSource(env: ChainEnvironment): Promise<InboxSource> {
  const chain = getChainAdapter(env.config);
  if (chain.id === "sui") {
    return fetchSuiInboxEvents(env.config);
  }
  return { announcements: await getEventClient().fetchAll() };
}

export function getTokenScanTargets(
  env: ChainEnvironment,
  announcements: OnChainStealthAnnouncement[],
): TokenScanTarget[] {
  const chain = getChainAdapter(env.config);
  const utxopiaClient = UTXOpiaClient.instance();
  const config = utxopiaClient.config;
  const tokensToScan: TokenScanTarget[] = [];
  const seenTokenIds = new Set<string>();
  const pushTokenToScan = (symbol: string, tokenId: bigint) => {
    const key = tokenId.toString(16).padStart(64, "0");
    if (seenTokenIds.has(key)) return;
    seenTokenIds.add(key);
    tokensToScan.push({ symbol, tokenId });
  };

  if (chain.id === "sui") {
    pushTokenToScan("zkBTC", SUI_ZKBTC_TOKEN_ID);
    return tokensToScan;
  }

  for (const token of VAULT_TOKENS) {
    try {
      let mintAddr = token.mint;
      if (!mintAddr && token.symbol === "zkBTC") mintAddr = config.zkbtcMint;
      if (!mintAddr) continue;
      pushTokenToScan(token.shieldedSymbol, utxopiaClient.getTokenId(mintAddr));
    } catch (err) {
      console.error("[ChainInbox] invalid mint for token:", token.symbol, err);
    }
  }

  for (const ann of announcements) {
    if (!ann.tokenIdHex) continue;
    try {
      const tokenId = BigInt(`0x${ann.tokenIdHex}`);
      pushTokenToScan("zkBTC", tokenId);
    } catch {
      // Ignore malformed backend token ids.
    }
  }

  return tokensToScan;
}

async function fetchSuiInboxEvents(config: NetworkConfig): Promise<InboxSource> {
  if (!config.sui) return { announcements: [], spentNullifiers: new Set() };

  const { SuiClient } = await import("@mysten/sui/client");
  type SuiEvent = Awaited<ReturnType<InstanceType<typeof SuiClient>["queryEvents"]>>["data"][number];
  const client = new SuiClient({ url: config.sui.rpcUrl });
  const events: SuiEvent[] = [];
  let cursor: { txDigest: string; eventSeq: string } | null = null;

  for (let page = 0; page < 20; page += 1) {
    const result = await client.queryEvents({
      query: {
        MoveEventModule: {
          package: config.sui.packageId,
          module: "events",
        },
      },
      cursor,
      limit: 50,
      order: "descending",
    });
    events.push(...result.data);
    if (!result.hasNextPage || !result.nextCursor) break;
    cursor = result.nextCursor;
  }

  const announcements: OnChainStealthAnnouncement[] = [];
  const spentNullifiers = new Set<string>();

  for (const event of events) {
    const type = event.type.split("::").at(-1) ?? "";
    const payload = objectPayload(event.parsedJson);

    if (type === "BtcDepositVerified") {
      const amount = bigintField(payload.amount_sats);
      const ephemeralPub = bytesField(payload.ephemeral_pubkey);
      const commitment = bytesField(payload.commitment);
      const leafIndex = numberField(payload.leaf_index);
      if (amount == null || !ephemeralPub || !commitment || leafIndex == null) continue;
      announcements.push({
        announcementType: 0,
        ephemeralPub,
        encryptedAmount: u64Le(amount),
        commitment,
        leafIndex,
        blockTime: Math.floor(Number(event.timestampMs ?? 0) / 1000),
        tokenIdHex: SUI_ZKBTC_TOKEN_ID.toString(16).padStart(64, "0"),
      });
    } else if (type === "NullifierSpent") {
      const nullifier = bytesField(payload.nullifier);
      if (nullifier) spentNullifiers.add(Buffer.from(nullifier).toString("hex"));
    }
  }

  announcements.sort((a, b) => a.leafIndex - b.leafIndex);
  return { announcements, spentNullifiers };
}

function objectPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function bytesField(value: unknown): Uint8Array | null {
  if (Array.isArray(value)) {
    const bytes = value.map((entry) => Number(entry));
    if (bytes.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)) {
      return Uint8Array.from(bytes);
    }
    return null;
  }
  if (typeof value === "string") {
    const normalized = value.replace(/^0x/, "");
    if (/^[0-9a-fA-F]*$/.test(normalized) && normalized.length % 2 === 0) {
      return Uint8Array.from(Buffer.from(normalized, "hex"));
    }
  }
  return null;
}

function bigintField(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

function numberField(value: unknown): number | null {
  const big = bigintField(value);
  if (big == null || big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(big);
}

function u64Le(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}
