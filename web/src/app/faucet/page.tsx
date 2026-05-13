"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Droplets, Bitcoin, ExternalLink } from "lucide-react";
import { getNetworkConfig } from "@/lib/network-config";
import { cn } from "@/lib/utils";

/**
 * Regtest BTC faucet — only renders when the active network's BTC layer is
 * `regtest` (i.e. the hybrid stack). On testnet4 / mainnet the page shows a
 * "not available on this network" hint instead of a working form, so the
 * route is safe to merge even before the backend wiring lands.
 *
 * Backend wiring lives at `/api/faucet/regtest` (stub until the regtest
 * `sendtoaddress` route is implemented — see TODOS.md "Regtest faucet
 * backend route").
 */
export default function FaucetPage() {
  const cfg = useMemo(() => {
    try {
      return getNetworkConfig();
    } catch {
      return null;
    }
  }, []);

  const isRegtest = cfg?.bitcoin.network === "regtest";

  return (
    <main className="min-h-screen bg-background hacker-bg noise-overlay flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-[480px] mb-4 flex items-center justify-between relative z-10">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-body2 text-gray hover:text-gray-light transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back home
        </Link>
        <span className="text-caption text-gray font-mono">
          {cfg?.bitcoin.network ?? "?"}
        </span>
      </div>

      <div
        className={cn(
          "bg-card border border-solid border-gray/30 p-6",
          "w-[480px] max-w-[calc(100vw-32px)] rounded-[16px]",
          "glow-border cyber-corners relative z-10",
        )}
      >
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-[10px] bg-warning/10">
            <Droplets className="w-5 h-5 text-warning" />
          </div>
          <div>
            <h1 className="text-heading6 text-foreground">Regtest BTC faucet</h1>
            <p className="text-caption text-gray">
              Drip a few regtest BTC to your own address so you can deposit.
            </p>
          </div>
        </div>

        {isRegtest ? <FaucetForm /> : <NotAvailableNotice network={cfg?.bitcoin.network} />}
      </div>
    </main>
  );
}

function NotAvailableNotice({ network }: { network?: string }) {
  return (
    <div className="space-y-3">
      <div className="p-4 rounded-[12px] bg-muted border border-gray/15">
        <p className="text-body2 text-gray-light">
          Faucet is only available on the <span className="text-warning font-mono">regtest</span>{" "}
          (hybrid) stack. The current network is{" "}
          <span className="text-foreground font-mono">{network ?? "unknown"}</span>.
        </p>
      </div>
      <div className="text-caption text-gray space-y-2">
        <p>To switch to the hybrid stack:</p>
        <pre className="bg-background/60 border border-gray/15 rounded-[10px] p-3 overflow-x-auto text-[11px] leading-relaxed">
{`# 1. Start regtest BTC + esplora
docker compose -f docker-compose.regtest.yml up -d

# 2. Switch backend to hybrid (devnet Solana + regtest BTC)
docker compose -f docker-compose.hybrid.yml up --build -d

# 3. Point web/.env.local at the hybrid backend +
#    set NEXT_PUBLIC_BTC_NETWORK=regtest`}
        </pre>
        <p className="pt-1">
          Public testnet4 / mainnet users should use{" "}
          <a
            className="text-privacy hover:underline inline-flex items-center gap-1"
            href="https://mempool.space/testnet4/faucet"
            target="_blank"
            rel="noreferrer"
          >
            mempool.space testnet4 faucet <ExternalLink className="w-3 h-3" />
          </a>{" "}
          instead.
        </p>
      </div>
    </div>
  );
}

function FaucetForm() {
  const [address, setAddress] = useState("");
  const [amountSats, setAmountSats] = useState(1_000_000);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<
    | { kind: "ok"; txid: string }
    | { kind: "err"; message: string }
    | null
  >(null);

  useEffect(() => {
    setResult(null);
  }, [address, amountSats]);

  const validAddress = address.trim().startsWith("bcrt1");

  async function handleDrip() {
    setSubmitting(true);
    setResult(null);
    try {
      const res = await fetch("/api/faucet/regtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: address.trim(), amountSats }),
      });
      const body = (await res.json()) as { ok: boolean; txid?: string; error?: string };
      if (!res.ok || !body.ok) {
        setResult({ kind: "err", message: body.error ?? `HTTP ${res.status}` });
      } else {
        setResult({ kind: "ok", txid: body.txid ?? "" });
      }
    } catch (e) {
      setResult({ kind: "err", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="text-body2 text-gray-light pl-2 mb-2 block">
          Your regtest BTC address
        </label>
        <div className="relative">
          <Bitcoin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray" />
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="bcrt1q… or bcrt1p…"
            className={cn(
              "w-full p-3 pl-10 bg-muted border border-gray/15 rounded-[12px]",
              "text-body2 font-mono text-foreground placeholder:text-gray",
              "outline-none focus:border-warning/40 transition-colors",
            )}
          />
        </div>
      </div>

      <div>
        <label className="text-body2 text-gray-light pl-2 mb-2 block">
          Amount (sats)
        </label>
        <input
          type="number"
          min={1000}
          max={100_000_000}
          step={1000}
          value={amountSats}
          onChange={(e) => setAmountSats(Number(e.target.value) || 0)}
          className={cn(
            "w-full p-3 bg-muted border border-gray/15 rounded-[12px]",
            "text-body2 font-mono text-foreground",
            "outline-none focus:border-warning/40 transition-colors",
          )}
        />
        <p className="text-caption text-gray mt-1 pl-2">
          {(amountSats / 1e8).toFixed(8)} BTC
        </p>
      </div>

      <button
        onClick={handleDrip}
        disabled={!validAddress || submitting || amountSats <= 0}
        className="btn-primary w-full"
      >
        <Droplets className="w-5 h-5" />
        {submitting ? "Dripping…" : "Send regtest BTC"}
      </button>

      {result?.kind === "ok" && (
        <div className="p-3 rounded-[10px] border border-success/30 bg-success/5 text-caption text-success">
          Sent. txid: <span className="font-mono break-all">{result.txid || "(see backend log)"}</span>
        </div>
      )}
      {result?.kind === "err" && (
        <div className="p-3 rounded-[10px] border border-error/30 bg-error/5 text-caption text-error">
          {result.message}
        </div>
      )}

      <p className="text-caption text-gray">
        After receiving BTC, head to <Link href="/send" className="text-privacy hover:underline">Send</Link>{" "}
        and create a deposit — paste the OP_RETURN payload from{" "}
        <span className="font-mono">scripts/deposit-for-stealth.ts</span>.
      </p>
    </div>
  );
}
