import { NextResponse } from "next/server";

const BINANCE_SYMBOLS = ["BTCUSDT", "SOLUSDT", "SUIUSDT", "USDCUSDT"];
const BINANCE_URL = `https://api.binance.com/api/v3/ticker/price?symbols=${JSON.stringify(BINANCE_SYMBOLS)}`;

const COINGECKO_IDS = "bitcoin,solana,sui,usd-coin,tether";
const COINGECKO_URL = `https://api.coingecko.com/api/v3/simple/price?ids=${COINGECKO_IDS}&vs_currencies=usd`;

export async function GET() {
  const binance = await fetchFromBinance();
  if (binance) {
    return NextResponse.json(binance, {
      headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" },
    });
  }

  const coingecko = await fetchFromCoinGecko();
  if (coingecko) {
    return NextResponse.json(coingecko, {
      headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" },
    });
  }

  return NextResponse.json(
    { error: "Unable to fetch token prices" },
    { status: 502 }
  );
}

async function fetchFromBinance() {
  try {
    const res = await fetch(BINANCE_URL, { next: { revalidate: 60 } });
    if (!res.ok) return null;
    const data: { symbol: string; price: string }[] = await res.json();
    const map = Object.fromEntries(data.map((d) => [d.symbol, parseFloat(d.price)]));
    return {
      btc: map.BTCUSDT ?? null,
      sol: map.SOLUSDT ?? null,
      sui: map.SUIUSDT ?? null,
      usdc: map.USDCUSDT ?? null,
      usdt: 1.0,
    };
  } catch (error) {
    console.error("[TokenPrices API] Binance fetch error:", error);
    return null;
  }
}

async function fetchFromCoinGecko() {
  try {
    const res = await fetch(COINGECKO_URL, { next: { revalidate: 60 } });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      btc: data?.bitcoin?.usd ?? null,
      sol: data?.solana?.usd ?? null,
      sui: data?.sui?.usd ?? null,
      usdc: data?.["usd-coin"]?.usd ?? null,
      usdt: data?.tether?.usd ?? null,
    };
  } catch (error) {
    console.error("[TokenPrices API] CoinGecko fetch error:", error);
    return null;
  }
}
