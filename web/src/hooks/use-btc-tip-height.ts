"use client";

import useSWR from "swr";
import { getEsploraApiUrl } from "@/lib/btc-network";

async function fetchTipHeight(url: string): Promise<number> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`tip height fetch ${res.status}`);
  const text = (await res.text()).trim();
  const n = Number(text);
  if (!Number.isFinite(n)) throw new Error(`tip height NaN: ${text}`);
  return n;
}

/** Current BTC tip height for the active network. Refreshes every 15s so
 *  confirmation counts advance live without per-row polling. Returns null
 *  until the first fetch lands. */
export function useBtcTipHeight(): number | null {
  const { data } = useSWR(
    `${getEsploraApiUrl()}/blocks/tip/height`,
    fetchTipHeight,
    { refreshInterval: 15_000, revalidateOnFocus: true, dedupingInterval: 5_000 },
  );
  return typeof data === "number" ? data : null;
}

/** Live confirmation count for a confirmed-at-height tx. Returns null when
 *  inputs are missing (still pending). Floors at 0 if the tip somehow lags
 *  the recorded height (race during reorgs / stale cache). */
export function confirmationsFromHeight(
  height: number | null | undefined,
  tip: number | null | undefined,
): number | null {
  if (height == null || tip == null) return null;
  return Math.max(0, tip - height + 1);
}
