import { useState, useEffect } from "react";

const BINANCE_SYMBOLS = ["BTCUSDT", "SOLUSDT", "USDCUSDT"];
const BINANCE_URL = `https://api.binance.com/api/v3/ticker/price?symbols=${JSON.stringify(BINANCE_SYMBOLS)}`;

const COINGECKO_IDS = "bitcoin,solana,usd-coin,tether";
const COINGECKO_URL = `https://api.coingecko.com/api/v3/simple/price?ids=${COINGECKO_IDS}&vs_currencies=usd`;

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
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c: Cache = JSON.parse(raw);
    if (Date.now() - c.ts < STALE_MS) return c;
  } catch {}
  return null;
}

function writeCache(prices: TokenPrices) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ prices, ts: Date.now() }));
  } catch {}
}

/** Try Binance first (faster, no rate limit), fall back to CoinGecko */
async function fetchFromBinance(): Promise<TokenPrices | null> {
  try {
    const res = await fetch(BINANCE_URL);
    if (!res.ok) return null;
    const data: { symbol: string; price: string }[] = await res.json();
    const map = Object.fromEntries(data.map((d) => [d.symbol, parseFloat(d.price)]));
    return {
      btc: map["BTCUSDT"] ?? null,
      sol: map["SOLUSDT"] ?? null,
      usdc: map["USDCUSDT"] ?? null,
      usdt: 1.0, // USDT is the quote currency
    };
  } catch {
    return null;
  }
}

async function fetchFromCoinGecko(): Promise<TokenPrices | null> {
  try {
    const res = await fetch(COINGECKO_URL);
    if (!res.ok) return null;
    const data = await res.json();
    return {
      btc: data?.bitcoin?.usd ?? null,
      sol: data?.solana?.usd ?? null,
      usdc: data?.["usd-coin"]?.usd ?? null,
      usdt: data?.tether?.usd ?? null,
    };
  } catch {
    return null;
  }
}

/** Fetch all token prices (BTC, SOL, USDC, USDT) — Binance primary, CoinGecko fallback */
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
      const p = (await fetchFromBinance()) ?? (await fetchFromCoinGecko());
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
