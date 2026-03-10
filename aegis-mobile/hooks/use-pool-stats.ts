import useSWR from "swr";
import { API_BASE, fetcher } from "@/lib/api";

export interface PoolStats {
  totalShielded: number;
  depositCount: number;
  totalMinted: number;
  totalBurned: number;
}

export function usePoolStats() {
  const { data, error, isLoading, mutate } = useSWR<PoolStats>(
    `${API_BASE}/api/pool/info`,
    fetcher,
    { refreshInterval: 60000 },
  );
  return { stats: data, error, isLoading, refresh: mutate };
}
