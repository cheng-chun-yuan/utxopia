import { SuiClient } from "@mysten/sui/client";
import { CommitmentTreeIndex, getMerkleProofFromTree, initPoseidon } from "@utxopia/sdk";
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

export interface SuiExplorerStats {
  totalShielded: bigint;
  depositCount: number;
  totalCommitments: number;
  volume: bigint;
}

export interface SuiMerkleProofResponse {
  success: true;
  commitment: string;
  leafIndex: string;
  root: string;
  computedRoot: string;
  siblings: string[];
  indices: number[];
  source: "sui-events";
}

export async function fetchSuiExplorerTransactions(config: NetworkConfig): Promise<ExplorerTx[]> {
  const events = await fetchSuiExplorerEvents(config);
  return buildSuiExplorerTransactions(config, events);
}

export async function fetchSuiExplorerStats(config: NetworkConfig): Promise<SuiExplorerStats> {
  const events = await fetchSuiExplorerEvents(config);
  const commitments = new Set<string>();
  let maxLeafIndex = -1;
  let totalShielded = 0n;
  let depositCount = 0;
  let redeemed = 0n;

  for (const event of events) {
    const type = eventName(event);
    const payload = objectPayload(event.parsedJson);

    if (type === "CommitmentInserted") {
      const commitment = bytesField(payload.commitment);
      if (commitment) commitments.add(commitment);
      const leafIndex = bigintField(payload.leaf_index);
      if (leafIndex != null && leafIndex <= BigInt(Number.MAX_SAFE_INTEGER)) {
        maxLeafIndex = Math.max(maxLeafIndex, Number(leafIndex));
      }
    } else if (type === "BtcDepositVerified") {
      const amount = bigintField(payload.amount_sats);
      if (amount != null) {
        totalShielded += amount;
        depositCount += 1;
      }
    } else if (type === "RedemptionRequested") {
      const amount = bigintField(payload.amount_sats);
      if (amount != null) redeemed += amount;
    }
  }

  const totalCommitments = Math.max(commitments.size, maxLeafIndex + 1, 0);
  return {
    totalShielded: totalShielded > redeemed ? totalShielded - redeemed : 0n,
    depositCount,
    totalCommitments,
    volume: totalShielded + redeemed,
  };
}

export async function fetchSuiMerkleProof(
  config: NetworkConfig,
  commitmentHex: string,
): Promise<SuiMerkleProofResponse | null> {
  const normalized = normalizeHex(commitmentHex);
  if (!normalized) return null;

  await initPoseidon();
  const events = await fetchSuiExplorerEvents(config);
  const commitments = extractSuiCommitments(events);
  if (!commitments.some((item) => item.commitment === normalized)) {
    return null;
  }

  const tree = new CommitmentTreeIndex();
  for (const item of commitments) {
    tree.addCommitment(BigInt(`0x${item.commitment}`), BigInt(item.amount ?? 0));
  }

  const proof = getMerkleProofFromTree(tree, BigInt(`0x${normalized}`));
  if (!proof) return null;

  const root = proof.root.toString(16).padStart(64, "0");
  return {
    success: true,
    commitment: normalized,
    leafIndex: String(proof.leafIndex),
    root,
    computedRoot: root,
    siblings: proof.siblings.map((sibling) => sibling.toString(16).padStart(64, "0")),
    indices: proof.indices,
    source: "sui-events",
  };
}

async function fetchSuiExplorerEvents(config: NetworkConfig): Promise<SuiEvent[]> {
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

  return events;
}

function buildSuiExplorerTransactions(config: NetworkConfig, events: SuiEvent[]): ExplorerTx[] {
  if (!config.sui) return [];

  const grouped = new Map<string, SuiEvent[]>();
  for (const event of events) {
    const list = grouped.get(event.id.txDigest) ?? [];
    list.push(event);
    grouped.set(event.id.txDigest, list);
  }

  const txs: ExplorerTx[] = [];
  const redemptions = new Map<string, {
    request?: SuiEvent;
    completion?: SuiEvent;
  }>();

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
          grossAmount: numberField(payload.amount_sats),
          netAmount: numberField(payload.amount_sats),
          btcDepositTxid: bytesField(payload.deposit_txid, true),
          depositAmountSats: numberField(payload.amount_sats),
        }],
        outputs: [{
          type: "commitment",
          commitment: bytesField(payload.commitment),
          leafIndex: numberField(payload.leaf_index),
          amount: numberField(payload.amount_sats),
        }],
        btcMeta: {
          depositTxid: bytesField(payload.deposit_txid, true),
          sweepTxid: null,
          taprootAddress: config.bitcoin.poolAddress || null,
          confirmations: null,
          sweepConfirmations: null,
          sweepFeeSats: null,
          mintedSats: numberField(payload.amount_sats),
          depositAmountSats: numberField(payload.amount_sats),
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
            leafIndex: numberField(eventPayload.leaf_index),
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
      const redemptionId = stringField(payload.redemption_id);
      if (redemptionId) {
        redemptions.set(redemptionId, {
          ...redemptions.get(redemptionId),
          request: primary,
        });
      }
      continue;
    }

    if (type === "RedemptionCompleted") {
      const redemptionId = stringField(payload.redemption_id);
      if (redemptionId) {
        redemptions.set(redemptionId, {
          ...redemptions.get(redemptionId),
          completion: primary,
        });
      }
    }
  }

  for (const [redemptionId, redemption] of redemptions) {
    const requestPayload = objectPayload(redemption.request?.parsedJson);
    const completionPayload = objectPayload(redemption.completion?.parsedJson);
    const amount = numberField(requestPayload.amount_sats);
    const fee = numberField(requestPayload.max_fee_sats);
    txs.push({
      txSignature: redemption.request?.id.txDigest ?? redemption.completion?.id.txDigest ?? redemptionId,
      type: "withdraw",
      tokenId: "zkbtc",
      tokenSymbol: "BTC",
      timestamp: Number((redemption.completion ?? redemption.request)?.timestampMs ?? 0),
      status: redemption.completion ? "confirmed" : "processing",
      inputs: [{
        requestId: redemptionId,
        grossAmount: amount,
        fee,
      }],
      outputs: [{
        type: "withdraw",
        amount,
        fee,
        payout: amount == null || fee == null ? undefined : Math.max(0, amount - fee),
        requestId: redemptionId,
        btcScript: bytesField(requestPayload.btc_address_hash),
        btcTxid: bytesField(completionPayload.btc_txid, true),
        localStatus: redemption.completion ? "Completed" : "Processing",
      }],
    });
  }

  txs.sort((a, b) => b.timestamp - a.timestamp);
  return txs;
}

function extractSuiCommitments(events: SuiEvent[]): Array<{ commitment: string; leafIndex: number; amount?: number }> {
  const seen = new Set<number>();
  const commitments: Array<{ commitment: string; leafIndex: number; amount?: number }> = [];

  for (const event of events) {
    const type = eventName(event);
    if (type !== "BtcDepositVerified" && type !== "CommitmentInserted") continue;

    const payload = objectPayload(event.parsedJson);
    const commitment = bytesField(payload.commitment);
    const leafIndex = numberField(payload.leaf_index);
    if (!commitment || leafIndex == null || seen.has(leafIndex)) continue;

    seen.add(leafIndex);
    commitments.push({
      commitment,
      leafIndex,
      amount: numberField(payload.amount_sats),
    });
  }

  commitments.sort((a, b) => a.leafIndex - b.leafIndex);
  return commitments;
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
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.value === "string" || typeof record.value === "number" || typeof record.value === "bigint") {
      return String(record.value);
    }
    if (typeof record.fields === "object" && record.fields) {
      return stringField((record.fields as Record<string, unknown>).value);
    }
  }
  return undefined;
}

function bigintField(value: unknown): bigint | undefined {
  const text = stringField(value);
  if (!text) return undefined;
  try {
    return BigInt(text);
  } catch {
    return undefined;
  }
}

function numberField(value: unknown): number | undefined {
  const parsedBigint = bigintField(value);
  if (parsedBigint == null || parsedBigint > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  const parsed = Number(parsedBigint);
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

function normalizeHex(value: string): string | null {
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]+$/.test(normalized) || normalized.length > 64) return null;
  return normalized.padStart(64, "0").toLowerCase();
}
