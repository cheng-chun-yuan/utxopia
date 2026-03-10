import useSWR from "swr";
import { API_BASE, fetcher } from "@/lib/api";
import { getEventClient } from "./use-event-stream";

export interface LeafRow {
  leaf_index: number;
  commitment: string;
  created_at: number;
  tx_signature: string;
  slot: number;
}

export interface AnnouncementRow {
  leaf_index: number;
  announcement_type: number;
  ephemeral_pub: string;
  encrypted_amount: string;
  commitment: string;
  tx_signature: string;
  slot: number;
}

export interface NullifierPdas {
  pdas: string[];
  total: number;
  latest_slot: number;
}

export interface AnnouncementsResponse {
  success: boolean;
  announcements: AnnouncementRow[];
  count: number;
  latest_leaf_index: number | null;
}

export function useAnnouncements() {
  return useSWR<AnnouncementsResponse>(
    `${API_BASE}/api/announcements`,
    fetcher,
  );
}

export function useNullifiers() {
  return useSWR<NullifierPdas>(
    `${API_BASE}/api/nullifiers`,
    async () => {
      const client = getEventClient();
      const pdas = await client.fetchSpentNullifiers();
      return { pdas: Array.from(pdas), total: pdas.size, latest_slot: 0 };
    },
  );
}

export interface TreeStatus {
  root: string;
  next_index: number;
  size: number;
}

export function useTreeStatus() {
  return useSWR<TreeStatus>(
    `${API_BASE}/api/tree/status`,
    async () => {
      const client = getEventClient();
      const status = await client.fetchTreeStatus();
      if (!status) throw new Error("Backend unavailable");
      return status;
    },
  );
}
