/**
 * EventClient — Unified event stream client extending AnnouncementClient
 *
 * Handles all three backend event types via /ws/events:
 * - leaf_inserted (tree updates)
 * - nullifier_spent
 * - stealth_announcement (delegated to parent AnnouncementClient)
 *
 * Also provides REST helpers for tree status and nullifier fetching.
 */

import {
  AnnouncementClient,
  type AnnouncementClientConfig,
} from "./announcement-client";
import type { OnChainStealthAnnouncement } from "./stealth";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LeafInsertedEvent {
  type: "leaf_inserted";
  leaf_index: number;
  commitment: string;
  new_root: string;
}

export interface NullifierSpentEvent {
  type: "nullifier_spent";
  nullifier_hash: string;
  slot: number;
}

export interface AnnouncementEvent {
  type: "stealth_announcement";
  announcement_type: number;
  ephemeral_pub: string;
  encrypted_amount: string;
  commitment: string;
  leaf_index: number;
  block_time?: number;
}

export type ServerEvent =
  | LeafInsertedEvent
  | NullifierSpentEvent
  | AnnouncementEvent;

export type EventListener<T> = (event: T) => void;

export interface TreeStatusResponse {
  root: string;
  next_index: number;
  size: number;
}

export interface NullifierPdasResponse {
  pdas: string[];
  total: number;
  latest_slot: number;
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

// ---------------------------------------------------------------------------
// EventClient
// ---------------------------------------------------------------------------

export class EventClient extends AnnouncementClient {
  private treeListeners = new Set<EventListener<LeafInsertedEvent>>();
  private nullifierListeners = new Set<EventListener<NullifierSpentEvent>>();
  private spentNullifiers = new Set<string>();
  private nullifierLatestSlot = 0;

  /** Subscribe to tree (leaf_inserted) events */
  onTreeUpdate(listener: EventListener<LeafInsertedEvent>): () => void {
    this.treeListeners.add(listener);
    return () => this.treeListeners.delete(listener);
  }

  /** Subscribe to nullifier (nullifier_spent) events */
  onNullifierSpent(listener: EventListener<NullifierSpentEvent>): () => void {
    this.nullifierListeners.add(listener);
    return () => this.nullifierListeners.delete(listener);
  }

  /** Fetch tree status from backend */
  async fetchTreeStatus(): Promise<TreeStatusResponse | null> {
    try {
      const resp = await fetch(
        `${this.config.backendUrl}/api/tree/status`,
        { signal: AbortSignal.timeout(this.restTimeout) },
      );
      if (!resp.ok) return null;
      return (await resp.json()) as TreeStatusResponse;
    } catch {
      return null;
    }
  }

  /** Fetch spent nullifier PDAs with incremental caching */
  async fetchSpentNullifiers(): Promise<Set<string>> {
    try {
      const since =
        this.nullifierLatestSlot > 0
          ? `?since=${this.nullifierLatestSlot}`
          : "";
      const resp = await fetch(
        `${this.config.backendUrl}/api/nullifiers${since}`,
        { signal: AbortSignal.timeout(this.restTimeout) },
      );
      if (!resp.ok) return this.spentNullifiers;
      const data: NullifierPdasResponse = await resp.json();
      for (const pda of data.pdas || []) this.spentNullifiers.add(pda);
      if (data.latest_slot > this.nullifierLatestSlot) {
        this.nullifierLatestSlot = data.latest_slot;
      }
      return this.spentNullifiers;
    } catch {
      return this.spentNullifiers;
    }
  }

  /** Check if a specific nullifier PDA is in the spent set */
  isNullifierSpent(pda: string): boolean {
    return this.spentNullifiers.has(pda);
  }

  /** Stop client, close WS, clear extra listeners */
  close(): void {
    super.close();
    this.treeListeners.clear();
    this.nullifierListeners.clear();
  }

  // -----------------------------------------------------------------------
  // Override: connect to /ws/events instead of /ws/announcements
  // -----------------------------------------------------------------------

  protected connectWs(): void {
    if (this.closed) return;

    try {
      const url = `${this.wsUrl}/ws/events`;
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.wsConnected = true;
        this.wsReconnectDelay = 1000;
      };

      this.ws.onmessage = (event) => {
        try {
          const data: ServerEvent = JSON.parse(
            typeof event.data === "string" ? event.data : "",
          );
          this.dispatchEvent(data);
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

  // -----------------------------------------------------------------------
  // Internal: route events to appropriate listeners
  // -----------------------------------------------------------------------

  private dispatchEvent(event: ServerEvent): void {
    switch (event.type) {
      case "stealth_announcement":
        this.handleAnnouncementEvent(event);
        break;
      case "leaf_inserted":
        for (const listener of this.treeListeners) {
          try { listener(event); } catch { /* ignore */ }
        }
        break;
      case "nullifier_spent":
        for (const listener of this.nullifierListeners) {
          try { listener(event); } catch { /* ignore */ }
        }
        break;
    }
  }

  private handleAnnouncementEvent(event: AnnouncementEvent): void {
    const announcement: OnChainStealthAnnouncement = {
      announcementType: event.announcement_type,
      ephemeralPub: hexToBytes(event.ephemeral_pub),
      encryptedAmount: hexToBytes(event.encrypted_amount),
      commitment: hexToBytes(event.commitment),
      leafIndex: event.leaf_index,
      blockTime: event.block_time ?? 0,
    };

    // Update cache (same logic as parent AnnouncementClient.connectWs)
    if (announcement.leafIndex > this.latestLeafIndex) {
      this.latestLeafIndex = announcement.leafIndex;
    }
    if (
      !this.cachedAnnouncements.some(
        (a) => a.leafIndex === announcement.leafIndex,
      )
    ) {
      this.cachedAnnouncements.push(announcement);
    }

    // Notify announcement listeners
    for (const listener of this.listeners) {
      try {
        listener([announcement]);
      } catch {
        // Listener errors shouldn't crash the client
      }
    }
  }
}
