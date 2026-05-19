/**
 * AnnouncementClient — Production-ready stealth announcement fetcher
 * with three-tier fallback: Backend WS → Backend REST → Direct RPC.
 *
 * - Backend WS: sub-second push via /ws/announcements
 * - Backend REST: initial load + catch-up via /api/announcements
 * - Direct RPC: last resort if backend is unavailable
 */

import type { OnChainStealthAnnouncement } from "./stealth";
import { parseProgramEvents } from "./events";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnnouncementClientConfig {
  /** Backend REST base URL, e.g. "http://localhost:8080" */
  backendUrl: string;
  /** Backend WS base URL — derived from backendUrl if omitted */
  backendWsUrl?: string;
  /** Solana RPC URL (for direct RPC fallback) */
  solanaRpcUrl: string;
  /** UTXOpia program ID base58 (for direct RPC fallback) */
  programId: string;
  /** Commitment tree PDA base58 — query this instead of program ID for fewer results */
  commitmentTreeAddress?: string;
  /** REST request timeout in ms (default 5000) */
  restTimeoutMs?: number;
  /** Max WS reconnect delay in ms (default 30000) */
  wsMaxReconnectMs?: number;
  /** Max leaves backend can lag before supplementing with RPC (default 2) */
  maxLagLeaves?: number;
}

export type AnnouncementListener = (
  announcements: OnChainStealthAnnouncement[],
) => void;

/** Shape returned by backend /api/announcements */
interface BackendAnnouncementRow {
  leaf_index: number;
  announcement_type: number;
  ephemeral_pub: string;
  encrypted_amount: string;
  commitment: string;
  tx_signature: string;
  slot: number;
  block_time?: number;
  token_id?: string | null;
}

interface BackendAnnouncementsResponse {
  success: boolean;
  announcements: BackendAnnouncementRow[];
  count: number;
  latest_leaf_index: number | null;
}

interface BackendStatusResponse {
  count: number;
  latest_leaf_index: number | null;
  tree_next_index: number;
}

/** WS message shape from /ws/announcements */
interface WsAnnouncementUpdate {
  type: string;
  announcement_type: number;
  ephemeral_pub: string;
  encrypted_amount: string;
  commitment: string;
  leaf_index: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function rowToAnnouncement(row: BackendAnnouncementRow): OnChainStealthAnnouncement {
  return {
    announcementType: row.announcement_type,
    ephemeralPub: hexToBytes(row.ephemeral_pub),
    encryptedAmount: hexToBytes(row.encrypted_amount),
    commitment: hexToBytes(row.commitment),
    leafIndex: row.leaf_index,
    blockTime: row.block_time ?? 0,
    slot: row.slot,
    tokenIdHex: row.token_id ?? undefined,
  };
}

function wsUpdateToAnnouncement(update: WsAnnouncementUpdate): OnChainStealthAnnouncement {
  return {
    announcementType: update.announcement_type,
    ephemeralPub: hexToBytes(update.ephemeral_pub),
    encryptedAmount: hexToBytes(update.encrypted_amount),
    commitment: hexToBytes(update.commitment),
    leafIndex: update.leaf_index,
  };
}

// ---------------------------------------------------------------------------
// AnnouncementClient
// ---------------------------------------------------------------------------

export class AnnouncementClient {
  protected ws: WebSocket | null = null;
  protected wsReconnectDelay = 1000;
  protected wsConnected = false;
  protected listeners = new Set<AnnouncementListener>();
  protected cachedAnnouncements: OnChainStealthAnnouncement[] = [];
  protected latestLeafIndex = -1;
  protected backendHealthy = true;
  protected closed = false;
  protected reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRpcFetchAt = 0;
  private rpcCooldownMs = 30_000; // minimum 30s between RPC fallback calls

  protected restTimeout: number;
  protected wsMaxReconnect: number;
  private maxLag: number;
  protected wsUrl: string;

  constructor(protected config: AnnouncementClientConfig) {
    this.restTimeout = config.restTimeoutMs ?? 5000;
    this.wsMaxReconnect = config.wsMaxReconnectMs ?? 30000;
    this.maxLag = config.maxLagLeaves ?? 2;
    this.wsUrl =
      config.backendWsUrl ??
      config.backendUrl.replace("http://", "ws://").replace("https://", "wss://");
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Start WS connection and perform initial data load */
  async start(): Promise<void> {
    if (this.closed) return;
    // Initial load via REST (+ RPC fallback)
    await this.fetchAll();
    // Open WS for real-time push
    this.connectWs();
  }

  /** Fetch all announcements using fallback chain */
  async fetchAll(): Promise<OnChainStealthAnnouncement[]> {
    try {
      const announcements = await this.fetchFromBackend();
      this.backendHealthy = true;
      this.cachedAnnouncements = announcements;
      this.latestLeafIndex = announcements.length > 0
        ? Math.max(...announcements.map((a) => a.leafIndex))
        : -1;

      // Consistency check — supplement from RPC if backend is behind
      await this.checkConsistency();
      return this.cachedAnnouncements;
    } catch {
      this.backendHealthy = false;
    }

    // Fallback: direct RPC
    try {
      const announcements = await this.fetchFromRpc();
      this.cachedAnnouncements = announcements;
      this.latestLeafIndex = announcements.length > 0
        ? Math.max(...announcements.map((a) => a.leafIndex))
        : -1;
      return this.cachedAnnouncements;
    } catch (e) {
      console.error("[AnnouncementClient] All sources failed:", e);
      return this.cachedAnnouncements;
    }
  }

  /** Subscribe to new announcement events. Returns unsubscribe function. */
  onAnnouncement(listener: AnnouncementListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Stop client, close WS */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.listeners.clear();
  }

  /** Whether the backend WS is currently connected */
  get isWsConnected(): boolean {
    return this.wsConnected;
  }

  /** Whether the backend REST was reachable on last attempt */
  get isBackendHealthy(): boolean {
    return this.backendHealthy;
  }

  // -----------------------------------------------------------------------
  // Internal: Backend REST
  // -----------------------------------------------------------------------

  protected async fetchFromBackend(
    since?: number,
  ): Promise<OnChainStealthAnnouncement[]> {
    const url = since != null
      ? `${this.config.backendUrl}/api/announcements?since=${since}`
      : `${this.config.backendUrl}/api/announcements`;

    const resp = await fetch(url, {
      signal: AbortSignal.timeout(this.restTimeout),
    });

    if (!resp.ok) throw new Error(`Backend REST ${resp.status}`);

    const data: BackendAnnouncementsResponse = await resp.json();
    if (!data.success) throw new Error("Backend returned success=false");

    return data.announcements.map(rowToAnnouncement);
  }

  // -----------------------------------------------------------------------
  // Internal: Direct RPC fallback
  // -----------------------------------------------------------------------

  private async fetchFromRpc(
    since?: number,
  ): Promise<OnChainStealthAnnouncement[]> {
    // Cooldown to avoid 429 spam when backend is down
    const now = Date.now();
    if (now - this.lastRpcFetchAt < this.rpcCooldownMs) {
      return this.cachedAnnouncements;
    }
    this.lastRpcFetchAt = now;

    // Query commitment tree PDA (only txs that insert leaves = stealth announcements)
    // Falls back to program ID if commitmentTreeAddress not configured
    const queryAddress = this.config.commitmentTreeAddress || this.config.programId;
    const sigsResp = await fetch(this.config.solanaRpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getSignaturesForAddress",
        params: [queryAddress, { limit: 200 }],
      }),
      signal: AbortSignal.timeout(this.restTimeout * 2),
    });

    const sigsData = await sigsResp.json();
    const signatures: string[] = (sigsData.result || []).map(
      (s: { signature: string }) => s.signature,
    );

    if (signatures.length === 0) return [];

    // Fetch transactions in batches of 10
    const announcements: OnChainStealthAnnouncement[] = [];
    const batchSize = 10;

    for (let i = 0; i < signatures.length; i += batchSize) {
      const batch = signatures.slice(i, i + batchSize);
      const txResponses = await Promise.all(
        batch.map((sig) =>
          fetch(this.config.solanaRpcUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "getTransaction",
              params: [sig, { encoding: "json", maxSupportedTransactionVersion: 0 }],
            }),
          }).then((r) => r.json()),
        ),
      );

      for (const txData of txResponses) {
        const logs: string[] | undefined =
          txData?.result?.meta?.logMessages;
        if (!logs) continue;

        const events = parseProgramEvents(logs, this.config.programId);
        for (const event of events) {
          if (event.type === "stealth_announcement") {
            if (since != null && event.leafIndex <= since) continue;
            announcements.push({
              announcementType: event.announcementType,
              ephemeralPub: event.ephemeralPub,
              encryptedAmount: event.encryptedAmount,
              commitment: event.commitment,
              leafIndex: event.leafIndex,
            });
          }
        }
      }
    }

    // Deduplicate by leafIndex and sort
    const seen = new Map<number, OnChainStealthAnnouncement>();
    for (const a of announcements) {
      if (!seen.has(a.leafIndex)) seen.set(a.leafIndex, a);
    }
    return Array.from(seen.values()).sort((a, b) => a.leafIndex - b.leafIndex);
  }

  // -----------------------------------------------------------------------
  // Internal: Consistency check
  // -----------------------------------------------------------------------

  private async checkConsistency(): Promise<void> {
    try {
      const statusResp = await fetch(
        `${this.config.backendUrl}/api/announcements/status`,
        { signal: AbortSignal.timeout(this.restTimeout) },
      );
      if (!statusResp.ok) return;

      const status: BackendStatusResponse = await statusResp.json();
      const backendLatest = status.latest_leaf_index ?? -1;
      const onChainNext = status.tree_next_index;

      // If backend is more than maxLag behind on-chain, supplement from RPC
      if (onChainNext - 1 - backendLatest > this.maxLag) {
        console.warn(
          `[AnnouncementClient] Backend behind: latest=${backendLatest}, on-chain next=${onChainNext}. Supplementing from RPC.`,
        );
        const supplement = await this.fetchFromRpc(backendLatest);
        if (supplement.length > 0) {
          // Merge: existing + supplement, dedup by leafIndex
          const merged = new Map<number, OnChainStealthAnnouncement>();
          for (const a of this.cachedAnnouncements) merged.set(a.leafIndex, a);
          for (const a of supplement) merged.set(a.leafIndex, a);
          this.cachedAnnouncements = Array.from(merged.values()).sort(
            (a, b) => a.leafIndex - b.leafIndex,
          );
          this.latestLeafIndex = Math.max(
            this.latestLeafIndex,
            ...supplement.map((a) => a.leafIndex),
          );
        }
      }
    } catch {
      // Non-fatal — consistency check is best-effort
    }
  }

  // -----------------------------------------------------------------------
  // Internal: WebSocket
  // -----------------------------------------------------------------------

  protected connectWs(): void {
    if (this.closed) return;

    try {
      const url = `${this.wsUrl}/ws/announcements`;
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.wsConnected = true;
        this.wsReconnectDelay = 1000; // reset backoff
      };

      this.ws.onmessage = (event) => {
        try {
          const update: WsAnnouncementUpdate = JSON.parse(
            typeof event.data === "string" ? event.data : "",
          );
          if (update.type !== "stealth_announcement") return;

          const announcement = wsUpdateToAnnouncement(update);

          // Update cache
          if (announcement.leafIndex > this.latestLeafIndex) {
            this.latestLeafIndex = announcement.leafIndex;
          }
          // Avoid duplicates in cache
          if (!this.cachedAnnouncements.some((a) => a.leafIndex === announcement.leafIndex)) {
            this.cachedAnnouncements.push(announcement);
          }

          // Notify listeners
          for (const listener of this.listeners) {
            try {
              listener([announcement]);
            } catch {
              // Listener errors shouldn't crash the client
            }
          }
        } catch {
          // Ignore malformed messages
        }
      };

      this.ws.onclose = () => {
        this.wsConnected = false;
        this.ws = null;
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        // onclose will fire after onerror
      };
    } catch {
      this.wsConnected = false;
      this.scheduleReconnect();
    }
  }

  protected scheduleReconnect(): void {
    if (this.closed) return;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      // Fetch missed announcements before reconnecting WS
      if (this.latestLeafIndex >= 0) {
        try {
          const missed = await this.fetchFromBackend(this.latestLeafIndex);
          if (missed.length > 0) {
            for (const a of missed) {
              if (!this.cachedAnnouncements.some((c) => c.leafIndex === a.leafIndex)) {
                this.cachedAnnouncements.push(a);
              }
              if (a.leafIndex > this.latestLeafIndex) {
                this.latestLeafIndex = a.leafIndex;
              }
            }
            // Notify listeners of catch-up
            for (const listener of this.listeners) {
              try { listener(missed); } catch { /* ignore */ }
            }
          }
        } catch {
          // Backend may still be down
        }
      }
      this.connectWs();
    }, this.wsReconnectDelay);

    // Exponential backoff
    this.wsReconnectDelay = Math.min(
      this.wsReconnectDelay * 2,
      this.wsMaxReconnect,
    );
  }
}
