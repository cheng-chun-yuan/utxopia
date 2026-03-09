import useSWR from "swr";

const API_BASE =
  process.env.EXPO_PUBLIC_API_URL || "https://api-aegis.amidoggy.xyz";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export interface ExplorerItem {
  hash: string;
  timestamp: number;
  type?: string;
}

export function useCommitments() {
  return useSWR<ExplorerItem[]>(`${API_BASE}/tree/leaves`, fetcher);
}

export function useNullifiers() {
  return useSWR<ExplorerItem[]>(`${API_BASE}/events/nullifiers`, fetcher);
}

export function useProofs() {
  return useSWR<ExplorerItem[]>(`${API_BASE}/events/proofs`, fetcher);
}
