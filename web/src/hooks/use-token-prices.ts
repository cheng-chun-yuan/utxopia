import { useState, useEffect } from "react";

const PRICES_API_URL = "/api/token-prices";

const CACHE_KEY = "token_prices_cache";
const STALE_MS = 60_000; // refresh every 60s

export interface TokenPrices {
  btc: number | null;
  sol: number | null;
  usdc: number | null;
  usdt: number | null;
}

const EMPTY: TokenPrices = { btc: null, sol: null, usdc: null, usdt: null };

interface Cache {
  prices: TokenPrices;
  ts: number;
}

function readCache(): Cache | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c: Cache = JSON.parse(raw);
    if (Date.now() - c.ts < STALE_MS) return c;
  } catch (err) { console.error("[TokenPrices] cache read error:", err); }
  return null;
}

function writeCache(prices: TokenPrices) {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ prices, ts: Date.now() }));
  } catch (err) { console.error("[TokenPrices] cache write error:", err); }
}

async function fetchPricesFromApi(): Promise<TokenPrices | null> {
  try {
    const res = await fetch(PRICES_API_URL);
    if (!res.ok) return null;
    const data = await res.json();
    return {
      btc: data?.btc ?? null,
      sol: data?.sol ?? null,
      usdc: data?.usdc ?? null,
      usdt: data?.usdt ?? null,
    };
  } catch (err) {
    console.error("[TokenPrices] API fetch error:", err);
    return null;
  }
}

/** Fetch all token prices (BTC, SOL, USDC, USDT) via same-origin API */
export function useTokenPrices(): TokenPrices {
  const [prices, setPrices] = useState<TokenPrices>(() => readCache()?.prices ?? EMPTY);

  useEffect(() => {
    let cancelled = false;

    const fetchPrices = async () => {
      const cached = readCache();
      if (cached) {
        setPrices(cached.prices);
        return;
      }
      const p = await fetchPricesFromApi();
      if (p && !cancelled) {
        setPrices(p);
        writeCache(p);
      }
    };

    fetchPrices();
    const interval = setInterval(fetchPrices, STALE_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return prices;
}
