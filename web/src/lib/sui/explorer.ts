import { SuiClient } from "@mysten/sui/client";
import type { NetworkConfig } from "@/lib/network-config";

type SuiEvent = Awaited<ReturnType<SuiClient["queryEvents"]>>["data"][number];

interface ExplorerTx {
  txSignature: string;
  type: "shield" | "transfer" | "unshield" | "withdraw";
  tokenId: string | null;
  tokenSymbol: string | null;
  timestamp: number;
  status: string;
  inputs: Record<string, unknown>[];
  outputs: Record<string, unknown>[];
  btcMeta?: Record<string, unknown> | null;
}

export async function fetchSuiExplorerTransactions(config: NetworkConfig): Promise<ExplorerTx[]> {
  if (!config.sui) return [];

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

  const grouped = new Map<string, SuiEvent[]>();
  for (const event of events) {
    const list = grouped.get(event.id.txDigest) ?? [];
    list.push(event);
    grouped.set(event.id.txDigest, list);
  }

  const txs: ExplorerTx[] = [];
  for (const [txDigest, txEvents] of grouped) {
    const primary = pickPrimaryEvent(txEvents);
    if (!primary) continue;
    const type = eventName(primary);
    const timestamp = Number(primary.timestampMs ?? 0);
    const payload = objectPayload(primary.parsedJson);

    if (type === "BtcDepositVerified") {
      txs.push({
        txSignature: txDigest,
        type: "shield",
        tokenId: "zkbtc",
        tokenSymbol: "BTC",
        timestamp,
        status: "confirmed",
        inputs: [{
          grossAmount: numberString(payload.amount_sats),
          netAmount: numberString(payload.amount_sats),
          btcDepositTxid: bytesField(payload.deposit_txid, true),
          depositAmountSats: numberString(payload.amount_sats),
        }],
        outputs: [{
          type: "commitment",
          commitment: bytesField(payload.commitment),
          leafIndex: numberString(payload.leaf_index),
          amount: numberString(payload.amount_sats),
        }],
        btcMeta: {
          depositTxid: bytesField(payload.deposit_txid, true),
          sweepTxid: null,
          taprootAddress: config.bitcoin.poolAddress || null,
          confirmations: null,
          sweepConfirmations: null,
          sweepFeeSats: null,
          mintedSats: numberString(payload.amount_sats),
          depositAmountSats: numberString(payload.amount_sats),
          depositBlockHeight: null,
          sweepBlockHeight: null,
          trackerError: null,
        },
      });
      continue;
    }

    if (type === "JoinSplitVerified") {
      const nullifiers = txEvents
        .filter((event) => eventName(event) === "NullifierSpent")
        .map((event) => ({ nullifierHash: bytesField(objectPayload(event.parsedJson).nullifier) }));
      const commitments = txEvents
        .filter((event) => eventName(event) === "CommitmentInserted")
        .map((event) => {
          const eventPayload = objectPayload(event.parsedJson);
          return {
            type: "commitment",
            commitment: bytesField(eventPayload.commitment),
            leafIndex: numberString(eventPayload.leaf_index),
          };
        });
      txs.push({
        txSignature: txDigest,
        type: "transfer",
        tokenId: "zkbtc",
        tokenSymbol: "BTC",
        timestamp,
        status: "confirmed",
        inputs: nullifiers,
        outputs: commitments,
      });
      continue;
    }

    if (type === "RedemptionRequested") {
      txs.push({
        txSignature: txDigest,
        type: "withdraw",
        tokenId: "zkbtc",
        tokenSymbol: "BTC",
        timestamp,
        status: "processing",
        inputs: [{
          requestId: stringField(payload.redemption_id),
          grossAmount: numberString(payload.amount_sats),
          fee: numberString(payload.max_fee_sats),
        }],
        outputs: [{
          type: "withdraw",
          amount: numberString(payload.amount_sats),
          fee: numberString(payload.max_fee_sats),
          payout: Math.max(
            0,
            (numberString(payload.amount_sats) ?? 0) - (numberString(payload.max_fee_sats) ?? 0),
          ),
          requestId: stringField(payload.redemption_id),
          btcScript: bytesField(payload.btc_address_hash),
        }],
      });
      continue;
    }

    if (type === "RedemptionCompleted") {
      txs.push({
        txSignature: txDigest,
        type: "withdraw",
        tokenId: "zkbtc",
        tokenSymbol: "BTC",
        timestamp,
        status: "confirmed",
        inputs: [{ requestId: stringField(payload.redemption_id) }],
        outputs: [{
          type: "withdraw",
          requestId: stringField(payload.redemption_id),
          btcTxid: bytesField(payload.btc_txid, true),
        }],
      });
    }
  }

  txs.sort((a, b) => b.timestamp - a.timestamp);
  return txs;
}

function pickPrimaryEvent(events: SuiEvent[]): SuiEvent | null {
  return (
    events.find((event) => eventName(event) === "BtcDepositVerified") ??
    events.find((event) => eventName(event) === "JoinSplitVerified") ??
    events.find((event) => eventName(event) === "RedemptionRequested") ??
    events.find((event) => eventName(event) === "RedemptionCompleted") ??
    null
  );
}

function eventName(event: SuiEvent): string {
  return event.type.split("::").at(-1) ?? "";
}

function objectPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringField(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return undefined;
}

function numberString(value: unknown): number | undefined {
  const text = stringField(value);
  if (!text) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function bytesField(value: unknown, reverse = false): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const bytes = value
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item >= 0 && item <= 255);
  if (bytes.length !== value.length) return undefined;
  const ordered = reverse ? bytes.reverse() : bytes;
  return ordered.map((item) => item.toString(16).padStart(2, "0")).join("");
}
