import useSWR from "swr";

const API_BASE =
  process.env.EXPO_PUBLIC_API_URL || "https://api-aegis.amidoggy.xyz";

export interface PoolStats {
  totalShielded: number;
  depositCount: number;
  totalMinted: number;
  totalBurned: number;
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function usePoolStats() {
  const { data, error, isLoading, mutate } = useSWR<PoolStats>(
    `${API_BASE}/pool/info`,
    fetcher,
    { refreshInterval: 30000 },
  );
  return { stats: data, error, isLoading, refresh: mutate };
}
